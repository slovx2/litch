// 隔离假远程：正式设备读取、核心反向 IPC、主进程暂存和 Electron 浏览器；不接 SSH 或用户资料。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { app } from 'electron'
import { createToolCalls } from '../../../packages/core/src/device/tool-calls.mjs'
import type { ToolToCore } from '../../../packages/core/src/model-client-tools.mjs'
import { createToolHub } from '../../../packages/core/src/tool-hub.mjs'
import { DeviceCalls, DeviceLayer } from '../../../packages/device/src/device-layer.mjs'
import { createBrowserExecutor } from '../../../third_party/litch-automation/packages/browser/src/browser/executor.mjs'
import { createSiteBook } from '../../../third_party/litch-automation/packages/browser/src/browser/sites.mjs'
import { createElectronHost } from '../../../third_party/litch-automation/packages/browser/src/electron.mjs'
import { createClientToolHost } from './client-tools/host.mjs'

const root = process.env.LITCH_REMOTE_UPLOAD_PROFILE!
assert.ok(root)
app.setPath('userData', root)
app.commandLine.appendSwitch('use-mock-keychain')
void app
  .whenReady()
  .then(async () => {
    const server = createServer((request, response) => {
      if (request.method === 'POST') {
        let size = 0
        const hash = createHash('sha256')
        request.on('data', (chunk: Buffer) => {
          size += chunk.length
          hash.update(chunk)
        })
        request.on('end', () => response.end(JSON.stringify({ size, hash: hash.digest('hex') })))
      } else {
        response.setHeader('content-type', 'text/html')
        response.end(
          '<title>Remote source upload</title><input id="file" type="file" hidden><button onclick="document.getElementById(\'file\').click()">Select remote</button><script>window.ticks=0;setInterval(()=>ticks++,20)</script>',
        )
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const host = createElectronHost({
      partition: 'persist:remote-upload-probe',
      autofillPreload: join(root, 'empty.cjs'),
      failurePage: () => 'about:blank',
      blockedDownload: () => 'blocked',
    })
    const executor = createBrowserExecutor({ host, sites: createSiteBook(null) })
    const layer = new DeviceLayer()
    const device = new DeviceCalls(layer, {
      id: 'fixture',
      declares: (extension) => extension === 'litchBrowserUpload',
      send() {},
      close() {},
      backlog: () => 0,
    })
    const source = join(root, 'remote-source.txt')
    const size = 99 * 1024 * 1024
    const file = await open(source, 'wx')
    const block = Buffer.alloc(192 * 1024, 90)
    const hash = createHash('sha256')
    for (let position = 0; position < size; position += block.length) {
      const chunk = block.subarray(0, Math.min(block.length, size - position))
      await file.writeFile(chunk)
      hash.update(chunk)
    }
    await file.close()
    const expectedHash = hash.digest('hex')
    let inbox!: (message: ToolToCore) => void
    let main!: ReturnType<typeof createClientToolHost>
    const staged: string[] = []
    const hub = createToolHub(
      {
        namespaces: () => ['litch_browser'],
        post: (message) => queueMicrotask(() => main.handle(message)),
        listen: (handler) => {
          inbox = handler
        },
      },
      () => {},
    )
    main = createClientToolHost(
      [
        {
          namespace: 'litch_browser',
          call(invocation, context) {
            const prepare = context.prepareUpload
            return executor.call(invocation, {
              ...context,
              ...(prepare
                ? {
                    prepareUpload: async (...args: Parameters<typeof prepare>) => {
                      const result = await prepare(...args)
                      staged.push(...result.paths)
                      return result
                    },
                  }
                : {}),
            })
          },
        },
      ],
      (message) => inbox(message as ToolToCore),
    )
    let reads = 0
    const calls = createToolCalls({
      deviceId: 'fake-remote',
      hub,
      clock: {
        now: Date.now,
        setTimer(callback, delay) {
          const timer = setTimeout(callback, delay)
          return () => clearTimeout(timer)
        },
      },
      device: () => ({
        id: 'fake-remote',
        name: 'Fake remote',
        kind: 'ssh',
        target: 'unused.invalid',
      }),
      allowed: () => true,
      context: () => ({ harness: null, cwd: null }),
      showAsk(_place, answer) {
        queueMicrotask(() => answer('once'))
        return () => {}
      },
      log() {},
      uploadRead(params) {
        assert.equal(params.path, '/fake-device-only/remote-source.txt')
        reads++
        return device.call('litch/browserUpload/read', { ...params, path: source }) as ReturnType<
          NonNullable<Parameters<typeof createToolCalls>[0]['uploadRead']>
        >
      },
    })
    let sequence = 0
    const text = (result: unknown) =>
      (result as { contentItems: { text?: string }[] }).contentItems
        .map((item) => item.text ?? '')
        .join('\n')
    const run = async (tool: string, args: Record<string, unknown>) => {
      const result = await calls.serverRequest(
        'item/tool/call',
        {
          namespace: 'litch_browser',
          tool,
          arguments: args,
          threadId: 'remote-thread',
          turnId: 'remote-turn',
          callId: String(++sequence),
        },
        sequence,
      )
      assert.equal((result as { success: boolean }).success, true, text(result))
      return text(result)
    }
    try {
      await run('navigate', { url: `http://127.0.0.1:${address.port}` })
      const snapshot = await run('snapshot', {})
      const ref = snapshot
        .split('\n')
        .find((line) => line.includes('button "Select remote"'))
        ?.match(/\[ref=([^\]]+)\]/)?.[1]
      assert.ok(ref, snapshot)
      const memory = () =>
        app
          .getAppMetrics()
          .filter((item) => item.type === 'Tab')
          .reduce((sum, item) => sum + item.memory.workingSetSize * 1024, 0)
      const baseline = memory()
      let peak = baseline
      const monitor = setInterval(() => {
        peak = Math.max(peak, memory())
      }, 10)
      const started = Date.now()
      await run('upload', { ref, paths: ['/fake-device-only/remote-source.txt'] })
      const elapsedMs = Date.now() - started
      assert.ok(staged.length && staged.every((path) => !existsSync(path)))
      assert.equal(existsSync(source), true, '设备上的源文件保留')
      const result = JSON.parse(
        await run('evaluate', {
          expression: `new Promise(resolve=>{const file=document.getElementById('file').files[0];const reader=new FileReader();reader.onload=async()=>{const bytes=new Uint8Array(reader.result);const raw=await fetch('/raw',{method:'POST',body:file});const data=new FormData();data.append('file',file);const form=await fetch('/form',{method:'POST',body:data});resolve({size:file.size,first:bytes[0],last:bytes[bytes.length-1],ticks,raw:await raw.json(),form:await form.json()})};reader.onerror=()=>resolve({error:reader.error.name});reader.readAsArrayBuffer(file)})`,
        }),
      )
      clearInterval(monitor)
      assert.equal(result.size, size)
      assert.equal(result.first, 90)
      assert.equal(result.last, 90)
      assert.equal(result.raw.hash, expectedHash)
      assert.equal(result.raw.size, size)
      assert.ok(result.form.size > size)
      assert.ok(result.ticks > 10)
      console.log(
        'REMOTE_UPLOAD_FULL_IPC_OK',
        JSON.stringify({
          bytes: size,
          elapsedMs,
          rendererBaselineBytes: baseline,
          rendererPeakBytes: peak,
          deviceReads: reads,
          pageTicks: result.ticks,
          stagedFilesCleaned: staged.length,
        }),
      )
    } finally {
      calls.offline()
      main.reset()
      host.pages().forEach((page) => {
        host.close(page.id)
      })
      await layer.close()
      server.close()
    }
  })
  .then(
    () => app.quit(),
    (error) => {
      console.error(error)
      app.exit(1)
    },
  )
