/**
 * Unit tests for the MCP root allowlist — the server's filesystem perimeter.
 *
 * The integration side of the lock (validateDirectory ordering, the transport
 * gate, telemetry, federation withholding) lives in security.test.ts and
 * mcp.http.integration.test.ts; this file pins the primitive itself.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureRootAllowlist,
  assertRootAllowed,
  isRootAllowed,
  isRootAllowlistConfigured,
  getRootAllowlist,
  toolAccessMode,
  WRITING_TOOLS,
  _resetRootAllowlistForTesting,
} from './root-allowlist.js';

const mkroot = (tag: string): string => realpathSync(mkdtempSync(join(tmpdir(), `ol-allow-${tag}-`)));

let allowed: string;
let outside: string;

beforeEach(() => {
  allowed = mkroot('in');
  outside = mkroot('out');
});

afterEach(() => {
  _resetRootAllowlistForTesting();
  rmSync(allowed, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('root allowlist — configuration', () => {
  it('is inert until configured: any directory passes through resolved', () => {
    expect(isRootAllowlistConfigured()).toBe(false);
    expect(getRootAllowlist()).toBeNull();
    // This is the CLI/library boundary: `openlore federation add /elsewhere` must keep working.
    expect(assertRootAllowed(outside, 'write')).toBe(outside);
  });

  it('fails loudly at start on a root that does not exist', () => {
    expect(() => configureRootAllowlist({
      readRoots: [join(allowed, 'nope')], writeRoots: [],
    })).toThrow(/не существует/);
  });

  it('fails loudly at start on a root that is a file, not a directory', () => {
    const f = join(allowed, 'file.txt');
    writeFileSync(f, 'x', 'utf-8');
    expect(() => configureRootAllowlist({ readRoots: [f], writeRoots: [] })).toThrow(/не каталог/);
  });

  it('fails loudly when a write root is not a subset of the read roots', () => {
    expect(() => configureRootAllowlist({
      readRoots: [allowed], writeRoots: [outside],
    })).toThrow(/подмножеством корней чтения/);
  });

  it('accepts a write root nested inside a read root', () => {
    const nested = join(allowed, 'sub');
    mkdirSync(nested, { recursive: true });
    expect(() => configureRootAllowlist({ readRoots: [allowed], writeRoots: [nested] })).not.toThrow();
    expect(getRootAllowlist()?.writeRoots).toEqual([realpathSync(nested)]);
  });

  it('rejects an empty read-root list — a server with no root can serve nothing', () => {
    expect(() => configureRootAllowlist({ readRoots: [], writeRoots: [] })).toThrow(/пуст/);
  });
});

describe('root allowlist — read confinement', () => {
  beforeEach(() => configureRootAllowlist({ readRoots: [allowed], writeRoots: [allowed] }));

  it('allows the root itself and anything under it', () => {
    const nested = join(allowed, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(assertRootAllowed(allowed)).toBe(allowed);
    expect(assertRootAllowed(nested)).toBe(nested);
  });

  it('refuses a foreign absolute path with a message that names the boundary and the roots', () => {
    let msg = '';
    try { assertRootAllowed(outside); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/Root allowlist/);
    expect(msg).toMatch(/deliberate boundary/i);
    expect(msg).toContain(allowed);            // the agent is told where it CAN work
    expect(msg).not.toMatch(/exists|not found|ENOENT/i);   // …and nothing about the path it asked for
  });

  it('refuses a sibling whose name merely starts with the root path (prefix, not containment)', () => {
    const sibling = `${allowed}-evil`;
    mkdirSync(sibling, { recursive: true });
    try {
      expect(() => assertRootAllowed(sibling)).toThrow(/Root allowlist/);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('refuses a ../ traversal that lands outside the root', () => {
    expect(() => assertRootAllowed(join(allowed, '..', '..', 'etc'))).toThrow(/Root allowlist/);
  });

  it('refuses an in-root symlink that points outside the root (realpath, not lexical)', () => {
    const link = join(allowed, 'escape');
    symlinkSync(outside, link);
    // Lexically `link` is inside `allowed`; only its real path betrays the escape.
    expect(() => assertRootAllowed(link)).toThrow(/Root allowlist/);
  });

  it('allows an in-root symlink that points back inside the same root', () => {
    const real = join(allowed, 'real');
    mkdirSync(real, { recursive: true });
    const link = join(allowed, 'inner');
    symlinkSync(real, link);
    expect(assertRootAllowed(link)).toBe(link);
  });

  it('judges a not-yet-existing path by its nearest existing ancestor, without disclosing existence', () => {
    // Inside the root: allowed here, refused later by stat for the honest reason.
    expect(assertRootAllowed(join(allowed, 'ghost'))).toBe(join(allowed, 'ghost'));
    // Outside: refused by the perimeter — the caller learns nothing about existence.
    expect(() => assertRootAllowed(join(outside, 'ghost'))).toThrow(/Root allowlist/);
  });

  it('serves several roots at once', () => {
    const second = mkroot('in2');
    try {
      configureRootAllowlist({ readRoots: [allowed, second], writeRoots: [allowed, second] });
      expect(assertRootAllowed(allowed)).toBe(allowed);
      expect(assertRootAllowed(second)).toBe(second);
      expect(() => assertRootAllowed(outside)).toThrow(/Root allowlist/);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('returns the lexically resolved path, not the realpath (callers keep the value they had)', () => {
    const real = join(allowed, 'real');
    mkdirSync(real, { recursive: true });
    const link = join(allowed, 'alias');
    symlinkSync(real, link);
    expect(assertRootAllowed(link)).toBe(link);
    expect(assertRootAllowed(link)).not.toBe(real);
  });
});

describe('root allowlist — write confinement', () => {
  it('refuses a write into a root that is readable but not writable', () => {
    const readOnly = mkroot('ro');
    try {
      configureRootAllowlist({ readRoots: [allowed, readOnly], writeRoots: [allowed] });
      expect(assertRootAllowed(readOnly, 'read')).toBe(readOnly);
      let msg = '';
      try { assertRootAllowed(readOnly, 'write'); } catch (e) { msg = (e as Error).message; }
      expect(msg).toMatch(/readable but not writable/);
      expect(msg).toMatch(/Root allowlist/);
    } finally {
      rmSync(readOnly, { recursive: true, force: true });
    }
  });

  it('isRootAllowed is the non-throwing twin', () => {
    configureRootAllowlist({ readRoots: [allowed], writeRoots: [] });
    expect(isRootAllowed(allowed, 'read')).toBe(true);
    expect(isRootAllowed(allowed, 'write')).toBe(false);
    expect(isRootAllowed(outside, 'read')).toBe(false);
  });
});

describe('root allowlist — writer classification', () => {
  it('every tool that can touch disk is classified write, everything else read', () => {
    for (const w of WRITING_TOOLS) expect(toolAccessMode(w), w).toBe('write');
    for (const r of ['orient', 'search_code', 'get_subgraph', 'federation_status', 'recall']) {
      expect(toolAccessMode(r), r).toBe('read');
    }
  });

  it('carries the two names the fork\'s own mutator gate had gone stale on', () => {
    expect(WRITING_TOOLS.has('analyze_codebase')).toBe(true);
    expect(WRITING_TOOLS.has('change_impact_certificate')).toBe(true);
  });
});
