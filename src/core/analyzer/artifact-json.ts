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
 *     alone cost ~40% of llm-context.json (measured: 7 138 938 → 5 141 069 B).
 *     That is a 1.39x reprieve, NOT a fix for scaling: it moves the ceiling from
 *     roughly 45 000 to roughly 63 000 files at the density we measured, and a
 *     tree that overflows today will overflow again once it grows past that;
 *   - the ceiling is reported LOUDLY and precisely — naming the artifact, the
 *     scale of the run, WHICH top-level section is the heavy one, and the knob
 *     that bounds it — instead of a generic RangeError from deep inside the
 *     analyzer.
 *
 * The ceiling is NOT worked around by dropping data: a truncated analysis would
 * silently mislead every downstream consumer. Overflow is a hard stop.
 */

import { constants as bufferConstants } from 'node:buffer';

/**
 * V8's hard ceiling on a single string — 536 870 888 chars on 64-bit Node 22
 * (2^28−16 ≈ 268 M on 32-bit). Read from the runtime rather than hardcoded: it
 * differs across architectures and V8 has raised it before.
 */
export const MAX_STRING_LENGTH = bufferConstants.MAX_STRING_LENGTH;

/**
 * The exact V8 message for a string that outgrew the ceiling. `JSON.stringify`
 * also raises RangeError for deep nesting ("Maximum call stack size exceeded"),
 * which has nothing to do with size — matching on the class alone would report a
 * stack overflow as an oversized artifact and send the operator off excluding
 * directories for no reason.
 */
const STRING_CEILING_MESSAGE = 'Invalid string length';

/**
 * Per-section sizes of an object artifact, largest first — the answer to "what
 * exactly blew up". Only reached on the failure path, so the cost of
 * re-serialising section by section is paid once, in exchange for a diagnosis.
 * A section that overflows on its own is reported as such rather than throwing.
 */
function describeSections(value: unknown, limit = 3): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;

  const sized: Array<{ key: string; chars: number; overflowed: boolean }> = [];
  for (const [key, section] of Object.entries(value as Record<string, unknown>)) {
    if (section === undefined) continue;
    try {
      sized.push({ key, chars: JSON.stringify(section)?.length ?? 0, overflowed: false });
    } catch (error) {
      if (error instanceof RangeError) {
        sized.push({ key, chars: Number.POSITIVE_INFINITY, overflowed: true });
        continue;
      }
      throw error;
    }
  }
  if (sized.length === 0) return null;

  return sized
    .sort((a, b) => b.chars - a.chars)
    .slice(0, limit)
    .map(s => (s.overflowed
      ? `${s.key} (over the ceiling on its own)`
      : `${s.key} ${s.chars.toLocaleString('en-US')} chars`))
    .join(', ');
}

/**
 * Serialise one artifact, turning a string-ceiling overflow into an actionable
 * error. Compact by default; `indent` is reserved for the small artifacts that
 * stay hand-readable (repo-structure, the inventories).
 *
 * @param value    the artifact to serialise
 * @param artifact artifact file name, so the message names the actual file
 * @param opts.scale      optional human-readable size of this run (element
 *                        counts), quoted back to show what drove the overflow
 * @param opts.configPath optional ABSOLUTE path of the openlore config, so the
 *                        operator edits the file that is actually in effect —
 *                        analysis usually runs in a workspace copy, not in the
 *                        checkout the operator is looking at
 * @param opts.indent     pretty-print indentation; omit for the large artifacts
 */
export function stringifyArtifact(
  value: unknown,
  artifact: string,
  opts: { scale?: string; configPath?: string; indent?: number } = {}
): string {
  const { scale, configPath, indent } = opts;
  try {
    return JSON.stringify(value, null, indent);
  } catch (error) {
    if (error instanceof RangeError && error.message === STRING_CEILING_MESSAGE) {
      const sections = describeSections(value);
      throw new Error(
        `Artifact ${artifact} does not fit into a single JSON string: the serialised form ` +
        `exceeds the V8 maximum string length (${MAX_STRING_LENGTH.toLocaleString('en-US')} chars). ` +
        (sections ? `Largest sections: ${sections}. ` : '') +
        (scale ? `This run: ${scale}. ` : '') +
        `Narrow the analysed surface and re-run — exclude the trees you do not need:\n` +
        `  openlore analyze --exclude '<glob>' --exclude '<glob>'\n` +
        `or add the same globs to "analysis.excludePatterns" in ` +
        `${configPath ?? '.openlore/config.json'}\n` +
        `(generated, vendored or committed third-party trees are the usual cause; ` +
        `gitignored paths are already skipped).`,
        { cause: error }
      );
    }
    // Deep nesting (RangeError "Maximum call stack size exceeded") and circular
    // structures (TypeError) keep their own accurate messages.
    throw error;
  }
}
