import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'

/** 只写预览专属文件；退出后清理，不改正式手机入口。 */
export async function mobileLatencyFixture() {
  const boot = new URL('../apps/mobile/src/shell/boot.ts', import.meta.url)
  const override = new URL('../apps/mobile/src/shell/boot.web.ts', import.meta.url)
  const helper = new URL('../apps/mobile/src/preview/CommandLatencyFixture.web.ts', import.meta.url)
  if (existsSync(override) || existsSync(helper)) throw new Error('预览夹具已存在')
  const code = readFileSync(
    new URL('../packages/core/test/command-latency-fixture.mts', import.meta.url),
    'utf8',
  )
    .replaceAll('../src/', '../../../../packages/core/src/')
    .replaceAll('../../protocol/', '../../../../packages/protocol/')
  let source = `import { commandLatencyFixture } from '../preview/CommandLatencyFixture.web'\nimport { navigationRef } from './dev-links'\n${readFileSync(boot, 'utf8')}`
  source = source.replace(
    'const served = serve(\n      createMockCore({',
    'const fixture = commandLatencyFixture(\n      createMockCore({',
  )
  const boundary = '...(controlled ? { scenarioClock: controlled.clock } : {}),\n      }),\n    )'
  if (!source.includes(boundary)) throw new Error('手机预览入口已变化')
  source = source.replace(
    boundary,
    `${boundary}
    Object.assign(globalThis, { latency: { ...fixture.state,
      open: async () => {
        const { sessionId } = await fixture.core.command('session.create', { deviceId: 'local', cwd: '/', text: '延迟验收' }, new AbortController().signal) as { sessionId: string }
        navigationRef.navigate('Detail', { deviceId: 'local', sessionId })
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
