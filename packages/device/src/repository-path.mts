import { isAbsolute, relative, sep } from 'node:path'
import { RepositoryCommandError, runGit } from './repository-command.mjs'

export const insideRepository = (root: string, path: string): boolean => {
  const child = relative(root, path)
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

export async function repositoryRoot(directory: string, signal: AbortSignal): Promise<string> {
  const result = await runGit(['rev-parse', '--show-toplevel'], directory, signal, 16384)
  if (result.code !== 0 || result.truncated)
    throw new RepositoryCommandError(
      'not_repository',
      result.stderr || 'Select a repository subdirectory of the outer folder.',
    )
  return result.stdout.toString('utf8').trimEnd()
}
