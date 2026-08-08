/**
 * WRITE-SITE CENSUS GATE.
 *
 * Three rounds of review, three sets of holes, all the same shape: a path built by
 * a lexical `join` under a caller-supplied directory, written without asking the
 * perimeter. Each round the fix was "gate the doors we found". Each round the next
 * reviewer found doors nobody had thought of — `AnchorContext.open`, `--watch-auto`,
 * six lexical writers, a bare `new DatabaseSync` inside a read-shaped helper.
 *
 * The defect is not any one of those doors. It is that the set of doors lived in
 * people's heads. This test moves it into the build: every module in `src/` that
 * calls a filesystem write primitive must be classified, and an unclassified one
 * fails CI naming itself. Adding a writer is still easy; adding one SILENTLY is not.
 *
 * Classification is per-module, not per-line, on purpose — line numbers rot on
 * every edit, and a module is the unit that shares a notion of "where do I write".
 *
 * ⚠️ Enumeration reads files with `readFileSync`, never `grep`: four sources carry
 * NUL bytes (`cha.ts`, `analysis.ts`, `orient.ts`, `progressive.ts`) and plain grep
 * skips them as binary — that is how 21 files stayed invisible in an earlier audit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Filesystem write primitives, plus the two SQLite opens that write. */
const WRITE_PRIMITIVES = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync',
  'rename', 'renameSync', 'unlink', 'unlinkSync', 'rmdir', 'rmdirSync',
  'copyFile', 'copyFileSync', 'cpSync', 'createWriteStream',
  'symlink', 'symlinkSync', 'link', 'linkSync',
  'chmod', 'chmodSync', 'utimes', 'utimesSync', 'truncate', 'truncateSync',
  'EdgeStore.open', 'new DatabaseSync',
];
// Every name is anchored on a non-identifier character. Without that,
// `readlinkSync(` matches `linkSync(` and `rm(` matches half the codebase — the
// scanner reports phantom writers, someone silences it, and the gate dies of
// distrust rather than of a real hole.
//
// The anchor deliberately ALLOWS a leading `.`: the namespace form
// `fs.unlinkSync(...)` is a write like any other, and excluding `.` to stop
// `EdgeStore.open` from sub-matching made `utils/shutdown.ts` — three real writes —
// invisible to the census. Compound names are listed in full instead.
const WRITE_RE = new RegExp(
  '(?:^|[^A-Za-z0-9_$])(?:' +
  WRITE_PRIMITIVES.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
  '|rm|rmSync)\\s*\\(',
  'gm',
);

/** `new DatabaseSync(x, { readOnly: true })` opens for reading — not a write site. */
function isReadOnlyDbOpen(src: string, at: number): boolean {
  return /^[^;]{0,200}readOnly\s*:\s*true/.test(src.slice(at));
}

/**
 * Modules that reach the perimeter for their write paths. Each MUST import the
 * shared helper (`write-target`, `edge-store-access`) or the guard itself
 * (`root-allowlist`) — the test verifies the import, so deleting the gate and
 * leaving the entry here does not pass.
 */
const PERIMETER_GATED = new Set([
  'core/services/write-target.ts',
  'core/services/edge-store-access.ts',
  'core/services/telemetry.ts',
  'core/services/mcp-handlers/utils.ts',
  'core/services/mcp-handlers/panic-response.ts',
  'core/services/mcp-handlers/impact-certificate.ts',
  'core/services/mcp-handlers/change.ts',
  'core/services/mcp-handlers/epistemic-lease.ts',
  'core/services/call-graph-loader.ts',
  'core/decisions/store.ts',
  'core/decisions/memory-store.ts',
  'core/decisions/anchor-adapter.ts',
  'core/federation/registry.ts',
]);

/**
 * Modules that write WITHOUT consulting the perimeter, each with the reason it is
 * sound. A reason is a claim someone can check and disagree with — that is the
 * point. "It seemed fine" is not on this list.
 */
const EXEMPT: Record<string, string> = {
  // ── The primitive itself ────────────────────────────────────────────────────
  'core/services/edge-store.ts':
    'The SQLite primitive. Callers reach it through edge-store-access, which asks the perimeter; ' +
    'openReadOnly is immutable=1 and provably writes nothing.',

  // ── Reached only under a WRITE-gated tool, on its own approved root ─────────
  // analyze_codebase / generate are classified writers, so the transport already
  // required write access to `directory`; and their output dir is the analysis dir
  // under it. These do not accept a second, independent path from the caller.
  'core/analyzer/artifact-generator.ts': 'Analysis output; runs only under analyze_codebase (write-gated tool).',
  'core/analyzer/architecture-writer.ts': 'Analysis output dir supplied by the analyzer pipeline.',
  'core/analyzer/ai-config-generator.ts': 'Analysis output; analyze/init only.',
  'core/analyzer/codebase-digest.ts': 'Analysis output dir.',
  'core/analyzer/repository-mapper.ts': 'Analysis output dir.',
  'core/analyzer/spec-snapshot-generator.ts': 'Analysis output dir.',
  'core/analyzer/spec-vector-index.ts': 'Analysis output dir (vector index).',
  'core/analyzer/vector-index.ts': 'Analysis output dir (vector index).',
  'core/analyzer/vector-store.ts': 'Analysis output dir (vector store files).',
  'core/generator/mapping-generator.ts': 'Analysis output; generate only.',
  'core/generator/openspec-writer.ts': 'openspec tree; generate only (CLI + write-gated tool).',
  'core/generator/openspec-compat.ts': 'openspec config; generate/init only.',
  'core/generator/spec-pipeline.ts': 'Generator output dir.',
  'core/verifier/verification-engine.ts': 'Verifier output dir, supplied by the CLI command.',
  'core/test-generator/test-writer.ts': 'generate_tests output; write-gated tool, own containment check.',
  'core/decisions/syncer.ts': 'Writes under openspecPath during sync_decisions (write-gated tool).',
  'core/decisions/atomic-store.ts':
    'Generic atomic-write mechanism. It writes wherever it is told; its callers ' +
    '(decisions/store.ts, memory-store.ts) derive that path through the perimeter.',
  'core/decisions/lock.ts':
    'Lock beside the decisions store; the directory comes from decisionsDir, whose write ' +
    'twin is perimeter-derived, and the lock is created only on a write that already passed.',
  'core/services/config-manager.ts': 'Writes .openlore/config.json during init/analyze (CLI + write-gated).',
  'core/services/gitignore-manager.ts': 'Writes .gitignore during init/run (CLI only).',
  'core/services/mcp-watcher.ts':
    'Watcher writes the analysis index of the directory it watches. Adoption of an arbitrary ' +
    'directory (--watch-auto) is disabled while a perimeter is configured, and explicit ' +
    '--watch is validated into the roots at startup.',
  'core/services/llm-service.ts': 'LLM request log under a configured logDir; no caller-supplied project path.',

  // ── Process-local scratch ───────────────────────────────────────────────────
  'core/services/mcp-handlers/analysis.ts': 'Writes only into an os.tmpdir() mkdtemp for git plumbing output.',
  'core/agent-eval/measure.ts': 'Writes only into the mkdtemp workdir created by the prove command.',
  'core/services/mcp-handlers/live-data/report.ts': 'Writes into openlore\'s own live-data cache, never a served repo.',

  // ── Not the MCP server: CLI commands and installers ─────────────────────────
  // The documented boundary: a CLI process declares no allowlist, and must not.
  // `openlore federation add <path>` is PDLC registering a product's repo set.
  'cli/commands/analyze.ts': 'CLI command (no perimeter by design).',
  'cli/commands/blast-radius.ts': 'CLI command: installs a git hook.',
  'cli/commands/decisions.ts': 'CLI command: hooks and agent files.',
  'cli/commands/digest.ts': 'CLI command: writes the requested output file.',
  'cli/commands/drift.ts': 'CLI command: installs a git hook.',
  'cli/commands/generate.ts': 'CLI command.',
  'cli/commands/gryph-watch.ts': 'CLI command: pid file.',
  'cli/commands/impact-certificate.ts': 'CLI command: installs a git hook.',
  'cli/commands/panic-hotspots.ts': 'CLI command.',
  'cli/commands/refresh-stories.ts': 'CLI command: installs a git hook.',
  'cli/commands/reindex.ts': 'CLI command.',
  'cli/commands/run.ts': 'CLI command.',
  'cli/commands/serve.ts': 'Separate long-lived daemon command; MCP refuses to spawn or delegate to it under a perimeter.',
  'cli/commands/setup.ts': 'CLI command: agent integration files.',
  'cli/commands/prove.ts': 'CLI command: mkdtemp workdir.',
  'cli/export/scip.ts': 'CLI export: writes the --out path the operator named.',
  'cli/manifest/emit.ts': 'CLI export: writes the --out path the operator named.',
  'cli/install/adapters/claude-code.ts': 'Installer: writes agent config under the detected project root.',
  'cli/install/adapters/continue.ts': 'Installer.',
  'cli/install/adapters/cursor.ts': 'Installer.',
  'cli/install/adapters/markdown-block.ts': 'Installer.',
  'api/analyze.ts': 'Library/CLI entry point (no perimeter by design).',
  'api/audit.ts': 'Library/CLI entry point.',
  'api/generate.ts': 'Library/CLI entry point.',
  'api/run.ts': 'Library/CLI entry point.',
  'utils/shutdown.ts': 'Shutdown state file for the process that owns the directory.',
};

/** Import specifiers that count as "this module consults the perimeter". */
const GATE_IMPORTS = ['write-target', 'edge-store-access', 'root-allowlist'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'pi') continue;  // src/pi is out of scope (see vitest.config)
      out.push(...sourceFiles(p));
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      out.push(p);
    }
  }
  return out;
}

/** Comment- and string-free-ish view: strips line/block comments so prose does not count. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Write-Site Census Gate', () => {
  const files = sourceFiles(SRC).filter(f => statSync(f).isFile());
  const writers = new Map<string, string[]>();   // rel path → primitives found

  for (const file of files) {
    const src = code(readFileSync(file, 'utf-8'));
    const found = new Set<string>();
    for (const m of src.matchAll(WRITE_RE)) {
      const prim = m[0].replace(/\s*\($/, '').replace(/^[^A-Za-z]+/, '').trim();
      if (prim.endsWith('DatabaseSync') && isReadOnlyDbOpen(src, m.index ?? 0)) continue;
      found.add(prim);
    }
    if (found.size) writers.set(relative(SRC, file).split(sep).join('/'), [...found]);
  }

  it('finds the write surface at all (guards against the enumeration silently breaking)', () => {
    // If a refactor breaks the scan, every other assertion here passes vacuously —
    // which is the failure mode this whole file exists to prevent.
    expect(writers.size).toBeGreaterThan(40);
    // The NUL-carrying file with real writes must be visible; `grep` without -a misses it.
    expect(writers.has('core/services/mcp-handlers/analysis.ts'),
      'NUL-byte source not scanned — the enumeration is reading files the way grep does').toBe(true);
  });

  it('every module that writes is either perimeter-gated or explicitly exempt with a reason', () => {
    const unclassified = [...writers.keys()]
      .filter(f => !PERIMETER_GATED.has(f) && !(f in EXEMPT))
      .sort();
    expect(
      unclassified,
      'New ungated filesystem writer(s). Route the path through `writeTarget`/`openloreWriteTarget` ' +
      '(src/core/services/write-target.ts) and add the module to PERIMETER_GATED — or, if it genuinely ' +
      'must not be confined, add it to EXEMPT with the reason why:\n  ' + unclassified.join('\n  '),
    ).toEqual([]);
  });

  it('every perimeter-gated module actually imports the guard', () => {
    const notGated = [...PERIMETER_GATED]
      .filter(f => {
        const src = readFileSync(join(SRC, f), 'utf-8');
        return !GATE_IMPORTS.some(g => src.includes(g));
      })
      .sort();
    expect(notGated, `listed as perimeter-gated but importing no guard: ${notGated.join(', ')}`).toEqual([]);
  });

  it('the exemption list has no stale entries (a module that no longer writes)', () => {
    // Only EXEMPT is checked: an exemption is a standing claim that THIS module
    // writes without a gate, and it must expire when that stops being true.
    // PERIMETER_GATED members may legitimately hold no primitive of their own —
    // `decisions/store.ts` writes through atomic-store, `utils.ts` through
    // edge-store-access — and are held honest by the import check above instead.
    const stale = Object.keys(EXEMPT)
      .filter(f => !writers.has(f))
      .sort();
    expect(stale, `registered as a writer but writes nothing any more — drop it: ${stale.join(', ')}`).toEqual([]);
  });

  it('no MCP handler builds an .openlore write path with a bare join', () => {
    // The exact shape every round of this review kept re-discovering. Handlers are
    // the MCP-reachable surface; they must go through the helper.
    const offenders: string[] = [];
    for (const rel of writers.keys()) {
      if (!rel.startsWith('core/services/mcp-handlers/')) continue;
      if (rel in EXEMPT) continue;   // already justified above, with a stated reason
      const src = code(readFileSync(join(SRC, rel), 'utf-8'));
      if (/join\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*(OPENLORE_DIR|['"]\.openlore['"])/.test(src)
          && !GATE_IMPORTS.some(g => src.includes(g))) {
        offenders.push(rel);
      }
    }
    expect(offenders, `bare join(dir, '.openlore', …) on a write path: ${offenders.join(', ')}`).toEqual([]);
  });
});
