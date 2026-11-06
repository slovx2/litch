// 隔离验收专用的隐藏 Electron 宿主，运行正式 Chrome 桥、安装器、站点策略与执行器。

import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { app, BrowserWindow } from 'electron'
import { createSiteBook } from '../../apps/desktop/src/browser/sites.mjs'
import { ChromeBridge } from '../../apps/desktop/src/chrome-browser/bridge.mjs'
import { ChromeExecutor } from '../../apps/desktop/src/chrome-browser/executor.mjs'
import {
  ChromeInstaller,
  chromeIdentity,
} from '../../apps/desktop/src/chrome-browser/installer.mjs'

const [root, assets, profile, nativeBinary] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
]
app.setPath('userData', join(root, 'electron'))
// 隐藏验收宿主不参与 macOS 的应用激活，避免启动/退出影响用户前台。
app.setActivationPolicy('prohibited')
void app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    await window.loadURL('about:blank')
    const identity = await chromeIdentity(assets)
    const socketPath = join(root, 'bridge.sock')
    const installer = new ChromeInstaller({
      root: join(root, 'install'),
      assets,
      socketPath,
      nativeBinary,
      extensionIds: [identity.id],
      manifestDirectories: [join(profile, 'NativeMessagingHosts')],
    })
    const bridge = new ChromeBridge({
      socketPath,
      token: installer.token,
      extensionIds: [identity.id],
      version: identity.version,
    })
    await bridge.start()
    await installer.prepare()
    const executor = new ChromeExecutor({
      bridge,
      sites: createSiteBook(join(root, 'sites.json')),
      allowed: () => true,
    })
    const write = (data: unknown) =>
      process.stdout.write(`LITCH_LIFECYCLE ${JSON.stringify(data)}\n`)
    write({ ready: true, extensionDirectory: installer.extensionDirectory })
    const input = createInterface({ input: process.stdin })
    input.on('line', (line) => {
      void (async () => {
        const message = JSON.parse(line)
        if (message.op === 'status') return write({ id: message.id, instances: bridge.instances() })
        const asks: string[] = []
        const result = await executor.call(
          {
            id: String(message.id),
            callId: String(message.id),
            threadId: 'same-conversation',
            turnId: 'same-turn',
            device: { id: 'local', kind: 'local', name: 'Isolated', target: null },
            harness: null,
            cwd: root,
            namespace: 'litch_browser',
            tool: message.tool,
            arguments: message.args,
          },
          {
            signal: new AbortController().signal,
            ask: async (ask) => {
              asks.push(ask.kind)
              write({ waiting: true, id: message.id, kind: ask.kind })
              if (message.delay) await new Promise((resolve) => setTimeout(resolve, message.delay))
              return 'always'
            },
          },
        )
        write({ id: message.id, result, asks })
      })().catch((error) => write({ error: String(error) }))
    })
    let closing = false
    async function close() {
      if (closing) return
      closing = true
      executor.dispose()
      await bridge.close()
      window.destroy()
      app.quit()
    }
    process.on('SIGTERM', () => {
      void close()
    })
    input.on('close', () => {
      void close()
    })
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
