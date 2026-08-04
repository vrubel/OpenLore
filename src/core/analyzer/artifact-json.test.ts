import { describe, it, expect } from 'vitest';
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

  it('turns a string-ceiling overflow into an actionable error naming the artifact', () => {
    // A getter that raises the very RangeError V8 raises once the serialised
    // form passes the maximum string length — the real overflow is not
    // reproducible in a test without allocating ~512 MB.
    const oversized = {
      get callGraph(): unknown {
        throw new RangeError('Invalid string length');
      },
    };

    expect(() =>
      stringifyArtifact(oversized, 'llm-context.json', { scale: '4215 node(s) / 10179 edge(s)' })
    ).toThrowError(/llm-context\.json does not fit into a single JSON string/);

    expect(() => stringifyArtifact(oversized, 'llm-context.json')).toThrowError(
      new RegExp(String(MAX_STRING_LENGTH.toLocaleString('en-US')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );

    // The operator is told what to narrow, and how big this run was.
    expect(() =>
      stringifyArtifact(oversized, 'llm-context.json', { scale: '4215 node(s) / 10179 edge(s)' })
    ).toThrowError(/excludePatterns|--max-files/);
    expect(() =>
      stringifyArtifact(oversized, 'llm-context.json', { scale: '4215 node(s) / 10179 edge(s)' })
    ).toThrowError(/4215 node\(s\) \/ 10179 edge\(s\)/);
  });

  it('leaves a circular-structure failure with its own accurate message', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => stringifyArtifact(circular, 'llm-context.json')).toThrowError(TypeError);
  });
});
