import { join } from 'node:path';
import { EmbeddingService } from './embedding-service.js';
import { readOpenLoreConfig } from '../services/config-manager.js';
import { openloreReadTarget } from '../services/write-target.js';
import {
  IndexUnavailable, indexIssue, openStoredVectorIndex,
  type BackendKind, type IndexIdentity, type IndexIssue, type IndexTable, type StoredIndex,
} from './vector-store.js';

export interface IndexCapability {
  mode: 'text' | 'semantic' | 'unavailable';
  backend: BackendKind | null;
  identity: IndexIdentity | null;
  reason: IndexIssue | null;
}

export type SearchStatus = (capability: IndexCapability) => void;

export async function configuredEmbedder(root: string): Promise<EmbeddingService | null> {
  try {
    return EmbeddingService.fromEnv();
  } catch {
    const config = await readOpenLoreConfig(root);
    return config ? EmbeddingService.fromConfig(config) : null;
  }
}

export function unavailableIndex(error: unknown): IndexCapability {
  return {
    mode: 'unavailable', identity: null, reason: indexIssue(error),
    backend: error instanceof IndexUnavailable ? error.backend : null,
  };
}

function available(index: StoredIndex, embedder: EmbeddingService | null | undefined): IndexCapability {
  const identity = index.identity;
  const reason = identity.dim > 0 && (!embedder?.modelName || identity.model !== embedder.modelName)
    ? { code: 'embedding-mismatch' as const, message: 'The configured embedding model is unavailable or differs from this index. Keyword search is available.' }
    : null;
  return {
    mode: identity.dim > 0 && !reason ? 'semantic' : 'text',
    backend: index.kind, identity, reason,
  };
}

/** Select the real query mode. Embedding errors can still leave this same corpus searchable by BM25. */
export async function searchVector(
  index: StoredIndex, query: string, embedder: EmbeddingService | null | undefined, status?: SearchStatus,
): Promise<number[] | null> {
  const capability = available(index, embedder);
  if (capability.mode === 'text' || !embedder) {
    status?.(capability);
    return null;
  }
  let vector: number[] | undefined;
  try {
    [vector] = await embedder.embed([query]);
  } catch {
    status?.({
      ...capability, mode: 'text',
      reason: { code: 'backend-unreachable', message: 'The embedding backend could not embed this query. Keyword search is available.' },
    });
    return null;
  }
  if (vector?.length !== index.identity.dim || !vector.every(value => Number.isFinite(value))) {
    status?.({
      ...capability, mode: 'text',
      reason: { code: 'embedding-mismatch', message: 'The query vector does not match the saved index dimension. Keyword search is available.' },
    });
    return null;
  }
  status?.(capability);
  return vector;
}

export async function searchWithStatus<T>(
  search: (status: SearchStatus) => Promise<T[]>,
): Promise<{ results: T[]; index?: IndexCapability }> {
  let index: IndexCapability | undefined;
  try {
    const results = await search(value => { index = value; });
    return { results, index };
  } catch (error) {
    return { results: [], index: unavailableIndex(error) };
  }
}

const TABLES: IndexTable[] = ['functions', 'specs', 'text_lines'];

export async function inspectSearchIndexes(root: string, pinned: boolean) {
  const output = openloreReadTarget(root, 'analysis');
  const signal = AbortSignal.timeout(4000);
  const embedder = await configuredEmbedder(root).catch(() => null);
  const entries = await Promise.all(TABLES.map(async table => {
    const dir = table === 'text_lines' ? 'text-line-index' : 'vector-index';
    try {
      const index = await openStoredVectorIndex(join(output, dir), table, { pinned, signal });
      return [table, available(index, embedder)] as const;
    } catch (error) {
      return [table, unavailableIndex(error)] as const;
    }
  }));
  return { schema_version: 1, indexes: Object.fromEntries(entries) };
}
