import type { ClientToolNamespaceSpec } from './client-tools.mjs'

export const REPOSITORY_NAMESPACE = 'litch_repository'
export const REPOSITORY_METHODS = ['log', 'show', 'diff', 'blame', 'status'] as const
export type RepositoryMethod = (typeof REPOSITORY_METHODS)[number]

const text = (description: string) => ({ type: 'string', description })
const common = {
  directory: text(
    'Absolute repository/worktree directory, inside this manager or an owned workline directory. For a non-Git outer folder, select its repository subdirectory.',
  ),
  cursor: text(
    'Continue the previous bounded output snapshot. Supply only cursor; expires after two minutes and cannot be shared with other sessions.',
  ),
}
const path = text(
  'One literal path relative to the repository root. No pathspec/globs, parent traversal, or symbolic links outside the repository.',
)
const ref = text(
  'Local commit/ref, optionally with ~ or ^ ancestry. Missing objects are never fetched.',
)
const fields: Record<RepositoryMethod, Record<string, unknown>> = {
  log: {
    ref,
    path,
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    skip: { type: 'integer', minimum: 0, maximum: 10000 },
  },
  show: { ref, path },
  diff: { base: ref, head: ref, path, staged: { type: 'boolean' } },
  blame: {
    ref,
    path,
    start_line: { type: 'integer', minimum: 1 },
    end_line: { type: 'integer', minimum: 1 },
  },
  status: { path },
}
const descriptions: Record<RepositoryMethod, string> = {
  log: 'Read local commit history (default HEAD, 20 commits); use skip/limit for older commits.',
  show: 'Read a local commit patch, or the file at that commit when path is supplied. Binary files return metadata.',
  diff: 'Read unstaged changes by default; staged=true reads index vs base (default HEAD). base+head compares two commits; base alone compares that commit to the working tree.',
  blame:
    'Read committed line attribution (default HEAD). path is required; optionally give both start_line and end_line. Does not blame uncommitted contents.',
  status:
    'Read short repository status including untracked files; does not refresh or lock the original index.',
}
export const REPOSITORY_TOOLS: ClientToolNamespaceSpec = {
  type: 'namespace',
  name: REPOSITORY_NAMESPACE,
  description:
    'Device-executed, bounded local Git queries. No shell, network, tests, external helpers or writes to the repository. macOS/Linux use a read-only no-network OS sandbox; Windows provides controlled methods only.',
  instructions:
    'Use these methods for Git questions when available. Revisions and index are captured at the stated time; working files can change while a query runs. Use only cursor to continue the same output snapshot. No arbitrary commands, options, configuration or environment overrides are accepted.',
  tools: REPOSITORY_METHODS.map((name) => ({
    type: 'function',
    name,
    description: descriptions[name],
    inputSchema: {
      type: 'object',
      properties: { ...common, ...fields[name] },
      additionalProperties: false,
    },
  })),
}
