/**
 * Re-attach the call graph to a context read from `llm-context.json` (PDLC-156).
 *
 * The graph used to be serialized INTO that artifact — 86–91% of its bytes, and
 * the whole of its growth curve against the V8 string ceiling. It is written to
 * `call-graph.db` by the same analyze run, so the artifact now carries none of it
 * and readers attach it from the store instead.
 *
 * Every consumer that reads the artifact off disk goes through here, so there is
 * ONE place that knows where the graph lives. The MCP server has its own
 * long-lived variant (`mcp-handlers/utils.attachCallGraph`) that keeps the store
 * handle open across requests; this one is for the one-shot CLI/API readers and
 * owns the handle for the duration of a single materialization.
 */

import { existsSync } from 'node:fs';
import { EdgeStore } from './edge-store.js';
import type { SerializedCallGraph } from '../analyzer/call-graph.js';
import { logger } from '../../utils/logger.js';
import { openEdgeStoreForPerimeter } from './edge-store-access.js';

/** Any parsed llm-context.json — only the graph slot matters here. */
export interface ContextWithCallGraph {
  callGraph?: SerializedCallGraph;
}

/**
 * Attach `callGraph` as a lazy getter backed by `<analysisDir>/call-graph.db`.
 *
 * No-ops when the context already carries a graph (an analysis taken by an older
 * version keeps working unchanged) or when the context is null. When the store is
 * missing or empty the property stays `undefined` — the same "no call graph"
 * every consumer already handles — but the reason is logged rather than swallowed,
 * so an out-of-sync analysis is never mistaken for a repository without one.
 */
export function attachCallGraphFromStore<T extends ContextWithCallGraph>(
  ctx: T | null,
  analysisDir: string,
  opts: {
    /**
     * Whether the attached graph takes part in spreads and `JSON.stringify`.
     * True for readers that hand the context on to something expecting the graph
     * inline (the viewer's HTTP endpoints). FALSE for anything that writes the
     * context back to `llm-context.json` — an enumerable graph would be
     * re-serialized into the artifact on the first write and undo the split.
     */
    enumerable?: boolean;
  } = {},
): T | null {
  if (!ctx || ctx.callGraph !== undefined) return ctx;

  let materialized: SerializedCallGraph | undefined;
  let done = false;
  Object.defineProperty(ctx, 'callGraph', {
    configurable: true,
    enumerable: opts.enumerable ?? true,
    get(): SerializedCallGraph | undefined {
      if (done) return materialized;
      done = true;
      materialized = loadCallGraph(analysisDir) ?? undefined;
      return materialized;
    },
    set(v: SerializedCallGraph | undefined) {
      done = true;
      materialized = v;
    },
  });
  return ctx;
}

/**
 * Read the whole call graph out of `<analysisDir>/call-graph.db`, or null when
 * there is none. Opens and closes the store around the read — callers that hold a
 * store handle should use `EdgeStore.materializeCallGraph()` directly.
 */
export function loadCallGraph(analysisDir: string): SerializedCallGraph | null {
  const dbPath = EdgeStore.dbPath(analysisDir);
  if (!existsSync(dbPath)) {
    logger.debug(`No call graph store at ${dbPath} — graph-dependent output will be omitted.`);
    return null;
  }
  let store: EdgeStore;
  try {
    const opened = openEdgeStoreForPerimeter(analysisDir);
    if (!opened.store) return null;
    store = opened.store;
  } catch (err) {
    // A corrupt/locked database must not take down a read-only command; the
    // caller degrades to "no call graph", which every consumer already handles.
    logger.warning(
      `Could not open the call graph store ${dbPath}: ${err instanceof Error ? err.message : String(err)}.`
    );
    return null;
  }
  try {
    const graph = store.materializeCallGraph();
    if (!graph) {
      logger.warning(
        `The call graph store ${dbPath} is empty${store.wasReset ? ' (reset by a version upgrade)' : ''}. ` +
        `Re-run "openlore analyze --force" to rebuild it.`
      );
      return null;
    }
    return graph;
  } finally {
    store.close();
  }
}
