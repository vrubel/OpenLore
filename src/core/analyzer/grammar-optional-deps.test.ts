/**
 * Ensures every grammar loaded via loadGrammarSoft() is declared as an
 * optionalDependency in package.json, not a hard dependency.
 *
 * loadGrammarSoft = graceful failure at runtime → the package MUST be
 * optional at install time, or npm install will fail in restricted
 * environments (corporate proxy, TLS inspection, offline) when node-gyp
 * cannot fetch build headers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

function extractSoftLoadedPackages(): string[] {
  const src = readFileSync(join(ROOT, 'src', 'core', 'analyzer', 'call-graph.ts'), 'utf-8');
  // Match: loadGrammarSoft('X', () => import('tree-sitter-foo'), ...)
  const re = /loadGrammarSoft\('[^']+',\s*\(\)\s*=>\s*import\('(tree-sitter-[^']+)'\)/g;
  const packages: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    packages.push(m[1]);
  }
  return [...new Set(packages)];
}

describe('grammar optional dependencies', () => {
  it('every package loaded via loadGrammarSoft is in optionalDependencies', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const optional = new Set<string>(Object.keys(pkg.optionalDependencies ?? {}));
    const hardDeps = new Set<string>(Object.keys(pkg.dependencies ?? {}));

    const softLoaded = extractSoftLoadedPackages();
    expect(softLoaded.length).toBeGreaterThan(0); // regex sanity check

    const violations: string[] = [];
    for (const pkg of softLoaded) {
      if (hardDeps.has(pkg) && !optional.has(pkg)) {
        violations.push(pkg);
      }
    }

    expect(
      violations,
      `These packages are loaded via loadGrammarSoft() (graceful failure) but declared ` +
      `in "dependencies" (hard install). Move them to "optionalDependencies":\n` +
      violations.map(p => `  - ${p}`).join('\n')
    ).toEqual([]);
  });

  it('extractSoftLoadedPackages detects at least the known soft-loaded grammars', () => {
    const softLoaded = extractSoftLoadedPackages();
    // Kotlin is deliberately absent from this list on the fork line: the slim
    // series moved it to the WASM loader (native tree-sitter-kotlin ships no
    // prebuilt binary, so it never loaded under --ignore-scripts anyway). It is
    // still soft-loaded — just through the other mechanism, asserted below.
    const known = ['tree-sitter-bash', 'tree-sitter-c', 'tree-sitter-c-sharp'];
    for (const k of known) {
      expect(softLoaded, `Expected ${k} to be detected as soft-loaded`).toContain(k);
    }
  });

  it('the WASM path is soft too — the mechanism differs, the guarantee does not', () => {
    // Same install-time promise as loadGrammarSoft: a grammar that cannot be
    // resolved must degrade, never break `npm install` or the analyze run. Pinned
    // for Kotlin because it MOVED here from the native path — without this, the
    // list above shrinking would read as tightened scope rather than lost cover.
    const src = readFileSync(join(ROOT, 'src', 'core', 'analyzer', 'call-graph.ts'), 'utf-8');
    const wasmLoaded = [...src.matchAll(/loadWasmGrammarSoft\('([^']+)'/g)].map(m => m[1]);
    expect(wasmLoaded, 'Kotlin should be soft-loaded via the WASM loader').toContain('Kotlin');
  });
});
