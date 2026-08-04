import { describe, it, expect } from 'vitest';
import { constants as bufferConstants } from 'node:buffer';
import { stringifyArtifact, MAX_STRING_LENGTH } from './artifact-json.js';

describe('stringifyArtifact', () => {
  it('serialises compact by default — no indentation spent on machine input', () => {
    const out = stringifyArtifact({ a: 1, b: [2, 3] }, 'llm-context.json');
    expect(out).toBe('{"a":1,"b":[2,3]}');
  });

  it('honours an explicit indent for the hand-readable artifacts', () => {
    const out = stringifyArtifact({ a: 1 }, 'repo-structure.json', { indent: 2 });
    expect(out).toBe('{\n  "a": 1\n}');
  });

  it('exposes the runtime ceiling, not a hardcoded one', () => {
    expect(MAX_STRING_LENGTH).toBe(bufferConstants.MAX_STRING_LENGTH);
    // 2^29-24 on 64-bit, 2^28-16 on 32-bit — either way far above a real artifact.
    expect(MAX_STRING_LENGTH).toBeGreaterThan(2 ** 28 - 32);
  });

  it('reports a REAL string-ceiling overflow with artifact, sections and lever', () => {
    // A genuine overflow, not a simulated one: 600 references to one 1 MB string
    // serialise to ~600 MB while retaining ~1 MB, and V8 raises on the length
    // check without ever materialising the result (~3 s, ~46 MB RSS).
    const chunk = 'a'.repeat(1_000_000);
    const oversized = { signatures: [1, 2, 3], callGraph: new Array(600).fill(chunk) };

    let thrown: unknown;
    try {
      stringifyArtifact(oversized, 'llm-context.json', {
        scale: '4246 node(s) / 10248 edge(s)',
        configPath: '/srv/workspace/repo/.openlore/config.json',
      });
    } catch (error) {
      thrown = error;
    }

    const err = thrown as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/llm-context\.json does not fit into a single JSON string/);
    // Names the ceiling, the heavy section, this run's scale and where to act.
    expect(err.message).toContain('536,870,888');
    expect(err.message).toMatch(/Largest sections: callGraph/);
    expect(err.message).toContain('4246 node(s) / 10248 edge(s)');
    expect(err.message).toContain('/srv/workspace/repo/.openlore/config.json');
    expect(err.message).toContain('--exclude');
    // The original RangeError (and its stack) is preserved for debugging.
    expect(err.cause).toBeInstanceOf(RangeError);
    expect((err.cause as Error).message).toBe('Invalid string length');
    // Serialising ~600 MB twice (once to overflow, once to size the sections)
    // takes seconds — and more under a loaded full run than in isolation.
  }, 60_000);

  it('falls back to the relative config path when none is supplied', () => {
    const chunk = 'a'.repeat(1_000_000);
    // An array, not an object: describeSections has nothing to report, so the
    // message must still stand on its own.
    expect(() => stringifyArtifact(new Array(600).fill(chunk), 'llm-context.json'))
      .toThrowError(/\.openlore\/config\.json/);
  }, 60_000);

  it('does NOT misreport a stack overflow as a string-ceiling overflow', () => {
    // JSON.stringify raises RangeError for deep nesting too. Matching on the
    // class alone would tell the operator to exclude directories over a problem
    // that has nothing to do with size.
    let root: Record<string, unknown> = {};
    let cur = root;
    for (let i = 0; i < 20_000; i++) {
      const next: Record<string, unknown> = {};
      cur.n = next;
      cur = next;
    }
    expect(() => stringifyArtifact(root, 'llm-context.json'))
      .toThrowError(/Maximum call stack size exceeded/);
    expect(() => stringifyArtifact(root, 'llm-context.json'))
      .not.toThrowError(/does not fit into a single JSON string/);
  });

  it('leaves a circular-structure failure with its own accurate message', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => stringifyArtifact(circular, 'llm-context.json'))
      .toThrowError(/Converting circular structure to JSON/);
    expect(() => stringifyArtifact(circular, 'llm-context.json')).toThrowError(TypeError);
  });
});
