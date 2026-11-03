import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  type DirectoryValidationReason,
  homeDirectoryPath,
} from '../../protocol/src/directory-validation.mjs'

export class DirectoryError extends Error {
  readonly code = -32602
  readonly data: {
    litch: 'invalidDirectory'
    field: 'cwd'
    reason: DirectoryValidationReason
    value: string
    resolvedPath: string
  }
  constructor(reason: DirectoryValidationReason, value: string, resolvedPath: string) {
    super(`Invalid working directory (${reason}): ${value}; device path: ${resolvedPath}`)
    this.data = { litch: 'invalidDirectory', field: 'cwd', reason, value, resolvedPath }
  }
}

/** 新建经理和创建前的项目权限读取必须使用相同的目标设备路径。 */
export function requireDeviceDirectory(value: string): string {
  const resolved = homeDirectoryPath(value) ? join(homedir(), value.slice(2)) : value
  if (!isAbsolute(resolved)) throw new DirectoryError('absolutePath', value, resolved)
  let directory: boolean
  try {
    directory = statSync(resolved).isDirectory()
  } catch (error) {
    const missing = ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
    throw new DirectoryError(missing ? 'missingDirectory' : 'unreadableDirectory', value, resolved)
  }
  if (!directory) throw new DirectoryError('notDirectory', value, resolved)
  return resolved
}
