/**
 * Integration test for `openlore reindex` — the real delta data path end-to-end
 * (minus the commander wrapper): a real git repo + real getChangedFiles →
 * splitDelta → McpWatcher.reindexDelta against a REAL EdgeStore (call-graph.db)
 * and a REAL llm-context.json. Proves a mixed changed+added+deleted delta lands
 * incrementally in both the signature lane and the call graph, without a full
 * `analyze --force` and without a live watcher.
 *
 * Deliberately NOT mocked: this exercises the actual incremental pipeline the
 * command drives. Only the heavy full-analyze pipeline is skipped by seeding a
 * minimal prior analysis (empty EdgeStore + seed signatures), which is exactly
 * the state reindex assumes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpWatcher } from '../../core/services/mcp-watcher.js';
import { EdgeStore } from '../../core/services/edge-store.js';
import { getChangedFiles } from '../../core/drift/git-diff.js';
import { fileExists } from '../../utils/command-helpers.js';
import { splitDelta, reindexCommand } from './reindex.js';

/** Seed a minimal prior analysis (committed source + context + empty graph). Returns the base commit. */
async function seedAnalyzed(entries: Array<{ path: string; names: string[] }>): Promise<string> {
  for (const e of entries) {
    await writeFile(join(root, e.path), `export function ${e.names[0]}() {}\n`, 'utf-8');
  }
  git(['add', '-A']);
  git(['commit', '-m', 'init']);
  await seedContext(entries);
  EdgeStore.open(EdgeStore.dbPath(analysisDir)).close();
  return git(['rev-parse', 'HEAD']);
}

/** Run the real reindex command action in-process against the temp repo. */
async function runReindexCmd(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  const prevCwd = process.cwd();
  const prevExit = process.exitCode;
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array): boolean => { out.push(String(c)); return true; });
  try {
    process.chdir(root);
    process.exitCode = 0;
    await reindexCommand.parseAsync(args, { from: 'user' });
    return { exitCode: process.exitCode ?? 0, stdout: out.join('') };
  } finally {
    spy.mockRestore();
    process.chdir(prevCwd);
    process.exitCode = prevExit; // don't leak the command's exit code to the runner
  }
}

let root: string;
let analysisDir: string;
let contextPath: string;

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();

async function seedContext(sigs: Array<{ path: string; names: string[] }>): Promise<void> {
  const signatures = sigs.map((s) => ({
    path: s.path,
    entries: s.names.map((name) => ({ name, signature: '', docstring: '', line: 1, kind: 'function' })),
  }));
  await writeFile(contextPath, JSON.stringify({ signatures, callGraph: null }, null, 2), 'utf-8');
}

async function onDiskSigPaths(): Promise<Map<string, string[]>> {
  const ctx = JSON.parse(await readFile(contextPath, 'utf-8')) as {
    signatures: Array<{ path: string; entries: Array<{ name: string }> }>;
  };
  return new Map(ctx.signatures.map((s) => [s.path, s.entries.map((e) => e.name)]));
}

const nodeNamesForFile = (file: string): string[] => {
  const store = EdgeStore.open(EdgeStore.dbPath(analysisDir));
  try {
    return store.getNodesForFile(file).map((n: { name: string }) => n.name).sort();
  } finally {
    store.close();
  }
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ol-reindex-'));
  analysisDir = join(root, '.openlore', 'analysis');
  contextPath = join(analysisDir, 'llm-context.json');
  await mkdir(analysisDir, { recursive: true });
  git(['init']);
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 't']);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('reindex — incremental delta lands in graph + signatures (real stores)', () => {
  it('a mixed delta (modify + add + delete) is applied incrementally from the git diff', async () => {
    // ── prior analysis state (seeded): a.ts[foo], b.ts[bar] ──
    await writeFile(join(root, 'a.ts'), 'export function foo() { return 1; }\n', 'utf-8');
    await writeFile(join(root, 'b.ts'), "import { foo } from './a.js';\nexport function bar() { return foo(); }\n", 'utf-8');
    git(['add', '-A']);
    git(['commit', '-m', 'init']);
    const base = git(['rev-parse', 'HEAD']);
    await seedContext([{ path: 'a.ts', names: ['foo'] }, { path: 'b.ts', names: ['bar'] }]);
    // Establish a real (empty) call graph so the graph lane runs.
    EdgeStore.open(EdgeStore.dbPath(analysisDir)).close();
    expect(EdgeStore.exists(analysisDir)).toBe(true);

    // ── the change: modify a.ts (+baz), add c.ts, delete b.ts ──
    await writeFile(join(root, 'a.ts'), 'export function foo() { return 1; }\nexport function baz() { return 2; }\n', 'utf-8');
    await writeFile(join(root, 'c.ts'), 'export function qux() { return 9; }\n', 'utf-8');
    await rm(join(root, 'b.ts'));
    git(['add', '-A']);
    git(['commit', '-m', 'change']);

    // ── command's delta detection: getChangedFiles → splitDelta ──
    const diff = await getChangedFiles({ rootPath: root, baseRef: base, includeUnstaged: true });
    const { changed, deleted } = splitDelta(diff.files, root);
    expect(changed.sort()).toEqual([join(root, 'a.ts'), join(root, 'c.ts')]);
    expect(deleted).toEqual([join(root, 'b.ts')]);

    // ── apply incrementally (headless, no watcher) ──
    const watcher = new McpWatcher({ rootPath: root, embed: false });
    const applied = await watcher.reindexDelta({ changed, deleted });
    expect(applied).toEqual({ changed: 2, deleted: 1 });

    // ── signatures reflect the delta ──
    const sigs = await onDiskSigPaths();
    expect(sigs.get('a.ts')).toEqual(expect.arrayContaining(['foo', 'baz'])); // modified: baz added
    expect(sigs.get('c.ts')).toEqual(['qux']);                                // added
    expect(sigs.has('b.ts')).toBe(false);                                     // deleted: dropped

    // ── call graph reflects the delta (nodes inserted for changed files) ──
    expect(nodeNamesForFile('a.ts')).toEqual(['baz', 'foo']);
    expect(nodeNamesForFile('c.ts')).toEqual(['qux']);
    expect(nodeNamesForFile('b.ts')).toEqual([]); // deleted file has no graph nodes
  });

  it('an empty delta is a no-op (reindexDelta reports zero, signatures unchanged)', async () => {
    await writeFile(join(root, 'a.ts'), 'export function foo() {}\n', 'utf-8');
    git(['add', '-A']);
    git(['commit', '-m', 'init']);
    const base = git(['rev-parse', 'HEAD']);
    await seedContext([{ path: 'a.ts', names: ['foo'] }]);
    EdgeStore.open(EdgeStore.dbPath(analysisDir)).close();

    const diff = await getChangedFiles({ rootPath: root, baseRef: base, includeUnstaged: true });
    const { changed, deleted } = splitDelta(diff.files, root);
    expect(changed).toEqual([]);
    expect(deleted).toEqual([]);

    const watcher = new McpWatcher({ rootPath: root, embed: false });
    const applied = await watcher.reindexDelta({ changed, deleted });
    expect(applied).toEqual({ changed: 0, deleted: 0 });
    expect((await onDiskSigPaths()).get('a.ts')).toEqual(['foo']);
  });
});

describe('reindex command — fail-loud edges + accurate counts', () => {
  it('refuses a base ref that does not resolve — exit 1, no marker written (no silent stale index)', async () => {
    await seedAnalyzed([{ path: 'a.ts', names: ['foo'] }]);
    const bogus = '0000000000000000000000000000000000000000'; // valid syntax, unreachable
    const { exitCode } = await runReindexCmd(['--since', bogus, '--no-embed']);
    expect(exitCode).toBe(1);
    // A refused run must NOT advance the marker (would skip the real delta forever).
    expect(await fileExists(join(analysisDir, 'reindex-state.json'))).toBe(false);
  });

  it('--json reports APPLIED counts — a non-source file git also changed is not counted', async () => {
    const base = await seedAnalyzed([{ path: 'a.ts', names: ['foo'] }]);
    // change one SOURCE file and one NON-source file
    await writeFile(join(root, 'a.ts'), 'export function foo() {}\nexport function baz() {}\n', 'utf-8');
    await writeFile(join(root, 'README.md'), '# docs\n', 'utf-8');
    git(['add', '-A']);
    git(['commit', '-m', 'change + docs']);

    const { exitCode, stdout } = await runReindexCmd(['--since', base, '--no-embed', '--json']);
    expect(exitCode).toBe(0);
    const line = stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('{'));
    const result = JSON.parse(line!) as { changed: number; deleted: number };
    expect(result.changed).toBe(1); // ONLY a.ts — README.md excluded (applied, not submitted)
    expect(result.deleted).toBe(0);
    // marker advanced on success
    expect(await fileExists(join(analysisDir, 'reindex-state.json'))).toBe(true);
  });
});
