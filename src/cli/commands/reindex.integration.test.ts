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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpWatcher } from '../../core/services/mcp-watcher.js';
import { EdgeStore } from '../../core/services/edge-store.js';
import { getChangedFiles } from '../../core/drift/git-diff.js';
import { splitDelta } from './reindex.js';

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
