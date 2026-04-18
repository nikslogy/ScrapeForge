import { chromium, Browser, BrowserContext } from 'patchright';
import { generateFingerprint, toContextOptions } from './fingerprint.js';

interface PooledContext {
  context: BrowserContext;
  useCount: number;
  createdAt: number;
  inUse: boolean;
}

export class BrowserPool {
  private browser: Browser | null = null;
  private contexts: PooledContext[] = [];
  private waitQueue: Array<(ctx: BrowserContext) => void> = [];

  constructor(
    private maxContexts: number = 5,
    private maxUsesPerContext: number = 100,
    private maxAgeMs: number = 30 * 60 * 1000,
  ) {}

  async initialize(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-software-rasterizer',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });

    const warmCount = Math.min(3, this.maxContexts);
    for (let i = 0; i < warmCount; i++) {
      await this.createContext();
    }
    console.log(`Browser pool initialized with ${warmCount} contexts (max: ${this.maxContexts})`);
  }

  async acquire(): Promise<BrowserContext> {
    const idle = this.contexts.find(c => !c.inUse && !this.isExpired(c));
    if (idle) {
      idle.inUse = true;
      idle.useCount++;
      return idle.context;
    }

    if (this.contexts.length < this.maxContexts) {
      const pooled = await this.createContext();
      pooled.inUse = true;
      pooled.useCount++;
      return pooled.context;
    }

    return new Promise((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(context: BrowserContext): void {
    const pooled = this.contexts.find(c => c.context === context);
    if (!pooled) return;

    pooled.inUse = false;

    if (this.isExpired(pooled)) {
      this.recycleContext(pooled);
      return;
    }

    context.clearCookies().catch(() => {});

    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      pooled.inUse = true;
      pooled.useCount++;
      next(pooled.context);
    }
  }

  private isExpired(pooled: PooledContext): boolean {
    return (
      pooled.useCount >= this.maxUsesPerContext ||
      Date.now() - pooled.createdAt > this.maxAgeMs
    );
  }

  private async createContext(): Promise<PooledContext> {
    if (!this.browser) throw new Error('Browser not initialized');

    const fp = generateFingerprint();
    const context = await this.browser.newContext(toContextOptions(fp));

    const pooled: PooledContext = {
      context,
      useCount: 0,
      createdAt: Date.now(),
      inUse: false,
    };
    this.contexts.push(pooled);
    return pooled;
  }

  private async recycleContext(pooled: PooledContext): Promise<void> {
    const index = this.contexts.indexOf(pooled);
    if (index > -1) this.contexts.splice(index, 1);
    await pooled.context.close().catch(() => {});

    const fresh = await this.createContext();

    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      fresh.inUse = true;
      fresh.useCount++;
      next(fresh.context);
    }
  }

  async shutdown(): Promise<void> {
    for (const pooled of this.contexts) {
      await pooled.context.close().catch(() => {});
    }
    await this.browser?.close();
    this.contexts = [];
    this.waitQueue = [];
  }

  stats() {
    return {
      total: this.contexts.length,
      inUse: this.contexts.filter(c => c.inUse).length,
      idle: this.contexts.filter(c => !c.inUse).length,
      waiting: this.waitQueue.length,
    };
  }
}
