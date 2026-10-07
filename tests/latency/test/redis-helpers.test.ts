import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findChromium } from '../lib/chromium-path.js';
import { ensureRedis, parseInfo, pingRedis } from '../lib/redis-instance.js';
import { bullmqScriptNames, perUnit, scriptKey, tallyCommands, unescapeMonitorArg } from '../lib/redis-monitor.js';

describe('tallyCommands', () => {
  it('separates client round trips from commands run inside Lua', () => {
    const counts = tallyCommands([
      { args: ['GET', 'k'], source: '127.0.0.1:5000' },
      { args: ['get', 'k'], source: '127.0.0.1:5001' },
      { args: ['HSET', 'h', 'f', 'v'], source: 'lua' },
      { args: [], source: '127.0.0.1:5000' },
    ]);
    expect(counts.client).toEqual({ get: 2 });
    expect(counts.lua).toEqual({ hset: 1 });
    expect(counts.clientTotal).toBe(2);
    expect(counts.luaTotal).toBe(1);
  });

  it('labels EVALSHA by hash and EVAL by (MONITOR-escaped) script text', () => {
    const script = '--[[\n  Does a thing "quoted"\n]]\nreturn 1';
    const sha = createHash('sha1').update(script).digest('hex');
    const names = { bySha: new Map([[sha, 'myScript']]), byPrefix: new Map([[scriptKey(script), 'myScript']]) };
    // How MONITOR prints that same text: newlines and quotes escaped.
    const monitored = script.replace(/\n/g, '\\n').replace(/"/g, '\\"');
    const counts = tallyCommands(
      [
        { args: ['evalsha', sha, '0'], source: 'c' },
        { args: ['EVAL', monitored, '0'], source: 'c' },
        { args: ['eval', 'return 2', '0'], source: 'c' },
        { args: ['evalsha', 'f'.repeat(40), '0'], source: 'c' },
        { args: ['evalsha'], source: 'c' },
      ],
      names,
    );
    expect(counts.client).toEqual({ 'evalsha myScript': 1, 'eval myScript': 1, eval: 1, evalsha: 2 });
  });

  it('undoes MONITOR escaping, including escaped backslashes and hex bytes', () => {
    expect(unescapeMonitorArg('a\\nb\\t\\"c\\"')).toBe('a\nb\t"c"');
    // An escaped backslash followed by n is a literal backslash-n, not a newline.
    expect(unescapeMonitorArg('x\\\\ny')).toBe('x\\ny');
    expect(unescapeMonitorArg('\\x41\\x7a')).toBe('Az');
    expect(unescapeMonitorArg('trailing\\')).toBe('trailing\\');
  });

  it('keys scripts by a bounded whitespace-free prefix', () => {
    expect(scriptKey(' a \n b\t c ')).toBe('abc');
    expect(scriptKey('x'.repeat(10_000))).toHaveLength(300);
  });
});

describe('perUnit', () => {
  it('divides, rounds to 2 decimals and sorts by count', () => {
    const per = perUnit({ client: { a: 1, b: 9 }, lua: { c: 3 }, clientTotal: 10, luaTotal: 3 }, 3);
    expect(Object.keys(per.client)).toEqual(['b', 'a']);
    expect(per.client).toEqual({ b: 3, a: 0.33 });
    expect(per.clientTotal).toBe(3.33);
    expect(per.luaTotal).toBe(1);
  });

  it('rejects a non-positive divisor', () => {
    const empty = { client: {}, lua: {}, clientTotal: 0, luaTotal: 0 };
    expect(() => perUnit(empty, 0)).toThrow(RangeError);
    expect(() => perUnit(empty, Number.NaN)).toThrow(RangeError);
  });
});

describe('bullmqScriptNames', () => {
  it('maps the installed BullMQ scripts by SHA1', () => {
    const { bySha, byPrefix } = bullmqScriptNames();
    const names = new Set(bySha.values());
    expect(new Set(byPrefix.values())).toEqual(names);
    for (const expected of ['addPrioritizedJob', 'addStandardJob', 'moveToActive', 'moveToFinished', 'isFinished', 'updateProgress']) {
      expect(names.has(expected)).toBe(true);
    }
  });
});

describe('parseInfo', () => {
  it('parses INFO output and skips section headers and blanks', () => {
    const info = parseInfo('# Server\r\nredis_version:7.0.15\r\n\r\nused_memory:123\r\nweird_line\r\nk:v:w\r\n');
    expect(info).toEqual({ redis_version: '7.0.15', used_memory: '123', k: 'v:w' });
  });
});

describe('redis instance helpers', () => {
  it('reports a closed port as not answering', async () => {
    // Port 1 (tcpmux) is never a Redis; the connection is refused locally.
    expect(await pingRedis(1)).toBe(false);
  });

  it('gives up on a listener that accepts but never answers', async () => {
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;
    try {
      const t0 = performance.now();
      expect(await pingRedis(port, 300)).toBe(false);
      expect(performance.now() - t0).toBeLessThan(2000);
    } finally {
      silent.close();
    }
  });

  it('validates the port before touching anything', async () => {
    await expect(ensureRedis(0)).rejects.toThrow(RangeError);
    await expect(ensureRedis(70_000)).rejects.toThrow(RangeError);
    await expect(ensureRedis(1.5)).rejects.toThrow(RangeError);
  });
});

describe('findChromium', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'latency-chromium-'));
  const fakeChrome = (rev: string) => {
    mkdirSync(join(dir, `chromium-${rev}`, 'chrome-linux'), { recursive: true });
    writeFileSync(join(dir, `chromium-${rev}`, 'chrome-linux', 'chrome'), '');
  };
  fakeChrome('900');
  fakeChrome('1200');
  fakeChrome('99'); // numerically lowest, lexically highest
  mkdirSync(join(dir, 'chromium-5000')); // no binary inside
  mkdirSync(join(dir, 'chromium_headless_shell-9999', 'chrome-linux'), { recursive: true });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('picks the newest revision that has a binary', () => {
    expect(findChromium({ PLAYWRIGHT_BROWSERS_PATH: dir }, [])).toBe(join(dir, 'chromium-1200', 'chrome-linux', 'chrome'));
  });

  it('prefers an explicit path, but only if it exists', () => {
    const explicit = join(dir, 'chromium-900', 'chrome-linux', 'chrome');
    expect(findChromium({ LATENCY_CHROMIUM_PATH: explicit, PLAYWRIGHT_BROWSERS_PATH: dir }, [])).toBe(explicit);
    expect(findChromium({ LATENCY_CHROMIUM_PATH: join(dir, 'nope'), PLAYWRIGHT_BROWSERS_PATH: dir }, [])).toBeNull();
  });

  it('returns null when no root has a browser', () => {
    expect(findChromium({}, [join(dir, 'does-not-exist')])).toBeNull();
  });
});
