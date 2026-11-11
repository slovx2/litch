import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { createBrowserExecutor } from '../src/browser/executor.mjs'
import type { BrowserHost } from '../src/browser/model.mjs'

export async function remoteUploadChecks(
  executor: ReturnType<typeof createBrowserExecutor>,
  first: BrowserHost,
  profile: string,
  url: string,
  fixtureFile: string,
  rendererBytes: () => number,
): Promise<void> {
  let callId = 0
  const text = (reply: { contentItems: { type: string; text?: string }[] }) =>
    reply.contentItems.map((item) => item.text ?? '').join('\n')
  // 直接路径在 finally 清理后无法延迟读取；远程上传必须生成独立的浏览器 File。
  const pathBacked = join(profile, 'path-backed.txt')
  writeFileSync(pathBacked, 'path backed')
  const localPage = first.page(executor.currentTab('local', 'upload-session') ?? '')!
  const node = await localPage.cdp<{ result: { objectId: string } }>('Runtime.evaluate', {
    expression: 'document.getElementById("hidden-file")',
  })
  await localPage.cdp('DOM.setFileInputFiles', {
    objectId: node.result.objectId,
    files: [pathBacked],
  })
  await rm(pathBacked)
  const readLater = `new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve({text:r.result});r.onerror=()=>resolve({error:r.error.name});r.readAsText(document.getElementById('hidden-file').files[0])})`
  const deletedRead = await localPage.cdp<{ result: { value: { error: string } } }>(
    'Runtime.evaluate',
    { expression: readLater, awaitPromise: true, returnByValue: true },
  )
  assert.equal(deletedRead.result.value.error, 'NotFoundError')
  let remoteDirectory = ''
  const remoteCall = (tool: string, args: Record<string, unknown> = {}) =>
    executor.call(
      {
        id: `remote-${++callId}`,
        callId: String(callId),
        namespace: 'litch_browser',
        tool,
        threadId: 'remote-session',
        turnId: 'remote-turn',
        arguments: args,
        device: { id: 'remote', name: 'fake remote', kind: 'ssh', target: 'unused.invalid' },
        harness: null,
        cwd: null,
      },
      {
        signal: new AbortController().signal,
        ask: async () => 'once',
        async prepareUpload(paths, limits) {
          assert.deepEqual(paths, ['/remote-only/chooser-fixture.txt'])
          assert.equal(limits.fileBytes, 100 * 1024 * 1024)
          remoteDirectory = join(profile, `stage-${callId}`)
          await mkdir(remoteDirectory, { mode: 0o700 })
          const staged = join(remoteDirectory, 'chooser-fixture.txt')
          await copyFile(fixtureFile, staged)
          return {
            paths: [staged],
            dispose: () => rm(remoteDirectory, { recursive: true, force: true }),
          }
        },
      },
    )
  assert.equal((await remoteCall('navigate', { url })).success, true)
  for (const label of ['Select file', 'Dynamic file', 'hidden-file']) {
    const snap = text(await remoteCall('snapshot'))
    const ref = snap
      .split('\n')
      .find((line) => line.includes(`"${label}"`))
      ?.match(/\[ref=([^\]]+)\]/)?.[1]
    assert.ok(ref, snap)
    const result = await remoteCall('upload', { ref, paths: ['/remote-only/chooser-fixture.txt'] })
    assert.equal(result.success, true, text(result))
    assert.equal(existsSync(remoteDirectory), false, '调用返回时暂存已经清理')
    const input = label === 'Dynamic file' ? 'dynamic-file' : 'hidden-file'
    const verify = await remoteCall('evaluate', {
      expression: `new Promise(resolve=>{const file=document.getElementById(${JSON.stringify(input)}).files[0];const reader=new FileReader();reader.onload=async()=>{const data=new FormData();data.append('file',file);const response=await fetch('/receive',{method:'POST',body:data});resolve({text:reader.result,submitted:await response.text()})};reader.onerror=()=>resolve({error:reader.error.name});reader.readAsText(file)})`,
    })
    assert.match(text(verify), /chooser fixture 中文/)
    assert.match(text(verify), /received/)
  }
  // 取消和设备断线都走同一 AbortSignal；在页面已组装一块后中止，核对对象立即清空且没有半个 File。
  const remotePage = first.page(executor.currentTab('remote', 'remote-session') ?? '')!
  const originalCdp = remotePage.cdp.bind(remotePage)
  for (const reason of ['cancel', 'disconnect']) {
    let state: string | undefined
    let discarded = false
    const abort = new AbortController()
    const source = join(profile, 'partial.txt')
    writeFileSync(source, Buffer.alloc(512 * 1024, 77))
    remotePage.cdp = async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
      const result = await originalCdp<T>(method, params)
      if (
        method === 'Runtime.callFunctionOn' &&
        String(params?.functionDeclaration).includes('this.parts.push(new Blob')
      ) {
        state = String(params?.objectId)
        abort.abort(reason)
      }
      if (
        method === 'Runtime.callFunctionOn' &&
        params?.functionDeclaration === 'function(){this.clear()}'
      ) {
        const cleaned = await originalCdp<{ result: { value: boolean } }>(
          'Runtime.callFunctionOn',
          {
            objectId: params.objectId,
            functionDeclaration:
              'function(){return this.expired && this.parts.length===0 && this.files.length===0 && this.target===null}',
            returnByValue: true,
          },
        )
        discarded = cleaned.result.value
      }
      return result
    }
    const ref = text(await remoteCall('snapshot'))
      .split('\n')
      .find((line) => line.includes('file input "hidden-file"'))
      ?.match(/\[ref=([^\]]+)\]/)?.[1]
    assert.ok(ref)
    const result = await executor.call(
      {
        id: `partial-${++callId}`,
        callId: String(callId),
        namespace: 'litch_browser',
        tool: 'upload',
        threadId: 'remote-session',
        turnId: 'remote-turn',
        arguments: { ref, paths: ['/remote-only/partial.txt'] },
        device: { id: 'remote', name: 'fake remote', kind: 'ssh', target: 'unused.invalid' },
        harness: null,
        cwd: null,
      },
      {
        signal: abort.signal,
        ask: async () => 'once',
        prepareUpload: async () => ({
          paths: [source],
          dispose: () => rm(source, { force: true }),
        }),
      },
    )
    remotePage.cdp = originalCdp
    assert.equal(result.success, false)
    assert.ok(state, '必须在页面已收到第一块后取消')
    assert.equal(discarded, true, '取消后立即丢弃页面分块与 File 对象')
    assert.equal(existsSync(source), false)
    // 已 release 的 state 不能再读取；用 cleanup 执行时检查清空结果的证据。
    const files = await originalCdp<{ result: { value: string[] } }>('Runtime.evaluate', {
      expression: 'Array.from(document.getElementById("hidden-file").files,f=>f.name)',
      returnByValue: true,
    })
    assert.deepEqual(
      files.result.value,
      ['chooser-fixture.txt'],
      '保持上次完整文件，不提交半个新文件',
    )
  }
  // 接近原有单文件限额，监测渲染进程工作集与响应性；页面延迟读取和提交在磁盘清理后发生。
  const largeBytes = 99 * 1024 * 1024
  const large = join(profile, 'near-limit.txt')
  writeFileSync(large, Buffer.alloc(largeBytes, 90))
  const snap = text(await remoteCall('snapshot'))
  const ref = snap
    .split('\n')
    .find((line) => line.includes('file input "hidden-file"'))
    ?.match(/\[ref=([^\]]+)\]/)?.[1]
  assert.ok(ref)
  let peak = rendererBytes()
  const baseline = peak
  let heartbeats = 0
  remotePage.cdp = async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
    const result = await originalCdp<T>(method, params)
    if (
      method === 'Runtime.callFunctionOn' &&
      String(params?.functionDeclaration).includes('this.parts.push(new Blob')
    ) {
      peak = Math.max(peak, rendererBytes())
      if (++heartbeats % 64 === 0) {
        const ping = await originalCdp<{ result: { value: number } }>('Runtime.evaluate', {
          expression: '1+1',
          returnByValue: true,
        })
        assert.equal(ping.result.value, 2)
      }
    }
    return result
  }
  const started = Date.now()
  const uploaded = await executor.call(
    {
      id: `large-${++callId}`,
      callId: String(callId),
      namespace: 'litch_browser',
      tool: 'upload',
      threadId: 'remote-session',
      turnId: 'remote-turn',
      arguments: { ref, paths: ['/remote-only/near-limit.txt'] },
      device: { id: 'remote', name: 'fake remote', kind: 'ssh', target: 'unused.invalid' },
      harness: null,
      cwd: null,
    },
    {
      signal: new AbortController().signal,
      ask: async () => 'once',
      prepareUpload: async () => ({ paths: [large], dispose: () => rm(large, { force: true }) }),
    },
  )
  remotePage.cdp = originalCdp
  assert.equal(uploaded.success, true, text(uploaded))
  assert.equal(existsSync(large), false)
  const elapsedMs = Date.now() - started
  const later = await remoteCall('evaluate', {
    expression: `new Promise(resolve=>{const file=document.getElementById('hidden-file').files[0];const reader=new FileReader();reader.onload=async()=>{const b=new Uint8Array(reader.result);const data=new FormData();data.append('file',file);const response=await fetch('/receive',{method:'POST',body:data});resolve({size:file.size,first:b[0],last:b[b.length-1],submitted:await response.text()})};reader.onerror=()=>resolve({error:reader.error.name});reader.readAsArrayBuffer(file)})`,
  })
  assert.equal(later.success, true, text(later))
  assert.match(text(later), new RegExp(`"size":${largeBytes}`))
  assert.match(text(later), /"first":90,"last":90/)
  assert.match(text(later), /received/)
  peak = Math.max(peak, rendererBytes())
  console.log(
    'BROWSER_REMOTE_UPLOAD_METRICS',
    JSON.stringify({
      bytes: largeBytes,
      elapsedMs,
      rendererBaselineBytes: baseline,
      rendererPeakBytes: peak,
      heartbeats,
    }),
  )
  console.log(
    'BROWSER_REMOTE_UPLOAD_OK deleted-path-fails/hidden/dynamic/trigger/FileReader/delayed-form/cancel/disconnect/99MiB',
  )
}
