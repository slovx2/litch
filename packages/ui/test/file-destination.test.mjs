import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileDestination, revealLabel } from '../src/files/destination.ts'
import { en } from '../src/i18n/en.ts'
import { zhCN as zh } from '../src/i18n/zh-CN.ts'

test('本机文件与目录只显示系统文件管理器，远程文件保留另存', () => {
  const both = { reveal: true, save: true }
  for (const dir of [false, true]) assert.equal(fileDestination('local', dir, both), 'revealLocal')
  assert.equal(fileDestination('ssh', false, both), 'saveLocal')
  assert.equal(fileDestination('ssh', true, both), null)
  assert.equal(fileDestination(undefined, false, both), null)
  assert.equal(fileDestination('local', false, { reveal: false, save: true }), null)
  assert.equal(fileDestination('ssh', false, { reveal: true, save: false }), null)
})

test('macOS、Windows 和 Linux 文案按客户端平台选择，中英文均提供', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const key = revealLabel(platform)
    assert.equal(
      zh[key],
      platform === 'darwin'
        ? '在 Finder 中打开'
        : platform === 'win32'
          ? '在资源管理器中显示'
          : '在文件管理器中打开',
    )
    assert.equal(
      en[key],
      platform === 'darwin'
        ? 'Show in Finder'
        : platform === 'win32'
          ? 'Show in File Explorer'
          : 'Show in File Manager',
    )
  }
})
