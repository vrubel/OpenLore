/**
 * ADR Generator
 *
 * Converts enriched Architecture Decision Records from the LLM pipeline
 * into formatted markdown files following the standard ADR template.
 */

import type { EnrichedADR, ArchitectureSynthesis, PipelineResult } from './spec-pipeline.js';
import type { GeneratedSpec } from './openspec-format-generator.js';
import { t } from '../../utils/i18n.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ADRGeneratorOptions {
  /** Version string for headers */
  version?: string;
  /** Include Mermaid architecture diagrams */
  includeMermaid?: boolean;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Convert a title to a kebab-case slug for file naming.
 */
function titleToSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ============================================================================
// ADR GENERATOR
// ============================================================================

export class ADRGenerator {
  private options: Required<ADRGeneratorOptions>;

  constructor(options: ADRGeneratorOptions = {}) {
    this.options = {
      version: options.version ?? '1.0.0',
      includeMermaid: options.includeMermaid ?? true,
    };
  }

  /**
   * Generate all ADR specs from pipeline results.
   * Returns individual ADR files plus an index file.
   */
  generateADRs(result: PipelineResult): GeneratedSpec[] {
    if (!result.adrs || result.adrs.length === 0) return [];

    const specs: GeneratedSpec[] = [];

    for (const adr of result.adrs) {
      specs.push(this.generateSingleADR(adr, result.architecture));
    }

    specs.push(this.generateADRIndex(result.adrs));

    return specs;
  }

  /**
   * Generate a single ADR markdown file.
   */
  private generateSingleADR(adr: EnrichedADR, architecture: ArchitectureSynthesis): GeneratedSpec {
    const lines: string[] = [];
    const date = new Date().toISOString().split('T')[0];
    const slug = titleToSlug(adr.title);
    const adrNum = adr.id.replace(/[^0-9]/g, '').padStart(4, '0');

    // Defensive defaults for arrays that the LLM may omit from its response
    const consequences = adr.consequences ?? [];
    const alternatives = adr.alternatives ?? [];
    const relatedLayers = adr.relatedLayers ?? [];
    const relatedDomains = adr.relatedDomains ?? [];

    // Header
    lines.push(`# ${adr.id}: ${adr.title}`);
    lines.push('');
    lines.push(t('spec.generatedBy', { version: this.options.version, date }));
    lines.push('');

    // Status
    lines.push(t('adr.status'));
    lines.push('');
    lines.push(capitalize(adr.status));
    lines.push('');

    // Context
    lines.push(t('adr.context'));
    lines.push('');
    lines.push(adr.context);
    lines.push('');

    // Decision
    lines.push(t('adr.decision'));
    lines.push('');
    lines.push(adr.decision);
    lines.push('');

    // Consequences
    lines.push(t('adr.consequences'));
    lines.push('');
    if (consequences.length > 0) {
      for (const consequence of consequences) {
        lines.push(`- ${consequence}`);
      }
    } else {
      lines.push(t('adr.noConsequences'));
    }
    lines.push('');

    // Alternatives Considered
    if (alternatives.length > 0) {
      lines.push(t('adr.alternativesConsidered'));
      lines.push('');
      for (const alt of alternatives) {
        lines.push(`- ${alt}`);
      }
      lines.push('');
    }

    // Architecture Impact (Mermaid diagram)
    if (this.options.includeMermaid && relatedLayers.length > 0 && architecture.layerMap.length > 0) {
      lines.push(t('adr.architectureImpact'));
      lines.push('');
      lines.push('```mermaid');
      lines.push('graph TB');

      // Filter to affected layers
      const affectedLayers = architecture.layerMap.filter(
        l => relatedLayers.some(rl => l.name.toLowerCase().includes(rl.toLowerCase()))
      );

      // Fall back to all layers if filter matched nothing
      const layers = affectedLayers.length > 0 ? affectedLayers : architecture.layerMap;

      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        const layerId = layer.name.replace(/\s+/g, '');
        const isAffected = affectedLayers.length > 0;
        lines.push(`    ${layerId}["${layer.name}"]`);

        if (i < layers.length - 1) {
          const nextLayerId = layers[i + 1].name.replace(/\s+/g, '');
          lines.push(`    ${layerId} --> ${nextLayerId}`);
        }

        if (isAffected) {
          lines.push(`    style ${layerId} fill:#f9f,stroke:#333`);
        }
      }

      lines.push('```');
      lines.push('');
    }

    // Related
    lines.push(t('adr.related'));
    lines.push('');
    if (relatedLayers.length > 0) {
      lines.push(t('adr.fieldLayers', { value: relatedLayers.join(', ') }));
    }
    if (relatedDomains.length > 0) {
      lines.push(t('adr.fieldDomains', { value: relatedDomains.join(', ') }));
    }
    if (relatedLayers.length === 0 && relatedDomains.length === 0) {
      lines.push(t('adr.noLayersOrDomains'));
    }
    lines.push('');

    return {
      path: `openspec/decisions/adr-${adrNum}-${slug}.md`,
      content: lines.join('\n'),
      domain: 'decisions',
      type: 'adr',
    };
  }

  /**
   * Generate the ADR index file with a table of all decisions.
   */
  private generateADRIndex(adrs: EnrichedADR[]): GeneratedSpec {
    const lines: string[] = [];
    const date = new Date().toISOString().split('T')[0];

    lines.push(t('adr.indexTitle'));
    lines.push('');
    lines.push(t('spec.generatedBy', { version: this.options.version, date }));
    lines.push('');
    lines.push(t('adr.indexIntro1'));
    lines.push(t('adr.indexIntro2'));
    lines.push('');
    lines.push(t('adr.decisions'));
    lines.push('');
    lines.push(t('adr.decisionsTableHeader'));
    lines.push(t('adr.decisionsTableSep'));

    for (const adr of adrs) {
      const adrNum = adr.id.replace(/[^0-9]/g, '').padStart(4, '0');
      const slug = titleToSlug(adr.title);
      const fileName = `adr-${adrNum}-${slug}.md`;
      const layers = (adr.relatedLayers ?? []).join(', ') || '-';
      lines.push(`| [${adr.id}](./${fileName}) | ${adr.title} | ${capitalize(adr.status)} | ${layers} |`);
    }

    lines.push('');
    lines.push(t('adr.aboutTitle'));
    lines.push('');
    lines.push(t('adr.aboutProse1'));
    lines.push(t('adr.aboutProse2'));
    lines.push(t('adr.aboutProse3'));
    lines.push(t('adr.aboutProse4'));
    lines.push('');
    lines.push(t('adr.aboutProse5'));
    lines.push(t('adr.aboutProse6'));
    lines.push('');

    return {
      path: 'openspec/decisions/index.md',
      content: lines.join('\n'),
      domain: 'decisions',
      type: 'adr',
    };
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
