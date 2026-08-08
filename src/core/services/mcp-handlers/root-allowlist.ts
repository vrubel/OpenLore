/**
 * Root allowlist — the MCP server's filesystem perimeter.
 *
 * An openlore MCP server is always started FOR something: one repository, or a
 * declared set of them. Nothing in the protocol said so, though — every one of
 * the 62 tools takes a `directory` argument, and the only check it ever met was
 * "does this resolve to an existing directory". A server raised for repo A
 * therefore answered, in full, about repo B, about `/etc`, about any absolute
 * path the agent cared to name. The perimeter was held by the agent not knowing
 * the neighbours' paths — and openlore itself hands those out (federation
 * registry), so it was not held at all.
 *
 * This module is the boundary. Roots are declared once at server start
 * (`--root` / `--write-root`, defaulting to the process working directory) and
 * every `directory` is measured against them BEFORE anything touches the disk.
 *
 * Three properties are deliberate:
 *
 *   • CLOSED BY DEFAULT. No flags ⇒ the single root is `process.cwd()`, which
 *     is how PDLC (and every editor integration) already starts the server.
 *     Widening is an explicit act by the operator.
 *
 *   • CONFINEMENT IS DECIDED ON THE REAL PATH. A candidate is inside a root when
 *     its `realpath` is the root's `realpath` or lies under it. A symlink placed
 *     inside an allowed root and pointing out of it is an escape, and a lexical
 *     `resolve()` comparison would wave it through. What is RETURNED, however, is
 *     the lexically resolved path — the value every caller already had — so
 *     confinement gains a check without changing any path downstream.
 *
 *   • UNCONFIGURED MEANS NO PERIMETER, ON PURPOSE. The allowlist is a property of
 *     the MCP SERVER, not of the handler library. CLI commands import the same
 *     handlers and legitimately act on paths outside the working directory —
 *     `openlore federation add /elsewhere/repo` is exactly that, and PDLC calls it
 *     when it registers a product's repository set. A CLI process never configures
 *     the allowlist, so it is never confined by it. Only `openlore mcp` configures.
 */

import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export type RootAccessMode = 'read' | 'write';

export interface RootAllowlist {
  /** Canonical (realpath'd) roots this server may read. */
  readRoots: string[];
  /** Canonical (realpath'd) roots this server may write. Always ⊆ readRoots. */
  writeRoots: string[];
}

let _state: RootAllowlist | null = null;

/**
 * Tools that can write to the target directory, named EXPLICITLY rather than
 * derived from the MCP annotation table.
 *
 * The annotations are a hint published to clients, and they have already been
 * wrong: `change_impact_certificate` shipped as read-only while carrying a
 * `persist` parameter that writes a file, and the fork's own mutator gate listed
 * eight names while ten tools wrote. A perimeter that reads its rules from a
 * table that drifts is not a perimeter. This list is the rule; a test asserts the
 * annotation table agrees with it in BOTH directions, so the next divergence
 * fails CI instead of quietly opening a hole.
 *
 * `generate_tests` (default `dryRun: true`) and `change_impact_certificate`
 * (writes only with `persist: true`) are classified as writers UNCONDITIONALLY:
 * whether the call writes is decided by an argument the caller controls, and a
 * boundary must not depend on the caller's honesty about its own intent.
 */
export const WRITING_TOOLS: ReadonlySet<string> = new Set([
  'analyze_codebase',
  'annotate_story',
  'approve_decision',
  'change_impact_certificate',
  'generate_change_proposal',
  'generate_tests',
  'record_decision',
  'reject_decision',
  'remember',
  'sync_decisions',
]);

/** The access a tool needs on its `directory` argument. */
export function toolAccessMode(tool: string): RootAccessMode {
  return WRITING_TOOLS.has(tool) ? 'write' : 'read';
}

/**
 * The canonical path of `p`, or — when `p` does not exist — the canonical path of
 * its nearest existing ancestor. A path that does not exist still has to be
 * judged, and it must be judged WITHOUT the caller learning whether it exists:
 * the ancestor decides, and a non-existent path inside an allowed root passes the
 * perimeter (to be refused later, by `stat`, for the honest reason).
 */
function canonical(p: string): string {
  let cur = resolve(p);
  for (;;) {
    try {
      return realpathSync(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return cur;
      const parent = dirname(cur);
      if (parent === cur) return cur; // filesystem root
      cur = parent;
    }
  }
}

/** True when `candidate` (already canonical) is `root` or lies inside it. */
function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;               // different drive/volume
  return rel.split(/[\\/]/)[0] !== '..';           // not an escape upwards
}

function withinAny(candidate: string, roots: string[]): boolean {
  return roots.some(root => isWithin(candidate, root));
}

/**
 * Containment by the SAME rule the perimeter uses (canonical on both sides), but
 * usable BEFORE `configureRootAllowlist`: the caller has to decide the DEFAULT write
 * root ("is my cwd inside the roots I am about to declare?") at a moment when the
 * allowlist does not exist yet. Kept here so there is exactly one definition of
 * "inside a root" — a second, subtly different one over in the CLI is how perimeters rot.
 */
export function isPathWithinRoots(candidate: string, roots: string[]): boolean {
  return withinAny(canonical(candidate), roots.map(canonical));
}

/**
 * Declare the perimeter. Called ONCE, at MCP server start, before any request is
 * served. Fails loudly rather than degrading: a root that does not exist, or a
 * write root outside every read root, is an operator mistake that must surface at
 * launch — not on the first tool call, half an hour into a run.
 */
export function configureRootAllowlist(config: { readRoots: string[]; writeRoots: string[] }): void {
  const readRoots = canonicalizeRoots(config.readRoots, '--root');
  if (readRoots.length === 0) {
    throw new Error('openlore mcp: список корней чтения пуст — сервер без единого корня не может обслужить ни один вызов.');
  }
  const writeRoots = canonicalizeRoots(config.writeRoots, '--write-root');
  for (const w of writeRoots) {
    if (!withinAny(w, readRoots)) {
      throw new Error(
        `openlore mcp --write-root ${w}: корень записи обязан быть подмножеством корней чтения, ` +
        `а он не лежит ни в одном из них (${readRoots.join(', ')}). ` +
        'Добавьте его в --root или уберите из --write-root.'
      );
    }
  }
  _state = { readRoots, writeRoots };
}

function canonicalizeRoots(roots: string[], flag: string): string[] {
  const out: string[] = [];
  for (const raw of roots) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error(`openlore mcp ${flag}: пустое значение — укажите путь к каталогу.`);
    }
    const abs = resolve(raw.trim());
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new Error(`openlore mcp ${flag} ${abs}: каталог не существует. Лучше упасть на старте, чем на первом вызове агента.`);
    }
    if (!st.isDirectory()) {
      throw new Error(`openlore mcp ${flag} ${abs}: это не каталог.`);
    }
    const real = realpathSync(abs);
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/** The configured perimeter, or null when this process never declared one. */
export function getRootAllowlist(): RootAllowlist | null {
  return _state;
}

/** True when a perimeter has been declared in this process (i.e. we are an MCP server). */
export function isRootAllowlistConfigured(): boolean {
  return _state !== null;
}

/** Test-only: drop the perimeter so the next test can declare its own. */
export function _resetRootAllowlistForTesting(): void {
  _state = null;
}

/**
 * The refusal an agent reads. It has to do three things at once: make clear this
 * is a BOUNDARY and not a malfunction (so the agent stops retrying), say what IS
 * reachable (so it can carry on doing useful work instead of probing), and reveal
 * nothing about the path it asked for — in particular not whether it exists.
 */
function denialMessage(requested: string, mode: RootAccessMode, state: RootAllowlist): string {
  const verb = mode === 'write' ? 'write to' : 'read';
  const scoped = mode === 'write' && withinAny(canonical(requested), state.readRoots);
  return [
    `Root allowlist: this openlore MCP server may not ${verb} "${requested}".`,
    scoped
      ? 'That location is readable but not writable by this server.'
      : 'That location is outside every root this server was started for.',
    'This is a deliberate boundary, not a transient failure. The server serves a fixed set of ' +
      'repositories for the duration of this run; no retry, and no variation of the path, will widen it.',
    `Readable roots: ${state.readRoots.join(', ') || '(none)'}`,
    `Writable roots: ${state.writeRoots.join(', ') || '(none)'}`,
    `Use a "directory" inside ${mode === 'write' ? 'a writable' : 'a readable'} root. If you genuinely need ` +
      'another repository, that is an operator decision — the server must be restarted with it declared.',
  ].join('\n');
}

/**
 * Gate a caller-supplied `directory`. Returns the resolved absolute path (the same
 * value callers had before this check existed) or throws a refusal.
 *
 * Order matters at every call site: this runs BEFORE `stat`, before telemetry,
 * before daemon resolution, before spawning git. Anything that touches the path
 * first turns the refusal into an oracle — "Directory not found" versus "Not a
 * directory" versus a perimeter refusal tells the agent what exists out there.
 */
export function assertRootAllowed(directory: string, mode: RootAccessMode = 'read'): string {
  if (!directory || typeof directory !== 'string') {
    throw new Error('directory parameter is required and must be a string');
  }
  const abs = resolve(directory);
  const state = _state;
  if (!state) return abs;                       // not an MCP server — no perimeter (see file header)
  const cand = canonical(abs);
  if (!withinAny(cand, state.readRoots)) throw new Error(denialMessage(abs, 'read', state));
  if (mode === 'write' && !withinAny(cand, state.writeRoots)) {
    throw new Error(denialMessage(abs, 'write', state));
  }
  return abs;
}

/**
 * Non-throwing form, for the places that must WITHHOLD rather than refuse:
 * enumerating responses (the federation registry) must not hand out the addresses
 * of repositories the caller would be refused on — otherwise the refusal above
 * merely turns a listing into a probing exercise.
 */
export function isRootAllowed(directory: string, mode: RootAccessMode = 'read'): boolean {
  try {
    assertRootAllowed(directory, mode);
    return true;
  } catch {
    return false;
  }
}
