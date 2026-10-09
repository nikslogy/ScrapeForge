import { chromium, Browser, BrowserContext, type LaunchOptions, type Request } from 'patchright';
import { egressProxyUrl } from '../net/egress.js';
import { generateFingerprint, toContextOptions } from './fingerprint.js';

interface PooledContext {
  context: BrowserContext;
  useCount: number;
  createdAt: number;
  inUse: boolean;
  /** Being cleaned after a release; not available yet. */
  cleaning: boolean;
  /** Origins the context requested anything from since it was last cleaned. */
  origins: Set<string>;
  /** Set once more than MAX_TRACKED_ORIGINS were seen: retired instead of cleaned. */
  tooManyOrigins: boolean;
}

interface Waiter {
  resolve: (ctx: BrowserContext) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

/** Why acquire() failed: `timeout`, `queue-full` or `closed`. */
export class BrowserPoolError extends Error {
  readonly code = 'BROWSER_POOL_UNAVAILABLE' as const;

  constructor(
    readonly reason: 'timeout' | 'queue-full' | 'closed',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserPoolError';
  }
}

export interface BrowserPoolOptions {
  /** Default wait for a context in acquire(); env BROWSER_ACQUIRE_TIMEOUT_MS, else 30 s. */
  acquireTimeoutMs?: number;
  /** Callers allowed to wait at once; beyond it acquire() fails fast. Env BROWSER_POOL_MAX_WAITERS, else 100. */
  maxWaiters?: number;
  /** Chromium binary; env PLAYWRIGHT_CHROMIUM_EXECUTABLE, else the browser patchright bundles. */
  executablePath?: string;
  /** Launcher override (tests). */
  launch?: (options: LaunchOptions) => Promise<Browser>;
  /** Proxy Chromium connects through; default the worker's egress guard (net/egress.ts). */
  egressProxy?: () => Promise<string>;
  logger?: Pick<Console, 'log' | 'warn'>;
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_WAITERS = 100;
const CLEAN_TIMEOUT_MS = 5_000;
// Beyond this many origins in one use, a context is replaced rather than
// cleaned origin by origin.
const MAX_TRACKED_ORIGINS = 200;

function hasServiceWorkers(context: BrowserContext): boolean {
  try {
    return context.serviceWorkers().length > 0;
  } catch {
    return false;
  }
}

/**
 * Record the origin of every request the context makes (its pages, popups,
 * frames, workers): any of them may have stored something.
 */
function trackOrigins(pooled: PooledContext): void {
  // Test doubles have no event API; a real context always has one.
  if (typeof pooled.context.on !== 'function') return;
  pooled.context.on('request', (request: Request) => {
    const url = request.url();
    // Other schemes have no storage of their own (data:) or share their
    // creator's origin, which is tracked already (blob:, about:).
    if (!url.startsWith('http:') && !url.startsWith('https:')) return;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }
    if (pooled.origins.has(origin)) return;
    if (pooled.origins.size >= MAX_TRACKED_ORIGINS) pooled.tooManyOrigins = true;
    else pooled.origins.add(origin);
  });
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * A fixed set of browser contexts shared by the browser tiers.
 *
 * - A slot is reserved before a context is created, so concurrent acquire()
 *   calls never create more than `maxContexts`.
 * - acquire() waits at most `timeoutMs` and at most `maxWaiters` callers wait
 *   at once; both fail with a BrowserPoolError instead of hanging.
 * - Contexts are recycled after `maxUsesPerContext` uses or `maxAgeMs`, also
 *   when they expire while idle, and as soon as a page left a service worker
 *   behind. Before a context is reused, pages left open are closed and its
 *   cookies and the storage of every origin it loaded are cleared; one that
 *   cannot be cleaned is replaced.
 * - If Chromium dies, the next acquire() relaunches it.
 * - Chromium connects only through the egress guard, which applies the
 *   outbound policy to every connection it makes (see browser/outbound-guard.ts).
 */
export class BrowserPool {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private contexts: PooledContext[] = [];
  private waitQueue: Waiter[] = [];
  /** Slots reserved for contexts being created. */
  private creating = 0;
  private closed = false;
  private readonly acquireTimeoutMs: number;
  private readonly maxWaiters: number;
  private readonly executablePath: string | undefined;
  private readonly launcher: (options: LaunchOptions) => Promise<Browser>;
  private readonly egressProxy: () => Promise<string>;
  private readonly logger: Pick<Console, 'log' | 'warn'>;

  constructor(
    private maxContexts: number = 5,
    private maxUsesPerContext: number = 100,
    private maxAgeMs: number = 30 * 60 * 1000,
    options: BrowserPoolOptions = {},
  ) {
    if (!Number.isInteger(maxContexts) || maxContexts < 1) {
      throw new RangeError(`maxContexts must be a positive integer, got ${maxContexts}`);
    }
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? envInt('BROWSER_ACQUIRE_TIMEOUT_MS', DEFAULT_ACQUIRE_TIMEOUT_MS);
    this.maxWaiters = options.maxWaiters ?? envInt('BROWSER_POOL_MAX_WAITERS', DEFAULT_MAX_WAITERS);
    this.executablePath = options.executablePath ?? (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined);
    this.launcher = options.launch ?? ((o) => chromium.launch(o));
    this.egressProxy = options.egressProxy ?? egressProxyUrl;
    this.logger = options.logger ?? console;
  }

  async initialize(): Promise<void> {
    this.closed = false;
    try {
      await this.ensureBrowser();
      const warmCount = Math.max(0, Math.min(3, this.maxContexts) - this.contexts.length - this.creating);
      for (let i = 0; i < warmCount; i++) {
        this.creating++;
        try {
          this.contexts.push(await this.createContext());
        } finally {
          this.creating--;
        }
      }
      this.logger.log(`Browser pool initialized with ${warmCount} contexts (max: ${this.maxContexts})`);
    } catch (err) {
      // Never leave a Chromium process behind a failed start.
      await this.shutdown().catch(() => {});
      this.closed = false;
      throw err;
    }
  }

  /**
   * A context for exclusive use until release(). Waits at most `timeoutMs`
   * (default from the constructor options) for one to free up.
   */
  async acquire(timeoutMs: number = this.acquireTimeoutMs): Promise<BrowserContext> {
    if (this.closed) throw new BrowserPoolError('closed', 'Browser pool is shut down');
    this.recycleExpiredIdle();

    const idle = this.contexts.find((c) => !c.inUse && !c.cleaning);
    if (idle) return this.checkOut(idle);

    if (this.contexts.length + this.creating < this.maxContexts) {
      // Reserve the slot before the first await.
      this.creating++;
      let pooled: PooledContext;
      try {
        pooled = await this.createContext();
      } catch (err) {
        this.creating--;
        // Callers that queued behind this reservation can use the slot.
        this.replenish();
        throw err;
      }
      this.creating--;
      if (this.closed) {
        await pooled.context.close().catch(() => {});
        throw new BrowserPoolError('closed', 'Browser pool is shut down');
      }
      this.contexts.push(pooled);
      return this.checkOut(pooled);
    }

    if (this.waitQueue.length >= this.maxWaiters) {
      throw new BrowserPoolError(
        'queue-full',
        `Browser pool saturated: ${this.maxContexts} contexts busy and ${this.waitQueue.length} requests waiting`,
      );
    }
    return new Promise<BrowserContext>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
        waiter.timer = setTimeout(() => {
          const i = this.waitQueue.indexOf(waiter);
          if (i >= 0) this.waitQueue.splice(i, 1);
          reject(
            new BrowserPoolError('timeout', `Timed out after ${timeoutMs} ms waiting for a browser context`),
          );
        }, timeoutMs);
      }
      this.waitQueue.push(waiter);
    });
  }

  release(context: BrowserContext): void {
    const pooled = this.contexts.find((c) => c.context === context);
    // Unknown, or released twice: handing it out again would share it.
    if (!pooled || !pooled.inUse) return;
    pooled.inUse = false;

    if (this.closed) return;
    if (this.isExpired(pooled) || hasServiceWorkers(context)) {
      // A service worker would keep answering the next fetch of its site
      // (possibly another customer's) from its own cache.
      this.retire(pooled);
      return;
    }

    if (pooled.tooManyOrigins) {
      this.retire(pooled);
      return;
    }

    // Nothing one fetch stored may reach the next (possibly another
    // customer's) fetch of the same site, so the context is not handed out
    // until it is clean.
    pooled.cleaning = true;
    let timer: NodeJS.Timeout | undefined;
    Promise.race([
      this.clean(pooled),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('cleaning timed out')), CLEAN_TIMEOUT_MS);
      }),
    ])
      .catch(() => {
        // A context that cannot be cleaned is not reused.
        pooled.useCount = this.maxUsesPerContext;
      })
      .finally(() => {
        clearTimeout(timer);
        pooled.cleaning = false;
        if (this.closed) return;
        if (this.isExpired(pooled)) this.retire(pooled);
        else this.handOff(pooled);
      });
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waitQueue.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new BrowserPoolError('closed', 'Browser pool is shut down'));
    }
    const contexts = this.contexts.splice(0);
    await Promise.all(contexts.map((p) => p.context.close().catch(() => {})));
    const browser = this.browser ?? (await this.launching?.catch(() => null)) ?? null;
    this.browser = null;
    this.launching = null;
    await browser?.close().catch(() => {});
  }

  stats() {
    return {
      total: this.contexts.length,
      inUse: this.contexts.filter((c) => c.inUse).length,
      idle: this.contexts.filter((c) => !c.inUse && !c.cleaning).length,
      creating: this.creating,
      waiting: this.waitQueue.length,
    };
  }

  // ── internals ─────────────────────────────────────────

  private checkOut(pooled: PooledContext): BrowserContext {
    pooled.inUse = true;
    pooled.useCount++;
    return pooled.context;
  }

  private isExpired(pooled: PooledContext): boolean {
    return (
      pooled.useCount >= this.maxUsesPerContext ||
      Date.now() - pooled.createdAt > this.maxAgeMs
    );
  }

  /** Give `pooled` (idle, clean) to the oldest waiter, if any. */
  private handOff(pooled: PooledContext): void {
    const next = this.waitQueue.shift();
    if (!next) return;
    clearTimeout(next.timer);
    next.resolve(this.checkOut(pooled));
  }

  /** Expired contexts that sit idle hold slots; free them for fresh ones. */
  private recycleExpiredIdle(): void {
    for (const pooled of [...this.contexts]) {
      if (!pooled.inUse && !pooled.cleaning && this.isExpired(pooled)) this.retire(pooled);
    }
  }

  /** Close `pooled` and free its slot. Never throws: this runs from release(). */
  private retire(pooled: PooledContext): void {
    const index = this.contexts.indexOf(pooled);
    if (index > -1) this.contexts.splice(index, 1);
    void pooled.context.close().catch(() => {});
    this.replenish();
  }

  /**
   * While someone waits and a slot is free, create a context for them. If
   * creation fails (Chromium cannot start), the oldest waiter gets the error
   * rather than waiting out its timeout.
   */
  private replenish(): void {
    while (
      !this.closed &&
      this.waitQueue.length > this.creating &&
      this.contexts.length + this.creating < this.maxContexts
    ) {
      this.creating++;
      this.createContext().then(
        (fresh) => {
          this.creating--;
          if (this.closed) {
            void fresh.context.close().catch(() => {});
            return;
          }
          this.contexts.push(fresh);
          this.handOff(fresh);
        },
        (err: unknown) => {
          this.creating--;
          this.logger.warn(`[browser-pool] creating a context failed: ${(err as Error)?.message ?? String(err)}`);
          const waiter = this.waitQueue.shift();
          if (waiter) {
            clearTimeout(waiter.timer);
            waiter.reject(err instanceof Error ? err : new Error(String(err)));
          }
          this.replenish();
        },
      );
    }
  }

  private async createContext(): Promise<PooledContext> {
    const browser = await this.ensureBrowser();
    const fp = generateFingerprint();
    const context = await browser.newContext(toContextOptions(fp));
    const pooled: PooledContext = {
      context,
      useCount: 0,
      createdAt: Date.now(),
      inUse: false,
      cleaning: false,
      origins: new Set(),
      tooManyOrigins: false,
    };
    trackOrigins(pooled);
    return pooled;
  }

  /**
   * Remove what a fetch could leave for the next one: pages still open
   * (popups, which could write again after cleaning), cookies, and the
   * origin storage (localStorage, IndexedDB, Cache Storage, service worker
   * registrations, ...) of every origin the context requested anything
   * from. Partitioned storage of third-party frames is cleared with its
   * origin. sessionStorage ends with its page. The context's HTTP cache too:
   * a response cached while serving one tenant (personalized by its headers
   * or cookies) must not be served to the next. Throws if any step fails.
   */
  private async clean(pooled: PooledContext): Promise<void> {
    const { context } = pooled;
    // Test doubles have no pages.
    const leftovers = typeof context.pages === 'function' ? context.pages() : [];
    await Promise.all(leftovers.map((page) => page.close()));
    await context.clearCookies();
    const origins = [...pooled.origins];
    if (origins.length === 0) return;
    // CDP Storage and Network commands act on the page's browser context only.
    const page = await context.newPage();
    try {
      const cdp = await context.newCDPSession(page);
      await Promise.all(
        origins.map((origin) => cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })),
      );
      // Not an origin storage type. Test doubles' sessions (no event API,
      // which a real CDP session always has) implement only the Storage command.
      if (typeof (cdp as { on?: unknown }).on === 'function') await cdp.send('Network.clearBrowserCache');
      await cdp.detach().catch(() => {});
    } finally {
      await page.close().catch(() => {});
    }
    for (const origin of origins) pooled.origins.delete(origin);
  }

  /** The running browser, launching (or relaunching after a crash) as needed. */
  private ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return Promise.resolve(this.browser);
    if (this.launching) return this.launching;
    if (this.closed) return Promise.reject(new BrowserPoolError('closed', 'Browser pool is shut down'));

    const launching = this.egressProxy().then((proxyServer) =>
      this.launcher({
        headless: true,
        ...(this.executablePath ? { executablePath: this.executablePath } : {}),
        args: [
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-software-rasterizer',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          // Every connection (redirect hops, WebSockets, workers, popups)
          // goes through the egress guard, which refuses blocked addresses
          // when it connects. "<-loopback>" removes Chromium's implicit
          // loopback bypass, so the guard decides for loopback too.
          `--proxy-server=${proxyServer}`,
          '--proxy-bypass-list=<-loopback>',
          // WebRTC would otherwise send UDP (STUN/TURN) around the proxy.
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        ],
      }),
    ).then((browser) => {
      if (this.browser && this.browser !== browser) this.dropContexts();
      this.browser = browser;
      browser.on('disconnected', () => {
        if (this.browser !== browser) return;
        this.logger.warn('[browser-pool] Chromium disconnected; it will be relaunched on next use');
        this.browser = null;
        this.dropContexts();
      });
      return browser;
    });
    this.launching = launching;
    const clear = () => {
      if (this.launching === launching) this.launching = null;
    };
    launching.then(clear, clear);
    return launching;
  }

  /** Forget contexts of a dead browser. Ones in use are dropped when released. */
  private dropContexts(): void {
    this.contexts = this.contexts.filter((c) => c.inUse);
    for (const c of this.contexts) c.useCount = this.maxUsesPerContext;
    this.replenish();
  }
}
