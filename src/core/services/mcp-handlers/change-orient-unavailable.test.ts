/**
 * PDLC-2785 D12: generate_change_proposal and annotate_story against the REAL orient.
 *
 * change.test.ts mocks orient's shape; this file does not. Orient used to throw or
 * return `error` when the code index was unavailable, and both handlers reported
 * that in `orientErrors`. Now orient answers with `indexes.functions.mode:
 * 'unavailable'` and empty lists, and `orientErrors` came back empty: a proposal
 * built with no code context read as a clean run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleGenerateChangeProposal, handleAnnotateStory } from './change.js';

let repo: string;
beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'ol-change-orient-')));   // no search table published
  vi.stubEnv('EMBED_BASE_URL', '');
  vi.stubEnv('EMBED_MODEL', '');
  vi.stubEnv('QDRANT_URL', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(repo, { recursive: true, force: true });
});

describe('orient consumers in change.ts see an unavailable code index', () => {
  it('generate_change_proposal reports the reason in orientErrors', async () => {
    const result = await handleGenerateChangeProposal(repo, 'Add payment retry', 'add-payment-retry') as
      { orientErrors: string[]; functionsFound: number };
    expect(result.functionsFound).toBe(0);
    expect(result.orientErrors).toHaveLength(1);
    expect(result.orientErrors[0]).toMatch(/No saved search index/);
  });

  it('annotate_story reports the reason in orientErrors', async () => {
    mkdirSync(join(repo, 'stories'), { recursive: true });
    writeFileSync(join(repo, 'stories', 'US-1.md'), '# US-1\n\n## Tasks\n\n- [ ] do it\n');
    const result = await handleAnnotateStory(repo, 'stories/US-1.md', 'Add payment retry') as
      { orientErrors: string[]; functionsFound: number };
    expect(result.functionsFound).toBe(0);
    expect(result.orientErrors).toHaveLength(1);
    expect(result.orientErrors[0]).toMatch(/No saved search index/);
  });
});
