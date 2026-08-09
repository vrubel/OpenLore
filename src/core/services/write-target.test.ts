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
 * fails CI naming itself.
 *
 * WHAT THIS DOES AND DOES NOT GUARANTEE — stated narrowly on purpose, because the
 * comfortable version of this sentence ("a new writer cannot bypass the helper by
 * construction") is FALSE and would be exactly the false confidence this whole line
 * exists to remove. What it actually guarantees:
 *
 *   a writer that calls one of the listed primitives — under its own name, or under
 *   a local alias of it — from a .ts/.js/.mjs/.cjs file outside `src/pi`, and does
 *   not edit these two lists, WILL be named by CI.
 *
 * It does NOT catch: a write performed by a helper this module merely hands a path
 * to (the helper is classified, not the caller); a write through an external process
 * (`execFileSync('sh', …)`); a primitive reached dynamically (`fs['write' + 'File']`);
 * anything under `src/pi` (excluded from build, lint and tests alike); and — most
 * importantly — it cannot stop someone EDITING these lists, since the gate lives in
 * the repository it guards. The reason check below raises the cost of a careless
 * exemption; only review of the registry diff can catch a deliberate one.
 *
 * That is a list of primitives with a maintenance rule, not a property of the
 * construction. It is still far better than remembering — three rounds of review
 * prove the remembering does not work — but it should be described as what it is.
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
  'copyFile', 'copyFileSync', 'cp', 'cpSync', 'createWriteStream',
  'openSync', 'writeSync', 'ftruncate', 'ftruncateSync',
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
  'core/services/mcp-handlers/analysis.ts',
  'core/services/mcp-watcher.ts',
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
/**
 * The analyzer/generator writers do not choose a directory: they are HANDED one,
 * and the two places that derive it (`handleAnalyzeCodebase`, the watcher) now
 * derive it through the perimeter, so what arrives is already canonical and
 * approved. This is the honest reason; "analysis output dir" was not — it justified
 * the CHOICE of directory and said nothing about a symlink carrying the write out
 * of the root, which is exactly what happened.
 */
const RECEIVES_APPROVED_DIR =
  'Writes into an output directory it is GIVEN. The deriving call sites (handleAnalyzeCodebase, ' +
  'McpWatcher) resolve that directory through openloreWriteTarget, so it arrives canonical and ' +
  'inside the write perimeter; this module never builds a project path of its own.';

/**
 * The documented boundary of the whole feature: the allowlist is a property of the
 * MCP SERVER, and a CLI process declares none. That is not an oversight to be fixed
 * later — `openlore federation add /elsewhere/repo` is PDLC registering a product's
 * repository set, and confining it would break registration. These modules run only
 * on the CLI/library path, where `getRootAllowlist()` is null and every gate is a
 * pass-through by design.
 */
const CLI_NO_PERIMETER =
  'CLI/library entry point. The allowlist is declared only by `openlore mcp`; a CLI process ' +
  'declares none by design (see the boundary note in root-allowlist.ts), so this module is not ' +
  'reachable from a perimeter-bearing server.';

const EXEMPT: Record<string, string> = {
  // ── The primitive itself ────────────────────────────────────────────────────
  'core/services/edge-store.ts':
    'The SQLite primitive. Callers reach it through edge-store-access, which asks the perimeter; ' +
    'openReadOnly is immutable=1 and provably writes nothing.',

  // ── Reached only under a WRITE-gated tool, on its own approved root ─────────
  // analyze_codebase / generate are classified writers, so the transport already
  // required write access to `directory`; and their output dir is the analysis dir
  // under it. These do not accept a second, independent path from the caller.
  'core/analyzer/artifact-generator.ts': RECEIVES_APPROVED_DIR,
  'core/analyzer/architecture-writer.ts': RECEIVES_APPROVED_DIR,
  'core/analyzer/ai-config-generator.ts': RECEIVES_APPROVED_DIR,
  'core/analyzer/codebase-digest.ts': RECEIVES_APPROVED_DIR,
  'core/analyzer/repository-mapper.ts': RECEIVES_APPROVED_DIR,
  'core/analyzer/spec-snapshot-generator.ts': RECEIVES_APPROVED_DIR,
  'core/analyzer/spec-vector-index.ts': RECEIVES_APPROVED_DIR,
  'core/analyzer/vector-index.ts': RECEIVES_APPROVED_DIR,
  'core/analyzer/vector-store.ts': RECEIVES_APPROVED_DIR,
  'core/generator/mapping-generator.ts': RECEIVES_APPROVED_DIR,
  'core/generator/openspec-writer.ts': 'openspec tree; generate only (CLI + write-gated tool).',
  'core/generator/openspec-compat.ts':
    'Writes the openspec config during generate/init, into a root the caller already owns; not ' +
    'reachable from a read-only or foreign root, and it derives no project path of its own.',
  'core/generator/spec-pipeline.ts': RECEIVES_APPROVED_DIR,
  'core/verifier/verification-engine.ts': 'Verifier output dir, supplied by the CLI command.',
  'core/test-generator/test-writer.ts':
    'generate_tests output. Confines every write with safeJoin (canonical, symlink-aware) against the ' +
    'root it was given, and generate_tests is itself a write-gated tool, so the root has already passed ' +
    'the perimeter; this module derives no project path of its own.',
  'core/decisions/syncer.ts': 'Writes under openspecPath during sync_decisions (write-gated tool).',
  'core/decisions/atomic-store.ts':
    'Generic atomic-write mechanism. It writes wherever it is told; its callers ' +
    '(decisions/store.ts, memory-store.ts) derive that path through the perimeter.',
  'core/decisions/lock.ts':
    'Lock beside the decisions store; the directory comes from decisionsDir, whose write ' +
    'twin is perimeter-derived, and the lock is created only on a write that already passed.',
  'core/services/config-manager.ts': 'Writes .openlore/config.json during init/analyze (CLI + write-gated).',
  'core/services/gitignore-manager.ts': 'Writes .gitignore during init/run (CLI only).',
  'core/services/llm-service.ts': 'LLM request log under a configured logDir; no caller-supplied project path.',

  // ── Process-local scratch ───────────────────────────────────────────────────
  'core/agent-eval/measure.ts': 'Writes only into the mkdtemp workdir created by the prove command.',
  'core/services/mcp-handlers/live-data/report.ts': 'Writes into openlore\'s own live-data cache, never a served repo.',

  // ── Not the MCP server: CLI commands and installers ─────────────────────────
  // The documented boundary: a CLI process declares no allowlist, and must not.
  // `openlore federation add <path>` is PDLC registering a product's repo set.
  'cli/commands/analyze.ts': CLI_NO_PERIMETER + ' Specifically: CLI command (no perimeter by design).',
  'cli/commands/blast-radius.ts': CLI_NO_PERIMETER + ' Specifically: CLI command: installs a git hook.',
  'cli/commands/decisions.ts': CLI_NO_PERIMETER + ' Specifically: CLI command: hooks and agent files.',
  'cli/commands/digest.ts': CLI_NO_PERIMETER + ' Specifically: CLI command: writes the requested output file.',
  'cli/commands/drift.ts': CLI_NO_PERIMETER + ' Specifically: CLI command: installs a git hook.',
  'cli/commands/generate.ts': CLI_NO_PERIMETER,
  'cli/commands/gryph-watch.ts': CLI_NO_PERIMETER + ' Specifically: CLI command: pid file.',
  'cli/commands/impact-certificate.ts': CLI_NO_PERIMETER + ' Specifically: CLI command: installs a git hook.',
  'cli/commands/panic-hotspots.ts': CLI_NO_PERIMETER,
  'cli/commands/refresh-stories.ts': CLI_NO_PERIMETER + ' Specifically: CLI command: installs a git hook.',
  'cli/commands/reindex.ts': CLI_NO_PERIMETER,
  'cli/commands/run.ts': CLI_NO_PERIMETER,
  'cli/commands/serve.ts': CLI_NO_PERIMETER + ' Specifically: Separate long-lived daemon command; MCP refuses to spawn or delegate to it under a perimeter.',
  'cli/commands/setup.ts': CLI_NO_PERIMETER + ' Specifically: CLI command: agent integration files.',
  'cli/commands/prove.ts': CLI_NO_PERIMETER + ' Specifically: CLI command: mkdtemp workdir.',
  'cli/export/scip.ts': CLI_NO_PERIMETER + ' Specifically: CLI export: writes the --out path the operator named.',
  'cli/manifest/emit.ts': CLI_NO_PERIMETER + ' Specifically: CLI export: writes the --out path the operator named.',
  'cli/install/adapters/claude-code.ts': CLI_NO_PERIMETER + ' Specifically: Installer: writes agent config under the detected project root.',
  'cli/install/adapters/continue.ts': CLI_NO_PERIMETER + ' Specifically: Installer.',
  'cli/install/adapters/cursor.ts': CLI_NO_PERIMETER + ' Specifically: Installer.',
  'cli/install/adapters/markdown-block.ts': CLI_NO_PERIMETER + ' Specifically: Installer.',
  'api/analyze.ts': CLI_NO_PERIMETER + ' Specifically: Library/CLI entry point (no perimeter by design).',
  'api/audit.ts': CLI_NO_PERIMETER,
  'api/generate.ts': CLI_NO_PERIMETER,
  'api/run.ts': CLI_NO_PERIMETER,
  'utils/shutdown.ts': 'Shutdown state file for the process that owns the directory.',
};

/**
 * Handlers that join `.openlore` but never write — they locate an index and READ it
 * (`VectorIndex.exists`, `readCachedContext`, a fingerprint). Listing them is not a
 * judgement call: the test below re-derives "this module calls no write primitive"
 * from the source and fails if that stops being true, so an entry here cannot
 * quietly become a writer.
 */
const OPENLORE_JOIN_READERS: Record<string, string> = {
  'core/services/mcp-handlers/architecture.ts': 'Reads the analysis artifacts for the overview.',
  'core/services/mcp-handlers/claim-verification.ts': 'Locates the index to verify a claim against it.',
  'core/services/mcp-handlers/confidence-boundary.ts': 'Reads fingerprint.json to judge staleness.',
  'core/services/mcp-handlers/graph.ts': 'Locates the vector index for semantic expansion (read).',
  'core/services/mcp-handlers/orient.ts': 'Reads analysis + vector index to orient.',
  'core/services/mcp-handlers/reachability.ts': 'Reads the graph to compute reachability.',
  'core/services/mcp-handlers/semantic.ts': 'Locates the vector index for search (read).',
};

/** Import specifiers that count as "this module consults the perimeter". */
const GATE_IMPORTS = ['write-target', 'edge-store-access', 'root-allowlist'];

/**
 * A REAL import statement, not `includes()` over the raw text. The loose form
 * accepted the word appearing anywhere — including a comment — so a module could
 * list itself as perimeter-gated merely by mentioning `root-allowlist` in prose.
 */
function importsGuard(src: string): boolean {
  return GATE_IMPORTS.some(g =>
    new RegExp(`(?:import|require)[^;\n]*['"][^'"]*${g}(?:\\.js)?['"]`).test(src));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'pi') continue;  // src/pi is out of scope (see vitest.config)
      out.push(...sourceFiles(p));
    } else if (/\.(ts|js|mjs|cjs)$/.test(entry.name) && !entry.name.includes('.test.')) {
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
    // A primitive can arrive under another name — `import { writeFileSync as _w }`
    // or `const put = writeFileSync` — and the plain name scan walks straight past
    // both. Collect the local aliases first and look for those too.
    for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g)) {
      if (WRITE_PRIMITIVES.includes(m[1])) found.add(`${m[1]} as ${m[2]}`);
    }
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*[;,\n]/g)) {
      if (WRITE_PRIMITIVES.includes(m[2])) found.add(`${m[2]} aliased as ${m[1]}`);
    }
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
      .filter(f => !importsGuard(readFileSync(join(SRC, f), 'utf-8')))
      .sort();
    expect(notGated, `listed as perimeter-gated but importing no guard: ${notGated.join(', ')}`).toEqual([]);
  });

  it('every exemption states a reason a human can actually check', () => {
    // Not a proof of correctness — no test can read intent — but it stops the
    // cheapest evasion: adding yourself with `'ok'`. A reason has to be long enough
    // to say something, and must not be one of the non-answers.
    const NON_ANSWERS = /^(ok|n\/a|na|safe|fine|todo|see above|by design|trusted)\.?$/i;
    const bad = Object.entries(EXEMPT)
      .filter(([, why]) => why.trim().length < 40 || NON_ANSWERS.test(why.trim()))
      .map(([f, why]) => `${f}: "${why}"`)
      .sort();
    expect(bad, `exemption without a checkable reason:\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('no read-only-join entry has quietly become a writer', () => {
    const nowWriting = Object.keys(OPENLORE_JOIN_READERS).filter(f => writers.has(f)).sort();
    expect(
      nowWriting,
      'listed as joining .openlore only to READ, but now calls a write primitive — ' +
      `route it through openloreWriteTarget: ${nowWriting.join(', ')}`,
    ).toEqual([]);
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
    //
    // This check deliberately does NOT skip EXEMPT modules any more. It used to, and
    // that is how `analyze_codebase` shipped writing 14 artifacts through a symlinked
    // `.openlore`: the module carried an exemption whose stated reason ("writes only
    // into an os.tmpdir() mkdtemp") was untrue of the line that mattered, and the
    // exemption ALSO switched off the one check built to catch that exact shape. An
    // exemption is a claim about a module's write TARGETS; it is not a licence to
    // stop looking.
    // Walks EVERY handler file on disk, not `writers` — `writers` holds only modules
    // that call a primitive themselves, so a handler that builds the path here and
    // hands it to someone else to write would never have been looked at. The limit of
    // this gate should be "you edited the gate", not "you split the write across two
    // files".
    const handlerFiles = files
      .map(f => relative(SRC, f).split(sep).join('/'))
      .filter(rel => rel.startsWith('core/services/mcp-handlers/'))
      .sort();
    expect(handlerFiles.length, 'handler sweep collected nothing — the scan is broken').toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const rel of handlerFiles) {
      const src = code(readFileSync(join(SRC, rel), 'utf-8'));
      const joinsOpenlore = /join\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*(OPENLORE_DIR|['"]\.openlore['"])/.test(src);
      if (!joinsOpenlore || importsGuard(src)) continue;
      // A bare join is fine in a module that writes NOTHING — it is locating
      // something to read. That claim is re-derived here from the source, not taken
      // on trust: if such a module ever gains a write primitive, it drops out of
      // this branch and is reported.
      if (rel in OPENLORE_JOIN_READERS && !writers.has(rel)) continue;
      offenders.push(rel);
    }
    expect(offenders, `bare join(dir, '.openlore', …) on a write path: ${offenders.join(', ')}`).toEqual([]);
  });
});
