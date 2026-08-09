/**
 * openlore audit — programmatic API
 *
 * Compares current codebase state to the spec snapshot to report coverage gaps.
 * No LLM required.
 *
 * PERIMETER NOTE. This module was registered as unreachable from a perimeter-bearing
 * server ("CLI/library entry point"), and that was simply false: the MCP handler
 * `audit_spec_coverage` imports `openloreAudit` and called it with `save: true`
 * hardcoded. The result was a tool published to clients as read-only, absent from
 * `WRITING_TOOLS`, creating `audit-report.json` and `spec-snapshot.json` inside a
 * repository the operator had granted on READ ONLY — found by sweeping all 52
 * non-writing tools against a read-only root. Both derivations below now go through
 * the perimeter (pass-through in a CLI process, which declares none), and saving is
 * the caller's decision rather than a constant.
 */

import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import { SpecSnapshotGenerator } from '../core/analyzer/spec-snapshot-generator.js';
import {
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_MAPPING,
  ARTIFACT_AUDIT_REPORT,
  OPENSPEC_DIR,
} from '../constants.js';
import type {
  AuditReport,
  AuditUncoveredFunction,
  AuditOrphanRequirement,
  AuditStaleDomain,
} from '../types/index.js';
import type { AuditApiOptions } from './types.js';
import type { LLMContext } from '../core/analyzer/artifact-generator.js';
import type { MappingArtifact } from '../core/generator/mapping-generator.js';
import type { SerializedCallGraph, FunctionNode } from '../core/analyzer/call-graph.js';
import { attachCallGraphFromStore } from '../core/services/call-graph-loader.js';
import { openloreReadTarget, openloreWriteTarget } from '../core/services/write-target.js';

const DEFAULT_MAX_UNCOVERED = 50;
const DEFAULT_HUB_THRESHOLD = 5;

// ============================================================================
// HELPERS
// ============================================================================

function buildCoveredSet(mapping: MappingArtifact): Set<string> {
  const covered = new Set<string>();
  for (const m of mapping.mappings) {
    for (const fn of m.functions) {
      if (fn.name && fn.name !== '*') {
        covered.add(`${fn.file}::${fn.name}`);
        covered.add(fn.name);
      }
    }
  }
  return covered;
}

function isNodeCovered(node: FunctionNode, covered: Set<string>): boolean {
  return covered.has(`${node.filePath}::${node.name}`) || covered.has(node.name);
}

function toAuditFunction(node: FunctionNode, isHub: boolean): AuditUncoveredFunction {
  return {
    name: node.name,
    file: node.filePath,
    kind: node.className ? 'method' : 'function',
    fanIn: node.fanIn,
    fanOut: node.fanOut,
    isHub,
  };
}

// ============================================================================
// PUBLIC API
// ============================================================================

export async function openloreAudit(options: AuditApiOptions = {}): Promise<AuditReport> {
  const rootPath = options.rootPath ?? process.cwd();
  const maxUncovered = options.maxUncovered ?? DEFAULT_MAX_UNCOVERED;
  const hubThreshold = options.hubThreshold ?? DEFAULT_HUB_THRESHOLD;
  const shouldSave = options.save ?? true;
  // Read side through the perimeter: `<root>/.openlore` can be a symlink, and a
  // lexical join reads the analysis artifacts of whatever it points at.
  const analysisDir = openloreReadTarget(rootPath, OPENLORE_ANALYSIS_SUBDIR);

  // Load (or refresh) snapshot. It persists only if this audit persists — the
  // snapshot is a by-product of the report, not a separate grant.
  const openloreConfig = await readOpenLoreConfig(rootPath);
  const openspecRelPath = openloreConfig?.openspecPath ?? OPENSPEC_DIR;
  const snapshotGen = new SpecSnapshotGenerator(rootPath, openspecRelPath);
  const snapshot = await snapshotGen.generate({ save: shouldSave }).catch(() => null);

  // Load raw artifacts for deep analysis
  const [llmContextRaw, mappingRaw] = await Promise.all([
    readFile(join(analysisDir, ARTIFACT_LLM_CONTEXT), 'utf-8').catch(() => null),
    readFile(join(analysisDir, ARTIFACT_MAPPING), 'utf-8').catch(() => null),
  ]);

  // The graph lives in call-graph.db, not in the artifact (PDLC-156) — attach it.
  const llmContext = attachCallGraphFromStore(
    llmContextRaw ? JSON.parse(llmContextRaw) as LLMContext : null,
    analysisDir,
  );
  const mapping = mappingRaw ? JSON.parse(mappingRaw) as MappingArtifact : null;

  const callGraph = llmContext?.callGraph as SerializedCallGraph | undefined;
  const allNodes = callGraph?.nodes ?? [];
  const hubNodes = new Set((callGraph?.hubFunctions ?? []).map(n => n.id));

  // Build coverage set
  const covered = mapping ? buildCoveredSet(mapping) : new Set<string>();

  // 1. Uncovered functions
  const uncoveredNodes = allNodes.filter(n => !isNodeCovered(n, covered));
  const uncoveredFunctions: AuditUncoveredFunction[] = uncoveredNodes
    .slice(0, maxUncovered)
    .map(n => toAuditFunction(n, hubNodes.has(n.id) || n.fanIn >= hubThreshold));

  // 2. Hub gaps (hubs with no spec coverage)
  const hubGaps: AuditUncoveredFunction[] = allNodes
    .filter(n => (hubNodes.has(n.id) || n.fanIn >= hubThreshold) && !isNodeCovered(n, covered))
    .map(n => toAuditFunction(n, true));

  // 3. Orphan requirements (requirements in mapping with no matched function)
  const orphanRequirements: AuditOrphanRequirement[] = mapping
    ? mapping.mappings
        .filter(m => m.functions.length === 0 || m.functions.every(f => f.name === '*'))
        .map(m => ({ requirement: m.requirement, domain: m.domain, specFile: m.specFile }))
    : [];

  // 4. Stale domains (source files modified after spec)
  const staleDomains: AuditStaleDomain[] = snapshot
    ? snapshot.domains
        .filter(d => d.sourcesModifiedAt > d.specModifiedAt)
        .map(d => ({
          name: d.name,
          specFile: d.specFile,
          specModifiedAt: d.specModifiedAt,
          sourcesModifiedAt: d.sourcesModifiedAt,
          staleSince: d.sourcesModifiedAt,
        }))
    : [];

  const coveredCount = allNodes.length - uncoveredNodes.length;
  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalFunctions: allNodes.length,
      coveredFunctions: coveredCount,
      coveragePct: allNodes.length > 0 ? Math.round((coveredCount / allNodes.length) * 100) : 0,
      uncoveredCount: uncoveredNodes.length,
      hubGapCount: hubGaps.length,
      orphanRequirementCount: orphanRequirements.length,
      staleDomainCount: staleDomains.length,
    },
    uncoveredFunctions,
    hubGaps,
    orphanRequirements,
    staleDomains,
  };

  if (shouldSave) {
    await writeFile(
      openloreWriteTarget(rootPath, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_AUDIT_REPORT),
      JSON.stringify(report, null, 2),
    );
  }

  return report;
}
