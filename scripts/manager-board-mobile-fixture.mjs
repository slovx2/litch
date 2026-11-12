// 只在网页预览创建临时替身；不改原生入口和正式 boot.ts，结束后删除自己创建的文件。

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'

export async function installManagerBoardMobileFixture({
  consoleCards = false,
  drafts = false,
  links = false,
  issues = false,
  port: fixed = 0,
} = {}) {
  const boot = new URL('../apps/mobile/src/shell/boot.ts', import.meta.url)
  const override = new URL('../apps/mobile/src/shell/boot.web.ts', import.meta.url)
  const fixture = new URL('../apps/mobile/src/preview/ManagerBoardFixture.web.ts', import.meta.url)
  if (existsSync(override) || existsSync(fixture))
    throw new Error('手机看板临时夹具已存在，请先结束上一轮验收')
  let source = readFileSync(boot, 'utf8')
  source = `import { managerBoardFixture } from '../preview/ManagerBoardFixture.web'\n${drafts ? "import { jsonFile } from './json-file'\n" : ''}${source}`
  if (links || consoleCards) source = `import { navigationRef } from './dev-links'\n${source}`
  source = source.replace(
    'const served = serve(\n      createMockCore({',
    'const fixture = managerBoardFixture(\n      createMockCore({',
  )
  const end = '...(controlled ? { scenarioClock: controlled.clock } : {}),\n      }),\n    )'
  if (!source.includes(end)) throw new Error('手机 boot 结构已变化，需要更新看板夹具')
  source = source.replace(
    end,
    `...(controlled ? { scenarioClock: controlled.clock } : {}),
      }),
      ${consoleCards || links || issues ? '' : "await fetch('/__manager_board_data').then(r => r.json()),"}
    )
    ${drafts ? 'for (const [name, value] of Object.entries(fixture.drafts.mobile)) jsonFile(name).write(value)' : ''}
    Object.assign(globalThis, { __managerBoardFixture: fixture.state })
    ${consoleCards ? 'Object.assign(globalThis, { __managerBoardNavigation: navigationRef })' : ''}
    ${links ? "Object.assign(globalThis, { __managerLinks: { ...fixture.state, jump: (issue: string) => navigationRef.navigate('ManagerConsole', { deviceId: 'local', managerId: 'm1', issue }) } })" : ''}
    const served = serve(fixture.core)`,
  )
  let helper = readFileSync(
    new URL(
      issues
        ? '../packages/core/test/mobile-console-fixture.mts'
        : links
          ? '../packages/core/test/manager-link-fixture.mts'
          : consoleCards
            ? '../packages/core/test/console-cards-fixture.mts'
            : '../packages/core/test/manager-board-fixture.mts',
      import.meta.url,
    ),
    'utf8',
  )
    .replace('export function consoleCardsFixture', 'export function managerBoardFixture')
    .replace('export function managerLinkFixture', 'export function managerBoardFixture')
    .replace(
      './console-cards-fixture.mjs',
      '../../../../packages/core/test/console-cards-fixture.mts',
    )
    .replaceAll('../src/', '../../../../packages/core/src/')
    .replaceAll('../../protocol/', '../../../../packages/protocol/')
  // Metro 只观察 core/src；复用的测试夹具一起放进临时网页文件，不扩大正式包的观察目录。
  if (links) {
    const cards = readFileSync(
      new URL('../packages/core/test/console-cards-fixture.mts', import.meta.url),
      'utf8',
    ).replace(/^import .*\n/gm, '')
    helper = helper.replace(
      "import { consoleCardsFixture } from '../../../../packages/core/test/console-cards-fixture.mts'",
      "import { sampleManagers } from '../../../../packages/core/src/mock/sample-manager.mts'",
    )
    helper += `\n${cards}`
  }
  writeFileSync(fixture, helper, { flag: 'wx' })
  try {
    writeFileSync(override, source, { flag: 'wx' })
  } catch (error) {
    unlinkSync(fixture)
    throw error
  }
  const cleanup = () => {
    unlinkSync(override)
    unlinkSync(fixture)
  }
  // Metro 会缓存模块解析；夹具文件必须先创建，再起这一轮专用预览。
  const probe = createServer()
  await new Promise((resolve) => probe.listen(fixed, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const server = spawn(
    process.execPath,
    ['node_modules/expo/bin/cli', 'start', '--web', '--offline', '--port', String(port)],
    {
      cwd: new URL('../apps/mobile/', import.meta.url),
      env: { ...process.env, CI: '1', EXPO_NO_TYPESCRIPT_SETUP: '1', EXPO_PUBLIC_LITCH_E2E: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  server.stdout.on('data', (chunk) => {
    output += chunk
  })
  server.stderr.on('data', (chunk) => {
    output += chunk
  })
  const close = async () => {
    server.kill()
    if (server.exitCode === null) await new Promise((resolve) => server.once('exit', resolve))
    cleanup()
  }
  try {
    const url = `http://127.0.0.1:${port}`
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(url)).ok) return { url, close }
      } catch {}
      if (server.exitCode !== null) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error(`手机隔离预览未就绪：${output}`)
  } catch (error) {
    await close()
    throw error
  }
}
