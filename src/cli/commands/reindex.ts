/**
 * openlore reindex command
 *
 * One-shot INCREMENTAL catch-up of the code knowledge base (call graph +
 * signatures + text-line + dependency-graph + vector index) for the files that
 * changed since the last index — WITHOUT a full `analyze --force` and WITHOUT a
 * long-lived file watcher. It computes the delta from git and drives the same
 * incremental pipeline the MCP watch mode uses (McpWatcher.reindexDelta), so
 * freshness is O(change), not O(repo).
 *
 * This is the batch-mode counterpart to `openlore mcp --watch-auto` (Spec 13.1):
 * the watcher keeps a live session fresh reactively; `reindex` does one delta
 * pass and exits — the right fit for discrete, between-run refreshes (e.g. a
 * control plane that re-indexes a target after pulling new commits).
 *
 * Boundary (documented, by design): the incremental path refreshes the graph,
 * signatures, text-line and dependency-edge lanes + the vector index. Repo-LEVEL
 * aggregates (architecture pattern, domains, high-value ranking in
 * repo-structure) are whole-tree derivations and are NOT recomputed here — a
 * periodic full `analyze --force` refreshes those "by cadence". This mirrors the
 * intended semantics of the `openlore.reindex: watch-auto` config: depth-1
 * continuously; full rebuild on a cadence.
 *
 * Precondition: a prior `analyze` must exist (llm-context + call-graph). Reindex
 * is a delta catch-up, not a cold build — it fails loud if the base index is
 * missing.
 */

import { Command } from 'commander';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../../utils/logger.js';
import { fileExists, formatDuration } from '../../utils/command-helpers.js';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_FINGERPRINT,
} from '../../constants.js';
import { EdgeStore } from '../../core/services/edge-store.js';
import { McpWatcher } from '../../core/services/mcp-watcher.js';
import {
  getChangedFiles,
  isGitRepository,
  isSkippableFile,
  classifyFile,
} from '../../core/drift/git-diff.js';
import type { ChangedFile } from '../../types/index.js';

const execFileAsync = promisify(execFile);

/** Marker persisted under .openlore/analysis so the next reindex knows the base. */
const REINDEX_STATE_FILE = 'reindex-state.json';

interface ReindexState {
  /** Git ref (commit SHA) the index was last brought up to. */
  baseRef: string;
  updatedAt: string;
}

async function readState(outputPath: string): Promise<ReindexState | null> {
  try {
    return JSON.parse(await readFile(join(outputPath, REINDEX_STATE_FILE), 'utf-8')) as ReindexState;
  } catch {
    return null;
  }
}

/**
 * The commit `analyze` last ran at, recorded in fingerprint.json ({hash, commit,
 * computedAt, fileCount}). Used as the default base for the FIRST reindex after
 * an analyze — the delta is everything committed since then. No `analyze` change
 * needed: it already stamps the commit.
 */
async function analysisCommit(outputPath: string): Promise<string | null> {
  try {
    const fp = JSON.parse(await readFile(join(outputPath, ARTIFACT_FINGERPRINT), 'utf-8')) as { commit?: string };
    return fp.commit && fp.commit.trim() ? fp.commit.trim() : null;
  } catch {
    return null;
  }
}

async function writeState(outputPath: string, baseRef: string): Promise<void> {
  const state: ReindexState = { baseRef, updatedAt: new Date().toISOString() };
  await writeFile(join(outputPath, REINDEX_STATE_FILE), JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Split a git diff into ABSOLUTE {changed, deleted} source paths for the watcher.
 * Pure — no fs/git — so it is unit-tested directly. Drops test files and
 * non-source noise (binaries/locks); handleBatch/handleDeletions apply the
 * authoritative per-language filter downstream. Renames become oldPath-deleted +
 * newPath-changed (add == delete-then-add in the incremental pipeline).
 */
export function splitDelta(files: ChangedFile[], rootPath: string): { changed: string[]; deleted: string[] } {
  // Never re-index openlore's own analysis output (.openlore/ — call-graph.db,
  // llm-context.json, …): if the tree isn't gitignoring it, it would otherwise
  // leak into the delta. (git emits '/'-separated paths on every platform.)
  const inOpenlore = (p: string) => p === OPENLORE_DIR || p.startsWith(OPENLORE_DIR + '/');
  const changedRel = new Set<string>();
  const deletedRel = new Set<string>();
  for (const f of files) {
    if (inOpenlore(f.path)) continue;
    if (classifyFile(f.path).isTest) continue;
    if (f.status === 'deleted') {
      if (!isSkippableFile(f.path)) deletedRel.add(f.path);
    } else if (f.status === 'renamed') {
      if (f.oldPath && !inOpenlore(f.oldPath) && !isSkippableFile(f.oldPath)) deletedRel.add(f.oldPath);
      if (!isSkippableFile(f.path)) changedRel.add(f.path);
    } else {
      // added | modified
      if (!isSkippableFile(f.path)) changedRel.add(f.path);
    }
  }
  return {
    changed: [...changedRel].map((rel) => join(rootPath, rel)),
    deleted: [...deletedRel].map((rel) => join(rootPath, rel)),
  };
}

/** Resolve the current HEAD commit SHA (marker for the NEXT reindex). */
async function currentHead(rootPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: rootPath });
    return stdout.trim() || null;
  } catch {
    return null; // e.g. a repo with no commits yet — marker stays unset, next run re-diffs
  }
}

export const reindexCommand = new Command('reindex')
  .description('Incrementally re-index only the files changed since the last analysis (delta catch-up, no full rebuild)')
  .option(
    '--since <ref>',
    'Re-index files changed since this git ref (default: last reindex marker, else the commit analyze recorded in fingerprint.json, else working-tree changes vs HEAD)'
  )
  .option(
    '--no-embed',
    'Skip vector re-embedding — refresh graph/signatures only (BM25)',
  )
  .option(
    '--json',
    'Output the result as JSON only',
    false,
  )
  .action(async (options: { since?: string; embed?: boolean; json?: boolean }) => {
    const startTime = Date.now();
    const rootPath = process.cwd();
    const outputPath = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    const jsonOnly = !!options.json;

    try {
      // ── Preconditions (fail-loud) ──────────────────────────────────────────
      if (!(await isGitRepository(rootPath))) {
        logger.error('Not a git repository. `reindex` computes the delta from git — run it inside the repo.');
        process.exitCode = 1;
        return;
      }
      const contextPath = join(outputPath, ARTIFACT_LLM_CONTEXT);
      if (!(await fileExists(contextPath)) || !EdgeStore.exists(outputPath)) {
        logger.error('No existing analysis found (missing llm-context or call graph). Run "openlore analyze" first — reindex is a delta catch-up, not a cold build.');
        process.exitCode = 1;
        return;
      }

      // ── Compute the delta ──────────────────────────────────────────────────
      // Base ref precedence: explicit --since > last reindex marker > the commit
      // `analyze` recorded in fingerprint.json > HEAD (working-tree-only fallback).
      const state = await readState(outputPath);
      const fpCommit = await analysisCommit(outputPath);
      const baseRef = options.since ?? state?.baseRef ?? fpCommit ?? 'HEAD';
      const baseSource = options.since ? '--since' : state ? 'last reindex' : fpCommit ? 'analyze commit' : 'working tree';
      const diff = await getChangedFiles({ rootPath, baseRef, includeUnstaged: true });

      const { changed, deleted } = splitDelta(diff.files, rootPath);
      const head = await currentHead(rootPath);

      if (changed.length === 0 && deleted.length === 0) {
        if (jsonOnly) {
          process.stdout.write(JSON.stringify({ base: diff.resolvedBase, changed: 0, deleted: 0, upToDate: true }) + '\n');
        } else {
          logger.success(`Index is up to date — no source changes since ${diff.resolvedBase.slice(0, 12)}.`);
        }
        if (head) await writeState(outputPath, head); // advance marker even on a no-op
        return;
      }

      // ── Apply the incremental update ───────────────────────────────────────
      if (!jsonOnly) {
        logger.section('Incremental re-index');
        logger.info('Base', `${diff.resolvedBase.slice(0, 12)} (${baseSource})`);
        logger.info('Changed/added files', String(changed.length));
        logger.info('Deleted files', String(deleted.length));
        logger.blank();
      }

      const watcher = new McpWatcher({ rootPath, outputPath, embed: options.embed ?? true });
      const applied = await watcher.reindexDelta({ changed, deleted });

      // Advance the marker to the current HEAD so the next reindex diffs from here.
      if (head) await writeState(outputPath, head);

      const durationMs = Date.now() - startTime;
      if (jsonOnly) {
        process.stdout.write(JSON.stringify({
          base: diff.resolvedBase,
          changed: applied.changed,
          deleted: applied.deleted,
          embed: options.embed ?? true,
          durationMs,
        }) + '\n');
      } else {
        logger.success(`Re-indexed ${applied.changed} changed + ${applied.deleted} deleted file(s) in ${formatDuration(durationMs)}.`);
        logger.info('Note', 'Graph/signatures/vector are fresh. Repo-level summaries (architecture, domains) refresh on the next full "openlore analyze --force".');
      }
    } catch (error) {
      logger.error(`reindex failed: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });
