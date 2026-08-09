# Changelog

All notable changes to OpenLore are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **The MCP server now has a filesystem perimeter, closed by default — a behaviour
  change for every existing `openlore mcp` user.** Previously a server started for
  one repository answered, in full, about any absolute path on the machine: all 62
  tools take a `directory`, and the only check it met was "does this resolve to an
  existing directory". The perimeter was held by the agent not knowing the
  neighbours' paths, and openlore itself hands those out through the federation
  registry — so it was not held at all.

  Roots are declared at start: `--root <path>` (readable, repeatable) and
  `--write-root <path>` (writable, repeatable, must be inside a read root).
  **Defaults: read = the working directory; write = the working directory when it
  lies inside a read root, otherwise nothing.** A repository granted for reading
  never becomes writable by implication, so serving neighbours with several
  `--root` flags cannot silently make them writable. The perimeter is printed to
  stderr at startup.

  Enforcement stands where the disk is touched, not only where a request arrives:
  in `validateDirectory`; on the transport before telemetry, daemon resolution,
  panic state, watcher adoption or any `git` spawn; on paths taken from
  `.openlore/config.json` (`specStore.path` is caller input — the config sits in a
  root the caller can write); and at each write performed during a read. The
  call-graph index is no longer opened for writing in a read-only repository
  (opening it ran `PRAGMA journal_mode = WAL`, `CREATE TABLE`, and on a schema bump
  `DROP TABLE` over someone else's index) — it is opened `immutable`, leaving no
  `-wal`/`-shm` behind, and any withheld capability is reported rather than
  silently degraded.

  Refusals are uniform: a path outside the roots gets the same answer whether it
  exists, is absent, or is a file, reached directly or through a symlink inside an
  allowed root. Canonicalization fails closed, and the canonical path is what the
  check returns and callers use, so a symlink swapped after the check cannot move
  the target. Enumerating responses (`federation_status`, `spec_store_status`, and
  every `federation: true` query) withhold members outside the read roots and
  report how many were withheld.

  **What may need adjusting.** A server that must serve more than its working
  directory needs explicit `--root` flags — notably an isolated agent whose
  `directory` is a scratch dir distinct from the analysis root, and cross-repo
  federation over neighbouring repositories. `openlore mcp --daemon` is refused
  while a perimeter is configured, and an already-running `openlore serve` daemon
  is no longer delegated to: that daemon carries no allowlist and is discovered
  through a file inside the perimeter. `--watch <dir>` now implies a root and must
  lie inside the declared ones.

  The allowlist applies to the MCP server only. CLI commands declare none, so
  `openlore federation add <path>` and every other command are unchanged.

- **`change_impact_certificate` is no longer annotated read-only.** It writes a
  certificate file when `persist: true`. The mutator gate that trusted the
  annotations listed eight tools while ten write; the list is now explicit and a
  test keeps it and the annotations in agreement in both directions.


### Removed

- **The unused `memfs` devDependency is gone, and with it the entire
  `@jsonjoy.com/*` subtree** (ru line). This supersedes the 4.64.0 pin below and
  closes the failure class for good rather than until the next version surfaces
  in a mirror: a dependency that is not installed cannot demand a version nobody
  has. `memfs` was never imported — verified across the whole repository, not
  just `src/`: sources, tests, fixtures, mocks, the `vitest` configs (their only
  alias is `@` → `./src`; `fs` is never substituted), build scripts and both CI
  workflows. No memfs companion (`fs-monkey`, `unionfs`, `vol.fromJSON`,
  `createFsFromVolume`) appears either, and the lockfile named the root as its
  sole consumer. Dropping it removes 26 lock entries — the eight
  `@jsonjoy.com/fs-*` packages, their `@jsonjoy.com` support packages, and
  `memfs`'s own companions (`thingies`, `tree-dump`, `hyperdyperid`,
  `glob-to-regex.js`) — so the `overrides` added for `@jsonjoy.com/fs-*` are
  dropped as well: with no consumer left they pinned nothing. A clean install in
  an empty directory, via `npm ci` and via the `--no-package-lock` path the
  installer actually uses, now unpacks **zero** `@jsonjoy.com` directories. Unit
  tests are unchanged from the baseline: 8 failing / 4451 passing.

### Fixed

- **Install no longer fails on registries that lag npmjs: `@jsonjoy.com/fs-*`
  pinned to 4.64.0** (ru line, superseded by the removal above — kept for the
  record, since v2.1.3-ru12 shipped with it). The dev-only `memfs` dependency was a floating
  `^4.15.0`, and every `memfs` release hard-pins its eight `@jsonjoy.com/fs-*`
  companions to its own exact version. Since the fork is installed with
  `npm install --no-package-lock` (the lockfile is deliberately bypassed — the
  build strips lint devDeps from `package.json` first, which would make `npm ci`
  fail on a lock mismatch), `memfs` re-resolved to whatever was newest on every
  install: it reached 4.66.1 and demanded `@jsonjoy.com/fs-node@4.66.1`, which a
  mirrored/air-gapped registry did not carry (its newest was 4.64.0) → `ETARGET`,
  and the whole install died. `memfs` is now an exact `4.64.0`, and all eight
  `@jsonjoy.com/fs-*` packages are additionally nailed to `4.64.0` via
  `overrides`, so neither a direct nor a transitive path can drift upward again.
  Same class of failure as the lint-stack strip on the PDLC side. `memfs` itself
  is not imported anywhere in the source tree — the dependency is inert, only its
  resolution mattered.

### Added

- **`openlore reindex` — one-shot incremental delta catch-up** (ru line). Brings
  the code knowledge base current for only the files that changed since the last
  analysis — WITHOUT a full `analyze --force` and WITHOUT a long-lived watcher. It
  computes the delta from git and drives the same incremental pipeline the MCP
  watch mode uses (a new public `McpWatcher.reindexDelta({changed, deleted})`),
  so freshness is O(change), not O(repo): per-file call-graph swap (incl.
  cross-file caller edges), signatures, text-line + dependency-edge lanes, and an
  incremental vector update (`--no-embed` to skip). The batch-mode counterpart to
  `openlore mcp --watch-auto` (Spec 13.1) — the right fit for discrete,
  between-run refreshes (e.g. a control plane re-indexing a target after pulling
  new commits). Base ref precedence: `--since <ref>` > last reindex marker
  (`.openlore/analysis/reindex-state.json`) > the commit `analyze` stamped in
  `fingerprint.json` > HEAD; the analysis dir (`.openlore/`) is never re-indexed.
  Precondition: a prior `analyze` (fails loud if the base index is missing) — it
  is a delta catch-up, not a cold build. Boundary (by design): repo-LEVEL
  aggregates (architecture pattern, domains, high-value ranking) are whole-tree
  derivations and refresh on the next full `analyze --force` "by cadence".

## [2.1.3] - 2026-06-22

Everything merged since v2.1.2: a batch of new agent-facing capabilities plus a
deep end-to-end hardening and dogfooding pass. The version is read from
`package.json`, so the CLI and the MCP server both report `2.1.3`.

### Added

- **Agent behavioral governance ("panic")** — opt-in, off by default (#175). A
  PreToolUse destabilization guard (`openlore panic-check`), an observe→memory
  feedback loop that feeds behavioral hotspots into `orient`, an optional Gryph
  runtime observer, and an accuracy-validation harness
  (`panic-validate` / `panic-calibrate` / `panic-replay`). Enable per project with
  `openlore setup --panic <mode>` and install the hooks with
  `openlore setup --hooks <format>` (remove them with `--hooks none`).
- **External spec-store binding** — the `spec_store_status` MCP tool (federation
  preset) reports the read-only health of a `.openlore/config.json` `specStore`
  binding and its indexed targets (#178).
- **Working-set context briefing** — the `working_set_context` MCP tool assembles
  one token-budgeted, per-target structural briefing for an active change across
  its spec-store targets (#180).
- **Change-impact certificate** — the `change_impact_certificate` MCP tool and the
  `openlore impact-certificate` CLI certify what a diff touches: the paths it
  newly opens into declared covering surfaces (differential, no LLM), blast
  radius, drifted specs, and the tests to run (#181).
- **Live dependency graph in watch mode** — `watch` now reconciles file creates &
  deletes and keeps `dependency-graph.json` import edges (including inline
  `<script>` and HTML asset edges) fresh incrementally (#173).
- **Pi extension** — marketplace gallery preview image (#174); Windows daemon
  hardening so no console window flashes (#177).

### Changed

- Removed the `get_decisions` MCP tool. ADRs are now surfaced through
  `search_specs` (domain `decisions`) and via `orient`'s ADR matches, which now
  work without an embedding server (#179).
- `.mjs` / `.cjs` / `.mts` / `.cts` files are now recognized as JavaScript /
  TypeScript and included in the call graph and signature index (previously
  silently dropped).
- Panic-state: the on-disk file is the single source of truth for the
  cross-process intervention counter; all writers (MCP server, hook, daemon)
  serialize through one lock.
- Documentation: Windows setup steps in CONTRIBUTING (#176); corrected and guarded
  MCP tool-count references.

### Fixed

End-to-end hardening pass (PR #182), all with regression tests:

- **First run** — `openlore init` and `openlore run` now create `.gitignore` on a
  fresh `git init` repo, so `.openlore/` analysis artifacts (multi-MB lance
  binaries) aren't accidentally committed and don't pollute diff-based tools.
- **MCP no-throw / robustness** — `get_spec` confines its `domain` argument
  (path-traversal fix); `get_file_dependencies` guards a partial dependency-graph
  artifact; `change_impact_certificate` drops non-object surface members and
  `buildLeaseAnchors` never escapes the handler; a malformed `callGraph` is
  normalized instead of crashing graph handlers; large tool results stay valid
  JSON when capped to the byte budget.
- **LLM generation** — all providers tolerate malformed or `usage`-less responses
  (common with OpenAI-compatible gateways) instead of crashing or reporting `$NaN`
  cost.
- **Panic** — fixed a cross-process lost-update on the intervention counter;
  untrusted `panic-state.json` fields are sanitized and a NaN timestamp is treated
  as expired; panic hooks gained an uninstall path and update in place on a format
  change.
- **Multi-repo federation** — a registered repo that throws mid-query is skipped
  with a reason instead of aborting the whole fleet query; tool output no longer
  leaks absolute host paths.
- **CLI** — `verify --json` and `decisions --sync` now exit non-zero on failure
  (they previously reported failure but exited 0, defeating CI gates); `decisions`
  has a top-level error boundary; `openlore view` reports a friendly message on a
  port-in-use, sanitizes errors before logging, and serves a 404 (not 500) for a
  missing graph artifact.

**Full Changelog**: https://github.com/clay-good/OpenLore/compare/v2.1.2...v2.1.3
