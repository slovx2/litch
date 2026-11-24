// 秘密和待发正文只存独立的私有目录。文件名只接受设备生成的标识。
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, win32 } from 'node:path'

export const privateName = (name: string): boolean => /^[a-zA-Z0-9_-]{1,160}$/.test(name)
const privateFilename = (name: string): boolean =>
  privateName(name) ||
  name === 'hosts.yml' ||
  name === 'helper.cjs' ||
  name === 'gh.cmd' ||
  name === 'git.cmd' ||
  name === 'lark-cli.cmd'

export function windowsPrivateAcl(directory: boolean): string {
  // 用当前进程身份和 LocalSystem 的 SID，不依赖 Windows 的显示语言。
  return [
    "$ErrorActionPreference='Stop'",
    '$target=$env:LITCH_EXTERNAL_ACL_PATH',
    '$acl=Get-Acl -LiteralPath $target',
    '$acl.SetAccessRuleProtection($true,$false)',
    'foreach($rule in @($acl.Access)){ $acl.RemoveAccessRuleAll($rule) }',
    '$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$system=[System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")',
    '$acl.SetOwner($user)',
    directory ? '$inherit="ContainerInherit,ObjectInherit"' : '$inherit="None"',
    'foreach($sid in @($user,$system)){',
    '  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,"FullControl",$inherit,"None","Allow"))',
    '}',
    'Set-Acl -LiteralPath $target -AclObject $acl',
  ].join('\n')
}

function protectWindows(path: string, directory: boolean): void {
  const root = process.env.SystemRoot
  if (!root || !win32.isAbsolute(root)) throw new Error('external_private_acl_unavailable')
  try {
    execFileSync(
      win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(windowsPrivateAcl(directory), 'utf16le').toString('base64'),
      ],
      {
        env: { SystemRoot: root, LITCH_EXTERNAL_ACL_PATH: path },
        stdio: 'ignore',
        windowsHide: true,
        timeout: 10_000,
      },
    )
  } catch {
    throw new Error('external_private_acl_unavailable')
  }
}

export class ExternalPrivateFiles {
  readonly directory: string
  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new Error('external_private_directory_must_be_absolute')
    mkdirSync(directory, { mode: 0o700, recursive: true })
    const stat = lstatSync(directory)
    if (!stat.isDirectory()) throw new Error('external_private_directory_invalid')
    if (process.platform === 'win32') protectWindows(directory, true)
    else if ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.())
      throw new Error('external_private_directory_permissions')
    this.directory = directory
  }

  path(key: string): string {
    if (!privateFilename(key)) throw new Error('external_private_file_key')
    return join(this.directory, key)
  }

  read(key: string): string | null {
    let fd: number | undefined
    try {
      const path = this.path(key)
      if (!lstatSync(path).isFile()) throw new Error('external_private_file_invalid')
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const stat = fstatSync(fd)
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 1024 * 1024 ||
        (process.platform !== 'win32' &&
          ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()))
      )
        throw new Error('external_private_file_permissions')
      return readFileSync(fd, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('external_private_file_unavailable')
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  write(key: string, contents: string): void {
    const file = this.path(key)
    const temp = this.path(`temporary-${randomUUID()}`)
    let fd: number | undefined
    try {
      fd = openSync(temp, 'wx', 0o600)
      if (process.platform === 'win32') protectWindows(temp, false)
      writeFileSync(fd, contents, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temp, file)
      if (process.platform !== 'win32') {
        const dir = openSync(this.directory, constants.O_RDONLY)
        try {
          fsyncSync(dir)
        } finally {
          closeSync(dir)
        }
      }
    } catch {
      throw new Error('external_private_file_write_failed')
    } finally {
      if (fd !== undefined) closeSync(fd)
      try {
        unlinkSync(temp)
      } catch {
        /* 已改名或未建文件。 */
      }
    }
  }

  remove(key: string): void {
    try {
      unlinkSync(this.path(key))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('external_private_file_cleanup_failed')
    }
  }

  keys(): string[] {
    return readdirSync(this.directory).filter(privateFilename)
  }

  modifiedAt(key: string): number | null {
    try {
      const stat = lstatSync(this.path(key))
      return stat.isFile() ? Math.floor(stat.mtimeMs / 1000) : null
    } catch {
      return null
    }
  }
}
