// A pooled context is reused by the next fetch (possibly another customer's):
// nothing fetch A stored may be visible to fetch B (finding
// pool-storage-leak-across-fetches). Real Chromium behind the egress guard;
// skipped when none is installed. The page is served from 127.0.0.1 (a
// secure context, so Cache Storage exists); its iframe from widget.test, a
// different site (partitioned storage) that resolves to 127.0.0.1 in the
// test policy only, so it is reachable only through the guard.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserContext } from 'patchright';
import { setOutboundPolicyForTests } from '@scrapeforge/shared';
import { BrowserPool } from '../../src/browser/pool.js';
import { tier4Fetch } from '../../src/engine/tier4-browser.js';
import { findChromium } from '../../../../tests/latency/lib/chromium-path.js';
import { PUBLIC_IP, html, routes, startServer, useFixturePolicy, type FixtureServer } from './fixtures.js';

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || findChromium() || undefined;

const SECRET = 'TENANT-A-SECRET';

// Writes (or reads) every kind of origin storage, then replaces "Loading"
// (which holds the readiness wait) with the result.
const storageScript = (mode: 'write' | 'read', widgetOrigin: string) => `
<script>
  const mode = ${JSON.stringify(mode)};
  const secret = new URLSearchParams(location.search).get('secret') || '';
  const out = {};
  function idb(write) {
    return new Promise((resolve) => {
      const open = indexedDB.open('tenant', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        const tx = open.result.transaction('kv', write ? 'readwrite' : 'readonly');
        const store = tx.objectStore('kv');
        if (write) { store.put(secret, 'session'); tx.oncomplete = () => resolve('ok'); }
        else { const get = store.get('session'); get.onsuccess = () => resolve(get.result ?? null); get.onerror = () => resolve(null); }
      };
    });
  }
  async function cache(write) {
    const c = await caches.open('tenant');
    if (write) { await c.put('/cached-session', new Response(secret)); return 'ok'; }
    const hit = await c.match('/cached-session');
    return hit ? await hit.text() : null;
  }
  const widget = new Promise((resolve) => {
    addEventListener('message', (e) => resolve(e.data));
    setTimeout(() => resolve('no-answer'), 1500);
  });
  (async () => {
    try {
    if (mode === 'write') {
      localStorage.setItem('session', secret);
      sessionStorage.setItem('session', secret);
      document.cookie = 'session=' + secret + '; path=/';
    }
    out.local = localStorage.getItem('session');
    out.sessionStorage = sessionStorage.getItem('session');
    out.cookie = document.cookie;
    out.idb = await idb(mode === 'write');
    out.cache = await cache(mode === 'write');
    out.widget = await widget;
    } catch (e) { out.error = String(e); }
    document.getElementById('result').textContent = 'RESULT ' + JSON.stringify(out);
  })();
</script>
<iframe src="${widgetOrigin}/widget?mode=${mode}${mode === 'write' ? `&secret=${SECRET}` : ''}"></iframe>`;

describe.skipIf(!chromiumPath)('pooled context reuse', () => {
  let app: FixtureServer;
  let widget: FixtureServer;
  let pool: BrowserPool;

  beforeAll(async () => {
    widget = await startServer(
      PUBLIC_IP,
      routes({
        // Third-party iframe: its storage is partitioned under app.test.
        '/widget': html(`<script>
          const q = new URLSearchParams(location.search);
          if (q.get('mode') === 'write') localStorage.setItem('widget', q.get('secret'));
          parent.postMessage('widget:' + localStorage.getItem('widget'), '*');
        </script>`),
      }),
    );
    const widgetOrigin = `http://widget.test:${widget.port}`;
    app = await startServer(
      PUBLIC_IP,
      routes({
        '/write': html(`<html><body><p id="result">Loading</p>${storageScript('write', widgetOrigin)}</body></html>`),
        '/read': html(`<html><body><p id="result">Loading</p>${storageScript('read', widgetOrigin)}</body></html>`),
      }),
    );
    pool = new BrowserPool(1, 100, 30 * 60 * 1000, { executablePath: chromiumPath, logger: { log() {}, warn() {} } });
  }, 30_000);

  afterAll(async () => {
    await pool?.shutdown();
    await Promise.all([app?.close(), widget?.close()]);
  });

  beforeEach(() => {
    useFixturePolicy(async (host) => {
      if (host === 'widget.test') return [PUBLIC_IP];
      throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    });
  });
  afterEach(() => setOutboundPolicyForTests(null));

  async function fetchWith(url: string): Promise<{ html: string; context: BrowserContext }> {
    const context = await pool.acquire();
    try {
      const r = await tier4Fetch(url, context, { readyTimeoutMs: 5_000 });
      return { html: r.html, context };
    } finally {
      pool.release(context);
    }
  }

  function result(page: string): Record<string, unknown> {
    const match = /RESULT (\{.*?\})<\/p>/.exec(page);
    if (!match) throw new Error(`no result in page: ${page.slice(0, 300)}`);
    return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  }

  it("does not let fetch B see anything fetch A stored in the same context", async () => {
    const a = await fetchWith(`${app.origin}/write?secret=${SECRET}`);
    // Fetch A really stored everything.
    expect(result(a.html)).toEqual({
      local: SECRET,
      sessionStorage: SECRET,
      cookie: `session=${SECRET}`,
      idb: 'ok',
      cache: 'ok',
      widget: `widget:${SECRET}`,
    });

    const b = await fetchWith(`${app.origin}/read`);
    expect(b.context).toBe(a.context); // reused, not replaced
    expect(result(b.html)).toEqual({
      local: null,
      sessionStorage: null,
      cookie: '',
      idb: null,
      cache: null,
      widget: 'widget:null',
    });
    expect(b.html).not.toContain(SECRET);
  });

  it('closes pages a fetch left open (popups) before the next fetch', async () => {
    const context = await pool.acquire();
    const leftover = await context.newPage();
    pool.release(context);
    const again = await pool.acquire();
    try {
      expect(again).toBe(context);
      expect(leftover.isClosed()).toBe(true);
      expect(again.pages()).toEqual([]);
    } finally {
      pool.release(again);
    }
  });
});
