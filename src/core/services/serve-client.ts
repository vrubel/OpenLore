/**
 * serve-client — discover, spawn, and call the `openlore serve` daemon.
 *
 * Lets in-process callers (notably the stdio MCP server) delegate tool dispatch
 * to a shared warm daemon instead of running it locally. Delegation means a
 * single process holds the warm caches and runs ONE watcher for a repo, so two
 * agents (Pi + Claude Code, or Claude Code + Cline) don't each spin a watcher
 * racing to write the same .openlore/analysis.
 *
 * Every call degrades gracefully: if no daemon can be reached or spawned, the
 * caller falls back to in-process dispatch.
 */

import { spawn } from 'node:child_process';

/** Subset of the daemon's serve.json we need to reach it. */
interface ServeDescriptor {
  port: number;
  pid: number;
  host: string;
  token?: string;
}

/** A resolved, reachable daemon. */
export interface ServeEndpoint {
  baseUrl: string;
  token?: string;
}

const SPAWN_HEALTH_TIMEOUT_MS = 8000;
const HEALTH_POLL_MS = 150;
// Per-probe timeout for the reuse check. Generous so a cold Node HTTP server on
// Windows isn't misread as dead — a false negative spawns a second daemon and
// orphans the first (orphans pile up in RAM). Matches serve.ts / the Pi extension.
const HEALTH_PROBE_TIMEOUT_MS = 2500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));


/**
 * CLI args to spawn the daemon. Exported + asserted in tests because the daemon
 * MUST accept exactly these — `serve` has only `--no-watch` (watch is the
 * default), so passing a non-existent `--watch` flag makes commander reject and
 * the daemon never starts. Keep this in lockstep with serve.ts's options.
 */
export function serveSpawnArgs(directory: string): string[] {
  return ['serve', '--directory', directory];
}

/**
 * Read `<dir>/.openlore/serve.json` — an UNTRUSTED on-disk artifact. It sits inside
 * a repository the agent can write, and the very next thing that happens to it is a
 * `fetch` at the host:port it names. Parsed without validation, that is an outbound
 * request to any address the agent chooses (metadata service, internal network,
 * port scanning by true/false), and on `ok:true` every tool call is then routed
 * through it.
 *
 * `serve.ts` already had the fail-closed reader — every field type-checked and the
 * host confined to loopback. This one JSON.parse'd and cast. Two readers of one
 * untrusted format, one of them careless, is how the careless one gets forgotten:
 * reuse the strict one.
 *
 * NOT A PERIMETER LAYER — do not count it as one. Under a configured allowlist this
 * function is unreachable from the MCP server: `resolveDaemon` and
 * `maybeStartWatcher` both refuse before reading any descriptor, and
 * `applyRootAllowlist` runs unconditionally on both transports, so the guard above
 * always fires first (confirmed with a canary: zero calls). What this hardening
 * protects is the CLI path — `openlore serve --stop`, the Pi extension — where no
 * allowlist exists. Describing it as defence for the MCP perimeter would be
 * describing a decoration, and a decoration outlives the removal of whatever was
 * actually holding the line.
 */
async function readDescriptor(directory: string): Promise<ServeDescriptor | null> {
  const { readDescriptor: readValidated } = await import('../../cli/commands/serve.js');
  return readValidated(directory);
}

/** True when a descriptor points at a LIVE daemon (ok:true /health), not a stale
 * file or a recycled port owned by an unrelated server. */
async function healthy(desc: ServeDescriptor): Promise<boolean> {
  try {
    const res = await fetch(`http://${desc.host}:${desc.port}/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

function endpointOf(desc: ServeDescriptor): ServeEndpoint {
  return { baseUrl: `http://${desc.host}:${desc.port}`, token: desc.token };
}

/**
 * Resolve a live daemon for `directory`: reuse an announced healthy one, else
 * (when `spawn` is true) start `openlore serve` detached and poll until
 * /health is ready. Returns null if none could be brought up — callers then run
 * in-process. Never kills a daemon; it may serve other clients.
 */
export async function ensureServeDaemon(
  directory: string,
  opts: { spawn?: boolean } = {},
): Promise<ServeEndpoint | null> {
  const existing = await readDescriptor(directory);
  if (existing && (await healthy(existing))) return endpointOf(existing);

  if (opts.spawn === false) return null;

  // Spawn via the same CLI entry that's running us (works installed or in dev).
  const cli = process.argv[1];
  if (!cli) return null;
  try {
    const child = spawn(
      process.execPath,
      [cli, ...serveSpawnArgs(directory)],
      { cwd: directory, stdio: 'ignore', detached: true, windowsHide: true },
    );
    child.on('error', () => {}); // swallow — caller falls back to in-process
    child.unref();
  } catch {
    return null;
  }

  const deadline = Date.now() + SPAWN_HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(HEALTH_POLL_MS);
    const desc = await readDescriptor(directory);
    if (desc && (await healthy(desc))) return endpointOf(desc);
  }
  return null;
}

/**
 * Call a tool on the daemon. Throws on transport failure so the caller can fall
 * back to in-process dispatch; a tool-level error is returned in the body (the
 * handler's own `{ error }`), not thrown.
 */
export async function callServeTool(
  ep: ServeEndpoint,
  name: string,
  args: Record<string, unknown>,
  directory: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ep.token) headers['x-openlore-token'] = ep.token;
  const res = await fetch(`${ep.baseUrl}/tool/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ directory, args }),
    signal,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // 404 = unknown tool, etc. Surface as a thrown error → caller falls back.
    const msg = (body as { error?: string } | null)?.error ?? `daemon HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}
