/**
 * FileBackend — корпус индекса без lancedb и без Qdrant.
 *
 * Отдельный юнит-тест нужен потому, что в dev-окружении форка установлен
 * @lancedb, и авто-выбор бэкенда отдаёт Lance: тесты vector-index/text-line-index
 * этот класс не задевают вовсе, хотя в слим-дистрибутиве (инсталлятор PDLC сносит
 * @lancedb) работает именно он.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileBackend, type VectorRecord } from './vector-store.js';

const rec = (id: string, text: string, vector: number[] = []): VectorRecord => ({ id, text, vector });

describe('FileBackend', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ol-filebackend-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips records through build/loadAll', async () => {
    const backend = new FileBackend(dir, 'corpus');
    await backend.build([rec('a', 'alpha', [0.5, -0.25]), rec('b', 'beta')]);

    const rows = await backend.loadAll();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'a', text: 'alpha' });
    expect(rows[0].vector).toEqual([0.5, -0.25]);
    expect(rows[1]).toMatchObject({ id: 'b', text: 'beta' });
  });

  it('writes NDJSON — one record per line, never one big string', async () => {
    // The whole point: a single JSON.stringify over the corpus hit the V8 string
    // ceiling from ~12 600 files on the text-line index, and the overflow was
    // swallowed by the caller — analyze "succeeded" with no index at all.
    const backend = new FileBackend(dir, 'corpus');
    await backend.build([rec('a', 'alpha'), rec('b', 'beta'), rec('c', 'gamma')]);

    const raw = await readFile(join(dir, 'corpus.records.json'), 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(raw.startsWith('[')).toBe(false);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('still reads a legacy single-array corpus written before NDJSON', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'corpus.records.json'),
      JSON.stringify([rec('old', 'legacy', [1, 2])]),
      'utf-8'
    );

    const rows = await new FileBackend(dir, 'corpus').loadAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'old', text: 'legacy' });
    expect(rows[0].vector).toEqual([1, 2]);
  });

  it('overwrites on rebuild rather than appending', async () => {
    const backend = new FileBackend(dir, 'corpus');
    await backend.build([rec('a', 'alpha'), rec('b', 'beta')]);
    await backend.build([rec('c', 'gamma')]);

    const rows = await backend.loadAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'c' });
  });

  it('handles an empty corpus and a missing file', async () => {
    const backend = new FileBackend(dir, 'corpus');
    expect(await backend.loadAll()).toEqual([]);   // файла ещё нет
    expect(backend.exists()).toBe(false);

    await backend.build([]);
    expect(backend.exists()).toBe(true);
    expect(await backend.loadAll()).toEqual([]);
  });

  it('leaves no temp file behind after build', async () => {
    const backend = new FileBackend(dir, 'corpus');
    await backend.build([rec('a', 'alpha')]);

    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).filter(f => f.includes('.tmp'))).toEqual([]);
  });
});
