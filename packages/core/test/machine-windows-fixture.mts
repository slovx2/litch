// 只在隔离 Windows 用例里查询真实 8.3 名称，不改卷设置或系统配置。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { powershellCommand } from '../src/device/machine/scripts-windows.mjs'

export function windowsShortPath(path: string): string {
  const argv = powershellCommand(
    `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$ErrorActionPreference = 'Stop'
(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${path.replaceAll("'", "''")}').ShortPath`,
  )
  const result = spawnSync(argv[0] as string, argv.slice(1), {
    windowsHide: true,
    timeout: 30_000,
  })
  assert.equal(result.status, 0, result.stderr?.toString() || String(result.error))
  const short = result.stdout.toString('utf8').trim().replaceAll('\\', '/')
  assert.ok(short.includes('~'), '验收目录必须有真实 8.3 短名，不能用长名代替')
  return short
}
