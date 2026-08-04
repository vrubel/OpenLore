/**
 * JSON serialisation of analysis artifacts, bounded by the V8 string ceiling.
 *
 * Every artifact is serialised into ONE string before it reaches the disk, so
 * `JSON.stringify` throws `RangeError: Invalid string length` as soon as the
 * result passes V8's maximum string length (536 870 888 chars on 64-bit Node).
 * On a large repository that surfaced as a bare
 *
 *     Analysis failed: Invalid string length
 *
 * with no indication of WHICH artifact overflowed, how big it got, or which knob
 * bounds it — and `analyze` exited 1 with a half-written analysis directory.
 *
 * Two measures live here:
 *   - the large artifacts are written COMPACT (no pretty-print indentation).
 *     They are machine input, never diffed or read by hand, and the indentation
 *     alone cost ~40% of llm-context.json (measured: 6.73 MB → 4.79 MB);
 *   - the ceiling is reported LOUDLY and precisely — naming the artifact, the
 *     scale of the run and the knob that bounds it — instead of a generic
 *     RangeError from deep inside the analyzer.
 *
 * The ceiling is NOT worked around by dropping data: a truncated analysis would
 * silently mislead every downstream consumer. Overflow is a hard stop.
 */

import { constants as bufferConstants } from 'node:buffer';

/**
 * V8's hard ceiling on a single string — 536 870 888 chars on 64-bit Node 22.
 * Read from the runtime rather than hardcoded: it differs across architectures
 * and has been raised by V8 before.
 */
export const MAX_STRING_LENGTH = bufferConstants.MAX_STRING_LENGTH;

/**
 * Serialise one artifact, turning a string-ceiling overflow into an actionable
 * error. Compact by default; `indent` is reserved for the small artifacts that
 * stay hand-readable (repo-structure, the inventories).
 *
 * @param value    the artifact to serialise
 * @param artifact artifact file name, so the message names the actual file
 * @param opts.scale  optional human-readable size of this run (element counts),
 *                    quoted back to the operator to show what drove the overflow
 * @param opts.indent pretty-print indentation; omit for the large artifacts
 */
export function stringifyArtifact(
  value: unknown,
  artifact: string,
  opts: { scale?: string; indent?: number } = {}
): string {
  const { scale, indent } = opts;
  try {
    return JSON.stringify(value, null, indent);
  } catch (error) {
    // JSON.stringify signals the string ceiling with a RangeError; a circular
    // structure raises a TypeError and must keep its own (accurate) message.
    if (error instanceof RangeError) {
      throw new Error(
        `Artifact ${artifact} does not fit into a single JSON string: the serialised form ` +
        `exceeds the V8 maximum string length (${MAX_STRING_LENGTH.toLocaleString('en-US')} chars). ` +
        (scale ? `This run: ${scale}. ` : '') +
        `Narrow the analysed surface and re-run: add the vendored/generated trees to ` +
        `analysis.excludePatterns in .openlore/config.json, or lower --max-files.`
      );
    }
    throw error;
  }
}
