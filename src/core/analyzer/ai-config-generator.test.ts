/**
 * AI Config Generator Tests
 *
 * Tests for generateAiConfigs() using real filesystem temp dirs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateAiConfigs } from './ai-config-generator.js';

// ============================================================================
// HELPERS
// ============================================================================

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `ai-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ============================================================================
// TESTS
// ============================================================================

describe('generateAiConfigs', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('creates all 9 files when none exist and returns their relative paths', async () => {
    const results = await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.openlore/analysis',
      projectName: 'my-project',
    });

    const rels = results.map(r => r.rel);
    // 7 upstream targets + QWEN.md and GIGACODE.md, added by this fork when it
    // taught openlore the qwen and gigacode CLIs. The count is spelled out rather
    // than derived from the generator's own table on purpose: a silently dropped
    // target would then still pass.
    expect(results).toHaveLength(9);
    expect(results.every(r => r.created)).toBe(true);
    expect(rels).toContain('CLAUDE.md');
    expect(rels).toContain('AGENTS.md');
    expect(rels).toContain('.cursorrules');
    expect(rels).toContain('.clinerules/openlore.md');
    expect(rels).toContain('.github/copilot-instructions.md');
    expect(rels).toContain('.windsurf/rules.md');
    expect(rels).toContain('.vibe/skills/openlore.md');
    expect(rels).toContain('QWEN.md');
    expect(rels).toContain('GIGACODE.md');
  });

  it('skips files that already exist — all have created=false on second call', async () => {
    // First call creates all files
    await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.openlore/analysis',
      projectName: 'my-project',
    });

    // Second call: all files still returned, but created=false
    const results = await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.openlore/analysis',
      projectName: 'my-project',
    });

    expect(results).toHaveLength(9);
    expect(results.every(r => !r.created)).toBe(true);
  });

  it('respects tools filter — tools: ["claude"] creates only CLAUDE.md', async () => {
    const results = await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.openlore/analysis',
      projectName: 'my-project',
      tools: ['claude'],
    });

    expect(results).toHaveLength(1);
    expect(results[0].rel).toBe('CLAUDE.md');
    expect(results[0].created).toBe(true);
  });

  it('Claude format uses @analysisDir/CODEBASE.md reference', async () => {
    await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.openlore/analysis',
      projectName: 'my-project',
      tools: ['claude'],
    });

    const content = await readFile(join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('@.openlore/analysis/CODEBASE.md');
    // Should NOT use HTML comment
    expect(content).not.toContain('<!--');
  });

  it('a host-OS (Windows) analysisDir does not mint a two-dialect reference', async () => {
    // The caller hands over whatever `path` gave it, and on Windows that is
    // `.openlore\analysis`. The reference appends a literal `/CODEBASE.md`, so the file
    // used to end up with `@.openlore\analysis/CODEBASE.md` — one path in two dialects,
    // written once by writeIfAbsent and then committed for good.
    await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.openlore\\analysis',
      projectName: 'my-project',
      tools: ['claude', 'cursor'],
    });

    const claude = await readFile(join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('@.openlore/analysis/CODEBASE.md');
    expect(claude).not.toContain('\\');

    const cursor = await readFile(join(tmpDir, '.cursorrules'), 'utf-8');
    expect(cursor).toContain('.openlore/analysis/CODEBASE.md');
    expect(cursor).not.toContain('\\');
  });

  it('a trailing separator in analysisDir does not double up in the reference', async () => {
    await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: 'out/analysis/',
      projectName: 'my-project',
      tools: ['claude'],
    });

    const content = await readFile(join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('@out/analysis/CODEBASE.md');
    expect(content).not.toContain('//CODEBASE.md');
  });

  it('non-Claude format uses HTML comment reference', async () => {
    await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.openlore/analysis',
      projectName: 'my-project',
      tools: ['cursor'],
    });

    const content = await readFile(join(tmpDir, '.cursorrules'), 'utf-8');
    expect(content).toContain('<!-- Import or paste .openlore/analysis/CODEBASE.md here');
    expect(content).not.toContain('@.openlore/analysis/CODEBASE.md');
  });

  it('content contains project name', async () => {
    await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.openlore/analysis',
      projectName: 'awesome-app',
      tools: ['claude'],
    });

    const content = await readFile(join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('awesome-app');
  });

  it('content contains MCP workflow', async () => {
    await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.openlore/analysis',
      projectName: 'my-project',
      tools: ['cursor'],
    });

    const content = await readFile(join(tmpDir, '.cursorrules'), 'utf-8');
    expect(content).toContain('openlore MCP workflow');
    expect(content).toContain('orient');
    expect(content).toContain('search_code');
  });

  it('creates nested directory for .clinerules/openlore.md', async () => {
    const results = await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.openlore/analysis',
      projectName: 'my-project',
      tools: ['cline'],
    });

    expect(results[0].rel).toBe('.clinerules/openlore.md');
    expect(results[0].created).toBe(true);
    const content = await readFile(join(tmpDir, '.clinerules', 'openlore.md'), 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('creates nested directory for .github/copilot-instructions.md', async () => {
    const results = await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.openlore/analysis',
      projectName: 'my-project',
      tools: ['copilot'],
    });

    expect(results[0].rel).toBe('.github/copilot-instructions.md');
    expect(results[0].created).toBe(true);
    const content = await readFile(join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('empty tools: [] produces no files', async () => {
    const created = await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.openlore/analysis',
      projectName: 'my-project',
      tools: [],
    });

    expect(created).toHaveLength(0);
  });

  it('skips only pre-existing files, creates the rest', async () => {
    // Create only CLAUDE.md ahead of time
    await writeFile(join(tmpDir, 'CLAUDE.md'), 'existing content', 'utf-8');

    const results = await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.openlore/analysis',
      projectName: 'my-project',
    });

    // All 9 returned, CLAUDE.md has created=false, the rest created=true
    expect(results).toHaveLength(9);
    const claudeResult = results.find(r => r.rel === 'CLAUDE.md');
    expect(claudeResult?.created).toBe(false);
    expect(results.filter(r => r.created)).toHaveLength(8);

    // Existing file content should be unchanged
    const content = await readFile(join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toBe('existing content');
  });
});
