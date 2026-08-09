/**
 * Architecture invariant rules (spec-23).
 *
 * A small, opt-in, fully declarative rule format for dependency / layer /
 * module-boundary constraints. Rules are author-declared in
 * `.openlore/architecture.json` (and optionally sourced from synced ADR files),
 * NEVER inferred by an LLM. Parsing is total: malformed entries become warnings
 * and are skipped — loading rules never throws.
 *
 * The checker ([check.ts](./check.ts)) compiles these down to deterministic
 * passes over the file-level dependency graph, reusing the canonical
 * `classifyLayerEdge` primitive from the call-graph analyzer for the `layers` kind.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { OPENLORE_DIR } from '../../constants.js';
import { openloreReadTarget } from '../services/write-target.js';

/** Where a rule came from — an author's config file, or a recorded decision (spec-16). */
export type RuleSource = 'config' | 'decision';

/**
 * Ordered layering: key order is top → bottom, so a lower layer depending on an
 * upper layer is a violation. Each layer maps to one or more path prefixes.
 */
export interface LayersRule {
  kind: 'layers';
  layers: Record<string, string[]>;
  source: RuleSource;
}

/** "Files under `from` must not depend on files under `to`." */
export interface ForbiddenRule {
  kind: 'forbidden';
  from: string;
  to: string;
  reason?: string;
  source: RuleSource;
}

/** Module boundary: "files under `module` may depend ONLY on `mayDependOn` (plus themselves)." */
export interface AllowedOnlyRule {
  kind: 'allowedOnly';
  module: string;
  mayDependOn: string[];
  reason?: string;
  source: RuleSource;
}

export type ArchitectureRule = LayersRule | ForbiddenRule | AllowedOnlyRule;

/** The parsed rule set plus any non-fatal warnings collected while loading. */
export interface ArchitectureRules {
  rules: ArchitectureRule[];
  warnings: string[];
}

/** The on-disk shape of `.openlore/architecture.json` (all keys optional). */
interface RawArchitectureConfig {
  layers?: Record<string, string[]>;
  forbidden?: Array<{ from?: unknown; to?: unknown; reason?: unknown }>;
  allowedOnly?: Array<{ module?: unknown; mayDependOn?: unknown; reason?: unknown }>;
}

const ARCHITECTURE_CONFIG_FILE = 'architecture.json';

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

/**
 * Parse a raw config object into validated rules. Total: every malformed entry is
 * recorded as a warning and skipped; this never throws. `source` tags provenance.
 */
export function parseArchitectureRules(raw: unknown, source: RuleSource): ArchitectureRules {
  const rules: ArchitectureRule[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { rules, warnings: ['architecture rules: expected a JSON object'] };
  }
  const cfg = raw as RawArchitectureConfig;

  // layers
  if (cfg.layers !== undefined) {
    if (cfg.layers && typeof cfg.layers === 'object' && !Array.isArray(cfg.layers)) {
      const layers: Record<string, string[]> = {};
      for (const [name, prefixes] of Object.entries(cfg.layers)) {
        if (isStringArray(prefixes) && prefixes.length > 0) {
          layers[name] = prefixes;
        } else {
          warnings.push(`layers.${name}: expected a non-empty array of path prefixes — skipped`);
        }
      }
      if (Object.keys(layers).length >= 2) {
        rules.push({ kind: 'layers', layers, source });
      } else if (Object.keys(layers).length > 0) {
        warnings.push('layers: need at least 2 layers to define a direction — skipped');
      }
    } else {
      warnings.push('layers: expected an object mapping layer name → path prefixes — skipped');
    }
  }

  // forbidden
  if (cfg.forbidden !== undefined) {
    if (Array.isArray(cfg.forbidden)) {
      cfg.forbidden.forEach((r, i) => {
        if (r && typeof r.from === 'string' && typeof r.to === 'string') {
          rules.push({
            kind: 'forbidden',
            from: r.from,
            to: r.to,
            reason: typeof r.reason === 'string' ? r.reason : undefined,
            source,
          });
        } else {
          warnings.push(`forbidden[${i}]: requires string "from" and "to" — skipped`);
        }
      });
    } else {
      warnings.push('forbidden: expected an array — skipped');
    }
  }

  // allowedOnly
  if (cfg.allowedOnly !== undefined) {
    if (Array.isArray(cfg.allowedOnly)) {
      cfg.allowedOnly.forEach((r, i) => {
        if (r && typeof r.module === 'string' && isStringArray(r.mayDependOn)) {
          rules.push({
            kind: 'allowedOnly',
            module: r.module,
            mayDependOn: r.mayDependOn,
            reason: typeof r.reason === 'string' ? r.reason : undefined,
            source,
          });
        } else {
          warnings.push(`allowedOnly[${i}]: requires string "module" and string[] "mayDependOn" — skipped`);
        }
      });
    } else {
      warnings.push('allowedOnly: expected an array — skipped');
    }
  }

  return { rules, warnings };
}

/**
 * Parse `Invariant:` markers out of synced ADR files. We read SYNCED files only —
 * never `pending.json` fields, which are purged on sync (spec-16 edge case).
 * Supported single-line grammar (deterministic, no LLM):
 *
 *   Invariant: forbidden <fromPrefix> -> <toPrefix> [(reason)]
 *   Invariant: allowedOnly <modulePrefix> -> <prefixA>, <prefixB> [(reason)]
 *
 * Anything else is ignored. Returns rules tagged `source: 'decision'`.
 */
export function parseInvariantMarkers(adrText: string): ArchitectureRule[] {
  const rules: ArchitectureRule[] = [];
  for (const line of adrText.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*>]\s*)*Invariant:\s*(.+)$/i);
    if (!m) continue;
    let body = m[1].trim();
    let reason: string | undefined;
    const reasonMatch = body.match(/\(([^)]*)\)\s*$/);
    if (reasonMatch) {
      reason = reasonMatch[1].trim() || undefined;
      body = body.slice(0, reasonMatch.index).trim();
    }
    const forbidden = body.match(/^forbidden\s+(\S+)\s*->\s*(\S+)$/i);
    if (forbidden) {
      rules.push({ kind: 'forbidden', from: forbidden[1], to: forbidden[2], reason, source: 'decision' });
      continue;
    }
    const allowed = body.match(/^allowedOnly\s+(\S+)\s*->\s*(.+)$/i);
    if (allowed) {
      const mayDependOn = allowed[2].split(',').map(s => s.trim()).filter(Boolean);
      if (mayDependOn.length > 0) {
        rules.push({ kind: 'allowedOnly', module: allowed[1], mayDependOn, reason, source: 'decision' });
      }
    }
  }
  return rules;
}

/** Read invariants from synced ADR files under `openspec/decisions/adr-*.md`. */
async function loadDecisionInvariants(absDir: string): Promise<{ rules: ArchitectureRule[]; warnings: string[] }> {
  const rules: ArchitectureRule[] = [];
  const warnings: string[] = [];
  const decisionsDir = join(absDir, 'openspec', 'decisions');
  let entries: string[];
  try {
    entries = await readdir(decisionsDir);
  } catch {
    return { rules, warnings }; // no decisions dir — fine
  }
  for (const name of entries.sort()) {
    if (!/^adr-.*\.md$/i.test(name)) continue;
    try {
      const text = await readFile(join(decisionsDir, name), 'utf-8');
      rules.push(...parseInvariantMarkers(text));
    } catch {
      warnings.push(`could not read decision file ${name}`);
    }
  }
  return { rules, warnings };
}

/**
 * Load the effective architecture rules for a project: the opt-in config file
 * merged with any decision-sourced invariants. Absent config is NOT an error —
 * returns an empty, inert rule set. Never throws.
 */
export async function loadArchitectureRules(
  absDir: string,
  opts: { includeDecisions?: boolean } = {}
): Promise<ArchitectureRules> {
  const rules: ArchitectureRule[] = [];
  const warnings: string[] = [];

  // Config file (opt-in).
  try {
    // Through the perimeter: a lexical join reads the architecture rules of whatever
    // `<root>/.openlore` points at, and those rules decide what the server reports as
    // a layer violation. Refusal lands in the catch below, like an absent config.
    const raw = await readFile(openloreReadTarget(absDir, ARCHITECTURE_CONFIG_FILE), 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { rules, warnings: [`${OPENLORE_DIR}/${ARCHITECTURE_CONFIG_FILE}: invalid JSON — ignored`] };
    }
    const fromConfig = parseArchitectureRules(parsed, 'config');
    rules.push(...fromConfig.rules);
    warnings.push(...fromConfig.warnings);
  } catch {
    /* no config file — inert */
  }

  // Decision-sourced invariants (spec-16 tie), opt-in via flag.
  if (opts.includeDecisions !== false) {
    const fromDecisions = await loadDecisionInvariants(absDir);
    rules.push(...fromDecisions.rules);
    warnings.push(...fromDecisions.warnings);
  }

  return { rules, warnings };
}

/** True when no rules are declared — the instrument is fully inert. */
export function rulesAreInert(rules: ArchitectureRules): boolean {
  return rules.rules.length === 0;
}
