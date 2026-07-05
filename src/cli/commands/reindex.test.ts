/**
 * Unit tests for `openlore reindex` delta classification (splitDelta).
 *
 * Pure — no git, no fs. Locks the mapping from a git diff into the ABSOLUTE
 * {changed, deleted} source sets the incremental watcher consumes: renames split
 * into oldPath-deleted + newPath-changed, test files and non-source noise
 * (binaries/locks) are dropped, paths are made absolute, duplicates collapse.
 */
import { describe, it, expect } from 'vitest';
import { splitDelta } from './reindex.js';
import type { ChangedFile } from '../../types/index.js';

const cf = (path: string, status: ChangedFile['status'], oldPath?: string): ChangedFile => ({
  path,
  status,
  oldPath,
  additions: 0,
  deletions: 0,
  isTest: false,
  isConfig: false,
  isGenerated: false,
  extension: path.slice(path.lastIndexOf('.')),
});

const ROOT = '/repo';

describe('splitDelta — git diff → {changed, deleted} absolute source paths', () => {
  it('added and modified files go to changed (absolute)', () => {
    const { changed, deleted } = splitDelta(
      [cf('src/a.ts', 'added'), cf('src/b.ts', 'modified')],
      ROOT,
    );
    expect(changed.sort()).toEqual(['/repo/src/a.ts', '/repo/src/b.ts']);
    expect(deleted).toEqual([]);
  });

  it('deleted files go to deleted (absolute)', () => {
    const { changed, deleted } = splitDelta([cf('src/gone.ts', 'deleted')], ROOT);
    expect(changed).toEqual([]);
    expect(deleted).toEqual(['/repo/src/gone.ts']);
  });

  it('a rename splits into oldPath-deleted + newPath-changed', () => {
    const { changed, deleted } = splitDelta(
      [cf('src/new.ts', 'renamed', 'src/old.ts')],
      ROOT,
    );
    expect(changed).toEqual(['/repo/src/new.ts']);
    expect(deleted).toEqual(['/repo/src/old.ts']);
  });

  it('test files are dropped from both sets (by path, not the diff flag)', () => {
    const { changed, deleted } = splitDelta(
      [cf('src/foo.test.ts', 'modified'), cf('tests/bar_spec.py', 'added'), cf('src/real.ts', 'modified')],
      ROOT,
    );
    expect(changed).toEqual(['/repo/src/real.ts']);
    expect(deleted).toEqual([]);
  });

  it('non-source noise (locks, binaries) is dropped', () => {
    const { changed, deleted } = splitDelta(
      [cf('package-lock.json', 'modified'), cf('assets/logo.png', 'added'), cf('src/keep.ts', 'modified'), cf('yarn.lock', 'deleted')],
      ROOT,
    );
    expect(changed).toEqual(['/repo/src/keep.ts']);
    expect(deleted).toEqual([]); // yarn.lock is skippable → not queued for deletion either
  });

  it('non-source files git reports but the pipeline drops (.md/.json/.yaml) are excluded, so counts = applied', () => {
    const { changed, deleted } = splitDelta(
      [cf('README.md', 'modified'), cf('data.json', 'added'), cf('ci.yaml', 'modified'), cf('src/real.ts', 'modified'), cf('notes.txt', 'deleted')],
      ROOT,
    );
    expect(changed).toEqual(['/repo/src/real.ts']); // only the graphable source
    expect(deleted).toEqual([]);                     // notes.txt is not source → not counted as a deletion
  });

  it('graphable source across languages is kept (py/go/rs/…)', () => {
    const { changed } = splitDelta(
      [cf('app/main.py', 'modified'), cf('svc/handler.go', 'added'), cf('lib/core.rs', 'modified')],
      ROOT,
    );
    expect(changed.sort()).toEqual(['/repo/app/main.py', '/repo/lib/core.rs', '/repo/svc/handler.go']);
  });

  it('duplicate paths collapse (a path listed twice stays once)', () => {
    const { changed } = splitDelta(
      [cf('src/a.ts', 'added'), cf('src/a.ts', 'modified')],
      ROOT,
    );
    expect(changed).toEqual(['/repo/src/a.ts']);
  });

  it("openlore's own analysis output (.openlore/) is never re-indexed", () => {
    const { changed, deleted } = splitDelta(
      [
        cf('.openlore/analysis/call-graph.db', 'modified'),
        cf('.openlore/analysis/llm-context.json', 'added'),
        cf('.openlore/analysis/repo-structure.json', 'deleted'),
        cf('src/keep.ts', 'modified'),
      ],
      ROOT,
    );
    expect(changed).toEqual(['/repo/src/keep.ts']);
    expect(deleted).toEqual([]);
  });

  it('empty diff → empty sets', () => {
    expect(splitDelta([], ROOT)).toEqual({ changed: [], deleted: [] });
  });
});
