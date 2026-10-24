import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { WebRemote } from '../src/remote.mjs'
import { dshHome } from '../src/runtime.mjs'
import { DshServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'

// 没说过话的会话不进线程列表（上游也不列没有预览的会话）。dsh 的清单项自带“空白”一项，适配器原先只看它；
// 但没打开的会话这一项出自 dsh 的投影缓存，缓存里没有这个会话时 dsh 一律报成不空白：
// 会话建好之后一百毫秒之内 dsh 就收场时它来不及记（实测 6 次里 5 次），适配器重启后这个空会话就进了列表。
// 用例直接把缓存拿掉来摆出这个局面，时序上才是确定的；缓存的位置是 dsh 0.2.0-rc.2 的，换了地方前提那一步会先红。

const text = (value: string) => [{ type: 'text', text: value }]

test('dsh：没说过话的会话不进线程列表，适配器重启后 dsh 的投影缓存里没有它时也不进；说过话的照列', {
  timeout: 180000,
}, async () => {
  const env = await isolate((body) => [
    { type: 'text', chunks: [body.tools?.length ? '好的。' : 'mock 标题'] },
  ])
  const home = join(env.root, 'home')
  let server = new DshServer(home)
  try {
    const desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const speak = async (peer: ReturnType<typeof client>, threadId: string) => {
      const { turn } = await peer.call('turn/start', { threadId, input: text('说一句话。') })
      await peer.until(
        'turn/completed',
        (params) => params.threadId === threadId && params.turn.id === turn.id,
      )
    }
    const ids = async (peer: ReturnType<typeof client>): Promise<string[]> =>
      (await peer.call('thread/list', { limit: 50 })).data.map((thread: any) => thread.id).sort()
    const start = async (): Promise<string> =>
      (await desktop.call('thread/start', { cwd: env.cwd, permissions: ':workspace' })).thread.id
    const spoken = await start()
    await speak(desktop, spoken)
    const silent = await start()
    assert.deepEqual(await ids(desktop), [spoken])

    await server.close()
    await rm(join(dshHome(), 'storages/session_projcache'), { recursive: true, force: true })
    server = new DshServer(home)
    const again = client(server)
    await again.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    // 前提：缓存里没有的会话，dsh 的清单不带投影，说没说过话都报成不空白
    assert.deepEqual(
      (await server.sessions())
        .map((item) => [item.sessionId, item.blank, item.projections === undefined])
        .sort(),
      [
        [silent, false, true],
        [spoken, false, true],
      ].sort(),
    )
    assert.deepEqual(await ids(again), [spoken])
    // 再列一遍还是一样（说过话的那个不用再问 dsh）
    assert.deepEqual(await ids(again), [spoken])

    // 没列出来的会话还在：打开它说一句话，就进列表了
    await again.call('thread/resume', { threadId: silent })
    await speak(again, silent)
    assert.deepEqual(await ids(again), [silent, spoken].sort())
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await server.close()
    await env.restore()
  }
})

// 反过来的一种：缓存里有这个会话，但还是它刚建好时记的那一份（“空白”），之后的没写下去。dsh 只在会话建好、
// 回合结束、会话关掉和隔一阵时写缓存，都不等写完；回合刚结束 dsh 就收场时这几次可能一次都没落盘（机器忙时实测过，
// ECHO-DSH-003 偶发失败就是这个），重启后它的清单把说过话的会话报成空白，适配器原先照单全收，会话就从列表里没了。
// 用例把建好时的那一份缓存原样放回去来摆出这个局面，时序上是确定的。
const cacheFile = (id: string) =>
  join(dshHome(), 'storages/session_projcache/sessions', `${id}.json`)

test('dsh：投影缓存还停在会话刚建好时（说成没说过话），适配器重启后说过话的会话照列；真没说过话的不进，也不每次都问 dsh', {
  timeout: 180000,
}, async () => {
  const env = await isolate((body) => [
    { type: 'text', chunks: [body.tools?.length ? '好的。' : 'mock 标题'] },
  ])
  const home = join(env.root, 'home')
  let server = new DshServer(home)
  try {
    const desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const start = async (): Promise<string> =>
      (await desktop.call('thread/start', { cwd: env.cwd, permissions: ':workspace' })).thread.id
    const spoken = await start()
    const silent = await start()
    // 会话建好时 dsh 记的那一份缓存（空白）
    let created = ''
    for (let waited = 0; !created && waited < 20000; waited += 20) {
      created = await readFile(cacheFile(spoken), 'utf8').catch(() => '')
      if (!created) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(JSON.parse(created).record.rows.sessionListMetadata.val.blank, true, '前提')
    const { turn } = await desktop.call('turn/start', {
      threadId: spoken,
      input: text('说一句话。'),
    })
    await desktop.until('turn/completed', (params) => params.turn.id === turn.id)
    await desktop.until('thread/name/updated', (params) => params.threadId === spoken)

    await server.close()
    await writeFile(cacheFile(spoken), created)
    server = new DshServer(home)
    const again = client(server)
    await again.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    // 数一数入口另问了 dsh 几次投影
    const remote: WebRemote = await server.remote()
    const asked: string[] = []
    const rpc = remote.rpc.bind(remote)
    remote.rpc = ((endpoint: string, args: any, shape?: any) => {
      if (endpoint === 'session/projections') asked.push(args.request.sessionId)
      return rpc(endpoint, args, shape)
    }) as typeof remote.rpc
    // 前提：dsh 的清单照缓存把说过话的会话报成空白
    const item = (await server.sessions()).find((entry) => entry.sessionId === spoken)
    assert.deepEqual(
      [item.blank, item.projections?.kind, item.projections?.values?.sessionListMetadata?.blank],
      [true, 'cached', true],
    )
    const ids = async (): Promise<string[]> =>
      (await again.call('thread/list', { limit: 50 })).data.map((thread: any) => thread.id)
    assert.deepEqual(await ids(), [spoken])
    assert.deepEqual(asked.sort(), [silent, spoken].sort(), '缓存说空白的都另问一次')
    // 名字和预览照适配器记下的报：缓存里这时还没有标题，不能把模型起的名字报成没有
    const shown = (await again.call('thread/list', { limit: 50 })).data[0]
    assert.deepEqual(
      { name: shown.name, preview: shown.preview },
      { name: 'mock 标题', preview: '说一句话。' },
    )
    // 再列几遍：说过话的记住了；真没说过话的这个 dsh 进程里问过一次就记着，不再问
    asked.length = 0
    assert.deepEqual(await ids(), [spoken])
    assert.deepEqual(await ids(), [spoken])
    assert.deepEqual(asked, [])
    // 没列出来的那个打开说一句话，就进列表了
    await again.call('thread/resume', { threadId: silent })
    const { turn: next } = await again.call('turn/start', {
      threadId: silent,
      input: text('说一句话。'),
    })
    await again.until('turn/completed', (params) => params.turn.id === next.id)
    assert.deepEqual((await ids()).sort(), [silent, spoken].sort())
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await server.close()
    await env.restore()
  }
})
