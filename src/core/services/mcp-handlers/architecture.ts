/**
 * `check_architecture` MCP handler (spec-23).
 *
 * Two read-only modes over the opt-in architecture rules:
 *   - pre-edit ({ directory, from, to }): "may a file under `from` import `to`?" —
 *     a deterministic verdict + the governing rule + why, BEFORE the edit is made.
 *   - scan ({ directory }): the full current-violations report.
 *
 * Fully inert when no rules are declared. Offline and deterministic.
 */

import { readFile } from 'node:fs/promises';
import { OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_DEPENDENCY_GRAPH,  } from '../../../constants.js';
import { validateDirectory } from './utils.js';
import { loadArchitectureRules } from '../../architecture/rules.js';
import type { ArchitectureRule } from '../../architecture/rules.js';
import { scanViolations, canImport } from '../../architecture/check.js';
import type { DependencyGraphResult } from '../../analyzer/dependency-graph.js';
import { openloreReadTarget } from '../write-target.js';

const VIOLATION_REPORT_CAP = 200;

async function loadDepGraph(absDir: string): Promise<DependencyGraphResult | null> {
  try {
    const raw = await readFile(
      openloreReadTarget(absDir, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_DEPENDENCY_GRAPH),
      'utf-8',
    );
    return JSON.parse(raw) as DependencyGraphResult;
  } catch {
    return null;
  }
}

/** One-line human summary of a rule, for the report. */
function describeRule(rule: ArchitectureRule): string {
  switch (rule.kind) {
    case 'layers':
      return `layers (${rule.source}): ${Object.keys(rule.layers).join(' → ')}`;
    case 'forbidden':
      return `forbidden (${rule.source}): ${rule.from} ⇏ ${rule.to}${rule.reason ? ` — ${rule.reason}` : ''}`;
    case 'allowedOnly':
      return `allowedOnly (${rule.source}): ${rule.module} → [${rule.mayDependOn.join(', ')}]${rule.reason ? ` — ${rule.reason}` : ''}`;
  }
}

const INERT_NOTE =
  'No architecture rules declared. This guardrail is opt-in and inert: add a ' +
  '.openlore/architecture.json (layers / forbidden / allowedOnly) or an "Invariant:" ' +
  'marker in a synced ADR to enable it.';

const ACTIVE_NOTE =
  'Deterministic, advisory architecture guardrail. Rules are author-declared ' +
  '(.openlore/architecture.json + synced ADR "Invariant:" markers), never LLM-inferred. ' +
  'It complements, not replaces, CI linters.';

export interface CheckArchitectureArgs {
  directory: string;
  /** Pre-edit mode: the file that would gain the import (relative or absolute). */
  from?: string;
  /** Pre-edit mode: the target file path or exported symbol being imported. */
  to?: string;
}

export async function handleCheckArchitecture(args: CheckArchitectureArgs): Promise<unknown> {
  const absDir = await validateDirectory(args.directory);
  const rules = await loadArchitectureRules(absDir);
  const depGraph = await loadDepGraph(absDir);

  const preEdit = typeof args.from === 'string' && typeof args.to === 'string';

  // ---- Pre-edit verdict mode ----
  if (preEdit) {
    if (rules.rules.length === 0) {
      return {
        mode: 'pre-edit',
        rulesDeclared: false,
        allowed: true,
        reason: 'no architecture rules declared — inert',
        note: INERT_NOTE,
      };
    }
    const verdict = canImport(args.from!, args.to!, rules, depGraph ?? undefined);
    return {
      mode: 'pre-edit',
      rulesDeclared: true,
      from: args.from,
      to: args.to,
      allowed: verdict.allowed,
      rule: verdict.rule,
      resolvedTo: verdict.resolvedTo,
      reason: verdict.reason,
      warnings: rules.warnings.length ? rules.warnings : undefined,
      note: ACTIVE_NOTE,
    };
  }

  // ---- Full scan mode ----
  if (rules.rules.length === 0) {
    return {
      mode: 'scan',
      rulesDeclared: false,
      violationCount: 0,
      violations: [],
      note: INERT_NOTE,
    };
  }

  if (!depGraph) {
    return { error: 'No analysis found. Run analyze_codebase first.' };
  }

  const scan = scanViolations(depGraph, rules);
  const capped = scan.violations.slice(0, VIOLATION_REPORT_CAP);
  return {
    mode: 'scan',
    rulesDeclared: true,
    rulesApplied: scan.rulesApplied,
    ruleSummary: rules.rules.map(describeRule),
    violationCount: scan.violations.length,
    violations: capped,
    truncated: scan.violations.length > capped.length
      ? `showing first ${capped.length} of ${scan.violations.length}`
      : undefined,
    checkedEdges: scan.checkedEdges,
    warnings: scan.warnings.length ? scan.warnings : undefined,
    note: ACTIVE_NOTE,
  };
}
