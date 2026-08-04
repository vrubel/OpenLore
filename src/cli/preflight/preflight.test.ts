/**
 * End-to-end tests for `openlore preflight` against a real SQLite graph and
 * a real git repo fixture. We don't shell out to the CLI binary — we call
 * runPreflight() directly and assert on its return code + summary.
 *
 * Each test builds an isolated temp-dir fixture containing:
 *   - a minimal .git repo with one commit
 *   - a tiny call-graph.db with a couple of nodes
 *   - a fingerprint.json
 *
 * That's enough to exercise every code path without depending on the real
 * analyzer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runPreflight } from './index.js';
import { renderJson, renderHuman, renderGithubAnnotations, buildSummary } from './report.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// When this suite runs inside CI, GITHUB_ACTIONS=true makes runPreflight() write
// GitHub workflow-command annotations (::error::/::warning::) to stdout for the
// STALE fixtures below — GitHub then renders those as spurious annotations on a
// green job (spec 24, F2). Neutralize it for the whole file; the one test that
// verifies GHA rendering re-enables it locally and calls the *pure*
// renderGithubAnnotations(), which returns a string and writes nothing.
let savedGithubActions: string | undefined;
beforeEach(() => {
  savedGithubActions = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
});
afterEach(() => {
  if (savedGithubActions === undefined) delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS = savedGithubActions;
});

interface FixtureNode {
  id: string;
  name: string;
  file_path: string;
  fan_in: number;
  is_hub: 0 | 1;
}

async function makeGraphDb(dbPath: string, nodes: FixtureNode[]): Promise<void> {
  await mkdir(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        is_external INTEGER NOT NULL DEFAULT 0,
        is_hub INTEGER NOT NULL DEFAULT 0,
        fan_in INTEGER NOT NULL DEFAULT 0,
        fan_out INTEGER NOT NULL DEFAULT 0,
        -- The store holds the test side of the graph too since PDLC-156, and the
        -- preflight query filters it out; this fixture mirrors the real schema so
        -- the filter is exercised rather than crashing on a missing column.
        is_test INTEGER NOT NULL DEFAULT 0
      );
    `);
    const stmt = db.prepare(
      'INSERT INTO nodes (id, name, file_path, is_external, is_hub, fan_in) VALUES (?,?,?,?,?,?)'
    );
    for (const n of nodes) stmt.run(n.id, n.name, n.file_path, 0, n.is_hub, n.fan_in);
    // One test-side node in every fixture: preflight scores PRODUCTION surface, so
    // this must never show up in the graph stats it reports.
    db.prepare(
      'INSERT INTO nodes (id, name, file_path, is_external, is_hub, fan_in, is_test) VALUES (?,?,?,?,?,?,1)'
    ).run('tests/fixture.test.ts::spec', 'spec', 'tests/fixture.test.ts', 0, 0, 0);
  } finally {
    db.close();
  }
}

async function makeFingerprint(dir: string, isoTs: string): Promise<void> {
  await writeFile(
    join(dir, '.openlore', 'analysis', 'fingerprint.json'),
    JSON.stringify({ hash: 'fake', computedAt: isoTs, fileCount: 1 })
  );
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

async function makeGitRepo(dir: string): Promise<void> {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@test.test']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

async function commitAll(dir: string, message: string): Promise<void> {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

describe('openlore preflight', () => {
  let dir: string;
  const GRAPH_TS = '2025-01-01T00:00:00.000Z';
  const GRAPH_MS = Date.parse(GRAPH_TS);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-preflight-'));
    await makeGitRepo(dir);
    // One source file that exists in the graph.
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src/foo.ts'), 'export const foo = 1;\n');
    await commitAll(dir, 'initial');
    await makeGraphDb(join(dir, '.openlore', 'analysis', 'call-graph.db'), [
      { id: 'src/foo.ts::foo', name: 'foo', file_path: 'src/foo.ts', fan_in: 0, is_hub: 0 },
    ]);
    await makeFingerprint(dir, GRAPH_TS);
    // Set every file's mtime to BEFORE the graph build so "fresh" really is fresh.
    const before = (GRAPH_MS - 60_000) / 1000;
    await utimes(join(dir, 'src/foo.ts'), before, before);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC#1: freshly-analyzed clean repo exits 0 with FRESH', async () => {
    const { code, summary } = await runPreflight({ cwd: dir, json: true });
    expect(code).toBe(0);
    expect(summary?.status).toBe('FRESH');
  });

  it('AC#2: editing a source file produces STALE + lists the file', async () => {
    const after = (GRAPH_MS + 60_000) / 1000;
    await writeFile(join(dir, 'src/foo.ts'), 'export const foo = 2;\n');
    await utimes(join(dir, 'src/foo.ts'), after, after);
    const { code, summary } = await runPreflight({ cwd: dir, json: true });
    expect(code).toBe(1);
    expect(summary?.status).toBe('STALE');
    expect(summary?.changedFiles).toContain('src/foo.ts');
    expect(summary?.stalenessScore).toBeGreaterThan(0);
  });

  it('AC#4: --json produces the documented schema', async () => {
    const after = (GRAPH_MS + 60_000) / 1000;
    await writeFile(join(dir, 'src/foo.ts'), 'export const foo = 3;\n');
    await utimes(join(dir, 'src/foo.ts'), after, after);
    const { summary } = await runPreflight({ cwd: dir, json: true });
    expect(summary).toBeDefined();
    const parsed = JSON.parse(renderJson(summary!));
    // Documented schema keys:
    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('graph_built_at');
    expect(parsed).toHaveProperty('graph_commit');
    expect(parsed).toHaveProperty('working_commit');
    expect(parsed).toHaveProperty('changed_files');
    expect(parsed).toHaveProperty('staleness_score');
    expect(parsed).toHaveProperty('threshold');
    expect(parsed.status).toBe('STALE');
    expect(Array.isArray(parsed.changed_files)).toBe(true);
  });

  it('AC#5: --since <git-ref> uses git diff and works against the merge base', async () => {
    // Branch off, edit, commit.
    git(dir, ['checkout', '-q', '-b', 'feature']);
    await writeFile(join(dir, 'src/foo.ts'), 'export const foo = 99;\n');
    await commitAll(dir, 'feature change');
    const { code, summary } = await runPreflight({ cwd: dir, since: 'main', json: true });
    expect(code).toBe(1);
    expect(summary?.mechanism).toBe('git');
    expect(summary?.changedFiles).toContain('src/foo.ts');
  });

  it('exits 2 when no graph exists', async () => {
    await rm(join(dir, '.openlore', 'analysis', 'call-graph.db'));
    const { code } = await runPreflight({ cwd: dir, json: true });
    expect(code).toBe(2);
  });

  it('exits 2 when --since ref does not exist', async () => {
    const { code } = await runPreflight({ cwd: dir, since: 'no-such-ref', json: true });
    expect(code).toBe(2);
  });

  it('AC#6: example GitHub Actions workflow is syntactically valid YAML', async () => {
    const { parse } = await import('yaml');
    const { readFile: rf } = await import('node:fs/promises');
    const text = await rf(join(REPO_ROOT, 'examples/ci/openlore-preflight.yml'), 'utf8');
    const parsed = parse(text);
    expect(parsed).toBeTruthy();
    expect(parsed.name).toBe('OpenLore preflight');
    expect(parsed.on?.pull_request).toBeDefined();
    expect(parsed.jobs?.preflight?.steps).toBeDefined();
    // The GitLab example too.
    const gitlab = await rf(join(REPO_ROOT, 'examples/ci/openlore-preflight.gitlab.yml'), 'utf8');
    expect(parse(gitlab)).toBeTruthy();
  });

  it('renderHuman includes the standard banner and the status line', async () => {
    const after = (GRAPH_MS + 60_000) / 1000;
    await writeFile(join(dir, 'src/foo.ts'), 'changed\n');
    await utimes(join(dir, 'src/foo.ts'), after, after);
    const { summary } = await runPreflight({ cwd: dir, json: true });
    const human = renderHuman(summary!);
    expect(human).toContain('OpenLore preflight');
    expect(human).toContain('Status:');
    expect(human).toContain('Staleness:');
  });

  it('AC#3: --fix invokes analyzer, then re-check reports FRESH', async () => {
    const after = (GRAPH_MS + 60_000) / 1000;
    await writeFile(join(dir, 'src/foo.ts'), 'changed\n');
    await utimes(join(dir, 'src/foo.ts'), after, after);

    let analyzerCalls = 0;
    const fakeAnalyze = async (cwd: string): Promise<number> => {
      analyzerCalls++;
      expect(cwd).toBe(dir);
      // Real `analyze` rewrites fingerprint.json with a current timestamp;
      // simulate that side-effect only.
      await makeFingerprint(cwd, new Date().toISOString());
      return 0;
    };

    const res = await runPreflight({ cwd: dir, json: true, fix: true, analyzeFn: fakeAnalyze });
    expect(analyzerCalls).toBe(1);
    expect(res.code).toBe(0);
    expect(res.summary?.status).toBe('FRESH');
  });

  it('--fix exits 2 when the analyzer itself fails', async () => {
    const after = (GRAPH_MS + 60_000) / 1000;
    await writeFile(join(dir, 'src/foo.ts'), 'changed\n');
    await utimes(join(dir, 'src/foo.ts'), after, after);

    const failingAnalyze = async (): Promise<number> => 1;
    const res = await runPreflight({ cwd: dir, json: true, fix: true, analyzeFn: failingAnalyze });
    expect(res.code).toBe(2);
  });

  it('--max-staleness raises the threshold and lets a small change through', async () => {
    const after = (GRAPH_MS + 60_000) / 1000;
    await writeFile(join(dir, 'src/foo.ts'), 'changed\n');
    await utimes(join(dir, 'src/foo.ts'), after, after);

    // Default threshold 0 → STALE
    let res = await runPreflight({ cwd: dir, json: true });
    expect(res.code).toBe(1);
    expect(res.summary?.stalenessScore).toBe(1);

    // Threshold 5 → FRESH (score 1 ≤ 5)
    res = await runPreflight({ cwd: dir, json: true, maxStaleness: 5 });
    expect(res.code).toBe(0);
    expect(res.summary?.status).toBe('FRESH');
    expect(res.summary?.threshold).toBe(5);
  });

  it('emits GitHub Actions annotations when GITHUB_ACTIONS=true and stale', () => {
    // Direct unit test on the renderer — avoids env leakage in runPreflight.
    const summary = buildSummary({
      diff: {
        changed: ['src/foo.ts', 'src/new-file.ts'],
        mechanism: 'git',
        warnings: [],
        workingCommit: 'abc1234',
      },
      score: {
        perFile: [
          { filePath: 'src/foo.ts', inGraph: true, hub: true, maxFanIn: 20, nodeCount: 1, weight: 6 },
        ],
        totalScore: 6,
        hubCount: 1,
        leafCount: 0,
        unknownFiles: ['src/new-file.ts'],
      },
      graphBuiltAt: GRAPH_TS,
      graphCommit: null,
      threshold: 0,
    });

    const prev = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = 'true';
    try {
      const out = renderGithubAnnotations(summary);
      expect(out).toContain('::warning file=src/foo.ts::');
      // unknown file should NOT get an annotation (weight 0).
      expect(out).not.toContain('::warning file=src/new-file.ts::');
      expect(out).toContain('::error::OpenLore preflight: staleness score 6');
    } finally {
      if (prev === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = prev;
    }
  });

  it('does NOT emit GHA annotations outside GitHub Actions', () => {
    const summary = buildSummary({
      diff: { changed: ['src/foo.ts'], mechanism: 'git', warnings: [], workingCommit: null },
      score: {
        perFile: [
          { filePath: 'src/foo.ts', inGraph: true, hub: false, maxFanIn: 0, nodeCount: 1, weight: 1 },
        ],
        totalScore: 1,
        hubCount: 0,
        leafCount: 1,
        unknownFiles: [],
      },
      graphBuiltAt: GRAPH_TS,
      graphCommit: null,
      threshold: 0,
    });
    const prev = process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_ACTIONS;
    try {
      expect(renderGithubAnnotations(summary)).toBe('');
    } finally {
      if (prev !== undefined) process.env.GITHUB_ACTIONS = prev;
    }
  });

  it('human output shows per-file weight + flags hubs', async () => {
    // One hub file + one leaf file changed.
    await rm(join(dir, '.openlore', 'analysis', 'call-graph.db'));
    await makeGraphDb(join(dir, '.openlore', 'analysis', 'call-graph.db'), [
      { id: 'src/hub.ts::hub', name: 'hub', file_path: 'src/hub.ts', fan_in: 20, is_hub: 1 },
      { id: 'src/leaf.ts::leaf', name: 'leaf', file_path: 'src/leaf.ts', fan_in: 0, is_hub: 0 },
    ]);
    const after = (GRAPH_MS + 60_000) / 1000;
    await writeFile(join(dir, 'src/hub.ts'), 'hub change\n');
    await writeFile(join(dir, 'src/leaf.ts'), 'leaf change\n');
    await utimes(join(dir, 'src/hub.ts'), after, after);
    await utimes(join(dir, 'src/leaf.ts'), after, after);

    const { summary } = await runPreflight({ cwd: dir, json: true });
    const human = renderHuman(summary!);

    // Hub surfaces first (sorted DESC by weight)
    const hubIdx = human.indexOf('src/hub.ts');
    const leafIdx = human.indexOf('src/leaf.ts');
    expect(hubIdx).toBeGreaterThan(-1);
    expect(leafIdx).toBeGreaterThan(-1);
    expect(hubIdx).toBeLessThan(leafIdx);

    // Hub line is annotated with `hub` and a weight > leaf weight
    expect(human).toMatch(/src\/hub\.ts.*hub.*weight 6/);
    expect(human).toMatch(/src\/leaf\.ts.*weight 1/);
  });

  it('falls back to mtime + emits warning when no .git directory exists', async () => {
    // Remove the .git dir entirely; the fixture should now have no git.
    await rm(join(dir, '.git'), { recursive: true, force: true });
    const after = (GRAPH_MS + 60_000) / 1000;
    await writeFile(join(dir, 'src/foo.ts'), 'no git\n');
    await utimes(join(dir, 'src/foo.ts'), after, after);

    const { code, summary } = await runPreflight({ cwd: dir, json: true });
    expect(code).toBe(1);
    expect(summary?.mechanism).toBe('mtime');
    expect(summary?.warnings.some((w) => /no \.git/.test(w))).toBe(true);
    // Working commit should be null when there's no git.
    expect(summary?.workingCommit).toBeNull();
  });

  it('returns "nothing to check" + exit 0 when no source files have changed', async () => {
    // Default fixture: foo.ts mtime is pre-graph-build, nothing changed since.
    const { code, summary } = await runPreflight({ cwd: dir, json: true });
    expect(code).toBe(0);
    expect(summary?.status).toBe('FRESH');
    expect(summary?.changedFiles).toEqual([]);
    expect(summary?.message).toContain('nothing to check');
  });

  it('Status line distinguishes "nothing to check" from generic FRESH', async () => {
    // Default fixture has no changed files (everything pre-dates graph build).
    const { summary } = await runPreflight({ cwd: dir, json: true });
    const human = renderHuman(summary!);
    expect(human).toContain('Status:');
    expect(human).toContain('nothing to check');
  });

  it('hub files contribute more weight than leaf files', async () => {
    // Replace the DB with one node marked as a hub with high fan-in.
    await rm(join(dir, '.openlore', 'analysis', 'call-graph.db'));
    await makeGraphDb(join(dir, '.openlore', 'analysis', 'call-graph.db'), [
      { id: 'src/foo.ts::foo', name: 'foo', file_path: 'src/foo.ts', fan_in: 20, is_hub: 1 },
    ]);
    const after = (GRAPH_MS + 60_000) / 1000;
    await writeFile(join(dir, 'src/foo.ts'), 'changed\n');
    await utimes(join(dir, 'src/foo.ts'), after, after);
    const { summary } = await runPreflight({ cwd: dir, json: true });
    // 1 base + 2 hub + min(3, ceil(20/5)=4) = 6
    expect(summary?.stalenessScore).toBe(6);
    expect(summary?.hubCount).toBe(1);
  });
});
