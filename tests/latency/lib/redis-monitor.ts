// Counts the Redis commands a piece of work issues, via MONITOR. MONITOR
// slows Redis down, so it is only used on short dedicated runs whose timings
// are thrown away; the latency runs never have a monitor attached.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Redis } from 'ioredis';
import { sleep } from './runner.js';

export interface MonitorEntry {
  args: readonly string[];
  /** "ip:port" for client commands, "lua" for commands run inside a script. */
  source: string;
}

export interface CommandCounts {
  /** Commands clients sent: each is one network round trip. */
  client: Record<string, number>;
  /** Commands executed inside Lua scripts (no extra round trip). */
  lua: Record<string, number>;
  clientTotal: number;
  luaTotal: number;
}

export interface ScriptNames {
  /** SHA1 of the script text → name (EVALSHA). */
  bySha: Map<string, string>;
  /** Normalised start of the script text → name (EVAL). */
  byPrefix: Map<string, string>;
}

const PREFIX_CHARS = 300;

/**
 * MONITOR prints arguments with C-style escapes (\n, \", \\, \xHH), so
 * EVAL script text arrives escaped and cannot be hashed as is.
 */
export function unescapeMonitorArg(text: string): string {
  const named: Record<string, string> = { n: '\n', r: '\r', t: '\t', a: '\x07', b: '\b' };
  return text.replace(/\\(x[0-9a-fA-F]{2}|[\s\S])/g, (_, c: string) =>
    c.length === 3 ? String.fromCharCode(parseInt(c.slice(1), 16)) : (named[c] ?? c),
  );
}

/**
 * Comparison key for a script's text: whitespace-free prefix. BullMQ scripts
 * each open with their own description comment, so a prefix tells them apart.
 */
export function scriptKey(text: string): string {
  return text.replace(/\s+/g, '').slice(0, PREFIX_CHARS);
}

/**
 * Names of BullMQ's Lua scripts, so EVALSHA/EVAL calls can be told apart
 * (ioredis sends EVALSHA with the SHA1 of the script text, or EVAL with the
 * text itself). Reads a BullMQ internal module; returns empty maps if its
 * layout ever changes, which only makes the counts less specific.
 */
export function bullmqScriptNames(): ScriptNames {
  const names: ScriptNames = { bySha: new Map(), byPrefix: new Map() };
  try {
    const require = createRequire(import.meta.url);
    const scripts = require('bullmq/dist/cjs/scripts/index.js') as Record<string, { name?: unknown; content?: unknown }>;
    for (const script of Object.values(scripts)) {
      if (typeof script?.name !== 'string' || typeof script.content !== 'string') continue;
      names.bySha.set(createHash('sha1').update(script.content).digest('hex'), script.name);
      names.byPrefix.set(scriptKey(script.content), script.name);
    }
  } catch {
    // Unlabelled EVALSHA counts are still correct, just less specific.
  }
  return names;
}

function commandName(args: readonly string[], scripts: ScriptNames): string {
  const name = String(args[0]).toLowerCase();
  if (name !== 'evalsha' && name !== 'eval') return name;
  const arg = String(args[1] ?? '');
  const script = name === 'evalsha' ? scripts.bySha.get(arg) : scripts.byPrefix.get(scriptKey(unescapeMonitorArg(arg)));
  return script ? `${name} ${script}` : name;
}

export function tallyCommands(
  entries: readonly MonitorEntry[],
  scriptNames: ScriptNames = { bySha: new Map(), byPrefix: new Map() },
): CommandCounts {
  const counts: CommandCounts = { client: {}, lua: {}, clientTotal: 0, luaTotal: 0 };
  for (const { args, source } of entries) {
    if (args.length === 0) continue;
    const name = commandName(args, scriptNames);
    if (source === 'lua') {
      counts.lua[name] = (counts.lua[name] ?? 0) + 1;
      counts.luaTotal++;
    } else {
      counts.client[name] = (counts.client[name] ?? 0) + 1;
      counts.clientTotal++;
    }
  }
  return counts;
}

/** Divides every count by `units` (e.g. jobs), rounded to 2 decimals, sorted descending. */
export function perUnit(counts: CommandCounts, units: number): CommandCounts {
  if (!(units > 0)) throw new RangeError(`units must be > 0, got ${units}`);
  const scale = (rec: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(rec)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, Math.round((v / units) * 100) / 100]),
    );
  return {
    client: scale(counts.client),
    lua: scale(counts.lua),
    clientTotal: Math.round((counts.clientTotal / units) * 100) / 100,
    luaTotal: Math.round((counts.luaTotal / units) * 100) / 100,
  };
}

/** Runs `fn` with a MONITOR attached and returns what Redis executed meanwhile. */
export async function withCommandLog<T>(port: number, fn: () => Promise<T>): Promise<{ result: T; entries: MonitorEntry[] }> {
  const client = new Redis(port, '127.0.0.1', { maxRetriesPerRequest: null });
  const monitor = await client.monitor();
  const entries: MonitorEntry[] = [];
  monitor.on('monitor', (_time: string, args: string[], source: string) => {
    entries.push({ args, source });
  });
  try {
    const result = await fn();
    // MONITOR lines trail the replies the work already received.
    await sleep(200);
    return { result, entries };
  } finally {
    monitor.disconnect();
    client.disconnect();
  }
}
