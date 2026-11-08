/**
 * D3 (PDLC-2785), spec table: a record id is unique by construction — repeated
 * ids get a deterministic ordinal suffix at the producer — so no section is
 * dropped before publication. Non-Latin H2 headings all slug to an empty
 * section (`billing.`), which is what `openlore --lang ru generate` writes.
 * Ids that do not repeat stay exactly as before. The local writer refuses two
 * different records with one id instead of keeping one of them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecVectorIndex } from './spec-vector-index.js';
import { openStoredVectorIndex, publishVectorIndex } from './vector-store.js';

let root: string;
const out = () => join(root, 'analysis');
const specs = () => join(root, 'openspec', 'specs');

beforeEach(async () => {
  vi.stubEnv('QDRANT_URL', undefined);
  vi.stubEnv('OPENLORE_PINNED_INDEX', undefined);
  root = await mkdtemp(join(tmpdir(), 'ol-spec-ids-'));
  await mkdir(join(specs(), 'billing'), { recursive: true });
  await mkdir(out(), { recursive: true });
  await writeFile(join(specs(), 'billing', 'spec.md'), [
    '# Billing', '',
    '## Purpose', 'Charges customers.', '',
    '## Обзор', 'Обзор платёжного модуля overviewterm.', '',
    '## Контекст', 'Контекст и границы contextterm.', '',
    '## Requirements', '',
    '### Requirement: Charge', 'The system SHALL charge chargeterm.', '',
  ].join('\n'));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

const stored = async () => (await (await openStoredVectorIndex(join(out(), 'vector-index'), 'specs')).backend.loadAll())
  .map(row => ({ id: row.id as string, text: row.text as string }));

describe('D3: spec sections keep one record each', () => {
  it('two non-Latin H2 sections are both stored, under distinct ids', async () => {
    const result = await SpecVectorIndex.build(out(), specs(), null);
    const rows = await stored();

    expect(rows).toHaveLength(result.recordCount);
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
    expect(rows.some(row => row.text.includes('overviewterm'))).toBe(true);
    expect(rows.some(row => row.text.includes('contextterm'))).toBe(true);
    // First occurrence keeps the old id; the repeat gets an ordinal suffix.
    expect(rows.find(row => row.text.includes('overviewterm'))?.id).toBe('billing.');
    expect(rows.find(row => row.text.includes('contextterm'))?.id).toBe('billing.#2');
  });

  it('ids that do not repeat are unchanged', async () => {
    await SpecVectorIndex.build(out(), specs(), null);
    const ids = (await stored()).map(row => row.id);

    expect(ids).toEqual(expect.arrayContaining(['billing.purpose', 'billing.charge']));
  });

  it('the local writer refuses two different records with one id and publishes nothing', async () => {
    const db = join(out(), 'vector-index');
    await expect(publishVectorIndex(db, 'specs', [
      { id: 'billing.', text: 'overview', vector: [] },
      { id: 'billing.', text: 'context', vector: [] },
    ], null, null)).rejects.toThrow(/share the id "billing\."/);
    expect(await readdir(db).catch(() => [])).not.toContain('specs.index.json');
  });
});
