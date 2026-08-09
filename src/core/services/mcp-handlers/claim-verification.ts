/**
 * Structural claim verification (change: add-structural-claim-verification).
 *
 * The reverse of context retrieval: instead of OpenLore handing the agent facts,
 * the AGENT submits a structured claim about code structure and OpenLore returns a
 * deterministic verdict plus a citation it can show a human. This converts the
 * agent's confident-wrong failure mode ("this function is dead", "Y calls Z") into
 * checked-or-flagged, and makes the agent's output auditable.
 *
 *   claim   = { kind: 'calls'|'reaches'|'dead'|'impacts'|'safe-to-change', subject, object? }
 *   verdict = { verdict: 'confirmed'|'refuted'|'unverifiable', reason, receipt?, confidenceBoundary }
 *
 * Every verdict is a graph computation over the deterministic call graph, never an
 * LLM judgement and never a confidence number (north star c6d1ad07):
 *   - `calls`          → a direct caller→callee edge exists.
 *   - `reaches`        → forward reachability subject ⇒ object.
 *   - `impacts`        → backward reachability: object transitively calls subject,
 *                        so changing subject can require changes in object.
 *   - `dead`           → mark-and-sweep reachability (reuses {@link deadCodeIds}),
 *                        run twice (synthesized-inclusive vs directly-resolved) to
 *                        separate truly-unreached from reached-only-via-heuristic.
 *   - `safe-to-change` → no internal caller depends on subject (blast radius is
 *                        empty by directly-resolved edges).
 *
 * The receipt reuses the grounding-certificate shape (`{ symbol, filePath,
 * lineSpan, contentHash }`) — the same span hash the freshness check compares — so
 * a human can audit the claim against the index at a named commit. `unverifiable`
 * is first-class: when a verdict rests on a dispatch blind spot it is named via
 * `add-confidence-boundary-disclosure`, rather than fabricating a decisive answer.
 */

import { readFile } from 'node:fs/promises';
import { validateDirectory, readCachedContext } from './utils.js';
import { buildAdjacency } from './graph.js';
import { deadCodeIds } from './reachability.js';
import {
  assembleBoundary,
  buildPairEdgeIndex,
  computeStaleness,
  edgeBasis,
  edgeBasisForChains,
  type BoundaryEdge,
  type ConfidenceBoundary,
  type KnownUnknowableCrossing,
} from './confidence-boundary.js';
import { AnchorContext } from '../../decisions/anchor-adapter.js';
import { ARTIFACT_FINGERPRINT, OPENLORE_ANALYSIS_SUBDIR } from '../../../constants.js';
import type { SerializedCallGraph, FunctionNode } from '../../analyzer/call-graph.js';
import type { GroundingCertificate, StructuralAnchor } from '../../../types/index.js';
import { openloreReadTarget } from '../write-target.js';

export type ClaimKind = 'calls' | 'reaches' | 'dead' | 'impacts' | 'safe-to-change';
const CLAIM_KINDS: ReadonlySet<string> = new Set<ClaimKind>([
  'calls', 'reaches', 'dead', 'impacts', 'safe-to-change',
]);
/** Kinds that relate two symbols and so require an `object`. */
const RELATIONAL_KINDS: ReadonlySet<ClaimKind> = new Set<ClaimKind>(['calls', 'reaches', 'impacts']);

export type Verdict = 'confirmed' | 'refuted' | 'unverifiable';

export interface VerifyClaimInput {
  directory: string;
  kind: ClaimKind;
  /** The symbol the claim is about (a function/method name). */
  subject: string;
  /** The second symbol, for relational kinds (`calls`, `reaches`, `impacts`). */
  object?: string;
}

/** Evidence behind a verdict — citable to a human, auditable against the index. */
interface Receipt {
  /** Short SHA the index was built at, when captured. */
  indexCommit: string | null;
  /** Grounding certificate for the subject symbol (span + content hash). */
  subject: GroundingCertificate;
  /** Grounding certificate for the object symbol, for relational kinds. */
  object?: GroundingCertificate;
  /** Symbol-name chain for a `reaches`/`impacts` path (subject ⇒ … ⇒ object). */
  via?: string[];
  /** Human-readable account of what the graph showed. */
  evidence: string;
}

interface ClaimResult {
  verdict: Verdict;
  reason: string;
  receipt?: Receipt;
  /** Crossings that make a verdict `unverifiable` or qualify a `confirmed` one. */
  extraCrossings?: KnownUnknowableCrossing[];
  /** Edges underpinning the verdict — the basis for the confidence boundary. */
  basisEdges?: BoundaryEdge[];
  /** Symbol-name chain to surface in the receipt (reaches/impacts paths). */
  receiptVia?: string[];
}

/** A code node we can reason about (not an external symbol). */
function isCodeNode(n: FunctionNode): boolean {
  return !n.isExternal;
}

interface Resolution {
  node?: FunctionNode;
  /** How many symbols the name matched (>1 ⇒ ambiguous). */
  matched: number;
  /** The match strategy that resolved it. */
  how: 'exact' | 'fuzzy' | 'none' | 'ambiguous';
}

/**
 * Resolve a symbol name to a single internal node. Prefer an exact (case-
 * insensitive) name match; fall back to a unique substring match. An ambiguous
 * name (multiple matches at the chosen precision) resolves to no node so the
 * caller can return `unverifiable` rather than guess which symbol was meant.
 */
function resolveSymbol(cg: SerializedCallGraph, name: string): Resolution {
  const lower = name.toLowerCase();
  const code = cg.nodes.filter(isCodeNode);
  const exact = code.filter(n => n.name.toLowerCase() === lower);
  if (exact.length === 1) return { node: exact[0], matched: 1, how: 'exact' };
  if (exact.length > 1) return { matched: exact.length, how: 'ambiguous' };
  const fuzzy = code.filter(n => n.name.toLowerCase().includes(lower));
  if (fuzzy.length === 1) return { node: fuzzy[0], matched: 1, how: 'fuzzy' };
  if (fuzzy.length > 1) return { matched: fuzzy.length, how: 'ambiguous' };
  return { matched: 0, how: 'none' };
}

/** Read the build commit the index was analyzed at, if it was captured. */
async function readIndexCommit(absDir: string): Promise<string | null> {
  try {
    const raw = await readFile(openloreReadTarget(absDir, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_FINGERPRINT), 'utf-8');
    const fp = JSON.parse(raw) as { commit?: string | null };
    return fp.commit ?? null;
  } catch {
    return null;
  }
}

/** Forward BFS from a seed, tracking the predecessor so a path can be rebuilt. */
function reachWithPath(
  seedId: string,
  targetId: string,
  adjacency: Map<string, Set<string>>,
): string[] | null {
  if (seedId === targetId) return [seedId];
  const parent = new Map<string, string>();
  const seen = new Set<string>([seedId]);
  const queue: string[] = [seedId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of adjacency.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      parent.set(next, id);
      if (next === targetId) {
        const path: string[] = [next];
        let cur = next;
        while (cur !== seedId) { cur = parent.get(cur)!; path.push(cur); }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

const SYNTH_DISPATCH_DETAIL =
  'reached only through synthesized dynamic-dispatch edges (callback/event/route or class-hierarchy ' +
  'dispatch), whose true target is not statically guaranteed — so static reachability cannot decide this ' +
  'claim. Read the source or run the code to confirm.';

/** Verify `calls`: a direct caller→callee edge subject→object. */
function verifyCalls(cg: SerializedCallGraph, subject: FunctionNode, object: FunctionNode): ClaimResult {
  let direct: BoundaryEdge | undefined;
  let synthesized: BoundaryEdge | undefined;
  for (const e of cg.edges) {
    if (e.callerId !== subject.id || e.calleeId !== object.id) continue;
    if (e.kind && e.kind !== 'calls') continue; // only true call edges decide "calls"
    if (e.confidence === 'synthesized') synthesized ??= { confidence: e.confidence, synthesizedBy: e.synthesizedBy };
    else direct ??= { confidence: e.confidence, synthesizedBy: e.synthesizedBy };
  }
  if (direct) {
    return {
      verdict: 'confirmed',
      reason: `"${subject.name}" directly calls "${object.name}" (a directly-resolved call edge).`,
      basisEdges: [direct],
    };
  }
  if (synthesized) {
    return {
      verdict: 'confirmed',
      reason: `"${subject.name}" calls "${object.name}" via a synthesized ${synthesized.synthesizedBy ?? 'dynamic-dispatch'} edge — recovered heuristically, not by direct name resolution; verify before asserting.`,
      basisEdges: [synthesized],
    };
  }
  return {
    verdict: 'refuted',
    reason: `No direct call edge from "${subject.name}" to "${object.name}" in the call graph.`,
    basisEdges: [],
  };
}

/** Verify `reaches` (forward) / `impacts` (backward) by reachability with a path. */
function verifyReach(
  cg: SerializedCallGraph,
  subject: FunctionNode,
  object: FunctionNode,
  kind: 'reaches' | 'impacts',
): ClaimResult {
  const { forward, backward } = buildAdjacency(cg);
  const pairIndex = buildPairEdgeIndex(cg.edges);
  // `reaches`: does subject call through to object (forward from subject)?
  // `impacts`: does changing subject affect object — i.e. object transitively
  // calls subject, so we walk backward from subject and look for object.
  const adjacency = kind === 'reaches' ? forward : backward;
  const path = reachWithPath(subject.id, object.id, adjacency);
  if (!path) {
    return {
      verdict: 'refuted',
      reason: kind === 'reaches'
        ? `No call path from "${subject.name}" to "${object.name}" — it is not transitively reachable.`
        : `Changing "${subject.name}" does not impact "${object.name}": no call path runs from "${object.name}" through to "${subject.name}".`,
      basisEdges: [],
    };
  }
  // For `impacts` the path was reconstructed over backward edges as
  // subject ⇐ … ⇐ object; present it caller→callee (object ⇒ … ⇒ subject).
  const callerToCallee = kind === 'reaches' ? path : [...path].reverse();
  const basis = edgeBasisForChains([callerToCallee], pairIndex);
  const names = callerToCallee.map(id => cg.nodes.find(n => n.id === id)?.name ?? id);
  const reason = kind === 'reaches'
    ? `"${subject.name}" transitively reaches "${object.name}" in ${callerToCallee.length - 1} hop(s).`
    : `Changing "${subject.name}" can impact "${object.name}": "${object.name}" transitively calls it in ${callerToCallee.length - 1} hop(s).`;
  return {
    verdict: 'confirmed',
    reason: basis.synthesizedEdges > 0
      ? `${reason} ${basis.synthesizedEdges} edge(s) on this path are synthesized — verify before asserting.`
      : reason,
    basisEdges: chainEdges(callerToCallee, pairIndex),
    receiptVia: names,
  };
}

/** Edges along a node-id chain, deduped, for the boundary basis. */
function chainEdges(chain: string[], pairIndex: Map<string, BoundaryEdge>): BoundaryEdge[] {
  const out: BoundaryEdge[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const e = pairIndex.get(chain[i] + '\x00' + chain[i + 1]);
    if (e) out.push(e);
  }
  return out;
}

/**
 * Verify `dead`: is subject unreachable from any liveness root? Reuses
 * {@link deadCodeIds} so the verdict agrees with `find_dead_code` on what
 * "reachable" means, run twice:
 *   - dead in the synthesized-inclusive graph AND the directly-resolved graph
 *     ⇒ confirmed dead (a strong candidate; external/reflection callers caveated).
 *   - reached by directly-resolved edges ⇒ refuted (it is live).
 *   - reached ONLY via synthesized dynamic-dispatch edges ⇒ unverifiable (a
 *     dispatch blind spot; static reachability cannot decide deadness).
 */
async function verifyDead(absDir: string, cg: SerializedCallGraph, subject: FunctionNode): Promise<ClaimResult> {
  const deadFull = await deadCodeIds(absDir, cg);
  const strictCg: SerializedCallGraph = { ...cg, edges: cg.edges.filter(e => e.confidence !== 'synthesized') };
  const deadStrict = await deadCodeIds(absDir, strictCg);

  const inFull = deadFull.has(subject.id);
  const inStrict = deadStrict.has(subject.id);

  if (inFull) {
    return {
      verdict: 'confirmed',
      reason: `"${subject.name}" is unreachable from every liveness root (tests, imported symbols, route handlers, main) — even counting synthesized dynamic-dispatch edges. It is a strong dead-code candidate; external consumers and reflection are still invisible to static analysis.`,
    };
  }
  if (inStrict) {
    // Live only with synthesized edges in play → reached only via heuristic dispatch.
    return {
      verdict: 'unverifiable',
      reason: `"${subject.name}" is ${SYNTH_DISPATCH_DETAIL}`,
      extraCrossings: [{
        kind: 'synthesized-dispatch',
        count: 1,
        detail: `"${subject.name}" is reachable only through synthesized dynamic-dispatch edges; whether it is truly live or dead cannot be decided statically.`,
      }],
    };
  }
  return {
    verdict: 'refuted',
    reason: `"${subject.name}" is reachable from a liveness root by directly-resolved call edges — it is not dead.`,
  };
}

/**
 * Verify `safe-to-change`: no internal caller depends on subject, so changing it
 * cannot break a caller inside this repo. Confirmed only when the directly-
 * resolved backward caller set is empty; unverifiable when subject is called via
 * synthesized dynamic dispatch (callers cannot be fully enumerated).
 */
function verifySafeToChange(cg: SerializedCallGraph, subject: FunctionNode): ClaimResult {
  const directCallers = new Set<string>();
  let synthesizedCallers = 0;
  for (const e of cg.edges) {
    if (e.calleeId !== subject.id) continue;
    if (e.kind && e.kind !== 'calls' && e.kind !== 'overrides') continue;
    if (e.confidence === 'synthesized') synthesizedCallers++;
    else directCallers.add(e.callerId);
  }
  if (synthesizedCallers > 0) {
    return {
      verdict: 'unverifiable',
      reason: `"${subject.name}" is invoked via ${synthesizedCallers} synthesized dynamic-dispatch edge(s); its callers cannot be fully enumerated statically, so changing it cannot be declared safe.`,
      extraCrossings: [{
        kind: 'synthesized-dispatch',
        count: synthesizedCallers,
        detail: `${synthesizedCallers} call(s) into "${subject.name}" are recovered heuristically (dynamic dispatch); a hidden caller may break.`,
      }],
    };
  }
  if (directCallers.size === 0) {
    return {
      verdict: 'confirmed',
      reason: `No internal caller depends on "${subject.name}" (zero directly-resolved callers) — changing it cannot break a caller inside this repo. External/public consumers are not visible to static analysis.`,
    };
  }
  return {
    verdict: 'refuted',
    reason: `"${subject.name}" has ${directCallers.size} internal caller(s); changing its contract risks breaking them. Run select_tests / analyze_impact before editing.`,
  };
}

/**
 * Verify a structured structural claim against the deterministic call graph.
 * Read-only, offline, no LLM. Returns `unknown` (additive-by-cast like the
 * sibling handlers).
 */
export async function handleVerifyClaim(input: VerifyClaimInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);

  if (!CLAIM_KINDS.has(input.kind)) {
    return { error: `Unknown claim kind "${input.kind}". Use one of: calls, reaches, dead, impacts, safe-to-change.` };
  }
  if (!input.subject || !input.subject.trim()) {
    return { error: 'A claim must name a "subject" symbol.' };
  }
  const needsObject = RELATIONAL_KINDS.has(input.kind);
  if (needsObject && (!input.object || !input.object.trim())) {
    return { error: `The "${input.kind}" claim relates two symbols — provide an "object" symbol.` };
  }

  const ctx = await readCachedContext(absDir);
  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };
  const cg = ctx.callGraph as SerializedCallGraph;

  const claim = { kind: input.kind, subject: input.subject, ...(input.object ? { object: input.object } : {}) };
  const staleness = await computeStaleness(absDir);

  // ── Resolve the symbols; an unresolved/ambiguous symbol is unverifiable ──────
  const subjRes = resolveSymbol(cg, input.subject);
  if (!subjRes.node) {
    return {
      claim,
      verdict: 'unverifiable' as Verdict,
      reason: subjRes.how === 'ambiguous'
        ? `Subject "${input.subject}" is ambiguous — it matches ${subjRes.matched} symbols. Disambiguate (e.g. by exact name) before verifying.`
        : `Subject "${input.subject}" was not found in the call graph. It may be external, mis-spelled, or in an unindexed file.`,
      confidenceBoundary: assembleBoundary({
        extraCrossings: [{ kind: 'unindexed-repo', count: 0, detail: `"${input.subject}" does not resolve to an indexed symbol.` }],
        staleness,
      }),
    };
  }
  let objNode: FunctionNode | undefined;
  if (needsObject) {
    const objRes = resolveSymbol(cg, input.object!);
    if (!objRes.node) {
      return {
        claim,
        verdict: 'unverifiable' as Verdict,
        reason: objRes.how === 'ambiguous'
          ? `Object "${input.object}" is ambiguous — it matches ${objRes.matched} symbols. Disambiguate before verifying.`
          : `Object "${input.object}" was not found in the call graph. It may be external, mis-spelled, or in an unindexed file.`,
        confidenceBoundary: assembleBoundary({
          extraCrossings: [{ kind: 'unindexed-repo', count: 0, detail: `"${input.object}" does not resolve to an indexed symbol.` }],
          staleness,
        }),
      };
    }
    objNode = objRes.node;
  }
  const subject = subjRes.node;

  // ── Dispatch the claim to its deterministic computation ──────────────────────
  let result: ClaimResult;
  switch (input.kind) {
    case 'calls':         result = verifyCalls(cg, subject, objNode!); break;
    case 'reaches':       result = verifyReach(cg, subject, objNode!, 'reaches'); break;
    case 'impacts':       result = verifyReach(cg, subject, objNode!, 'impacts'); break;
    case 'dead':          result = await verifyDead(absDir, cg, subject); break;
    case 'safe-to-change': result = verifySafeToChange(cg, subject); break;
    default:              return { error: `Unhandled claim kind "${input.kind}".` };
  }

  const confidenceBoundary: ConfidenceBoundary = assembleBoundary({
    ...(result.basisEdges ? { basis: edgeBasis(result.basisEdges) } : {}),
    ...(result.extraCrossings ? { extraCrossings: result.extraCrossings } : {}),
    staleness,
  });

  // ── Receipt (citation): only for a decided verdict, never for unverifiable ───
  let receipt: Receipt | undefined;
  if (result.verdict !== 'unverifiable') {
    const anchorCtx = AnchorContext.open(absDir);
    if (anchorCtx) {
      try {
        const subjCert = anchorCtx.certificateForAnchor(toAnchor(subject));
        if (subjCert) {
          const indexCommit = await readIndexCommit(absDir);
          receipt = { indexCommit, subject: subjCert, evidence: result.reason };
          if (objNode) {
            const objCert = anchorCtx.certificateForAnchor(toAnchor(objNode));
            if (objCert) receipt.object = objCert;
          }
          if (result.receiptVia) receipt.via = result.receiptVia;
        }
      } finally {
        anchorCtx.close();
      }
    }
  }

  return {
    claim,
    verdict: result.verdict,
    reason: result.reason,
    ...(receipt ? { receipt } : {}),
    confidenceBoundary,
  };
}

/** A symbol anchor for a resolved node, for the receipt's grounding certificate. */
function toAnchor(node: FunctionNode): StructuralAnchor {
  return {
    nodeId: node.id,
    filePath: node.filePath,
    symbolName: node.name,
    ...(node.stableId ? { stableId: node.stableId } : {}),
  };
}
