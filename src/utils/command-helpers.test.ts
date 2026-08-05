/**
 * Tests for command-helpers utilities:
 *   - fileExists
 *   - formatDuration
 *   - formatAge
 *   - parseList
 *   - readJsonFile
 *   - resolvePathArg / displayPathArg
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { formatDuration, formatAge, parseList, resolvePathArg, displayPathArg } from './command-helpers.js';

// ============================================================================
// resolvePathArg / displayPathArg — where --output actually lands, and what we say
// ============================================================================

describe('resolvePathArg', () => {
  const root = join(sep, 'repo');

  it('counts a relative path from the repository root', () => {
    expect(resolvePathArg(root, '.openlore/analysis/')).toBe(join(root, '.openlore', 'analysis'));
    expect(resolvePathArg(root, 'my-analysis')).toBe(join(root, 'my-analysis'));
  });

  it('uses an absolute path exactly as given — the whole point of the fix', () => {
    // join() would have produced /repo/tmp/out here: artifacts landing in a stray
    // directory INSIDE the analyzed tree while the CLI reported success over the
    // empty /tmp/out the operator was watching.
    const abs = join(sep, 'tmp', 'out');
    expect(resolvePathArg(root, abs)).toBe(abs);
    expect(resolvePathArg(root, abs).startsWith(root)).toBe(false);
  });

  it('resolves .. relative to the root rather than gluing it on', () => {
    expect(resolvePathArg(join(sep, 'repo', 'sub'), '../out')).toBe(join(sep, 'repo', 'out'));
  });
});

describe('displayPathArg', () => {
  const root = join(sep, 'repo');

  it('stays relative while the target is inside the repository', () => {
    const inside = join(root, '.openlore', 'analysis');
    expect(displayPathArg(root, inside)).toBe(`.openlore${sep}analysis${sep}`);
  });

  it('shows the absolute path once the target leaves the repository', () => {
    const outside = join(sep, 'tmp', 'out');
    expect(displayPathArg(root, outside)).toBe(`${outside}${sep}`);
  });

  it('always ends with a separator so `${display}file.json` is a path', () => {
    // Without this, `--output /tmp/out` printed /tmp/outllm-context.json.
    expect(displayPathArg(root, join(sep, 'tmp', 'out'))).toMatch(/[\\/]$/);
    expect(displayPathArg(root, join(root, 'x') + sep)).toBe(`x${sep}`);
  });
});

// ============================================================================
// formatDuration
// ============================================================================

describe('formatDuration', () => {
  it('formats milliseconds when < 1000ms', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(1)).toBe('1ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('formats seconds when 1000ms ≤ ms < 60s', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(59999)).toBe('60.0s');
  });

  it('formats minutes and seconds when ≥ 60s', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3_600_000)).toBe('60m 0s');
  });
});

// ============================================================================
// formatAge
// ============================================================================

describe('formatAge', () => {
  it('returns "just now" when < 1 minute', () => {
    expect(formatAge(0)).toBe('just now');
    expect(formatAge(30_000)).toBe('just now');
    expect(formatAge(59_999)).toBe('just now');
  });

  it('returns minutes when 1 min ≤ age < 1 hour', () => {
    expect(formatAge(60_000)).toBe('1 minutes ago');
    expect(formatAge(300_000)).toBe('5 minutes ago');
    expect(formatAge(3_599_999)).toBe('59 minutes ago');
  });

  it('returns hours when 1 hour ≤ age < 1 day', () => {
    expect(formatAge(3_600_000)).toBe('1 hours ago');
    expect(formatAge(7_200_000)).toBe('2 hours ago');
    expect(formatAge(86_399_999)).toBe('23 hours ago');
  });

  it('returns days when ≥ 1 day', () => {
    expect(formatAge(86_400_000)).toBe('1 days ago');
    expect(formatAge(172_800_000)).toBe('2 days ago');
  });
});

// ============================================================================
// parseList
// ============================================================================

describe('parseList', () => {
  it('splits by comma and trims whitespace', () => {
    expect(parseList('auth, billing, api')).toEqual(['auth', 'billing', 'api']);
  });

  it('handles no spaces', () => {
    expect(parseList('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('filters out empty strings from double commas', () => {
    expect(parseList('a,,b')).toEqual(['a', 'b']);
  });

  it('returns single-element array for no commas', () => {
    expect(parseList('auth')).toEqual(['auth']);
  });

  it('returns empty array for empty string', () => {
    expect(parseList('')).toEqual([]);
  });

  it('trims leading/trailing whitespace from each item', () => {
    expect(parseList('  foo  ,  bar  ')).toEqual(['foo', 'bar']);
  });
});

// ============================================================================
// fileExists + readJsonFile — use a real temp dir
// ============================================================================

describe('fileExists', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cmd-helpers-test-'));
  });

  it('returns true for existing file', async () => {
    const p = join(tmpDir, 'x.txt');
    await writeFile(p, 'hi', 'utf-8');
    const { fileExists } = await import('./command-helpers.js');
    expect(await fileExists(p)).toBe(true);
  });

  it('returns false for non-existent path', async () => {
    const { fileExists } = await import('./command-helpers.js');
    expect(await fileExists(join(tmpDir, 'nope.txt'))).toBe(false);
  });

  it('returns true for existing directory', async () => {
    const { fileExists } = await import('./command-helpers.js');
    expect(await fileExists(tmpDir)).toBe(true);
  });
});

describe('readJsonFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cmd-helpers-json-test-'));
  });

  it('returns null when file does not exist', async () => {
    const { readJsonFile } = await import('./command-helpers.js');
    const result = await readJsonFile(join(tmpDir, 'missing.json'), 'missing.json');
    expect(result).toBeNull();
  });

  it('returns parsed object when file is valid JSON', async () => {
    const data = { foo: 'bar', count: 42 };
    const p = join(tmpDir, 'data.json');
    await writeFile(p, JSON.stringify(data), 'utf-8');
    const { readJsonFile } = await import('./command-helpers.js');
    const result = await readJsonFile<typeof data>(p, 'data.json');
    expect(result).toEqual(data);
  });

  it('throws descriptive error when JSON is malformed', async () => {
    const p = join(tmpDir, 'bad.json');
    await writeFile(p, 'not-json{{', 'utf-8');
    const { readJsonFile } = await import('./command-helpers.js');
    await expect(readJsonFile(p, 'bad.json')).rejects.toThrow('bad.json');
  });

  it('throws descriptive error mentioning corruption', async () => {
    const p = join(tmpDir, 'corrupt.json');
    await writeFile(p, '{broken', 'utf-8');
    const { readJsonFile } = await import('./command-helpers.js');
    await expect(readJsonFile(p, 'corrupt.json')).rejects.toThrow('corrupted');
  });

  it('rethrows non-ENOENT file errors', async () => {
    const { readJsonFile } = await import('./command-helpers.js');
    // Pass a path that is a directory — readFile on a directory throws EISDIR, not ENOENT
    await expect(readJsonFile(tmpDir, 'dir')).rejects.toThrow();
  });

  it('returns typed data (generic T preserved)', async () => {
    interface Typed { name: string; value: number }
    const data: Typed = { name: 'test', value: 99 };
    const p = join(tmpDir, 'typed.json');
    await writeFile(p, JSON.stringify(data), 'utf-8');
    const { readJsonFile } = await import('./command-helpers.js');
    const result = await readJsonFile<Typed>(p, 'typed.json');
    expect(result?.name).toBe('test');
    expect(result?.value).toBe(99);
  });
});
