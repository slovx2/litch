import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ChromeInstaller } from '../src/installer.mjs'
import { applyRegistration, FileRegistrationStore, sameOwnerPolicy } from '../src/registration.mjs'

test('第二身份登记使用独立 host、ID、token、启动器，不改变 Litch 的 manifest 或配置', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'chrome-library-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = join(root, 'profile', 'NativeMessagingHosts')
  const assets = join(root, 'assets'),
    binary = join(root, 'host')
  await mkdir(assets)
  await writeFile(join(assets, 'manifest.json'), '{}')
  await writeFile(binary, '# fixture\n')
  const store = new FileRegistrationStore(profile, 'Fixture')
  const make = (app: string, hostName: string, id: string) =>
    new ChromeInstaller({
      root: join(root, app),
      assets,
      nativeBinary: binary,
      nativeArgs: [],
      socketPath: join(root, `${app}.sock`),
      claimLockDirectory: join(root, 'shared-claims'),
      identity: { hostName, extensionIds: [id], productName: app },
      registrations: [store],
    })
  const litch = make('litch', 'ai.litch.chrome', 'ddnllmibgnhhiiaaidfamlknbnfjpnpo')
  await litch.prepare()
  const before = await readFile(join(profile, 'ai.litch.chrome.json'))
  const config = await readFile(litch.configPath)
  const other = make('other', 'example.chrome', 'b'.repeat(32))
  await other.prepare()
  assert.deepEqual(await readFile(join(profile, 'ai.litch.chrome.json')), before)
  assert.deepEqual(await readFile(litch.configPath), config)
  const manifest = JSON.parse(await readFile(join(profile, 'example.chrome.json'), 'utf8'))
  assert.equal(manifest.name, 'example.chrome')
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${'b'.repeat(32)}/`])
  assert.notEqual(litch.token, other.token)
  const launcher = await readFile(manifest.path, 'utf8')
  assert.doesNotMatch(launcher, /chrome-host/)
  assert.match(launcher, /--config/)
  await assert.rejects(make('intruder', 'ai.litch.chrome', 'c'.repeat(32)).prepare(), /owned/)
  assert.deepEqual(await readFile(join(profile, 'ai.litch.chrome.json')), before)
  // 已有同归属的清单仍能随启动更新，Litch 自动准备语义保持。
  await litch.prepare()
})

test('归属策略拒绝覆盖、过期 revision 不生效，卸载只移除自己的当前登记', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'chrome-registration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new FileRegistrationStore(root, 'Test')
  const desired = {
    hostName: 'example.chrome',
    executable: join(root, 'host'),
    ownerId: join(root, 'host'),
    extensionIds: ['a'.repeat(32)],
  }
  const signal = new AbortController().signal
  const first = await applyRegistration(store, sameOwnerPolicy, desired, signal)
  await assert.rejects(store.apply({ expectedRevision: 'absent', desired }, signal), /changed/)
  assert.equal(await store.remove(desired.hostName, 'someone-else', first.revision), false)
  assert.equal(await store.remove(desired.hostName, desired.ownerId, 'outdated'), false)
  assert.equal(await store.remove(desired.hostName, desired.ownerId, first.revision), true)
  assert.equal((await store.inspect(desired.hostName)).registration, null)
  await assert.rejects(store.apply({ expectedRevision: 'absent', desired }, AbortSignal.abort()))
})
