/**
 * Compute the staleness score for a set of changed files.
 *
 * Scoring model (deliberately simple, documented in docs/preflight.md):
 *
 *   per-file weight =
 *     1                          base
 *     + 2 if any node in the file is a hub (is_hub = 1)
 *     + min(3, ceil(maxFanIn/5)) for the heaviest fan-in in the file
 *
 *   staleness_score = sum(per-file weight) over files that map to nodes in
 *                     the graph; files not in the graph are reported but do
 *                     not contribute to the score (we cannot reason about
 *                     them without re-analyzing).
 *
 * This is intentionally a heuristic — a hub change matters more than a leaf
 * change, but we never claim it's a true blast-radius computation. It is the
 * cheapest signal that distinguishes "noisy editor save" from "ripped out a
 * central module."
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_CALL_GRAPH_DB } from '../../constants.js';

export interface FileScore {
  filePath: string;
  /** Whether the file appears in the graph at all. */
  inGraph: boolean;
  /** Did the file contain at least one hub? */
  hub: boolean;
  /** Max fan-in across nodes in the file. */
  maxFanIn: number;
  /** Number of nodes in the file. */
  nodeCount: number;
  /** Weight contribution. */
  weight: number;
}

export interface ScoreResult {
  perFile: FileScore[];
  totalScore: number;
  hubCount: number;
  leafCount: number;
  /** Files not represented in the graph at all (e.g. new files). */
  unknownFiles: string[];
}

function dbPath(repoRoot: string): string {
  return join(repoRoot, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_CALL_GRAPH_DB);
}

interface NodeRow {
  file_path: string;
  is_hub: number;
  fan_in: number;
}

/** Stats keyed by file_path, computed from a single SELECT to keep things fast. */
function loadFileStats(db: DatabaseSync, files: string[]): Map<string, FileScore> {
  if (files.length === 0) return new Map();
  const placeholders = files.map(() => '?').join(',');
  const rows = db
    .prepare(
      // is_test = 0: the store also holds test nodes since PDLC-156, and this
      // score is about production surface — without the filter a change touching
      // only tests would start scoring as if it touched the graph.
      `SELECT file_path, is_hub, fan_in FROM nodes WHERE is_external = 0 AND is_test = 0 AND file_path IN (${placeholders})`
    )
    .all(...files) as unknown as NodeRow[];
  const byFile = new Map<string, FileScore>();
  for (const file of files) {
    byFile.set(file, {
      filePath: file,
      inGraph: false,
      hub: false,
      maxFanIn: 0,
      nodeCount: 0,
      weight: 0,
    });
  }
  for (const r of rows) {
    const s = byFile.get(r.file_path);
    if (!s) continue;
    s.inGraph = true;
    s.nodeCount += 1;
    if (r.is_hub) s.hub = true;
    if (r.fan_in > s.maxFanIn) s.maxFanIn = r.fan_in;
  }
  for (const s of byFile.values()) {
    if (!s.inGraph) {
      s.weight = 0;
      continue;
    }
    let w = 1;
    if (s.hub) w += 2;
    w += Math.min(3, Math.ceil(s.maxFanIn / 5));
    s.weight = w;
  }
  return byFile;
}

export function scoreChangedFiles(repoRoot: string, changedFiles: string[]): ScoreResult {
  const result: ScoreResult = {
    perFile: [],
    totalScore: 0,
    hubCount: 0,
    leafCount: 0,
    unknownFiles: [],
  };
  if (changedFiles.length === 0) return result;

  const db = new DatabaseSync(dbPath(repoRoot), { readOnly: true });
  try {
    const stats = loadFileStats(db, changedFiles);
    for (const file of changedFiles) {
      const s = stats.get(file)!;
      if (!s.inGraph) {
        result.unknownFiles.push(file);
        continue;
      }
      result.perFile.push(s);
      result.totalScore += s.weight;
      if (s.hub) result.hubCount += 1;
      else result.leafCount += 1;
    }
  } finally {
    db.close();
  }
  return result;
}
