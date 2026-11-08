import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { until } from '../chrome-m0/cdp.mjs'

// 根因对照直接走扩展 debugger，不把验收侧 CDP 当成产品上传路径。
export async function uploadChecks({
  cdp,
  identity,
  executor,
  bridge,
  targetId,
  success,
  text,
  check,
  work,
  origin,
}) {
  const evidence = { raw: [], uploads: [], skipped: 0 }
  const path = join(work, 'upload-small.txt')
  writeFileSync(path, 'Litch upload 中文\n')
  const settings = await cdp.call('Target.createTarget', {
    url: `chrome://extensions/?id=${identity.id}`,
  })
  const settingsSession = (
    await cdp.call('Target.attachToTarget', { targetId: settings.targetId, flatten: true })
  ).sessionId
  const evaluate = async (expression, sessionId) => {
    const reply = await cdp.call(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    )
    assert.equal(reply.exceptionDetails, undefined, JSON.stringify(reply.exceptionDetails))
    return reply.result.value
  }
  await until(() => evaluate('!!chrome.developerPrivate', settingsSession), 'Extension settings')
  const workerTarget = async () =>
    (await cdp.call('Target.getTargets')).targetInfos.find(
      (t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${identity.id}/`),
    )
  await check('上传根因：检查现有 manifest 文件网址设置', async () => {
    await until(
      () =>
        evaluate(
          `document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-detail-view')?.data?.id===${JSON.stringify(identity.id)}`,
          settingsSession,
        ),
      'Extension details UI',
    )
    const info = await evaluate(
      `chrome.developerPrivate.getExtensionInfo(${JSON.stringify(identity.id)})`,
      settingsSession,
    )
    console.log('FILE_ACCESS_INFO', JSON.stringify(info.fileAccess))
    evidence.fileAccess = info.fileAccess
    console.log(
      'FILE_ACCESS_UI',
      JSON.stringify(
        await evaluate(
          `(()=>{const found=[];const walk=root=>{for(const el of root.querySelectorAll('*')){if(/file/i.test(el.id))found.push({tag:el.tagName,id:el.id,text:el.textContent.trim(),visible:!!el.getBoundingClientRect().width});if(el.shadowRoot)walk(el.shadowRoot)}};walk(document);return found})()`,
          settingsSession,
        ),
      ),
    )
  })
  for (const allowed of [false, true, false]) {
    await check(`上传根因：扩展 debugger 文件权限 ${allowed}`, async () => {
      const oldWorker = await workerTarget()
      const oldEpoch = bridge.instances()[0].epoch
      await evaluate(
        `chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(identity.id)},fileAccess:${allowed}})`,
        settingsSession,
      )
      const worker = await until(async () => {
        const next = await workerTarget()
        return next?.targetId !== oldWorker.targetId && next
      }, 'Reloaded extension worker')
      await until(
        () => bridge.instances().some((i) => i.epoch !== oldEpoch),
        'Reloaded extension bridge',
      )
      const workerSession = (
        await cdp.call('Target.attachToTarget', { targetId: worker.targetId, flatten: true })
      ).sessionId
      assert.equal(
        await evaluate('chrome.extension.isAllowedFileSchemeAccess()', workerSession),
        allowed,
      )
      await cdp.call('Target.detachFromTarget', { sessionId: workerSession })
      const tabId = JSON.parse(
        text(await success('navigate', { targetId, url: `${origin}/upload` })).split('\n')[0],
      ).tabId
      const page = executor.pages.get(tabId)
      const { result } = await page.cdp('Runtime.evaluate', {
        expression: 'document.querySelector("input[type=file]")',
      })
      let outcome
      try {
        await page.cdp('DOM.setFileInputFiles', { objectId: result.objectId, files: [path] })
        outcome = { ok: true }
      } catch (error) {
        outcome = { ok: false, error: error.message }
      }
      console.log('FILE_UPLOAD_RAW', allowed, JSON.stringify(outcome))
      evidence.raw.push({ allowed, ...outcome })
      assert.equal(outcome.ok, allowed)
      if (!allowed) assert.match(outcome.error, /Not allowed/)
      await success('release', { tabId })
    })
  }
  await cdp.call('Target.closeTarget', { targetId: settings.targetId })
  const large = join(work, 'upload-large.mp4')
  const handle = await open(large, 'w')
  const hash = createHash('sha256')
  const block = Buffer.alloc(1024 * 1024)
  for (let i = 0; i < block.length; i++) block[i] = (i * 31 + 17) % 251
  try {
    for (let i = 0; i < 129; i++) {
      await handle.write(block)
      hash.update(block)
    }
  } finally {
    await handle.close()
  }
  const expectedHash = hash.digest('hex')
  const empty = join(work, 'empty.txt')
  writeFileSync(empty, '')
  for (const [label, paths, mode, frame] of [
    ['小文件与空文件', [path, empty], 'input', false],
    ['129 MiB 视频', [large], 'input', false],
    ['拖放区域', [path], 'drop', false],
    ['同源 iframe', [path], 'input', true],
  ]) {
    await check(`关闭文件网址权限：${label} 经正式 upload 全量到达服务器`, async () => {
      const tabId = JSON.parse(
        text(
          await success('navigate', {
            targetId,
            url: `${origin}/${frame ? 'upload-frame' : 'upload'}`,
          }),
        ).split('\n')[0],
      ).tabId
      const snapshot = text(await success('snapshot', { tabId }))
      const label = mode === 'drop' ? 'Drop fixture' : 'Upload fixture'
      const ref = snapshot
        .split('\n')
        .filter((line) => line.includes(`"${label}"`))
        .at(frame ? -1 : 0)
        ?.match(/\[ref=([^\]\s]+)\]/)?.[1]
      assert.ok(ref, snapshot)
      const response = await success('upload', { tabId, ref, paths, mode })
      const receipt = response.contentItems
        .filter((i) => i.type === 'inputText')
        .map((i) => {
          try {
            return JSON.parse(i.text).inputReceipt
          } catch {
            return null
          }
        })
        .find(Boolean)
      assert.equal(receipt.dispatch, 'dispatched')
      assert.equal(receipt.eventsDispatched, 1)
      const page = executor.pages.get(tabId)
      const result = await until(
        async () => {
          const { result } = await page.cdp('Runtime.evaluate', {
            expression: frame
              ? '(()=>{const w=document.querySelector("iframe").contentWindow;return {files:w.uploadResults,events:w.uploadEvents}})()'
              : '({files:uploadResults,events:uploadEvents})',
            returnByValue: true,
          })
          return result.value.files.length === paths.length && result.value
        },
        'Server received every upload byte',
        60000,
      )
      for (let i = 0; i < paths.length; i++) {
        const info = await stat(paths[i])
        const file = result.files[i]
        assert.equal(file.size, info.size)
        assert.equal(file.name, basename(paths[i]))
        assert.equal(file.lastModified, Math.trunc(info.mtimeMs))
        assert.equal(
          file.hash,
          paths[i] === large
            ? expectedHash
            : createHash('sha256')
                .update(paths[i] === empty ? '' : 'Litch upload 中文\n')
                .digest('hex'),
        )
        assert.equal(file.type, paths[i] === large ? 'video/mp4' : 'text/plain')
      }
      assert.deepEqual(
        result.events.map((e) => e.type),
        mode === 'drop' ? ['dragenter', 'dragover', 'drop'] : ['input', 'change'],
      )
      assert.ok(result.events.every((e) => e.trusted === false))
      evidence.uploads.push({ label, mode, frame, ...result })
      await success('release', { tabId })
    })
  }
  return evidence
}
