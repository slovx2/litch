// 隔离的真实 Electron 浏览器，stdin/stdout 只给验收脚本；不显示窗口、不读个人浏览器数据。
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { app, BrowserWindow } from 'electron'
import { createElectronHost } from '../../third_party/litch-automation/packages/browser/src/electron.mjs'
import {
  createBrowserExecutor,
  createSiteBook,
} from '../../third_party/litch-automation/packages/browser/src/index.mjs'

app.setPath('userData', process.env.BROWSER_FIXTURE_PROFILE!)
app.commandLine.appendSwitch('use-mock-keychain')
BrowserWindow.prototype.show = () => {
  throw new Error('验收禁止前台窗口')
}
BrowserWindow.prototype.showInactive = () => {
  throw new Error('验收禁止前台窗口')
}
async function main() {
  await app.whenReady()
  const site = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(
      "<title>Automation skill fixture</title><input aria-label=\"Name\"><button onclick=\"document.querySelector('output').textContent='Saved '+document.querySelector('input').value\">Save</button><output></output>",
    )
  })
  await new Promise<void>((done) => site.listen(0, '127.0.0.1', done))
  const address = site.address()
  if (!address || typeof address === 'string') throw new Error('fixture server failed')
  const host = createElectronHost({
    partition: 'automation-skills-fixture',
    autofillPreload: '',
    failurePage: () => 'about:blank',
    blockedDownload: () => 'fixture',
  })
  const executor = createBrowserExecutor({ host, sites: createSiteBook(null) })
  const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
  output({ ready: `http://127.0.0.1:${address.port}` })
  const reader = createInterface({ input: process.stdin })
  for await (const line of reader) {
    const call = JSON.parse(line)
    try {
      const result = await executor.call(
        {
          ...call.params,
          id: String(call.id),
          callId: String(call.id),
          namespace: 'litch_browser',
          device: { id: 'fixture', name: 'fixture', kind: 'local', target: null },
          harness: 'claude-code',
          cwd: null,
        },
        { signal: new AbortController().signal, ask: async () => 'once' },
      )
      output({ id: call.id, result })
    } catch (error) {
      output({ id: call.id, error: String(error) })
    }
  }
  host.dispose()
  site.close()
  app.exit(0)
}
void main().catch((error) => {
  console.error(error)
  app.exit(1)
})
