/**
 * MCP tool handlers: decisions
 *
 * record_decision      — agent records an architectural decision during dev
 * list_decisions       — list pending/approved/all decisions
 * approve_decision     — approve a decision for syncing
 * reject_decision      — reject a decision
 * sync_decisions       — write approved decisions to spec.md files
 */

import { spawn } from 'node:child_process';
import { validateDirectory, sanitizeMcpError, safeOpenspecDir } from './utils.js';
import { emit } from '../telemetry.js';
import {
  loadDecisionStore,
  updateDecisionStore,
  upsertDecisions,
  patchDecision,
  makeDecisionId,
} from '../../decisions/store.js';
import { syncApprovedDecisions } from '../../decisions/syncer.js';
import { buildSpecMap, matchFileToDomains } from '../../../core/drift/spec-mapper.js';
import { AnchorContext } from '../../decisions/anchor-adapter.js';
import { readOpenLoreConfig } from '../config-manager.js';
import { join } from 'node:path';
import type { PendingDecision, DecisionScope } from '../../../types/index.js';

function spawnConsolidateBackground(rootPath: string): void {
  // Resolve binary: prefer local build over global install (same order as pre-commit hook)
  const localDist = join(rootPath, 'dist', 'cli', 'index.js');
  const localBin = join(rootPath, 'node_modules', '.bin', 'openlore');

  import('node:fs').then(({ existsSync }) => {
    let cmd: string;
    let args: string[];
    if (existsSync(localBin)) {
      cmd = localBin; args = ['decisions', '--consolidate'];
    } else if (existsSync(localDist)) {
      cmd = process.execPath; args = [localDist, 'decisions', '--consolidate'];
    } else {
      cmd = 'openlore'; args = ['decisions', '--consolidate'];
    }
    const child = spawn(cmd, args, {
      cwd: rootPath,
      detached: true,
      stdio: 'ignore',
    });
    // `cmd` is often the bare `openlore` from PATH, which is frequently absent (a
    // test run, a build tree, a container with no global install). A spawn error
    // with no listener is an UNHANDLED rejection — a process-level failure raised by
    // a fire-and-forget consolidation that is explicitly allowed to not happen.
    child.on('error', () => { /* best-effort background consolidation */ });
    child.unref();
  }).catch(() => { /* ignore */ });
}

// ============================================================================
// record_decision
// ============================================================================

export async function handleRecordDecision(
  directory: string,
  title: string,
  rationale: string,
  consequences?: string,
  affectedFiles?: string[],
  supersedes?: string,
  scope?: DecisionScope,
): Promise<unknown> {
  try {
    if (!title?.trim()) return { error: 'title is required and must not be empty.' };
    if (!rationale?.trim()) return { error: 'rationale is required and must not be empty.' };

    const rootPath = await validateDirectory(directory);
    const store = await loadDecisionStore(rootPath);

    // Infer domain from affectedFiles via spec-map (best-effort, falls back to 'unknown')
    let primaryDomain = 'unknown';
    let inferredDomains: string[] = [];
    if (affectedFiles?.length) {
      try {
        const openloreConfig = await readOpenLoreConfig(rootPath);
        const openspecPath = safeOpenspecDir(rootPath, openloreConfig?.openspecPath);
        const specMap = await buildSpecMap({ rootPath, openspecPath });
        const domainSet = new Set<string>();
        for (const file of affectedFiles) {
          for (const domain of matchFileToDomains(file, specMap)) {
            domainSet.add(domain);
          }
        }
        inferredDomains = [...domainSet];
        if (inferredDomains.length > 0) primaryDomain = inferredDomains[0];
      } catch {
        // spec-map unavailable — keep 'unknown'
      }
    }

    const id = makeDecisionId(store.sessionId, primaryDomain, title.trim());

    // Resolve scope: explicit caller value wins; otherwise auto-promote via deterministic signals.
    // Two independent triggers, either is sufficient:
    //   1. Structural: files span 2+ distinct top-level source dirs (file-topology, no LLM)
    //   2. Semantic: multiple domains inferred AND rationale contains contract/API keywords
    // Rationale-only matching is intentionally avoided — too fuzzy to be reliable under replay.
    let resolvedScope: DecisionScope = scope ?? 'component';
    if (!scope) {
      const topLevelDirs = new Set(
        (affectedFiles ?? []).map((f) => f.split('/').slice(0, 2).join('/')),
      );
      const hasStructuralCrossDomain = topLevelDirs.size >= 2;

      const lowerRationale = (rationale ?? '').toLowerCase();
      const isRefactorOrUtil =
        /\b(refactor|rename|extract|util|helper|constant|config|logging|test)\b/.test(lowerRationale);
      const hasContractKeyword =
        /\b(api|schema|contract|interface|protocol|auth|database|event|migration)\b/.test(lowerRationale);
      const hasSemanticCrossDomain = inferredDomains.length >= 2 && !isRefactorOrUtil && hasContractKeyword;

      if (hasStructuralCrossDomain || hasSemanticCrossDomain) {
        resolvedScope = 'cross-domain';
      }
    }

    // Resolve structural anchors deterministically against the call graph so the
    // decision can self-invalidate when the code it describes changes/dies. Best
    // effort: if no analysis exists yet, the decision is recorded unanchored and
    // falls back to file-level freshness from affectedFiles at recall time.
    let anchors: PendingDecision['anchors'];
    if (affectedFiles?.length) {
      const anchorCtx = AnchorContext.open(rootPath);
      if (anchorCtx) {
        try {
          const resolved = anchorCtx.resolveDecisionAnchors(
            affectedFiles,
            `${title} ${rationale} ${consequences ?? ''}`,
          );
          if (resolved.length) anchors = resolved;
        } finally {
          anchorCtx.close();
        }
      }
    }

    const decision: PendingDecision = {
      id,
      status: 'draft',
      scope: resolvedScope,
      title: title.trim(),
      rationale: rationale.trim(),
      consequences: consequences ?? '',
      proposedRequirement: null,
      affectedDomains: inferredDomains,
      affectedFiles: affectedFiles ?? [],
      anchors,
      supersedes,
      sessionId: store.sessionId,
      recordedAt: new Date().toISOString(),
      confidence: 'medium',
      syncedToSpecs: [],
    };

    // CAS upsert so concurrent record_decision calls never lose a draft: the
    // id-keyed merge is re-applied to the latest store on a write conflict.
    // The decision id is derived from the committed store's sessionId (not the
    // separately-loaded one) so repeated records in a session dedupe correctly —
    // a fresh load of an absent store mints a new random sessionId. (harden-memory-integrity-invariant)
    let recordedId = id;
    await updateDecisionStore(rootPath, (s) => {
      recordedId = makeDecisionId(s.sessionId, primaryDomain, title.trim());
      return upsertDecisions(s, [{ ...decision, id: recordedId, sessionId: s.sessionId }]);
    });

    // Consolidate in background so commit-time gate is instant
    spawnConsolidateBackground(rootPath);

    return {
      id: recordedId,
      message: `Decision recorded: "${title}". Consolidation running in background.`,
    };
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}

// ============================================================================
// list_decisions
// ============================================================================

export async function handleListDecisions(
  directory: string,
  status?: string,
): Promise<unknown> {
  try {
    const rootPath = await validateDirectory(directory);
    const store = await loadDecisionStore(rootPath);

    const decisions = status
      ? store.decisions.filter((d) => d.status === status)
      : store.decisions;

    return {
      total: decisions.length,
      sessionId: store.sessionId,
      updatedAt: store.updatedAt,
      decisions: decisions.map((d) => ({
        id: d.id,
        status: d.status,
        title: d.title,
        rationale: d.rationale,
        confidence: d.confidence,
        affectedDomains: d.affectedDomains,
        affectedFiles: d.affectedFiles,
        proposedRequirement: d.proposedRequirement,
        recordedAt: d.recordedAt,
        syncedToSpecs: d.syncedToSpecs,
      })),
    };
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}

// ============================================================================
// approve_decision
// ============================================================================

export async function handleApproveDecision(
  directory: string,
  id: string,
  note?: string,
): Promise<unknown> {
  try {
    const rootPath = await validateDirectory(directory);
    const store = await loadDecisionStore(rootPath);

    const decision = store.decisions.find((d) => d.id === id);
    if (!decision) return { error: `Decision ${id} not found.` };
    if (decision.status === 'synced') return { error: `Decision ${id} is already synced to spec files — re-approval not allowed.` };

    const committed = await updateDecisionStore(rootPath, (s) => patchDecision(s, id, {
      status: 'approved',
      reviewedAt: new Date().toISOString(),
      reviewNote: note,
    }));
    // The patch no-ops if the decision was concurrently removed/synced — report
    // honestly rather than a false success.
    const after = committed.decisions.find((d) => d.id === id);
    if (!after || after.status !== 'approved') {
      return { error: `Decision ${id} could not be approved — it was concurrently removed or changed.` };
    }
    emit(rootPath, 'decisions', { event: 'decision_approved', id, title: decision.title });

    return { id, status: 'approved', title: decision.title };
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}

// ============================================================================
// reject_decision
// ============================================================================

export async function handleRejectDecision(
  directory: string,
  id: string,
  note?: string,
): Promise<unknown> {
  try {
    const rootPath = await validateDirectory(directory);
    const store = await loadDecisionStore(rootPath);

    const decision = store.decisions.find((d) => d.id === id);
    if (!decision) return { error: `Decision ${id} not found.` };

    const committed = await updateDecisionStore(rootPath, (s) => patchDecision(s, id, {
      status: 'rejected',
      reviewedAt: new Date().toISOString(),
      reviewNote: note,
    }));
    const after = committed.decisions.find((d) => d.id === id);
    if (!after || after.status !== 'rejected') {
      return { error: `Decision ${id} could not be rejected — it was concurrently removed or changed.` };
    }
    emit(rootPath, 'decisions', { event: 'decision_rejected', id, title: decision.title });

    return { id, status: 'rejected', title: decision.title };
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}

// ============================================================================
// sync_decisions
// ============================================================================

export async function handleSyncDecisions(
  directory: string,
  dryRun = false,
  id?: string,
): Promise<unknown> {
  try {
    const rootPath = await validateDirectory(directory);
    const openloreConfig = await readOpenLoreConfig(rootPath);
    if (!openloreConfig) return { error: 'No openlore configuration found. Run openlore init first.' };

    const openspecPath = safeOpenspecDir(rootPath, openloreConfig.openspecPath);
    const specMap = await buildSpecMap({ rootPath, openspecPath });

    let store = await loadDecisionStore(rootPath);

    // If a specific id is given, promote it to approved before syncing
    if (id) {
      const decision = store.decisions.find((d) => d.id === id);
      if (!decision) return { error: `Decision ${id} not found.` };
      store = patchDecision(store, id, { status: 'approved' });
    }

    const { result } = await syncApprovedDecisions(store, {
      rootPath,
      openspecPath,
      specMap,
      dryRun,
    });

    emit(rootPath, 'decisions', { event: 'decisions_synced', count: result.synced.length, dry_run: dryRun });

    return {
      synced: result.synced.map((d) => ({ id: d.id, title: d.title, specs: d.syncedToSpecs })),
      errors: result.errors,
      modifiedSpecs: result.modifiedSpecs,
      dryRun,
    };
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}
