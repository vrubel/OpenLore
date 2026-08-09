/**
 * A TOOL PUBLISHED AS READ-ONLY MUST NOT WRITE INTO A READ-ONLY ROOT.
 *
 * `audit_spec_coverage` is absent from `WRITING_TOOLS` and is advertised to clients
 * with a read-only annotation, so the transport asks the perimeter for READ on the
 * `directory` it is given. It then called `openloreAudit({ save: true })` with the
 * flag hardcoded, and two files appeared inside a repository the operator had granted
 * on read alone: `.openlore/analysis/audit-report.json` and `spec-snapshot.json`.
 * Found by calling all 52 non-writing tools against a read-only root and diffing the
 * tree afterwards, which is what this test does in miniature.
 *
 * The fix is deliberately NOT "reclassify it as a writer": a read-only server should
 * still be able to report coverage. Persisting is what needs the grant.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureRootAllowlist, _resetRootAllowlistForTesting, WRITING_TOOLS } from './root-allowlist.js';
import { handleAuditSpecCoverage } from './analysis.js';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ol-audit-ro-')));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export const local = 1;\n');
  // A minimal analysis tree, so the audit has something to report on and cannot be
  // passing merely because it bailed out early.
  const analysis = join(root, '.openlore', 'analysis');
  mkdirSync(analysis, { recursive: true });
  writeFileSync(join(analysis, 'llm-context.json'), JSON.stringify({
    callGraph: { nodes: [{ id: 'f1', name: 'local', filePath: 'src/app.ts', fanIn: 0, fanOut: 0 }], hubFunctions: [] },
  }));
  writeFileSync(join(analysis, 'mapping.json'), JSON.stringify({ mappings: [] }));
});

afterEach(() => {
  _resetRootAllowlistForTesting();
  rmSync(root, { recursive: true, force: true });
});

const analysisFiles = (): string[] => readdirSync(join(root, '.openlore', 'analysis')).sort();

describe('audit_spec_coverage on a root granted for reading only', () => {
  it('is not classified as a writer — which is precisely why it must not write', () => {
    expect(WRITING_TOOLS.has('audit_spec_coverage')).toBe(false);
  });

  it('returns the report and creates no file in the repository', async () => {
    const before = analysisFiles();
    configureRootAllowlist({ readRoots: [root], writeRoots: [] });

    const res = await handleAuditSpecCoverage(root) as Record<string, unknown>;

    expect(res.error, `the audit must still answer on a read-only root: ${String(res.error)}`).toBeUndefined();
    expect(res.summary, 'the report itself must be complete').toBeDefined();
    // …and it must SAY it withheld the file, because a silently missing artifact is
    // indistinguishable from a bug in whatever was going to consume it.
    expect(res.saved).toBe(false);
    expect(String(res.savedSkippedReason)).toMatch(/READ only/i);

    expect(analysisFiles(), 'audit_spec_coverage wrote into a read-only root').toEqual(before);
    expect(existsSync(join(root, '.openlore', 'analysis', 'audit-report.json'))).toBe(false);
    expect(existsSync(join(root, '.openlore', 'analysis', 'spec-snapshot.json'))).toBe(false);
  });

  it('still persists both artifacts when the root IS writable', async () => {
    configureRootAllowlist({ readRoots: [root], writeRoots: [root] });

    const res = await handleAuditSpecCoverage(root) as Record<string, unknown>;

    expect(res.error).toBeUndefined();
    expect(res.saved, 'a writable root must not be told the write was withheld').toBeUndefined();
    expect(analysisFiles()).toContain('audit-report.json');
    expect(analysisFiles()).toContain('spec-snapshot.json');
  });
});
