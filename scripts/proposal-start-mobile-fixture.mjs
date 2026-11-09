// 手机正式路由 + 只在验收期间生成的 Web 入口；不改原生入口。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'

export async function mobileProposalFixture() {
  const boot = new URL('../apps/mobile/src/shell/boot.ts', import.meta.url)
  const override = new URL('../apps/mobile/src/shell/boot.web.ts', import.meta.url)
  const helper = new URL('../apps/mobile/src/preview/ProposalStartFixture.web.ts', import.meta.url)
  if (existsSync(override) || existsSync(helper)) throw new Error('预览夹具已存在')
  const code = readFileSync(
    new URL('../packages/core/test/proposal-start-fixture.mts', import.meta.url),
    'utf8',
  ).replaceAll('../src/', '../../../../packages/core/src/')
  let source = `import { proposalStartFixture } from '../preview/ProposalStartFixture.web'\nimport { navigationRef } from './dev-links'\n${readFileSync(boot, 'utf8')}`
  source = source.replace(
    'const served = serve(\n      createMockCore({',
    'const fixture = proposalStartFixture(\n      createMockCore({',
  )
  const boundary = '...(controlled ? { scenarioClock: controlled.clock } : {}),\n      }),\n    )'
  if (!source.includes(boundary)) throw new Error('手机预览入口已变化')
  source = source.replace(
    boundary,
    `${boundary}
    let proposalSession = ''
    let proposalId = ''
    Object.assign(globalThis, { proposalFixture: { ...fixture.state,
      open: async () => {
        const result = await fixture.core.command('session.create', { deviceId: 'local', cwd: '/', text: '提个子会话' }, new AbortController().signal) as { sessionId: string }
        proposalSession = result.sessionId
        navigationRef.navigate('Detail', { deviceId: 'local', sessionId: proposalSession })
      },
      edit: (id: string) => {
        proposalId = id
        navigationRef.navigate('ProposalStart', { deviceId: 'local', sessionId: proposalSession, proposalId })
      }
    } })
    const served = serve(fixture.core)`,
  )
  writeFileSync(helper, code, { flag: 'wx' })
  writeFileSync(override, source, { flag: 'wx' })
  const listener = createServer()
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  const child = spawn(
    process.execPath,
    ['node_modules/expo/bin/cli', 'start', '--web', '--offline', '--port', String(port)],
    {
      cwd: new URL('../apps/mobile/', import.meta.url),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', EXPO_NO_TYPESCRIPT_SETUP: '1', EXPO_PUBLIC_LITCH_E2E: '1' },
    },
  )
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  const close = async () => {
    if (child.exitCode === null) {
      const done = new Promise((resolve) => child.once('exit', resolve))
      child.kill()
      await done
    }
    unlinkSync(override)
    unlinkSync(helper)
  }
  const url = `http://127.0.0.1:${port}`
  try {
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(url)).ok) return { url, close }
      } catch {}
      if (child.exitCode !== null) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error(output)
  } catch (error) {
    await close()
    throw error
  }
}
