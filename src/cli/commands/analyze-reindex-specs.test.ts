/**
 * `analyze --reindex-specs` binds the spec generation to the published analysis
 * (PDLC-2785, D14).
 *
 * The full analyze path hands `publishedAnalysisFingerprint(outputPath)` to the index
 * writers (`runEmbedStep`); the `--reindex-specs` fast path called the same spec
 * writer without it, so the descriptor said `analysis_fingerprint: null` and a pinned
 * reader refuses such a generation. Real filesystem on purpose: the fingerprint is
 * read synchronously from disk, and analyze-no-embed.test.ts stubs `fs/promises`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeCommand } from './analyze.js';
import { _resetRootAllowlistForTesting } from '../../core/services/mcp-handlers/root-allowlist.js';

const FINGERPRINT = 'a'.repeat(64);

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ol-reindex-specs-')));
  mkdirSync(join(root, '.openlore', 'analysis'), { recursive: true });
  writeFileSync(join(root, '.openlore', 'config.json'), JSON.stringify({
    version: '1.0.0', projectType: 'library', openspecPath: 'openspec',
    analysis: { maxFiles: 1000, includePatterns: [], excludePatterns: [] },
    generation: { model: 'x', domains: 'auto' },
    createdAt: new Date().toISOString(), lastRun: null,
  }));
  // The published analysis this spec generation must be anchored to.
  writeFileSync(join(root, '.openlore', 'analysis', 'fingerprint.json'), JSON.stringify({ hash: FINGERPRINT }));
  mkdirSync(join(root, 'openspec', 'specs', 'auth'), { recursive: true });
  writeFileSync(join(root, 'openspec', 'specs', 'auth', 'spec.md'),
    '# Auth\n\n## Purpose\n\nAuthenticate users.\n\n## Requirements\n\n### Requirement: Login\n\n' +
    'The system SHALL authenticate a user by token.\n\n#### Scenario: valid token\n\n- **WHEN** a valid token is sent\n- **THEN** the user is authenticated\n');
  vi.stubEnv('EMBED_BASE_URL', '');
  vi.stubEnv('EMBED_MODEL', '');
  vi.stubEnv('EMBEDDER_URL', '');
  vi.stubEnv('QDRANT_URL', '');
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  _resetRootAllowlistForTesting();
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('analyze --reindex-specs', () => {
  it('публикует поколение спецификаций с отпечатком опубликованного анализа', async () => {
    await analyzeCommand.parseAsync(['--reindex-specs'], { from: 'user' });
    expect(process.exitCode).toBeUndefined();

    const descriptor = JSON.parse(readFileSync(join(root, '.openlore', 'analysis', 'vector-index', 'specs.index.json'), 'utf8'));
    expect(descriptor.table).toBe('specs');
    expect(descriptor.count).toBeGreaterThan(0);
    expect(descriptor.analysis_fingerprint).toBe(FINGERPRINT);
  });
});
