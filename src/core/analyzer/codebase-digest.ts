/**
 * Codebase Digest — generates .openlore/CODEBASE.md
 *
 * A compact, agent-readable Markdown summary of the codebase produced by
 * `openlore analyze`.  Designed to be included in CLAUDE.md / .clinerules
 * so agents absorb architectural context passively at session start, without
 * needing to call any MCP tool.
 *
 * Content:
 *   - Entry points (functions with no internal callers)
 *   - Critical hubs (highest fan-in functions)
 *   - Spec domains (if openspec/specs/ exists)
 *   - Most coupled files (high in-degree in dependency graph)
 *   - God functions / oversized orchestrators
 *   - Layer violations (if any)
 */

import { writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMContext } from './artifact-generator.js';
import type { DependencyGraphResult } from './dependency-graph.js';
import { t } from '../../utils/i18n.js';

// ============================================================================
// TYPES
// ============================================================================

interface DigestOptions {
  /** Absolute path to the project root */
  rootPath: string;
  /** Absolute path to the .openlore/analysis/ output directory */
  outputDir: string;
  /** Max entry points to list */
  maxEntryPoints?: number;
  /** Max hub functions to list */
  maxHubs?: number;
  /** Max god functions to list */
  maxGodFunctions?: number;
  /** Max most-coupled files to list */
  maxCoupledFiles?: number;
}

// ============================================================================
// HELPERS
// ============================================================================

function rel(absPath: string, rootPath: string): string {
  return absPath.startsWith(rootPath)
    ? absPath.slice(rootPath.length).replace(/^\//, '')
    : absPath;
}

/** Extract per-file coupling from pre-computed node metrics */
function fileCoupling(depGraph: DependencyGraphResult | null): Array<{ path: string; importedBy: number; imports: number }> {
  if (!depGraph) return [];
  return depGraph.nodes
    .map(n => ({
      path: n.file?.path ?? n.id,
      importedBy: n.metrics?.inDegree ?? 0,
      imports: n.metrics?.outDegree ?? 0,
    }))
    .sort((a, b) => b.importedBy - a.importedBy);
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

/**
 * Generate `.openlore/CODEBASE.md` from cached analysis artifacts.
 *
 * Non-fatal: logs a warning and returns false if generation fails.
 */
export async function generateCodebaseDigest(
  llmContext: LLMContext,
  depGraph: DependencyGraphResult | null,
  opts: DigestOptions,
): Promise<boolean> {
  try {
    const {
      rootPath,
      outputDir,
      maxEntryPoints = 8,
      maxHubs = 10,
      maxGodFunctions = 5,
      maxCoupledFiles = 8,
    } = opts;

    const cg = llmContext.callGraph;
    const lines: string[] = [];
    const now = new Date().toISOString().slice(0, 10);

    lines.push(t('codebase.title'));
    lines.push(t('codebase.generatedBy', { date: now }));
    lines.push(t('codebase.addToClaudeMd'));
    lines.push('');

    // ── Overview ──────────────────────────────────────────────────────────────
    if (cg) {
      // Production functions only: cg.nodes also carries test and external (library)
      // nodes so the test-impact tools can use them. The digest describes the
      // production surface, so exclude both — otherwise test helpers and stdlib
      // calls inflate the counts and leak into the god-function list (e.g. a Java
      // `FooTest.checkOption` showing up as an orchestrator).
      const prodNodes = cg.nodes.filter(n => !n.isTest && !n.isExternal);
      lines.push(t('codebase.overview'));
      lines.push(t('codebase.overviewFunctions', { count: prodNodes.length }));
      lines.push(t('codebase.overviewEdges', { count: cg.stats?.totalEdges ?? '?' }));
      lines.push(t('codebase.overviewEntryPoints', { count: cg.entryPoints?.length ?? 0 }));
      lines.push(t('codebase.overviewHubs', { count: cg.hubFunctions?.length ?? 0 }));
      if (cg.stats?.avgFanIn !== undefined) {
        lines.push(t('codebase.overviewFanAvg', { fanIn: cg.stats.avgFanIn.toFixed(2), fanOut: cg.stats.avgFanOut.toFixed(2) }));
      }
      lines.push('');
    }

    // ── Entry points ──────────────────────────────────────────────────────────
    if (cg?.entryPoints?.length) {
      lines.push(t('codebase.entryPoints'));
      lines.push(t('codebase.entryPointsProse'));
      lines.push('');
      lines.push(t('codebase.entryPointsTableHeader'));
      lines.push(t('codebase.entryPointsTableSep'));
      for (const ep of cg.entryPoints.slice(0, maxEntryPoints)) {
        const file = rel(ep.filePath, rootPath);
        const name = ep.className ? `${ep.className}.${ep.name}` : ep.name;
        lines.push(`| \`${name}\` | \`${file}\` | ${ep.fanOut} |`);
      }
      if (cg.entryPoints.length > maxEntryPoints) {
        lines.push(t('codebase.moreRow', { count: cg.entryPoints.length - maxEntryPoints }));
      }
      lines.push('');
    }

    // ── Critical hubs ─────────────────────────────────────────────────────────
    if (cg?.hubFunctions?.length) {
      const sorted = [...cg.hubFunctions].sort((a, b) => b.fanIn - a.fanIn);
      lines.push(t('codebase.criticalHubs'));
      lines.push(t('codebase.criticalHubsProse'));
      lines.push('');
      lines.push(t('codebase.hubsTableHeader'));
      lines.push(t('codebase.hubsTableSep'));
      for (const hub of sorted.slice(0, maxHubs)) {
        const file = rel(hub.filePath, rootPath);
        const name = hub.className ? `${hub.className}.${hub.name}` : hub.name;
        lines.push(`| \`${name}\` | \`${file}\` | ${hub.fanIn} | ${hub.fanOut} |`);
      }
      if (sorted.length > maxHubs) {
        lines.push(t('codebase.hubsMoreRow', { count: sorted.length - maxHubs }));
      }
      lines.push('');
    }

    // ── God functions ─────────────────────────────────────────────────────────
    if (cg?.nodes?.length) {
      // Production functions only — test helpers and external (library) nodes are
      // not orchestrators of this codebase (see Overview note above).
      const gods = cg.nodes
        .filter(n => !n.isTest && !n.isExternal && n.fanOut >= 8)
        .sort((a, b) => b.fanOut - a.fanOut)
        .slice(0, maxGodFunctions);

      if (gods.length > 0) {
        lines.push(t('codebase.godFunctions'));
        lines.push(t('codebase.godFunctionsProse'));
        lines.push('');
        lines.push(t('codebase.godFunctionsTableHeader'));
        lines.push(t('codebase.godFunctionsTableSep'));
        for (const g of gods) {
          const file = rel(g.filePath, rootPath);
          const name = g.className ? `${g.className}.${g.name}` : g.name;
          lines.push(`| \`${name}\` | \`${file}\` | ${g.fanOut} |`);
        }
        lines.push('');
      }
    }

    // ── Most coupled files ────────────────────────────────────────────────────
    const coupled = fileCoupling(depGraph);
    if (coupled.length > 0) {
      const top = coupled.filter(f => f.importedBy >= 3).slice(0, maxCoupledFiles);
      if (top.length > 0) {
        lines.push(t('codebase.mostImportedFiles'));
        lines.push(t('codebase.mostImportedFilesProse'));
        lines.push('');
        lines.push(t('codebase.coupledTableHeader'));
        lines.push(t('codebase.coupledTableSep'));
        for (const f of top) {
          lines.push(`| \`${f.path}\` | ${f.importedBy} | ${f.imports} |`);
        }
        lines.push('');
      }
    }

    // ── Layer violations ──────────────────────────────────────────────────────
    if (cg?.layerViolations?.length) {
      lines.push(t('codebase.layerViolations'));
      lines.push(t('codebase.layerViolationsProse'));
      lines.push('');
      for (const v of cg.layerViolations.slice(0, 5)) {
        lines.push(`- \`${v.callerId}\` → \`${v.calleeId}\` *(${v.callerLayer} → ${v.calleeLayer})*`);
      }
      if (cg.layerViolations.length > 5) {
        lines.push(t('codebase.layerViolationsMore', { count: cg.layerViolations.length - 5 }));
      }
      lines.push('');
    }

    // ── Spec domains ──────────────────────────────────────────────────────────
    const specsDir = join(rootPath, 'openspec', 'specs');
    if (existsSync(specsDir)) {
      try {
        const entries = await readdir(specsDir);
        const domains = entries.filter(e => existsSync(join(specsDir, e, 'spec.md')));
        if (domains.length > 0) {
          lines.push(t('codebase.specDomains'));
          lines.push(t('codebase.specDomainsProse'));
          lines.push('');
          for (const d of domains) {
            lines.push(`- \`${d}\` — \`openspec/specs/${d}/spec.md\``);
          }
          lines.push('');
        }
      } catch { /* non-fatal */ }
    }

    // ── MCP workflow ─────────────────────────────────────────────────────────────────────────────
    lines.push(t('codebase.mcpWorkflow'));
    lines.push('');
    lines.push(t('codebase.mcpWorkflowFollow'));
    lines.push('');
    lines.push(t('codebase.mcpStep1'));
    lines.push(t('codebase.mcpStep2'));
    lines.push(t('codebase.mcpStep2Tools'));
    lines.push(t('codebase.mcpStep3'));
    lines.push(t('codebase.mcpStep4'));
    lines.push(t('codebase.mcpStep5'));
    lines.push('');
    lines.push(t('codebase.mcpOnDemand'));
    lines.push(t('codebase.mcpOnDemandTools'));

    const digest = lines.join('\n') + '\n';
    await writeFile(join(outputDir, 'CODEBASE.md'), digest, 'utf-8');
    return true;
  } catch {
    return false;
  }
}
