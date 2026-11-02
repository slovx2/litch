import type { ClientToolNamespaceSpec } from './client-tools.mjs'

export const REPOSITORY_NAMESPACE = 'litch_repository'
export const REPOSITORY_METHODS = ['log', 'show', 'diff', 'blame', 'status', 'run'] as const
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
const path = text('Path relative to the repository root.')
const ref = text('Git commit or revision expression.')
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
  run: {
    argv: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description:
        'Git arguments including the subcommand, for example ["log", "-5"] or ["add", "--", "file.txt"]. Do not include the git executable. All Git commands and options are supported.',
    },
  },
}
const descriptions: Record<RepositoryMethod, string> = {
  log: 'Read local commit history (default HEAD, 20 commits); use skip/limit for older commits.',
  show: 'Read a local commit patch, or the file at that commit when path is supplied. Binary files return metadata.',
  diff: 'Read unstaged changes by default; staged=true reads index vs base (default HEAD). base+head compares two commits; base alone compares that commit to the working tree.',
  blame:
    'Read committed line attribution (default HEAD). path is required; optionally give both start_line and end_line. Does not blame uncommitted contents.',
  status: 'Show short repository status including untracked files.',
  run: 'Execute Git with an argv array in an authorized repository. Commands can modify files, commits, refs and configuration, use the network, and run Git hooks or helpers. Returns exit_code and combined stdout/stderr as paged content.',
}
export const REPOSITORY_TOOLS: ClientToolNamespaceSpec = {
  type: 'namespace',
  name: REPOSITORY_NAMESPACE,
  description:
    'Device-executed Git commands in manager/workline repositories, with timeout and bounded output. Uses git from PATH via execFile, without a shell or OS sandbox.',
  instructions:
    'Prefer run with directory and argv. The five named methods remain convenience shortcuts. Git uses the device environment and repository configuration, and can write or access the network. directory is checked as the starting repository; Git arguments and helpers are not isolated. Use only cursor to continue the saved output without rerunning the command.',
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
