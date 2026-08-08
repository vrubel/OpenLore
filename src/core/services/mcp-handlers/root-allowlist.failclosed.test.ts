/**
 * The perimeter must FAIL CLOSED on a path it cannot canonicalize.
 *
 * Its own file because the case can only be reached by making `realpathSync` fail
 * with something other than ENOENT, and ESM will not let a named export be spied on
 * in place — the module has to be mocked before the subject imports it.
 *
 * Why it matters: on Windows `realpathSync` returns EPERM/EACCES/EBUSY/EINVAL for
 * junctions and locked entries that every subsequent call then handles perfectly
 * well. The first version answered those by falling back to the LEXICAL path and
 * judging it as if it were canonical — an escape out of the root on exactly the
 * platform where junctions are ordinary. A boundary may not guess.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const state: { failOn: string | null } = { failOn: null };

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const patched = (p: unknown, ...rest: unknown[]): unknown => {
    if (state.failOn !== null && String(p) === state.failOn) {
      throw Object.assign(new Error('EPERM: operation not permitted, realpath'), { code: 'EPERM' });
    }
    return (actual.realpathSync as unknown as (...a: unknown[]) => unknown)(p, ...rest);
  };
  (patched as unknown as { native: unknown }).native = actual.realpathSync.native;
  return { ...actual, realpathSync: patched };
});

const { mkdtempSync, mkdirSync, rmSync, realpathSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const {
  configureRootAllowlist, assertRootAllowed, isRootAllowed, _resetRootAllowlistForTesting,
} = await import('./root-allowlist.js');

let root: string;
let probe: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ol-failclosed-')));
  probe = join(root, 'junction-like');
  mkdirSync(probe, { recursive: true });
  configureRootAllowlist({ readRoots: [root], writeRoots: [root] });
});
afterEach(() => {
  state.failOn = null;
  _resetRootAllowlistForTesting();
  rmSync(root, { recursive: true, force: true });
});

describe('root allowlist — fail closed on an uncanonicalizable path', () => {
  it('refuses instead of falling back to the lexical path', () => {
    // Sanity: with realpath working, this path is plainly inside the root.
    expect(assertRootAllowed(probe)).toBe(probe);

    state.failOn = probe;
    expect(() => assertRootAllowed(probe)).toThrow(/cannot verify where/);
    expect(() => assertRootAllowed(probe)).toThrow(/deliberate boundary/);
    expect(isRootAllowed(probe, 'read')).toBe(false);
    expect(isRootAllowed(probe, 'write')).toBe(false);
  });
});
