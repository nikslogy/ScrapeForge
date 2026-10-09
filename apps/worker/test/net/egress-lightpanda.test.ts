// Tier 3 (Lightpanda) runs pages in another process, where neither the egress
// guard nor the route guard sees their sub-requests (finding
// lightpanda-no-subrequest-guard). It stays off unless the operator asserts
// LIGHTPANDA_EGRESS_GUARDED=1. A local recorder stands in for Lightpanda:
// it only notes whether anything connected to it.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setOutboundPolicyForTests } from '@scrapeforge/shared';
import { PUBLIC_IP, html, startServer, useFixturePolicy, type FixtureServer } from './fixtures.js';

type Tier3 = typeof import('../../src/engine/tier3-light.js');

let site: FixtureServer;
let lightpanda: FixtureServer;
let connections = 0;
const saved = { ...process.env };

let resetFreshPolicy: (() => void) | undefined;

/** A fresh copy of the module, reading the environment as it is now. */
async function loadTier3(env: Record<string, string | undefined>): Promise<Tier3> {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  // The reset also reloads the shared package: give its copy the fixture policy.
  const shared = await import('@scrapeforge/shared');
  shared.setOutboundPolicyForTests({ isBlocked: (ip) => ip !== PUBLIC_IP && shared.isBlockedAddress(ip) });
  resetFreshPolicy = () => shared.setOutboundPolicyForTests(null);
  return import('../../src/engine/tier3-light.js');
}

beforeAll(async () => {
  site = await startServer(PUBLIC_IP, html('<p>PAGE</p>'));
  lightpanda = await startServer(PUBLIC_IP, (_req, res) => {
    connections++;
    res.writeHead(404).end();
  });
});

afterAll(async () => {
  await Promise.all([site?.close(), lightpanda?.close()]);
});

beforeEach(() => {
  useFixturePolicy();
  connections = 0;
  lightpanda.requests.length = 0;
});

afterEach(() => {
  process.env = { ...saved };
  setOutboundPolicyForTests(null);
  resetFreshPolicy?.();
  vi.restoreAllMocks();
});

describe('tier 3 (Lightpanda) egress gate', () => {
  it('is off by default (no LIGHTPANDA_URL)', async () => {
    const tier3 = await loadTier3({ LIGHTPANDA_URL: undefined, LIGHTPANDA_EGRESS_GUARDED: undefined });
    expect(tier3.isLightpandaConfigured()).toBe(false);
    await expect(tier3.tier3Fetch(`${site.origin}/`)).resolves.toBeNull();
  });

  it('refuses an instance the operator has not declared egress-guarded, without connecting to it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const endpoint = `http://${PUBLIC_IP}:${lightpanda.port}/?token=SECRET-TOKEN`;
    const tier3 = await loadTier3({ LIGHTPANDA_URL: endpoint, LIGHTPANDA_EGRESS_GUARDED: undefined });
    expect(tier3.isLightpandaConfigured()).toBe(false);
    await expect(tier3.tier3Fetch(`${site.origin}/`)).resolves.toBeNull();
    await expect(tier3.tier3Fetch(`${site.origin}/`)).resolves.toBeNull();
    expect(connections).toBe(0);
    expect(lightpanda.requests).toEqual([]);
    // Said once, and never with the endpoint (it can carry a token).
    const lines = warn.mock.calls.map((c) => c.map(String).join(' ')).filter((l) => l.includes('LIGHTPANDA'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('LIGHTPANDA_EGRESS_GUARDED');
    expect(lines.join('\n')).not.toContain('SECRET-TOKEN');

    for (const value of ['0', 'true', 'yes', '']) {
      const again = await loadTier3({ LIGHTPANDA_URL: endpoint, LIGHTPANDA_EGRESS_GUARDED: value });
      expect(again.isLightpandaConfigured(), value).toBe(false);
    }
  });

  it('uses the instance once the operator asserts LIGHTPANDA_EGRESS_GUARDED=1', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const endpoint = `http://${PUBLIC_IP}:${lightpanda.port}/?token=SECRET-TOKEN`;
    const tier3 = await loadTier3({ LIGHTPANDA_URL: endpoint, LIGHTPANDA_EGRESS_GUARDED: '1' });
    expect(tier3.isLightpandaConfigured()).toBe(true);
    // The recorder is no CDP endpoint: the attempt fails and tier 3 yields nothing.
    await expect(tier3.tier3Fetch(`${site.origin}/`, { timeout: 2_000 })).resolves.toBeNull();
    expect(connections).toBeGreaterThan(0);
    expect(warn.mock.calls.flat().map(String).join('\n')).not.toContain('SECRET-TOKEN');
  });
});
