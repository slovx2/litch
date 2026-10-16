import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { locateHostPi, PI_PACKAGE } from '../src/host-pi.mjs'
import { requireMinimumPi, versions } from '../src/versions.mjs'

// 伪造 npm 全局安装：bin 是指向包内 CLI 的符号链接，pi-ai 嵌套在包内或被提升为兄弟包。
async function install(prefix: string, version: string, nested: boolean): Promise<string> {
  const modules = join(prefix, 'lib', 'node_modules')
  const pkg = join(modules, PI_PACKAGE)
  const ai = join(nested ? join(pkg, 'node_modules') : modules, '@earendil-works', 'pi-ai')
  await mkdir(join(pkg, 'dist', 'bundle'), { recursive: true })
  await mkdir(ai, { recursive: true })
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: PI_PACKAGE, version, exports: { '.': { import: './dist/index.js' } } }),
  )
  await writeFile(
    join(ai, 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-ai', version, main: './dist/ai.js' }),
  )
  const cli = join(pkg, 'dist', 'bundle', 'cli.js')
  await writeFile(cli, '#!/usr/bin/env node\n')
  await chmod(cli, 0o755)
  await mkdir(join(prefix, 'bin'), { recursive: true })
  await symlink(cli, join(prefix, 'bin', 'pi'))
  return realpath(pkg)
}

test('从用户安装的 CLI 定位 Pi 的 npm 包，兼容嵌套与提升布局，找不到时给出可操作提示', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cha-host-pi-')))
  try {
    for (const nested of [true, false]) {
      const prefix = join(root, nested ? 'nested' : 'hoisted')
      const pkg = await install(prefix, '1.0.4', nested)
      const found = locateHostPi({ PATH: join(prefix, 'bin') })
      assert.equal(found.root, pkg)
      assert.equal(found.version, '1.0.4')
      assert.equal(found.cli, join(pkg, 'dist', 'bundle', 'cli.js'))
      assert.equal(found.sdkEntry, join(pkg, 'dist', 'index.js'))
      assert.match(found.aiEntry, /pi-ai[/\\]dist[/\\]ai\.js$/)
      // PI_CLI 优先于 PATH，可直接指向包内文件。
      assert.equal(locateHostPi({ PATH: '', PI_CLI: found.cli }).root, pkg)
    }
    assert.throws(() => locateHostPi({ PATH: join(root, 'missing') }), /CLI 不可执行或未找到: pi/)
    // 独立二进制或包装脚本不在 npm 包内，没有可加载的运行时。
    const standalone = join(root, 'standalone')
    await writeFile(standalone, '#!/bin/sh\n')
    await chmod(standalone, 0o755)
    assert.throws(
      () => locateHostPi({ PATH: '', PI_CLI: standalone }),
      /无法从 .* 定位 Pi 的 npm 包.*PI_CLI/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('用户安装的 Pi 只校验下限：接受基线及更高稳定版，拒绝低版本与预发布', () => {
  const pi = { cli: '', root: '', sdkEntry: '', aiEntry: '' }
  for (const version of [versions.cli, '0.99.2', '1.0.4', '2.0.0'])
    assert.equal(requireMinimumPi({ ...pi, version }).version, version)
  for (const version of ['0.99.0', '0.98.9', '1.0.4-beta.1', 'latest'])
    assert.throws(() => requireMinimumPi({ ...pi, version }), /需要用户安装的 Pi CLI >= /)
})

test('接口不兼容的 Pi 在检测阶段就报出可操作的错误', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cha-host-pi-')))
  try {
    const pkg = await install(root, '9.0.0', true)
    const ai = join(pkg, 'node_modules', '@earendil-works', 'pi-ai', 'dist')
    await mkdir(ai)
    await writeFile(join(ai, 'ai.js'), '')
    await writeFile(join(pkg, 'dist', 'index.js'), 'export const createAgentSession = () => {}\n')
    const probe = () =>
      spawnSync(
        process.execPath,
        [fileURLToPath(new URL('../src/adapter.mjs', import.meta.url)), '--runtime-info'],
        { env: { PATH: '', PI_CLI: join(pkg, 'dist', 'bundle', 'cli.js') }, encoding: 'utf8' },
      )
    // 内部文件被移走：加载失败。
    let result = probe()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /用户安装的 Pi 9\.0\.0 与适配器不兼容（.*extensions.*PI_CLI/s)
    // 文件都在但接口被移除：逐个列出缺少的名字。
    await mkdir(join(pkg, 'dist', 'extensions'))
    await writeFile(
      join(pkg, 'dist', 'extensions', 'index.js'),
      'export const builtInExtensions = []\n',
    )
    result = probe()
    assert.equal(result.status, 1)
    assert.match(
      result.stderr,
      /与适配器不兼容（缺少 createEventBus、.*getSupportedThinkingLevels）/,
    )
    assert.doesNotMatch(result.stderr, /createAgentSession|builtInExtensions/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
