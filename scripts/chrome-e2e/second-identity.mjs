// 第二身份只装进本次隔离 profile；不使用系统 NativeMessagingHosts。
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assembleExtension, extensionId } from '../../packages/chrome-extension/build.mjs'

export async function secondIdentity({
  root,
  work,
  output,
  profile,
  assets,
  nativeBinary,
  library,
}) {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const id = extensionId(key)
  const hostName = 'example.automation_fixture'
  const manifest = JSON.parse(await readFile(join(assets, 'manifest.json'), 'utf8'))
  Object.assign(manifest, {
    key,
    name: 'Second automation fixture',
    description: 'Isolated second host fixture',
    action: { ...manifest.action, default_title: 'Second fixture — Stop browser control' },
  })
  const background = join(output, 'second-worker.mts')
  await writeFile(
    background,
    `import { createExtensionRuntime } from ${JSON.stringify(join(root, 'packages/chrome-extension/src/index.mts'))};
const runtime = createExtensionRuntime({ chrome, identity: ${JSON.stringify({ hostName, extensionIds: [id], productName: 'Second fixture' })}, protocol: {min:1,max:1}, storagePrefix:'secondFixture', pointerSource:__FIXTURE_POINTER__ });
void runtime.start();\n`,
  )
  const secondAssets = join(work, 'second-assets')
  await assembleExtension({
    output: secondAssets,
    background,
    pointer: join(root, 'apps/chrome-extension/src/pointer-world.mts'),
    pointerDefine: '__FIXTURE_POINTER__',
    identity: { key, id },
    manifest,
    icons: [16, 32, 48, 128].map((size) => join(assets, `icon-${size}.png`)),
  })
  const firstManifest = join(profile, 'NativeMessagingHosts', 'ai.litch.chrome.json')
  const before = await readFile(firstManifest)
  const installer = new library.ChromeInstaller({
    root: join(work, 'second-install'),
    assets: secondAssets,
    nativeBinary,
    nativeArgs: [],
    socketPath: join(work, 'second.sock'),
    claimLockDirectory: join(work, 'shared-claims'),
    identity: { hostName, extensionIds: [id], productName: 'Second fixture' },
    registrations: [
      new library.FileRegistrationStore(join(profile, 'NativeMessagingHosts'), 'Second fixture'),
    ],
  })
  await installer.prepare()
  assert.deepEqual(await readFile(firstManifest), before)
  const bridge = new library.ChromeBridge({
    socketPath: join(work, 'second.sock'),
    token: installer.token,
    extensionIds: [id],
    version: manifest.version,
    productName: 'Second fixture',
    protocol: { min: 1, max: 1 },
  })
  await bridge.start()
  const executor = new library.ChromeExecutor({
    bridge,
    allowed: () => true,
    namespace: 'fixture_browser',
    productName: 'Second fixture',
  })
  return {
    id,
    hostName,
    installer,
    bridge,
    executor,
    async check({ first, tabId, invocation, context, until }) {
      await until(() => bridge.instances().length === 1, 'Second identity handshake')
      assert.equal(bridge.instances()[0].extensionId, id)
      assert.equal(bridge.instances()[0].protocol, 1)
      assert.deepEqual(await readFile(firstManifest), before)
      let seq = 0
      const invoke = (tool, args) =>
        executor.call(
          {
            ...invocation,
            namespace: 'fixture_browser',
            callId: `second-${++seq}`,
            threadId: 'second-identity',
            tool,
            arguments: args,
          },
          { ...context, ask: async () => 'once' },
        )
      const text = (result) =>
        result.contentItems
          .filter((item) => item.type === 'inputText')
          .map((item) => item.text)
          .join('\n')
      const targetId = `chrome:${bridge.instances()[0].id}`
      const url = first.pages.get(tabId).state.url
      const listed = await invoke('tabs', { action: 'list', targetId })
      assert.equal(listed.success, true, text(listed))
      const tab = JSON.parse(text(listed)).tabs.find((tab) => tab.url === url)
      assert.ok(tab?.claimToken)
      const conflict = await invoke('claim', { claimToken: tab.claimToken })
      assert.equal(conflict.success, false, '不能抢占另一扩展的 debugger')
      assert.match(text(conflict), /cannot attach|debugger|targetUnavailable|busy/)
      const observed = await first.call(
        {
          ...invocation,
          callId: 'first-after-second-conflict',
          tool: 'snapshot',
          arguments: { tabId },
        },
        context,
      )
      assert.equal(observed.success, true, text(observed))
      const opened = await invoke('navigate', { targetId, url })
      assert.equal(opened.success, true, text(opened))
      const own = JSON.parse(text(opened).split('\n')[0]).tabId
      assert.equal((await invoke('snapshot', { tabId: own })).success, true)
      assert.equal((await invoke('tabs', { action: 'close', tabId: own })).success, true)
      assert.deepEqual(await readFile(firstManifest), before)
    },
    async dispose() {
      executor.dispose()
      await bridge.close()
    },
  }
}
