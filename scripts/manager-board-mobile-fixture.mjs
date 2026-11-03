// 只在网页预览创建临时替身；不改原生入口和正式 boot.ts，结束后删除自己创建的文件。

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'

export async function installManagerBoardMobileFixture() {
  const boot = new URL('../apps/mobile/src/shell/boot.ts', import.meta.url)
  const override = new URL('../apps/mobile/src/shell/boot.web.ts', import.meta.url)
  const fixture = new URL('../apps/mobile/src/preview/ManagerBoardFixture.web.ts', import.meta.url)
  if (existsSync(override) || existsSync(fixture))
    throw new Error('手机看板临时夹具已存在，请先结束上一轮验收')
  let source = readFileSync(boot, 'utf8')
  source = `import { managerBoardFixture } from '../preview/ManagerBoardFixture.web'\n${source}`
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
      await fetch('/__manager_board_data').then(r => r.json()),
    )
    Object.assign(globalThis, { __managerBoardFixture: fixture.state })
    const served = serve(fixture.core)`,
  )
  const helper = readFileSync(
    new URL('../packages/core/test/manager-board-fixture.mts', import.meta.url),
    'utf8',
  )
    .replaceAll('../src/', '../../../../packages/core/src/')
    .replaceAll('../../protocol/', '../../../../packages/protocol/')
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
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const server = spawn(
    process.execPath,
    ['node_modules/expo/bin/cli', 'start', '--web', '--offline', '--port', String(port)],
    {
      cwd: new URL('../apps/mobile/', import.meta.url),
      env: { ...process.env, CI: '1', EXPO_NO_TYPESCRIPT_SETUP: '1' },
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
