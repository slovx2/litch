import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CHROME_STORE_URL,
  chromeExtensionIds,
} from '../../../../../packages/protocol/src/chrome-browser.mjs'
import { BrowserTargets } from '../../chrome-browser/browser-targets.mjs'
import { ChromeInstaller } from '../../chrome-browser/installer.mjs'

// 假安装器只替代操作系统登记；设置路由、桥初始化和允许 ID 仍用正式实现，不写真实 HOME/注册表。
for (const failure of [null, 'prepare', 'open'] as const) {
  test(`商店安装先准备再打开，保留权限开关（失败阶段：${failure ?? '无'}）`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'litch-chrome-install-'))
    const events: string[] = []
    let prepared = false
    t.mock.method(ChromeInstaller.prototype, 'prepared', async () => prepared)
    t.mock.method(ChromeInstaller.prototype, 'prepare', async () => {
      events.push('prepare')
      if (failure === 'prepare') throw new Error('prepare failed')
      prepared = true
    })
    await writeFile(
      join(root, 'identity.json'),
      JSON.stringify({ id: chromeExtensionIds()[0], version: '0.33.0' }),
    )
    const targets = new BrowserTargets({
      root: join(root, 'state'),
      assets: root,
      nativeBinary: join(root, 'unused-native-host'),
      openInChrome: async (url) => {
        assert.equal(prepared, true)
        assert.equal(url, CHROME_STORE_URL)
        events.push('open')
        if (failure === 'open') throw new Error('open failed')
      },
      openDirectory: async () => assert.fail('商店入口不打开本地目录'),
    })
    try {
      if (failure)
        await assert.rejects(
          targets.settings({ kind: 'chrome.store' }),
          new RegExp(`${failure} failed`),
        )
      else await targets.settings({ kind: 'chrome.store' })
      assert.deepEqual(events, failure === 'prepare' ? ['prepare'] : ['prepare', 'open'])
      const state = await targets.settings({ kind: 'chrome.status' })
      assert.equal(state.prepared, failure !== 'prepare')
      assert.equal(state.enabled, false)
      assert.deepEqual(state.allowedDevices, [])
      assert.deepEqual(state.allowedExtensionIds, chromeExtensionIds())
      assert.deepEqual(state.instances, [])
    } finally {
      await targets.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}
