import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/core/src/draft-images.mjs'))
      return {
        url: new URL(specifier.replace(/\.mjs$/, '.mts'), context.parentURL).href,
        shortCircuit: true,
      }
    return next(specifier, context)
  },
})
const { draftImageFile } = await import('../../../apps/desktop/src/draft-images.mts')

test('桌面草稿通过外壳存储跨界面重开还原，发送清理磁盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-draft-images-'))
  const path = join(dir, 'draft-images.json')
  globalThis.window = {
    litchShell: {
      draftImages: draftImageFile(dir),
    },
  }
  try {
    const first = await import('../src/composer/drafts.ts?images=first')
    const image = { url: 'data:image/png;base64,AAAA', name: '截图.png' }
    assert.equal(first.saveDraftImages('a', [image]), null)
    const second = await import('../src/composer/drafts.ts?images=second')
    assert.deepEqual(second.loadDraftImages('a'), [image])
    second.dropDraft('a')
    assert.equal(existsSync(path), false)
    const third = await import('../src/composer/drafts.ts?images=third')
    assert.deepEqual(third.loadDraftImages('a'), [])
  } finally {
    delete globalThis.window
    rmSync(dir, { recursive: true, force: true })
  }
})
