import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// 假远程走正式 core → 客户端工具 IPC → 主进程暂存 → Chrome 扩展；不创建 SSH 连接。
export async function remoteUploadChecks({
  driver,
  executor,
  bridge,
  targetId,
  check,
  work,
  origin,
  text,
}) {
  const remoteRoot = join(work, 'fake-remote-device')
  await mkdir(remoteRoot)
  const remotePath = join(remoteRoot, 'remote-source.txt')
  const bytes = 'Remote upload 中文\n'
  await writeFile(remotePath, bytes)
  const source = '/fake-remote-only/remote-source.txt'
  assert.equal(existsSync(source), false)
  const layer = new driver.DeviceLayer()
  const device = new driver.DeviceCalls(layer, {
    id: 'remote-upload-peer',
    declares: (value) => value === 'litchBrowserUpload',
    send() {},
    close() {},
    backlog: () => 0,
  })
  let inbox
  let main
  let sequence = 0
  const staged = []
  let latestWork
  const hub = driver.createToolHub(
    {
      namespaces: () => ['litch_browser'],
      post: (message) => queueMicrotask(() => main.handle(message)),
      listen: (handler) => {
        inbox = handler
      },
    },
    () => {},
  )
  main = driver.createClientToolHost(
    [
      {
        namespace: 'litch_browser',
        call(invocation, context) {
          const prepare = context.prepareUpload
          latestWork = executor.call(invocation, {
            ...context,
            prepareUpload:
              prepare &&
              (async (...args) => {
                const result = await prepare(...args)
                staged.push(...result.paths)
                return result
              }),
          })
          return latestWork
        },
      },
    ],
    (message) => inbox(message),
  )
  const calls = driver.createToolCalls({
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
    context: () => ({ harness: null, cwd: '/fake-remote-only' }),
    showAsk(_place, answer) {
      queueMicrotask(() => answer('once'))
      return () => {}
    },
    log() {},
    uploadRead(params) {
      assert.equal(params.path, source)
      return device.call('litch/browserUpload/read', { ...params, path: remotePath })
    },
  })
  const run = async (tool, args) => {
    const response = await calls.serverRequest(
      'item/tool/call',
      {
        threadId: 'remote-upload-thread',
        turnId: 'remote-upload-turn',
        callId: `remote-${++sequence}`,
        namespace: 'litch_browser',
        tool,
        arguments: args,
      },
      `rpc-${sequence}`,
    )
    assert.equal(response.success, true, text(response))
    return response
  }
  const results = []
  try {
    const created = await run('navigate', { targetId, url: `${origin}/remote-upload` })
    const tabId = JSON.parse(text(created).split('\n')[0]).tabId
    for (const label of ['Remote trigger', 'Remote dynamic', 'remote-file']) {
      await check(`假远程 Chrome ${label} 清理后 FileReader 和延迟表单提交`, async () => {
        const snapshot = text(await run('snapshot', { tabId }))
        const ref = snapshot
          .split('\n')
          .find((line) => line.includes(`"${label}"`))
          ?.match(/\[ref=([^\]]+)\]/)?.[1]
        assert.ok(ref, snapshot)
        const uploaded = await run('upload', { tabId, ref, paths: [source] })
        assert.ok(staged.length)
        assert.ok(
          staged.every((path) => !existsSync(path)),
          '返回后所有主进程暂存文件已经删除',
        )
        const input = label === 'Remote dynamic' ? 'dynamic-file' : 'remote-file'
        const reply = await run('evaluate', {
          tabId,
          expression: `new Promise(resolve=>{const file=document.getElementById(${JSON.stringify(input)}).files[0];const reader=new FileReader();reader.onload=async()=>{const raw=await fetch('/upload-body',{method:'POST',headers:{'x-name':encodeURIComponent(file.name),'Content-Type':file.type},body:file});const data=new FormData();data.append('file',file);const form=await fetch('/upload-body',{method:'POST',headers:{'x-name':encodeURIComponent(file.name)},body:data});resolve({text:reader.result,raw:await raw.json(),form:await form.json()})};reader.onerror=()=>resolve({error:reader.error.name});reader.readAsText(file)})`,
        })
        const evidence = JSON.parse(text(reply).split('\n')[0])
        assert.equal(evidence.text, bytes)
        assert.equal(evidence.raw.hash, createHash('sha256').update(bytes).digest('hex'))
        assert.equal(evidence.raw.size, Buffer.byteLength(bytes))
        assert.ok(evidence.form.size > evidence.raw.size)
        results.push({ label, uploaded: text(uploaded), received: evidence })
      })
    }
    for (const reason of ['cancel', 'disconnect']) {
      await check(`假远程 Chrome 分块中 ${reason} 丢弃页面分块且不改变完整 input`, async () => {
        await writeFile(remotePath, bytes)
        const created = await run('navigate', {
          targetId,
          url: `${origin}/remote-upload`,
          newTab: true,
        })
        const partialTab = JSON.parse(text(created).split('\n')[0]).tabId
        const snapshot = text(await run('snapshot', { tabId: partialTab }))
        const ref = snapshot
          .split('\n')
          .find((line) => line.includes('file input "remote-file"'))
          ?.match(/\[ref=([^\]]+)\]/)?.[1]
        assert.ok(ref, snapshot)
        await run('upload', { tabId: partialTab, ref, paths: [source] })
        await writeFile(remotePath, Buffer.alloc(512 * 1024, 77))
        const page = executor.pages.get(partialTab)
        const original = page.cdp.bind(page)
        const originalDiscard = page.discardUpload.bind(page)
        let chunks = 0
        let discarded = false
        let retainedSize
        page.cdp = async (method, params) => {
          const result = await original(method, params)
          if (
            method === 'Runtime.callFunctionOn' &&
            String(params?.functionDeclaration).includes('this.parts.push(new Blob') &&
            ++chunks === 1
          ) {
            if (reason === 'cancel') calls.interrupted('remote-upload-thread')
            else calls.offline()
          }
          return result
        }
        page.discardUpload = async (state, objects) => {
          await originalDiscard(state, [])
          if (state) {
            const result = await bridge.call(page.instanceId, {
              op: 'command',
              leaseId: page.grant.leaseId,
              generation: page.state.generation,
              args: {
                method: 'Runtime.callFunctionOn',
                params: {
                  objectId: state,
                  functionDeclaration:
                    'function(){return {cleared:this.expired && this.parts.length===0 && this.files.length===0 && this.target===null,size:document.getElementById("remote-file").files[0].size}}',
                  returnByValue: true,
                },
              },
            })
            discarded = result.result.value.cleared
            retainedSize = result.result.value.size
          }
          await originalDiscard(undefined, objects)
        }
        try {
          const response = await calls.serverRequest(
            'item/tool/call',
            {
              threadId: 'remote-upload-thread',
              turnId: 'remote-upload-turn',
              callId: `partial-${++sequence}`,
              namespace: 'litch_browser',
              tool: 'upload',
              arguments: { tabId: partialTab, ref, paths: [source] },
            },
            `rpc-${sequence}`,
          )
          await latestWork
          assert.ok(typeof response === 'symbol' || !response.success)
          assert.equal(chunks, 1)
          assert.equal(discarded, true)
          assert.ok(staged.every((path) => !existsSync(path)))
        } finally {
          page.cdp = original
          page.discardUpload = originalDiscard
        }
        assert.equal(retainedSize, Buffer.byteLength(bytes))
      })
    }
    return { results, stagedFilesCleaned: staged.length, remoteFiles: await readdir(remoteRoot) }
  } finally {
    calls.offline()
    main.reset()
    await layer.close()
  }
}
