import assert from 'node:assert/strict'
import { open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function uploadBoundaries({
  executor,
  targetId,
  success,
  run,
  text,
  check,
  work,
  site,
}) {
  const path = join(work, 'upload-interrupted.bin')
  await writeFile(path, Buffer.alloc(1024 * 1024, 37))
  const create = async () => {
    const tabId = JSON.parse(
      text(await success('navigate', { targetId, url: `${site.origin}/upload` })).split('\n')[0],
    ).tabId
    const snapshot = text(await success('snapshot', { tabId }))
    const ref = snapshot
      .split('\n')
      .find((line) => line.includes('"Upload fixture"'))
      ?.match(/\[ref=([^\]\s]+)\]/)?.[1]
    assert.ok(ref, snapshot)
    return { tabId, ref, page: executor.pages.get(tabId) }
  }
  for (const action of ['release', 'navigate']) {
    await check(`上传中途 ${action}：停止后续分块，不派发文件或启动本地服务`, async () => {
      const { tabId, ref, page } = await create()
      const before = site.requests.filter((p) => p === '/upload-body').length
      const original = page.cdp.bind(page)
      let chunks = 0
      page.cdp = async (method, params) => {
        const result = await original(method, params)
        if (
          method === 'Runtime.callFunctionOn' &&
          params.functionDeclaration.includes('atob(base64)') &&
          ++chunks === 1
        ) {
          if (action === 'release') await page.release()
          else await page.load(`${site.origin}/input`, 10000)
        }
        return result
      }
      const result = await run('upload', { tabId, ref, paths: [path] })
      page.cdp = original
      assert.equal(result.success, false, text(result))
      assert.match(text(result), /Chrome file upload failed/)
      assert.match(text(result), /notDispatched/)
      assert.equal(chunks, 1)
      assert.equal(site.requests.filter((p) => p === '/upload-body').length, before)
      if (page.valid) await success('release', { tabId })
    })
  }
  await check('上传总量与单文件上限：拒绝后不读文件内容、不派发输入', async () => {
    const { tabId, ref, page } = await create()
    const sparse = join(work, 'upload-limit.bin')
    const handle = await open(sparse, 'w')
    const original = page.cdp.bind(page)
    let prepared = 0
    page.cdp = async (method, params) => {
      if (method === 'Page.createIsolatedWorld') prepared++
      return original(method, params)
    }
    try {
      await handle.truncate(300 * 1024 * 1024)
      const total = await run('upload', { tabId, ref, paths: [sparse, sparse] })
      assert.equal(total.success, false)
      assert.match(text(total), /totaling at most 512 MiB/)
      await handle.truncate(513 * 1024 * 1024)
      const single = await run('upload', { tabId, ref, paths: [sparse] })
      assert.equal(single.success, false)
      assert.match(text(single), /larger than 512 MiB/)
      assert.match(text(single), /cannot upload files above that limit/)
      assert.equal(prepared, 0)
    } finally {
      await handle.close()
      page.cdp = original
      await success('release', { tabId })
    }
  })
}
