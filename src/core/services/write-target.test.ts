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
  // Moved out of EXEMPT: both now re-derive their target instead of trusting the one
  // approval they were handed (see write-target.reassertWriteDir).
  'core/analyzer/artifact-generator.ts',
  'core/analyzer/spec-snapshot-generator.ts',
  // Moved out of EXEMPT because the exemption's REASON was false, not because the
  // module changed address: both are imported by mcp-handlers/analysis.ts and are
  // therefore reachable from a perimeter-bearing server.
  'api/audit.ts',
  'cli/commands/analyze.ts',
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
  'core/analyzer/architecture-writer.ts': RECEIVES_APPROVED_DIR,
  'core/analyzer/ai-config-generator.ts': RECEIVES_APPROVED_DIR,
  'core/analyzer/codebase-digest.ts': RECEIVES_APPROVED_DIR,
  'core/analyzer/repository-mapper.ts': RECEIVES_APPROVED_DIR,
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
  // NOT CLI_NO_PERIMETER: this module IS reachable — serve-client imports readDescriptor
  // dynamically to reuse its strict parser. What is unreachable is its writing body.
  'cli/commands/serve.ts':
    'Separate long-lived daemon. Under a configured allowlist the MCP server refuses at startup to ' +
    'spawn or delegate to a daemon (resolveDaemon and maybeStartWatcher both bail before reading a ' +
    'descriptor), so the writes here run only in the `openlore serve` process, which declares no ' +
    'perimeter. The one function reachable from the server, readDescriptor, writes nothing.',
  'cli/commands/setup.ts': CLI_NO_PERIMETER + ' Specifically: CLI command: agent integration files.',
  'cli/commands/prove.ts': CLI_NO_PERIMETER + ' Specifically: CLI command: mkdtemp workdir.',
  'cli/export/scip.ts': CLI_NO_PERIMETER + ' Specifically: CLI export: writes the --out path the operator named.',
  'cli/manifest/emit.ts': CLI_NO_PERIMETER + ' Specifically: CLI export: writes the --out path the operator named.',
  'cli/install/adapters/claude-code.ts': CLI_NO_PERIMETER + ' Specifically: Installer: writes agent config under the detected project root.',
  'cli/install/adapters/continue.ts': CLI_NO_PERIMETER + ' Specifically: Installer.',
  'cli/install/adapters/cursor.ts': CLI_NO_PERIMETER + ' Specifically: Installer.',
  'cli/install/adapters/markdown-block.ts': CLI_NO_PERIMETER + ' Specifically: Installer.',
  // NOT CLI_NO_PERIMETER: reachable through live-data/analyze-repo.ts.
  'api/analyze.ts':
    'Library entry point. Reachable from the server only via the live-data harness, which points it ' +
    'at openlore\'s OWN cached clones — never at a served repository — and its writes land in the ' +
    'analysis directory of the root it is given. The CLI path (openlore analyze) declares no perimeter.',
  'api/generate.ts': CLI_NO_PERIMETER,
  'api/run.ts': CLI_NO_PERIMETER,
  'utils/shutdown.ts': 'Shutdown state file for the process that owns the directory.',
};

/** Import specifiers that count as "this module consults the perimeter". */
const GATE_IMPORTS = ['write-target', 'edge-store-access', 'root-allowlist'];

/**
 * A REAL import statement, not `includes()` over the raw text. The loose form
 * accepted the word appearing anywhere — including a comment — so a module could
 * list itself as perimeter-gated merely by mentioning `root-allowlist` in prose.
 */
function importsGuard(src: string): boolean {
  // Comments stripped (a mention in prose is not an import) and `import type`
  // rejected (a type-only import is erased at build time and gates nothing).
  const bare = code(src);
  // `[^;]*?` and not `[^;\n]*`: a multi-line `import { a, b } from './write-target.js'`
  // is the same import, and the line-bound form reported `write-target.ts` itself as
  // ungated the moment its own import list grew past one line.
  return GATE_IMPORTS.some(g =>
    new RegExp(`(?:import|require)\\s+(?!type\\s)[^;]*?['"][^'"]*${g}(?:\\.js)?['"]`).test(bare));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'pi') continue;  // src/pi is out of scope (see vitest.config)
      out.push(...sourceFiles(p));
    } else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name) && !entry.name.includes('.test.')) {
      out.push(p);
    }
  }
  return out;
}

/** Comment- and string-free-ish view: strips line/block comments so prose does not count. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The one process that declares a perimeter — every reachability question starts here. */
const MCP_ENTRY = 'cli/commands/mcp.ts';

/**
 * Every module the MCP server can reach by a static import, transitively.
 *
 * Deliberately CRUDE and deliberately WIDE: relative specifiers only, `.js` mapped
 * back to `.ts`, dynamic `import('./x.js')` counted the same as a static one (the
 * handlers use it constantly, and a hole reached lazily is still a hole). It will
 * over-approximate — a module pulled in for one pure helper counts as reachable — and
 * that is the safe direction: the cost of a false positive is one declared exception
 * with a reason, the cost of a false negative is what `api/audit.ts` did.
 *
 * What it does NOT see: a module reached only through a bare specifier that resolves
 * inside this package, and anything spawned as a separate process. Neither is a way of
 * hiding a `.openlore` join from review, but both are reasons not to describe this as
 * a proof of confinement.
 */
function mcpReachableModules(): Set<string> {
  const all = new Map<string, string>();
  for (const f of sourceFiles(SRC)) {
    if (!statSync(f).isFile()) continue;
    all.set(relative(SRC, f).split(sep).join('/'), readFileSync(f, 'utf-8'));
  }
  const resolveSpec = (from: string, spec: string): string | null => {
    const dir = from.split('/').slice(0, -1);
    const parts = [...dir, ...spec.split('/')];
    const stack: string[] = [];
    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    const base = stack.join('/');
    const candidates = base.endsWith('.js')
      ? [base.slice(0, -3) + '.ts', base.slice(0, -3) + '.mts', base]
      : [base, base + '.ts', base + '/index.ts'];
    return candidates.find(c => all.has(c)) ?? null;
  };
  const seen = new Set<string>();
  const stack = [MCP_ENTRY];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (seen.has(cur) || !all.has(cur)) continue;
    seen.add(cur);
    for (const m of code(all.get(cur) as string).matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const next = resolveSpec(cur, m[1]);
      if (next && !seen.has(next)) stack.push(next);
    }
  }
  return seen;
}

/**
 * Count lexical `.openlore` derivations. `join(o.rootPath, …)`, `resolve(dir,
 * '.openlore')` and a template literal are all the same shape; matching only
 * `join(<identifier>, OPENLORE_DIR` let each of the others through.
 */
function openloreDerivations(src: string): number {
  // The two `*_REL_PATH` constants are `.openlore/...` under another name; leaving
  // them out would have made the count honest-looking and wrong.
  // The first argument may itself be a CALL — `join(this.rootDir(), '.openlore', …)`.
  // The inherited `[^,)]+` could not cross a parenthesis, so that whole form was
  // invisible; one nesting level covers what actually occurs.
  const re = /(?:join|resolve)\s*\(\s*(?:[^,()]|\([^()]*\))+,\s*(?:OPENLORE_DIR|OPENLORE_ANALYSIS_REL_PATH|OPENLORE_CONFIG_REL_PATH|['"]\.openlore['"])|`[^`]*\$\{[^}]*\}\/\.openlore/g;
  return [...src.matchAll(re)].length;
}

/**
 * Lexical derivations that are allowed to stay, counted, with the reason each is
 * sound. The COUNT is part of the claim: adding a second join to a module that
 * legitimately has one fails this gate, which is the difference between a per-site
 * exception and the module-wide switch this replaced.
 */
const CONFIG_PATH_IS_TEXT =
  'A `configPath:` string stamped into an artifact header for a human to read. It is never opened, ' +
  'stat-ed or written; the artifact it appears in is itself written to a perimeter-derived path.';

const DERIVATION_EXCEPTIONS: Record<string, { sites: number; why: string }> = {
  [MCP_ENTRY]: {
    sites: 3,
    why: 'The module that DECLARES the perimeter. Two joins build the `--watch` probe path passed ' +
      'straight into isPathAllowed at startup (before and while the allowlist is being set up), and ' +
      'the third is the argument of the isPathAllowed call that decides whether panic state may be ' +
      'written. All three are inputs to the gate, not paths used behind its back.',
  },
  'cli/commands/serve.ts': {
    sites: 4,
    why: 'Reachable only as a MODULE: serve-client dynamically imports readDescriptor to reuse its ' +
      'strict parser. The joins belong to the daemon body (descriptor file, analysis dir), which runs ' +
      'in the `openlore serve` process — and an MCP server with a perimeter refuses at startup to ' +
      'spawn or delegate to a daemon, so that body never executes behind this boundary.',
  },
  'core/services/mcp-watcher.ts': {
    sites: 4,
    why: 'One string COMPARISON (usesStandardLayout), not a path that is opened, plus three ' +
      '`configPath:` strings stamped into artifact headers. The watcher derives its real target ' +
      'through ensureWriteDir, once per cycle.',
  },
  'core/decisions/anchor-adapter.ts': {
    sites: 1,
    why: 'The joined path is handed directly to openEdgeStoreForPerimeter, which asks the perimeter ' +
      'before opening and returns no store when refused; nothing else uses it.',
  },
  'core/services/mcp-handlers/epistemic-lease.ts': {
    sites: 1,
    why: 'Same single consumer: openEdgeStoreForPerimeter. Module tracking is advisory and returns [] ' +
      'when the store cannot be opened, so a refusal degrades instead of throwing.',
  },
  'core/analyzer/artifact-generator.ts': { sites: 1, why: CONFIG_PATH_IS_TEXT },
  'cli/commands/analyze.ts': { sites: 1, why: CONFIG_PATH_IS_TEXT },
  'api/analyze.ts': { sites: 1, why: CONFIG_PATH_IS_TEXT },
  'core/analyzer/repository-mapper.ts': {
    sites: 1,
    why: 'A DEFAULT for the outputDir option, used only by writeOutput — whose sole caller is the ' +
      'mapRepository convenience helper, which nothing in the tree calls. Under the analyzer the ' +
      'mapper is constructed with no outputDir and writes nothing.',
  },
};

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
    // `const { writeFileSync: putBytes } = await import('node:fs')` — destructuring
    // with rename. Neither the import-alias regex nor the variable-alias regex saw
    // it, and a probe planted this way passed the census green.
    for (const m of src.matchAll(/\{[^{}]*?\b([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)[^{}]*?\}\s*=/g)) {
      if (WRITE_PRIMITIVES.includes(m[1])) found.add(`${m[1]} destructured as ${m[2]}`);
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

  it('no module the MCP server can reach builds an .openlore path with a bare join', () => {
    // The exact shape every round of this review kept re-discovering. Handlers are
    // the MCP-reachable surface; they must go through the helper.
    //
    // Nor does it exempt "this module only READS". That exemption existed, it was
    // re-derived from the source and it was still a blindspot: `orient` joined
    // `.openlore` to read, handed the path to a store loader, and the loader renamed
    // the operator's file when the JSON was corrupt. "Reads only" is a claim about
    // THIS module, and the write happened one module over. There is now a read-side
    // helper (`openloreReadTarget`), so every `.openlore` derivation — read or write —
    // goes through the perimeter and the exemption has nothing left to justify.
    //
    // This check deliberately does NOT skip EXEMPT modules either. It used to, and
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
    // SCOPE IS REACHABILITY, NOT A LIST OF DIRECTORIES. The previous scope was four
    // directory prefixes, and on the real tree it caught NOTHING: of the 40 modules
    // that derive an `.openlore` path, 33 simply lived elsewhere — `api/`, `cli/`,
    // `core/analyzer/`, `core/verifier/`, `core/test-generator/`, `utils/`. That is
    // how `audit_spec_coverage` came to write into a read-only root through
    // `api/audit.ts`: the module was outside the sweep and carried an exemption
    // claiming it was unreachable from a server, while `mcp-handlers/analysis.ts`
    // imported it directly. "Which directory is it in" was never the question; "can
    // the MCP server get there" always was, and that is computable.
    const reachable = mcpReachableModules();
    expect(reachable.size, 'import-graph walk collected nothing — the scan is broken').toBeGreaterThan(50);

    // AND THE VERDICT IS PER OCCURRENCE. The previous rule was
    // `if (!joinsOpenlore || importsGuard(src)) continue` — one import of the guard
    // anywhere in a module excused every bare join in it. All three read escapes
    // (`graph.ts` → dependency-graph.json, `utils.ts` → mapping.json,
    // `analysis.ts` → llm-context.json) were invisible for exactly that reason, in
    // modules that DID import the guard and used it elsewhere. It is the same
    // module-wide off switch that used to live in EXEMPT and let `analyze_codebase`
    // through; it had only moved. So: count the derivations, and require the count to
    // be declared site by site with a reason someone can check.
    const offenders: string[] = [];
    for (const rel of [...reachable].sort()) {
      const found = openloreDerivations(code(readFileSync(join(SRC, rel), 'utf-8')));
      if (found === 0) continue;
      const allowed = DERIVATION_EXCEPTIONS[rel];
      if (!allowed) { offenders.push(`${rel} (${found}×, not declared)`); continue; }
      if (allowed.sites !== found) {
        offenders.push(`${rel} (${found}× on disk, ${allowed.sites}× declared — a new derivation was added)`);
      }
    }
    expect(
      offenders,
      'A module the MCP server can reach derives `<dir>/.openlore/…` lexically. Route it through ' +
      '`openloreReadTarget` / `openloreWriteTarget` (src/core/services/write-target.ts) — or, if the ' +
      'derivation genuinely never reaches the disk under a perimeter, declare it in ' +
      'DERIVATION_EXCEPTIONS with the reason:\n  ' + offenders.join('\n  '),
    ).toEqual([]);
  });

  it('every exemption held to be unreachable from a perimeter really is unreachable', () => {
    // The claim `CLI_NO_PERIMETER` is not decoration: it is what lets a module write
    // wherever it likes. Two modules carried it while `mcp-handlers/analysis.ts`
    // imported them by name — `api/audit.ts` (line 54) and `cli/commands/analyze.ts`
    // (line 34) — and one of them was writing into read-only roots in production.
    // Nobody had to lie for that: the claim was true when it was written and nothing
    // re-checked it. This does.
    const reachable = mcpReachableModules();
    const lying = Object.entries(EXEMPT)
      .filter(([f, why]) => why.startsWith(CLI_NO_PERIMETER) && reachable.has(f))
      .map(([f]) => f)
      .sort();
    expect(
      lying,
      'exempt as "not reachable from a perimeter-bearing server", yet reachable by import from ' +
      `${MCP_ENTRY}: ${lying.join(', ')}`,
    ).toEqual([]);
  });
});
