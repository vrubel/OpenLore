/**
 * READING OUT OF THE PERIMETER THROUGH `<root>/.openlore`.
 *
 * The served root is genuine; the escape is one level in. `<root>/.openlore` is a
 * symlink to a directory nobody granted, and every handler that named its artifact
 * with a lexical `join` read that directory instead — answering about a repository
 * the operator never declared, with file names, symbols and import edges included.
 *
 * Demonstrated on the previous revision: `get_file_dependencies` returned
 * `SECRET-NEIGHBOUR-FILE.ts` / `SECRET_SYMBOL` from a tree outside every root. The
 * same layout served `search_code`, `get_spec`, `search_specs` and `unified_search`
 * (all through `mapping.json`) and `get_function_body` (through `llm-context.json`).
 *
 * These tests place that exact layout and demand a REFUSAL — not an empty answer.
 * "No dependency graph found" would be a pass for a test that only checked the secret
 * did not come back, and it is exactly what the swallowing `catch` used to produce,
 * so each expectation names the perimeter marker.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureRootAllowlist,
  _resetRootAllowlistForTesting,
  PERIMETER_REFUSAL_MARKER,
} from './root-allowlist.js';
import { handleGetFileDependencies } from './graph.js';
import { handleGetFunctionBody } from './analysis.js';
import { loadMappingIndex } from './utils.js';

let root: string;
let secret: string;

const SECRET_FILE = 'SECRET-NEIGHBOUR-FILE.ts';

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ol-readescape-')));
  secret = realpathSync(mkdtempSync(join(tmpdir(), 'ol-readescape-secret-')));

  // The neighbour's analysis tree — a complete, valid set of artifacts, so that
  // nothing but the perimeter can be what stops the handlers from reading it.
  const analysis = join(secret, 'analysis');
  mkdirSync(analysis, { recursive: true });
  writeFileSync(join(analysis, 'dependency-graph.json'), JSON.stringify({
    nodes: [
      { id: 'n1', file: { path: 'src/app.ts', absolutePath: join(secret, 'src/app.ts') } },
      { id: 'n2', file: { path: SECRET_FILE, absolutePath: join(secret, SECRET_FILE) } },
    ],
    edges: [{ source: 'n1', target: 'n2', importedNames: ['SECRET_SYMBOL'], isTypeOnly: false, weight: 1 }],
  }));
  writeFileSync(join(analysis, 'mapping.json'), JSON.stringify({
    mappings: [{ requirement: 'SECRET-REQ', domain: 'secret', specFile: 'secret.md', functions: [{ name: 'secretFn', file: SECRET_FILE }] }],
  }));
  writeFileSync(join(analysis, 'llm-context.json'), JSON.stringify({
    callGraph: { nodes: [{ name: 'secretFn', filePath: 'src/app.ts', startIndex: 0, endIndex: 20, language: 'typescript' }] },
  }));

  // The served repository: real, granted — and hollow. Its `.openlore` is the link.
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export const local = 1;\n');
  symlinkSync(secret, join(root, '.openlore'), 'dir');

  configureRootAllowlist({ readRoots: [root], writeRoots: [root] });
});

afterEach(() => {
  _resetRootAllowlistForTesting();
  rmSync(root, { recursive: true, force: true });
  rmSync(secret, { recursive: true, force: true });
});

/** The refusal, however the handler chooses to deliver it (throw or `{ error }`). */
async function refusalFrom(call: () => Promise<unknown>): Promise<string> {
  try {
    const res = await call();
    const err = (res as { error?: unknown } | null)?.error;
    return typeof err === 'string' ? err : `NO REFUSAL — handler returned: ${JSON.stringify(res).slice(0, 400)}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe('a symlinked .openlore does not turn a granted root into a window on another repository', () => {
  it('get_file_dependencies refuses instead of serving the neighbour import graph', async () => {
    const msg = await refusalFrom(() => handleGetFileDependencies(root, 'src/app.ts', 'both'));
    expect(msg).toContain(PERIMETER_REFUSAL_MARKER);
    expect(msg).not.toContain('SECRET_SYMBOL');
    expect(msg).not.toContain(SECRET_FILE);
  });

  it('get_function_body refuses instead of slicing the neighbour call graph', async () => {
    const msg = await refusalFrom(() => handleGetFunctionBody(root, 'src/app.ts', 'secretFn'));
    expect(msg).toContain(PERIMETER_REFUSAL_MARKER);
  });

  it('the mapping index behind search_code / get_spec / search_specs refuses', async () => {
    // Not "returns null": null is what an absent index looks like, and the handlers
    // above it degrade quietly on null. A refusal must be distinguishable from a repo
    // that was simply never analysed.
    const msg = await refusalFrom(() => loadMappingIndex(root) as Promise<unknown>);
    expect(msg).toContain(PERIMETER_REFUSAL_MARKER);
    expect(msg).not.toContain('SECRET-REQ');
  });

  it('the same handlers work normally when .openlore is a real directory in the root', async () => {
    rmSync(join(root, '.openlore'), { force: true });
    const analysis = join(root, '.openlore', 'analysis');
    mkdirSync(analysis, { recursive: true });
    writeFileSync(join(analysis, 'dependency-graph.json'), JSON.stringify({
      nodes: [{ id: 'n1', file: { path: 'src/app.ts', absolutePath: join(root, 'src/app.ts') } }],
      edges: [],
    }));

    const res = await handleGetFileDependencies(root, 'src/app.ts', 'both') as Record<string, unknown>;
    expect(JSON.stringify(res)).not.toContain(PERIMETER_REFUSAL_MARKER);
  });
});
