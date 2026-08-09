/**
 * MCP handler: federation_status — report the federation registry and the live
 * index state of each registered repo. Read-only, conclusion-shaped. Registered
 * only behind the opt-in `federation` preset (change: add-multi-repo-federation).
 */

import { basename } from 'node:path';
import { validateDirectory } from './utils.js';
import { listRepos, listRegisteredRepos, evaluateRepoState, readRepoFingerprint } from '../../federation/registry.js';

export async function handleFederationStatus(directory: string): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  // `listRepos` already withholds members outside the server's root allowlist —
  // their paths are exactly what an agent would otherwise probe. The count of what
  // was withheld IS reported: a deliberate omission has to be audible, or the
  // operator reads a short list and concludes the registry is short.
  const repos = listRepos(absDir);
  const withheld = listRegisteredRepos(absDir).length - repos.length;
  const entries = repos.map(entry => {
    const state = evaluateRepoState(entry);
    return {
      name: entry.name,
      path: entry.path,
      state,
      registeredFingerprint: entry.fingerprint || null,
      liveFingerprint: readRepoFingerprint(entry.path),
      lastBuilt: entry.lastBuilt,
    };
  });
  const indexed = entries.filter(e => e.state === 'indexed').length;
  const withheldNote = withheld > 0
    ? `${withheld} registered repo(s) lie outside this server's root allowlist: they are deliberately ` +
      'not listed, this server cannot consult them, and their locations are not disclosed. Widening the ' +
      'scope is an operator decision (restart the server with --root for those repositories).'
    : '';
  const baseNote = entries.length === 0
    ? (withheld > 0
        ? 'No repos are consultable from this server.'
        : 'No repos registered. Add one with `openlore federation add <path>`. Federation scope on analyze_impact/find_dead_code/select_tests/find_path is a no-op until a repo is registered.')
    : `Federation is an index-of-indexes: each repo keeps its own .openlore index; queries load them lazily. ${indexed}/${entries.length} repos are currently indexed and consultable.`;
  return {
    homeRepo: basename(absDir),
    registered: entries.length,
    indexed,
    ...(withheld > 0 ? { withheld } : {}),
    repos: entries,
    note: withheldNote ? `${baseNote} ${withheldNote}` : baseNote,
  };
}
