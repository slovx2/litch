// 存在应用文档目录里的几样（经 src/shell/json-file.ts；文件系统是 test/stubs 下的内存替身）：
// 草稿、新建会话页记住的选择、设备配置与快照、信任过的主机钥匙、测试链接写的远程开发参数。
// “杀掉应用重开”用换一个查询串重新引用模块来演：模块里的缓存没了，只剩文件里的。
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { files } from 'expo-file-system'

let generation = 0
/** 像重开了应用一样重新载入一个模块 */
const fresh = (path) => import(`${path}?run=${++generation}`)

beforeEach(() => files.clear())

test('草稿：攒一下才写文件，离开时当场写；重开应用还在；清空的不留', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const drafts = await fresh('../src/detail/composer/drafts.ts')
  const key = drafts.draftKey('dev', 's1')
  drafts.saveDraft(key, '写了一半')
  assert.equal(drafts.loadDraft(key), '写了一半')
  assert.equal(files.size, 0, '还没写文件')
  t.mock.timers.tick(600)
  assert.equal(files.size, 1)
  drafts.saveDraft(drafts.draftKey('dev', 's2'), '另一个')
  drafts.flushDrafts()
  drafts.saveDraftImages(key, [{ url: 'data:image/png;base64,AA', name: null }])

  const reopened = await fresh('../src/detail/composer/drafts.ts')
  assert.equal(reopened.loadDraft(key), '写了一半')
  assert.equal(reopened.loadDraft(reopened.draftKey('dev', 's2')), '另一个')
  assert.deepEqual(reopened.loadDraftImages(key), [], '图片只在内存里')
  reopened.dropDraft(key)
  reopened.flushDrafts()
  assert.equal((await fresh('../src/detail/composer/drafts.ts')).loadDraft(key), '')
})

test('草稿：文件坏了当作没有', async () => {
  files.set('doc:/drafts.json', '{坏的')
  const drafts = await fresh('../src/detail/composer/drafts.ts')
  assert.equal(drafts.loadDraft(drafts.draftKey('dev', 's1')), '')
})

test('新建会话页：记住工作区和 harness，过期的选择不回来', async () => {
  const memory = await fresh('../src/screens/new-session/remembered.ts')
  const ready = [{ id: 'pi' }, { id: 'claude' }]
  assert.equal(memory.pickHarness(ready, 'dev', 'w1', undefined).id, 'pi', '没记过：可用的第一个')
  memory.remember('dev', 'w1', 'claude', { model: 'm2', effort: 'high', permission: 'ask' })

  const again = await fresh('../src/screens/new-session/remembered.ts')
  assert.equal(again.lastPlace('dev'), 'w1')
  assert.equal(again.pickHarness(ready, 'dev', 'w1', undefined).id, 'claude')
  assert.equal(
    again.pickHarness(ready, 'dev', 'w9', undefined).id,
    'claude',
    '别的工作区按设备上最近的',
  )
  assert.equal(again.pickHarness(ready, 'dev', 'w1', 'pi').id, 'pi', '这次点选的优先')
  assert.equal(again.pickHarness([{ id: 'pi' }], 'dev', 'w1', undefined).id, 'pi', '记的那个没了')

  const options = {
    models: [{ id: 'm2', efforts: [{ id: 'low' }] }],
    permissions: [{ id: 'auto' }],
  }
  assert.deepEqual(
    again.recallPicks('dev', 'claude', options),
    { model: 'm2' },
    '强度和权限换了就不要',
  )
  assert.deepEqual(again.recallPicks('dev', 'pi', options), {})
})

test('设备配置：存了再读回来一样；读不懂的条目跳过；忘掉一台设备删它的快照和终端记录', async () => {
  const { fileDeviceStore, savedRemotes } = await fresh('../src/platform/device-store.ts')
  const store = fileDeviceStore()
  assert.deepEqual(store.load().remotes, [], '没有文件：空的')
  const remote = {
    id: 'r1',
    name: '家里',
    wire: 'blue',
    target: {
      kind: 'host',
      host: 'h.local',
      port: 2222,
      user: 'me',
      keyFile: 'k-0123456789abcdef',
    },
  }
  store.save({ remotes: [remote, { id: 'bad id!', target: {} }], tools: {} })
  assert.deepEqual(savedRemotes(), [remote])

  store.snapshot('r1').save({ any: 1 })
  store.terminals('r1').save({ any: 2 })
  store.snapshot('../x').save({})
  assert.ok(files.has('doc:/snapshot-___x.json'), '设备标识里不放心的字符换掉了')
  store.forget('r1')
  assert.ok(!files.has('doc:/snapshot-r1.json'))
  assert.ok(!files.has('doc:/terminals-r1.json'))
})

test('主机钥匙：按“主机:端口”记，主机名不分大小写、端口默认 22；忘掉的不再认', async () => {
  const hosts = await fresh('../src/platform/known-hosts.ts')
  assert.equal(hosts.knownHost('h', 22), null)
  hosts.trustHost('Box.Local', null, { fingerprint: 'SHA256:abc', keyType: 'ssh-ed25519' })
  assert.equal(hosts.knownHost('box.local', 22)?.fingerprint, 'SHA256:abc')
  assert.equal(hosts.knownHost('box.local', 2222), null)
  hosts.forgetHost('box.local', 22)
  assert.equal(hosts.knownHost('box.local', null), null)
})

test('测试链接写的远程开发参数：命令名要合规，环境变量名只收大写的', async () => {
  const dev = await fresh('../src/platform/dev.ts')
  dev.setRemoteDev(
    new URLSearchParams('adapter=fx-adapter&env=LITCH_FX_MODE=svc&env=bad-name=1&env=NOEQ'),
  )
  assert.deepEqual(dev.remoteDev(), { adapter: 'fx-adapter', env: { LITCH_FX_MODE: 'svc' } })
  assert.throws(() => dev.setRemoteDev(new URLSearchParams('codex=rm -rf')), /不是一个合规的命令名/)
  dev.setRemoteDev(new URLSearchParams('reset=1'))
  assert.deepEqual(dev.remoteDev(), {})
})

test('会话列表收起了的组和父会话：按设备记在文件里，重开应用还在；会话没了就清掉', async () => {
  const folds = await fresh('../src/screens/sessions/folds.ts')
  folds.toggleFolded('dev', 'folded', 'p1')
  folds.toggleFolded('dev', 'closed', 'ws1')
  const saved = () => JSON.parse(files.get('doc:/session-folds.json'))
  assert.deepEqual(saved(), { dev: { closed: ['ws1'], folded: ['p1'] } })

  // 重开：照文件里的接着记；再点一次是展开
  const reopened = await fresh('../src/screens/sessions/folds.ts')
  reopened.toggleFolded('dev', 'folded', 'p2')
  reopened.toggleFolded('dev', 'closed', 'ws1')
  assert.deepEqual(saved(), { dev: { closed: [], folded: ['p1', 'p2'] } })
  // p1 删掉或归档了：清掉；全清空了这台设备不留
  reopened.pruneFolded('dev', { closed: new Set(), folded: new Set(['p2']) })
  assert.deepEqual(saved(), { dev: { closed: [], folded: ['p2'] } })
  reopened.pruneFolded('dev', { closed: new Set(), folded: new Set() })
  assert.deepEqual(saved(), {})
})
