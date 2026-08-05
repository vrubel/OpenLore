/**
 * Capability Declaration and Accepted-Risk Register (spec: openspec/specs/mcp-security/spec.md).
 *
 * Validates schemas/security-capabilities.json — the machine-readable declaration
 * of the server's security-relevant capabilities — for shape, and keeps it in
 * sync with the code: every declared capability must be exercised by real code,
 * and no undeclared security-relevant capability (shell execution, novel egress)
 * may exist on the scanned server surface.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const SRC = join(REPO_ROOT, 'src');
const DECL_PATH = join(REPO_ROOT, 'schemas', 'security-capabilities.json');

const decl = JSON.parse(readFileSync(DECL_PATH, 'utf-8'));

function surfaceSources(): string[] {
  const out: string[] = [];
  for (const d of ['core', 'cli'].map(x => join(SRC, x))) {
    for (const f of readdirSync(d, { recursive: true, encoding: 'utf-8' })) {
      if (extname(f) === '.ts' && !f.includes('.test.')) out.push(join(d, f));
    }
  }
  return out;
}
const SURFACE = surfaceSources();
function surfaceText(): string {
  return SURFACE.map(f => readFileSync(f, 'utf-8')).join('\n');
}

// Scan CODE, not prose — TWIN of the scanner in mcp-handlers/security.test.ts; the two
// guards must see the same thing, so keep them in step.
//
// A grep over raw text indicts files whose COMMENTS merely discuss shells and trips on
// sentences like "WITHOUT a shell: git is invoked". But stripping comments by REGEX is
// worse: `"legacy/**"` in analyze.ts's help text opens a block comment that never closes
// nearby, and the stripper ate 548 of that file's 1031 lines — the declaration was being
// verified against half a file. Walk the source instead and step OVER string/template
// literals. Literal text is KEPT, not blanked: the shell-binary check matches on
// `execFileSync('sh', ['-c'`, which is all literals.
function codeOnly(src: string): string {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i], next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i];
        if (src[i] === c) { i++; break; }
        if (src[i] === '\n' && c !== '`') { i++; break; }  // unterminated quote: bail at EOL
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

describe('Capability declaration — shape (mcp-security)', () => {
  it('declares the required security-relevant capability categories', () => {
    expect(decl.tool).toBe('openlore');
    expect(decl.capabilities).toBeTruthy();
    for (const k of ['filesystem', 'subprocess', 'network', 'credentials', 'localDaemon']) {
      expect(decl.capabilities[k], `missing capabilities.${k}`).toBeTruthy();
    }
    expect(Array.isArray(decl.capabilities.filesystem.reads)).toBe(true);
    expect(Array.isArray(decl.capabilities.filesystem.writes)).toBe(true);
    expect(Array.isArray(decl.capabilities.network.allowedHosts)).toBe(true);
  });

  it('every accepted-risk entry names a source->sink pattern and justifies it', () => {
    expect(Array.isArray(decl.acceptedRisks)).toBe(true);
    expect(decl.acceptedRisks.length).toBeGreaterThan(0);
    for (const r of decl.acceptedRisks) {
      expect(r.id, 'risk entry needs an id').toBeTruthy();
      expect(r.pattern, `risk ${r.id} needs a source->sink pattern`).toMatch(/->/);
      expect(typeof r.why === 'string' && r.why.length > 20, `risk ${r.id} needs a real justification`).toBe(true);
    }
  });
});

describe('Capability declaration — matches observed behavior (mcp-security)', () => {
  it('declared subprocess spawns are exercised by real code (git)', () => {
    const bins = decl.capabilities.subprocess.spawns.map((s: { bin: string }) => s.bin);
    expect(bins.some((b: string) => b === 'git')).toBe(true);
    // git is genuinely spawned somewhere on the surface.
    expect(surfaceText()).toMatch(/(?:execFile|execFileSync|spawn|spawnSync)\(\s*['"`]git['"`]/);
  });

  it('declared egress hosts include the real configured-provider defaults', () => {
    const chatAgent = readFileSync(join(SRC, 'core', 'services', 'chat-agent.ts'), 'utf-8');
    const declared: string[] = decl.capabilities.network.allowedHosts;
    for (const host of ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com']) {
      expect(chatAgent, `provider default ${host} should exist in code`).toContain(host);
      expect(declared, `declaration must list provider host ${host}`).toContain(host);
    }
    // Loopback is declared (the local serve transport).
    expect(declared).toContain('127.0.0.1');
  });

  it('the no-shell claim holds: no unregistered shell on the core+cli surface', () => {
    // The declaration asserts argv-only subprocess on the server surface, with the
    // single registered Windows exception; verify exactly that. `shell:` set to
    // anything but the literal `false` counts — a conditional is still a shell where
    // the condition holds.
    const offenders: string[] = [];
    const SHELL_INVOKE = /(?:exec|execFile|execFileSync|spawn|spawnSync)\(\s*['"`](?:\/bin\/)?(?:sh|bash|zsh|dash)['"`]\s*,\s*\[\s*['"`]-c['"`]/;
    const SHELL_OPTION = /['"`]?shell['"`]?\s*:\s*(?!false\b)[A-Za-z_$(]/;
    const registered = new Set(['src/core/services/llm-service.ts']);
    for (const f of SURFACE) {
      const rel = f.replace(SRC, 'src');
      if (registered.has(rel)) continue;
      const src = codeOnly(readFileSync(f, 'utf-8'));
      if (SHELL_OPTION.test(src) || SHELL_INVOKE.test(src)) offenders.push(rel);
    }
    expect(offenders, `declaration claims no unregistered shell on surface, but found: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the Windows CLI-provider accepted-risk entry is justified by real code', () => {
    // Mirrors the src/pi check below: the register must not carry a justification for
    // code that no longer exists, and the code must not drift past what was justified
    // (constant argv, prompt over stdin, shell only on win32).
    const entry = decl.acceptedRisks.find((r: { id: string }) => r.id === 'windows-cli-provider-shim-shell');
    expect(entry, 'expected the windows-cli-provider-shim-shell entry').toBeTruthy();
    const llm = codeOnly(readFileSync(join(SRC, 'core', 'services', 'llm-service.ts'), 'utf-8'));
    const uses = [...llm.matchAll(/shell\s*:\s*([^,\n]+)/g)].map(m => m[1].trim());
    expect(uses.length, 'llm-service.ts should still use a Windows-gated shell').toBeGreaterThan(0);
    for (const use of uses) {
      expect(use, `shell must stay win32-gated, got \`shell: ${use}\``).toMatch(/^process\.platform\s*===\s*'win32'$/);
    }
    // The two shimmed CLIs are declared as spawned binaries.
    const bins: string = decl.capabilities.subprocess.spawns.map((s: { bin: string }) => s.bin).join(' ');
    for (const cli of ['qwen', 'gigacode']) {
      expect(bins, `declaration must list the ${cli} CLI provider`).toContain(cli);
    }
  });

  it('the Windows-launcher accepted-risk entry is justified by real code in src/pi', () => {
    // The entry exists precisely because src/pi/extension.ts uses shell:true with
    // fixed args. If that code is removed, the register entry is stale — fail so it
    // gets pruned (the register must not carry phantom justifications).
    const entry = decl.acceptedRisks.find((r: { id: string }) => r.id === 'windows-extension-launcher-shell');
    expect(entry, 'expected the windows-extension-launcher-shell entry').toBeTruthy();
    const piExt = readFileSync(join(SRC, 'pi', 'extension.ts'), 'utf-8');
    expect(piExt, 'src/pi/extension.ts should still use shell:true (justifying the entry)').toMatch(/shell\s*:\s*true/);
  });
});
