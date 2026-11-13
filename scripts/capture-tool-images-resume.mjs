import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'

/** 把隐藏窗口直接接到隔离的真实设备，整页重开后才截图。 */
export async function captureToolImagesResume(device, threadId, profile, output) {
  const vite = await createServer({
    root: resolve('packages/ui'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    logLevel: 'error',
  })
  const wss = new WebSocketServer({ noServer: true })
  const resumes = []
  vite.httpServer.on('upgrade', (request, socket, head) => {
    if (request.url !== '/tool-image-probe') return
    wss.handleUpgrade(request, socket, head, (ws) => {
      const handlers = device.attach({ send: (text) => ws.send(text), close: () => ws.close() })
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString())
        if (frame.method === 'thread/resume') resumes.push(frame.params)
        handlers.message(data.toString())
      })
      ws.on('close', () => handlers.close('验收窗口关闭'))
    })
  })
  await vite.listen()
  const binary =
    process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe'
  const child = spawn(
    resolve('apps/desktop/node_modules/electron/dist', binary),
    withChromiumTestArgs([resolve('apps/desktop/scripts/tool-images-resume-window.mjs')]),
    {
      env: {
        PATH: process.env.PATH,
        HOME: profile,
        CODEX_HOME: join(profile, '.codex'),
        LITCH_IMAGE_PROFILE: profile,
        LITCH_IMAGE_OUTPUT: output,
        LITCH_IMAGE_URL: `${vite.resolvedUrls.local[0]}test/tool-images-resume-fixture.html?thread=${threadId}`,
      },
      stdio: 'inherit',
    },
  )
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('exit', resolve)
      child.once('error', reject)
    })
    assert.equal(code, 0, '隐藏窗口图片验收必须通过')
    assert.ok(resumes.length >= 2, '必须打开后重开会话')
    for (const params of resumes) {
      assert.equal(params.excludeTurns, true)
      assert.ok(params.initialTurnsPage, '核心必须通过内嵌分页恢复首屏')
    }
    writeFileSync(join(output, 'ui-resumes.json'), JSON.stringify(resumes, null, 2))
  } finally {
    for (const ws of wss.clients) ws.terminate()
    await new Promise((resolve) => wss.close(resolve))
    await vite.close()
  }
}
