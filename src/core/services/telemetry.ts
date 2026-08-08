/**
 * Opt-in telemetry writer for openlore.
 *
 * Gate: OPENLORE_TELEMETRY=1 (disabled by default).
 * Writes append-only JSONL to .openlore/telemetry/<domain>.jsonl.
 * Never throws — telemetry must not crash the hot path.
 *
 * Rotation: when a domain file exceeds ROTATE_THRESHOLD_BYTES, it is renamed
 * to <domain>.1.jsonl and older rotated files shifted (keeps MAX_ROTATED_FILES).
 */

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { OPENLORE_DIR } from '../../constants.js';
import { redactSecrets } from './secret-redaction.js';
import { isPathAllowed } from './mcp-handlers/root-allowlist.js';

const TELEMETRY_SUBDIR = 'telemetry';
const ROTATE_THRESHOLD_BYTES = 50 * 1024 * 1024;  // 50 MB
const MAX_ROTATED_FILES = 5;
const _createdDirs = new Set<string>();

function rotateTelemetryFile(filePath: string): void {
  // Shift existing rotated files: .5.jsonl deleted, .4 → .5, …, .1 → .2
  const base = filePath.replace(/\.jsonl$/, '');
  try { unlinkSync(`${base}.${MAX_ROTATED_FILES}.jsonl`); } catch { /* not present */ }
  for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
    try { renameSync(`${base}.${i}.jsonl`, `${base}.${i + 1}.jsonl`); } catch { /* not present */ }
  }
  try { renameSync(filePath, `${base}.1.jsonl`); } catch { /* rename failed — continue writing */ }
}

/**
 * Emit a telemetry event to .openlore/telemetry/<domain>.jsonl.
 *
 * @param directory  - project root (must be absolute)
 * @param domain     - log file name without extension (e.g. 'mcp', 'cache', 'epistemic-lease')
 * @param payload    - arbitrary fields merged with the timestamp
 */
export function emit(
  directory: string,
  domain: string,
  payload: Record<string, unknown>,
): void {
  if (!process.env['OPENLORE_TELEMETRY']) return;
  if (!directory) return;
  // Telemetry IS a write: it mkdirs `<directory>/.openlore/telemetry` and appends
  // to it. On the MCP transport path it runs on the RAW caller-supplied directory,
  // before any handler has validated anything — so without this line the server
  // creates a directory tree inside any repository an agent names, purely by being
  // asked about it. (PDLC starts openlore with OPENLORE_TELEMETRY=1, so this is a
  // live write primitive, not a theoretical one.)
  //
  // Choice: SKIP, not redirect. Folding repo B's events into repo A's log would
  // silently corrupt per-repo analytics, and `emit` already treats "could not
  // write" as a no-op — staying silent here matches its existing contract instead
  // of inventing a new failure mode in the hot path.
  //
  // Judged on the DIRECTORY THE BYTES LAND IN, not on `directory`. In PDLC's
  // isolated layout `scratch/.openlore` is a symlink onto `ws/.openlore`, so the
  // write goes somewhere other than the directory that was approved; canonicalizing
  // the actual target is what makes the permission mean what it says. Same defect of
  // shape as the call-graph index and panic state: judge the directory, write to a
  // path inside it.
  const dir = join(directory, OPENLORE_DIR, TELEMETRY_SUBDIR);
  if (!isPathAllowed(dir, 'write')) return;
  try {
    if (!_createdDirs.has(dir)) { mkdirSync(dir, { recursive: true }); _createdDirs.add(dir); }
    const filePath = join(dir, `${domain}.jsonl`);
    // Rotate before writing if file exceeds threshold
    try {
      const { size } = statSync(filePath);
      if (size >= ROTATE_THRESHOLD_BYTES) rotateTelemetryFile(filePath);
    } catch { /* file doesn't exist yet */ }
    // Defense in depth: a telemetry payload must never carry a credential to disk
    // (mcp-security: Secret Confinement Across All Output Paths).
    const safe = redactSecrets(payload);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...safe }) + '\n';
    appendFileSync(filePath, line, 'utf-8');
  } catch {
    // never crash the hot path
  }
}
