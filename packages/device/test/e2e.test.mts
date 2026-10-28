// 端到端：真的 Pi 运行时（两份）加回环上的假模型，经隔离设备夹具起来，客户端只连聚合面这一条。
// 夹具就是客户端那条线和真实窗口验收要用的那一个（scripts/device-fixture.mjs），这里顺带把它也测了。
// 有一条走 Claude Code：夹具带 --managed --engines claude，由真的适配器主进程管着，命令行用 CHA_CLAUDE_CLI 那份隔离的。
import assert from 'node:assert/strict'
import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  spawn,
  spawnSync,
} from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { sessionTools } from '../../protocol/src/client-tools-sessions.mjs'
import {
  assertDeclaration,
  assertProject,
  assertRuntimeInfo,
  assertSectionUpdated,
  assertStatusChanged,
  assertThreadList,
  PINNED,
  REPO,
  TestClient,
} from './helpers.mjs'

const STATUS = 'litch/harness/status/changed'
const SECTION_UPDATED = 'litch/thread/section/updated'
const BOTH = ['harness', 'deviceWorkspaces']
const DEVICE_MAIN = 'packages/device/dist/device/src/main.mjs'

interface Fixture {
  child: ChildProcessWithoutNullStreams
  socket: string
  root: string
  dirs: { app: string; web: string; notes: string }
  upstreams: { id: string; socket: string; pid: number }[]
  devicePid: number
  /** 带 --engines 时才有：起了哪几个 harness，三个引擎共用的工作目录 */
  engines?: { ids: string[]; cwd: string }
}

/** flags：给夹具的开关，比如 --workspaces */
function startFixture(flags: string[] = []): Promise<Fixture> {
  for (const path of ['packages/pi/dist/pi/src/adapter.mjs', DEVICE_MAIN])
    assert.ok(
      existsSync(join(REPO, path)),
      `缺少构建产物 ${path}，先构建 packages/pi 和 packages/device`,
    )
  const child = spawn(process.execPath, [join(REPO, 'scripts/device-fixture.mjs'), ...flags], {
    // 夹具自己会给子进程一份干净的环境；这里只给它找得到 node 和临时目录的那几项，
    // 要起 Claude Code 时再给它那份隔离的命令行（没设的话夹具自己报错退出，不跳过）
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      ...(process.env.CHA_CLAUDE_CLI ? { CHA_CLAUDE_CLI: process.env.CHA_CLAUDE_CLI } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    let output = ''
    let errors = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`夹具 120 秒没有就绪\n${errors}`))
    }, 120_000)
    child.stderr.on('data', (data) => {
      errors = (errors + data).slice(-4000)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`夹具提前退出了（退出码 ${code}）\n${errors}`))
    })
    child.stdout.on('data', (data) => {
      output += data
      const line = output.split('\n').find((item) => item.startsWith('LITCH_DEVICE_FIXTURE '))
      if (!line || !output.includes('\n', output.indexOf(line))) return
      clearTimeout(timer)
      resolve({ child, ...JSON.parse(line.slice('LITCH_DEVICE_FIXTURE '.length)) })
    })
  })
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 握手，并等这条连接上的 harness 都可用。设备进程握手时只等上游几秒（到点没连上的先报成不可用、连上了再通知），
 * 机器很忙的时候真的运行时赶不上；这里量的不是那几秒，所以等齐了再往下走
 */
async function connected(client: TestClient, extensions?: string[]): Promise<void> {
  await (extensions ? client.initialize(extensions) : client.initialize())
  for (let attempt = 0; attempt < 300; attempt++) {
    const info = await client.call('runtime/info')
    if (info.harnesses.every((harness: any) => harness.available)) return
    await pause(100)
  }
  throw new Error('等了 30 秒，还有 harness 没连上')
}

/** 在一个会话上跑一个回合，返回助手说的话 */
async function runTurn(client: TestClient, threadId: string, text: string): Promise<string> {
  const from = client.notifications.length
  await client.call('turn/start', { threadId, input: [{ type: 'text', text }] })
  const completed = await client.waitFor(
    (frame) =>
      frame.method === 'turn/completed' &&
      (frame.params as any).threadId === threadId &&
      client.notifications.indexOf(frame) >= from,
    60_000,
  )
  assert.equal((completed.params as any).turn.status, 'completed')
  return client.notifications
    .slice(from)
    .filter((frame) => frame.method === 'item/completed')
    .map((frame) => frame.params as any)
    .filter((params) => params.threadId === threadId && params.item.type === 'agentMessage')
    .map((params) => params.item.text)
    .join('')
}

test('端到端：一条聚合面连接上两个 harness 的会话、回合、提问，一个上游被杀掉另一个不受影响', async () => {
  const fixture = await startFixture()
  try {
    const client = await TestClient.overSocket(fixture.socket)
    await connected(client)

    const info = await client.call('runtime/info')
    assertRuntimeInfo(info)
    assert.deepEqual(
      info.harnesses.map((harness: any) => [harness.id, harness.engine, harness.available]),
      [
        ['pi', 'pi', true],
        ['pi-b', 'pi', true],
      ],
    )
    // 名字和版本是从运行时自己的 runtime/info 里取的
    assert.deepEqual(
      info.harnesses.map((harness: any) => harness.displayName),
      ['Pi', 'Pi (pi-b)'],
    )
    assert.match(info.harnesses[0].version, /^\d+\.\d+\.\d+/)
    // 同一种引擎配了两份：徽标从标识来，分得开
    assert.deepEqual(
      info.harnesses.map((harness: any) => harness.badge),
      ['PI', 'PB'],
    )
    // 引擎自己的结构化声明（能力位、权限预设、它支持的扩展）原样带到了每个 harness 上
    for (const harness of info.harnesses) {
      assertDeclaration(harness)
      assert.ok(Array.isArray(harness.extensions))
    }
    // 设备级的工作区由设备层处理；这两个运行时里没有项目，所以是空的
    assert.ok(info.device.extensions.includes('deviceWorkspaces'))
    assert.deepEqual(await client.call('project/list', {}), { data: [], nextCursor: null })

    // 一次列出两个 harness 的会话，各自打着标
    const list = await client.call('thread/list', {})
    assertThreadList(list)
    const count = (harness: string) =>
      list.data.filter((thread: any) => thread.harness === harness).length
    assert.deepEqual([count('pi'), count('pi-b'), list.data.length], [3, 2, 5])
    assert.deepEqual(list.skippedHarnesses, [])
    for (let index = 1; index < list.data.length; index++)
      assert.ok(list.data[index - 1].updatedAt >= list.data[index].updatedAt, '按更新时间倒序')
    // 小页翻到底：一个不多一个不少
    const paged: string[] = []
    let cursor: string | null = null
    do {
      const page: any = await client.call('thread/list', { limit: 2, cursor })
      paged.push(...page.data.map((thread: any) => thread.id))
      cursor = page.nextCursor
    } while (cursor)
    assert.deepEqual([...paged].sort(), list.data.map((thread: any) => thread.id).sort())
    assert.equal(new Set(paged).size, paged.length)

    // 各跑通一个回合。假模型会在回话开头注明是哪个 harness 收到的，可以确认没有转错
    const threadOf = (harness: string) =>
      list.data.find((thread: any) => thread.harness === harness)
    for (const harness of ['pi', 'pi-b']) {
      const thread = threadOf(harness)
      const resumed = await client.call('thread/resume', { threadId: thread.id })
      assert.equal(resumed.thread.harness, harness)
      assert.ok(resumed.thread.turns.length >= 1)
      const said = await runTurn(client, thread.id, `你好，${harness}`)
      assert.match(said, new RegExp(`^${harness} 收到：你好，${harness}`))
    }

    // 新建会话要指明 harness；Pi 的会话标识会从临时值换成原生会话号，后续请求用的是最终标识
    const started = await client.call('thread/start', {
      harness: 'pi-b',
      cwd: fixture.dirs.notes,
      model: 'gate/gate',
    })
    assert.equal(started.thread.harness, 'pi-b')
    assert.match(
      await runTurn(client, started.thread.id, '新会话的第一句'),
      /^pi-b 收到：新会话的第一句/,
    )
    const announced = await client.waitFor(
      (frame) =>
        frame.method === 'thread/started' && (frame.params as any).thread.id === started.thread.id,
    )
    assert.equal((announced.params as any).thread.harness, 'pi-b')

    // 引擎向用户提问（服务端发起的请求）：经聚合面到客户端，答复原路回到那个引擎
    const piThread = threadOf('pi').id
    const asking = runTurn(client, piThread, '问我两个问题')
    const answers = ['只改客户端', '注意别动设计文档']
    const answered = new Set<unknown>()
    for (const answer of answers) {
      const question = await client.waitFor(
        (frame) => frame.method === 'item/tool/requestUserInput' && !answered.has(frame.id),
        30_000,
      )
      const params = question.params as any
      assert.equal(params.threadId, piThread)
      answered.add(question.id)
      client.answer(question.id, {
        answers: { [params.questions[0].id]: { answers: [answer] } },
      })
    }
    const reply = await asking
    for (const answer of answers) assert.ok(reply.includes(answer), `回话里带着回答：${answer}`)

    // 设备级的文件访问由设备进程自己处理
    const entries = await client.call('fs/readDirectory', { path: fixture.dirs.app })
    assert.ok(entries.entries.some((entry: any) => entry.fileName === 'web' && entry.isDirectory))

    // 杀掉一个上游
    const victim = fixture.upstreams.find((upstream) => upstream.id === 'pi-b')
    assert.ok(victim)
    process.kill(victim.pid, 'SIGKILL')
    const down = await client.waitFor(
      (frame) => frame.method === STATUS && (frame.params as any).harness === 'pi-b',
      15_000,
    )
    assertStatusChanged(down.params)
    assert.equal((down.params as any).info.available, false)
    assert.equal((down.params as any).info.displayName, 'Pi (pi-b)')
    // 另一个不受影响：订阅还在，回合照跑
    assert.match(await runTurn(client, piThread, '那边掉线了，这边还好吗'), /^pi 收到：那边掉线了/)
    const refused = await client.fails('thread/resume', { threadId: started.thread.id })
    assert.equal(refused.code, -32050)
    assert.equal(refused.data.litch, 'harnessUnavailable')
    const partial = await client.call('thread/list', {})
    assert.ok(partial.data.every((thread: any) => thread.harness === 'pi'))
    assert.deepEqual(
      partial.skippedHarnesses.map((item: any) => item.harness),
      ['pi-b'],
    )
    const during = await client.call('runtime/info')
    assert.deepEqual(
      during.harnesses.map((harness: any) => harness.available),
      [true, false],
    )

    // 把它重新起来：设备进程自己连回去，通知恢复可用，原来的会话还在
    fixture.child.stdin.write('start pi-b\n')
    const up = await client.waitFor(
      (frame) =>
        frame.method === STATUS &&
        (frame.params as any).harness === 'pi-b' &&
        (frame.params as any).info.available === true,
      60_000,
    )
    assertStatusChanged(up.params)
    const back = await client.call('thread/resume', { threadId: started.thread.id })
    assert.equal(back.thread.harness, 'pi-b')
    assert.match(await runTurn(client, started.thread.id, '回来了吗'), /^pi-b 收到：回来了吗/)
    client.close()
  } finally {
    // 夹具收到结束信号后要停掉所有子进程并删掉临时目录
    const exited = new Promise((resolve) => fixture.child.once('exit', resolve))
    fixture.child.kill('SIGTERM')
    await exited
  }
  assert.equal(existsSync(fixture.root), false, '临时目录删掉了')
  assert.equal(alive(fixture.devicePid), false, '设备进程停了')
  for (const upstream of fixture.upstreams)
    assert.equal(alive(upstream.pid), false, `${upstream.id} 停了`)
  // pi-b 重新起来之后进程号换了：按命令行里带着的临时目录再查一遍，一个都不该剩
  const leftover = spawnSync('pgrep', ['-f', fixture.root], { encoding: 'utf8' })
  assert.equal(leftover.stdout.trim(), '', '没有残留的子进程')
})

/** 这条连接从第 from 条通知起收到的、属于这个会话的通知 */
const threadFrames = (client: TestClient, threadId: string, from: number) =>
  client.notifications
    .slice(from)
    .filter((frame) => (frame.params as any)?.threadId === threadId)
    .map((frame) => ({ method: frame.method, params: frame.params }))

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// 一个会话多个订阅者：聚合面上每条客户端连接各有自己的上游连接，
// 两条连接恢复同一个会话，在引擎那边就是两个订阅者。
test('端到端：两条聚合面连接同看一个会话，通知两边都收到；提问两边都到，一边答了另一边收到已解决，迟到的应答不起作用；一条走了另一条照常', async () => {
  const fixture = await startFixture()
  try {
    const first = await TestClient.overSocket(fixture.socket)
    const second = await TestClient.overSocket(fixture.socket)
    for (const client of [first, second]) await connected(client)
    const list = await first.call('thread/list', {})
    const threadId: string = list.data.find((thread: any) => thread.harness === 'pi').id
    for (const client of [first, second]) await client.call('thread/resume', { threadId })
    await pause(300)

    // first 发起回合；没发起的 second 收到的通知和它逐条相同
    const mark = [first.notifications.length, second.notifications.length]
    const completed = (client: TestClient, from: number) =>
      client.waitFor(
        (frame) =>
          frame.method === 'turn/completed' &&
          (frame.params as any).threadId === threadId &&
          client.notifications.indexOf(frame) >= from,
        60_000,
      )
    assert.match(await runTurn(first, threadId, '两边都在看'), /^pi 收到：两边都在看/)
    await completed(second, mark[1] as number)
    await pause(300)
    const seen = threadFrames(first, threadId, mark[0] as number)
    for (const method of ['turn/started', 'item/agentMessage/delta', 'turn/completed'])
      assert.ok(
        seen.some((frame) => frame.method === method),
        `回合的通知里有 ${method}`,
      )
    assert.deepEqual(threadFrames(second, threadId, mark[1] as number), seen)

    // 引擎向用户提的问题发给两条连接，请求号相同
    const again = [first.notifications.length, second.notifications.length]
    const asking = runTurn(first, threadId, '问我两个问题')
    // 中途断言失败时这个回合没人等了，别让它的超时变成测试结束之后才冒出来的错误
    asking.catch(() => {})
    const asked = new Set<unknown>()
    const question = async () => {
      const fresh = (frame: any) =>
        frame.method === 'item/tool/requestUserInput' && !asked.has(frame.id)
      const [mine, theirs] = [
        await first.waitFor(fresh, 30_000),
        await second.waitFor(fresh, 30_000),
      ]
      assert.deepEqual(theirs, mine, '两条连接收到的是同一条请求')
      asked.add(mine.id)
      return mine
    }
    const reply = (frame: any, answer: string) => ({
      answers: { [frame.params.questions[0].id]: { answers: [answer] } },
    })
    const resolved = (client: TestClient, id: unknown) =>
      client.waitFor(
        (frame) =>
          frame.method === 'serverRequest/resolved' && (frame.params as any).requestId === id,
        15_000,
      )

    // 第一题：没发起回合的那条连接先答；另一条被告知，它之后的应答不起作用
    const one = await question()
    second.answer(one.id, reply(one, '只改客户端'))
    for (const client of [first, second]) await resolved(client, one.id)
    first.answer(one.id, reply(one, '迟到的回答'))
    // 第二题：发起回合的那条连接先答
    const two = await question()
    first.answer(two.id, reply(two, '注意别动设计文档'))
    for (const client of [first, second]) await resolved(client, two.id)
    second.answer(two.id, reply(two, '迟到的回答'))

    const said = await asking
    await completed(second, again[1] as number)
    for (const answer of ['只改客户端', '注意别动设计文档'])
      assert.ok(said.includes(answer), `回话里带着先到的回答：${answer}`)
    assert.ok(!said.includes('迟到的回答'), '迟到的应答没有进到回合里')
    assert.equal(first.requests.length, 2, '没有多出别的请求')
    assert.equal(second.requests.length, 2)

    // 一条连接走了，另一条照常；反过来由留下的那条发起回合
    first.close()
    await pause(300)
    assert.match(await runTurn(second, threadId, '还剩一条连接'), /^pi 收到：还剩一条连接/)
    second.close()
  } finally {
    const exited = new Promise((resolve) => fixture.child.once('exit', resolve))
    fixture.child.kill('SIGTERM')
    await exited
  }
  assert.equal(existsSync(fixture.root), false, '临时目录删掉了')
})

// 上游把会话的新建、状态、改名、归档、删除这些发给所有连接（rust-v0.162.0-alpha.20 里经全局的
// OutgoingMessageSender 发），客户端的侧栏靠它们跟着别处在跑的会话变；回合、条目这些只给订阅者。
// 聚合面上每条客户端连接各有自己的上游连接，设备进程收到就转。所以没打开（没恢复、没订阅）这个会话的连接，
// 只列过会话的、只读过它的（设备进程找会话归谁、核心取会话对象都是只读），都要收到前一种，收不到后一种。
const EVERYONE = new Set([
  'thread/started',
  'thread/status/changed',
  'thread/name/updated',
  'thread/archived',
  'thread/unarchived',
  'thread/closed',
  'thread/deleted',
  'thread/reverted',
  'thread/attachment/updated',
])

test('端到端：没打开会话的聚合面连接照样收到它的状态、改名、归档；回合和条目的通知只到打开了它的连接', async () => {
  const fixture = await startFixture()
  try {
    const owner = await TestClient.overSocket(fixture.socket)
    const listing = await TestClient.overSocket(fixture.socket)
    const reading = await TestClient.overSocket(fixture.socket)
    for (const client of [owner, listing, reading]) await connected(client)
    const threadId: string = (await listing.call('thread/list', {})).data.find(
      (thread: any) => thread.harness === 'pi',
    ).id
    await reading.call('thread/read', { threadId, includeTurns: false })
    await owner.call('thread/resume', { threadId })
    const marks = [listing.notifications.length, reading.notifications.length]

    assert.match(await runTurn(owner, threadId, '别处在跑'), /^pi 收到：别处在跑/)
    await owner.call('thread/name/set', { threadId, name: '别处改的名字' })
    await owner.call('thread/archive', { threadId })
    await owner.call('thread/unarchive', { threadId })
    for (const [index, client] of [listing, reading].entries()) {
      const from = marks[index] as number
      await client.waitFor(
        (frame) =>
          frame.method === 'thread/unarchived' &&
          (frame.params as any).threadId === threadId &&
          client.notifications.indexOf(frame) >= from,
        15_000,
      )
      const seen = threadFrames(client, threadId, from)
      for (const frame of seen)
        assert.ok(EVERYONE.has(frame.method as string), `没打开会话的连接不该收到 ${frame.method}`)
      const statuses = seen
        .filter((frame) => frame.method === 'thread/status/changed')
        .map((frame) => (frame.params as any).status.type)
      assert.ok(statuses.includes('active') && statuses.at(-1) === 'idle', `状态：${statuses}`)
      // Pi 自己也为改名发一条（会话名变了的事件），所以改名可能是两条
      assert.ok(
        seen.some((frame) => frame.method === 'thread/name/updated'),
        '改名',
      )
      for (const method of ['thread/archived', 'thread/unarchived'])
        assert.equal(seen.filter((frame) => frame.method === method).length, 1, method)
    }
    for (const client of [owner, listing, reading]) client.close()
  } finally {
    const exited = new Promise((resolve) => fixture.child.once('exit', resolve))
    fixture.child.kill('SIGTERM')
    await exited
  }
})

// Claude Code 这一路：由真的适配器主进程管着（--managed --engines claude，隔离的命令行加回环上的假模型）。
// 这时聚合面后面还有 Pi，dsh 和原生 Codex 都没装，所以只等 Claude Code 可用
test('端到端：Claude Code 的会话也一样，没打开它的聚合面连接收到新建、状态、改名、归档，回合和条目只到打开了它的连接', async () => {
  const fixture = await startFixture(['--managed', '--engines', 'claude'])
  try {
    const owner = await TestClient.overSocket(fixture.socket)
    const listing = await TestClient.overSocket(fixture.socket)
    const reading = await TestClient.overSocket(fixture.socket)
    for (const client of [owner, listing, reading]) {
      await client.initialize()
      for (let attempt = 0; ; attempt++) {
        const info = await client.call('runtime/info')
        if (info.harnesses.some((item: any) => item.id === 'claude-code' && item.available)) break
        assert.ok(attempt < 300, '等了 30 秒，Claude Code 还没连上')
        await pause(100)
      }
    }
    const marks = [listing.notifications.length, reading.notifications.length]
    const started = await owner.call('thread/start', {
      harness: 'claude-code',
      cwd: fixture.engines?.cwd,
    })
    const threadId: string = started.thread.id
    assert.equal(started.thread.harness, 'claude-code')
    await listing.call('thread/list', {})
    await reading.call('thread/read', { threadId, includeTurns: false })

    assert.match(await runTurn(owner, threadId, '别处在跑'), /^claude-code 收到：别处在跑/)
    await owner.call('thread/name/set', { threadId, name: '别处改的名字' })
    await owner.call('thread/archive', { threadId })
    await owner.call('thread/unarchive', { threadId })
    for (const [index, client] of [listing, reading].entries()) {
      const from = marks[index] as number
      await client.waitFor(
        (frame) =>
          frame.method === 'thread/unarchived' &&
          (frame.params as any).threadId === threadId &&
          client.notifications.indexOf(frame) >= from,
        15_000,
      )
      const announced = client.notifications
        .slice(from)
        .filter(
          (frame) =>
            frame.method === 'thread/started' && (frame.params as any).thread.id === threadId,
        )
      assert.equal(announced.length, 1, '新建')
      const seen = threadFrames(client, threadId, from)
      for (const frame of seen)
        assert.ok(EVERYONE.has(frame.method as string), `没打开会话的连接不该收到 ${frame.method}`)
      const statuses = seen
        .filter((frame) => frame.method === 'thread/status/changed')
        .map((frame) => (frame.params as any).status.type)
      assert.ok(statuses.includes('active') && statuses.at(-1) === 'idle', `状态：${statuses}`)
      assert.deepEqual(
        seen
          .filter((frame) => frame.method === 'thread/name/updated')
          .map((frame) => (frame.params as any).threadName),
        ['别处改的名字'],
      )
      for (const method of ['thread/archived', 'thread/unarchived'])
        assert.equal(seen.filter((frame) => frame.method === method).length, 1, method)
    }
    assert.ok(
      owner.notifications.some(
        (frame) =>
          frame.method === 'item/agentMessage/delta' && (frame.params as any).threadId === threadId,
      ),
      '打开了会话的连接照常收到回合的内容',
    )
    for (const client of [owner, listing, reading]) client.close()
  } finally {
    const exited = new Promise((resolve) => fixture.child.once('exit', resolve))
    fixture.child.kill('SIGTERM')
    await exited
  }
})

/** 聚合面上现在看到的工作区、分区，和每个会话的归属、分区 */
async function workspaceView(client: TestClient) {
  const projects: any[] = (await client.call('project/list', {})).data
  const sections: any[] = (await client.call('threadSection/list', {})).data
  const threads: unknown[][] = (await client.call('thread/list', { limit: 100 })).data
    .map((thread: any) => [
      thread.id,
      thread.harness,
      thread.projectId,
      thread.section?.id ?? null,
      thread.sectionEnteredAt,
    ])
    .sort()
  return { projects, sections, threads }
}

/** 对着同一批运行时另起一个设备进程，状态目录是空的 */
async function startDevice(fixture: Fixture, directory: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      join(REPO, DEVICE_MAIN),
      '--listen',
      `unix://${join(directory, 'device.sock')}`,
      '--state',
      directory,
      ...fixture.upstreams.flatMap((item) => ['--upstream', `${item.id}=unix://${item.socket}`]),
    ],
    {
      env: { PATH: process.env.PATH, HOME: join(fixture.root, 'home'), TMPDIR: fixture.root },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  await new Promise<void>((resolve, reject) => {
    let output = ''
    let errors = ''
    const timer = setTimeout(() => reject(new Error(`设备进程 30 秒没有就绪\n${errors}`)), 30_000)
    child.stderr?.on('data', (data) => {
      errors = (errors + data).slice(-4000)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`设备进程提前退出了（退出码 ${code}）\n${errors}`))
    })
    child.stdout?.on('data', (data) => {
      output += data
      if (!output.split('\n').includes('LITCH_DEVICE_READY')) return
      clearTimeout(timer)
      resolve()
    })
  })
  return child
}

test('端到端：Claude Code 的父会话回合在跑时子会话做完，回报当场插进这个回合，模型在同一回合里看到，不另开唤醒回合', async () => {
  const fixture = await startFixture(['--managed', '--engines', 'claude'])
  try {
    const client = await TestClient.overSocket(fixture.socket)
    await client.initialize(['harness', 'deviceWorkspaces', 'sessionTree', 'clientTools'])
    for (let attempt = 0; ; attempt++) {
      const info = await client.call('runtime/info')
      if (info.harnesses.some((item: any) => item.id === 'claude-code' && item.available)) break
      assert.ok(attempt < 300, '等了 30 秒，Claude Code 还没连上')
      await pause(100)
    }
    const started = await client.call('thread/start', {
      harness: 'claude-code',
      cwd: fixture.engines?.cwd,
      dynamicTools: [sessionTools(false)],
    })
    const parentId: string = started.thread.id
    const ended = (turnId: string) =>
      client.waitFor(
        (frame) => frame.method === 'turn/completed' && (frame.params as any).turn.id === turnId,
        120_000,
      )
    // 第一回合：假模型照话调 litch_sessions.start 派一个子会话。子会话先问用户一道题（问一句）、等着，
    // 这样它什么时候做完由这里定：父会话开始慢慢回话之后再答，它在父会话这一回合里做完
    const spec = {
      title: '问一句的子会话',
      prompt:
        '问一句：这个仓库先看哪一部分？用户答了之后照答复说一句就结束这一回合，不要做别的事情。',
      background:
        '这是一次隔离验证：父会话在跑的时候子会话做完，回报要当场插进父会话的回合里，模型在同一个回合里就能看到。',
      harness: 'claude-code',
      initiation: 'user_asked',
    }
    const first = await client.call('turn/start', {
      threadId: parentId,
      input: [{ type: 'text', text: `会话：start ${JSON.stringify(spec)}` }],
    })
    await ended(first.turn.id)
    const childId = client.notifications
      .map((frame) => (frame.params as any)?.thread)
      .find((thread) => thread?.litchLineage?.parentThreadId === parentId)?.id
    assert.ok(childId, '派出了子会话')
    await client.call('thread/resume', { threadId: childId })
    const question = await client.waitFor(
      (frame) =>
        frame.method === 'item/tool/requestUserInput' && (frame.params as any).threadId === childId,
      60_000,
    )
    // 第二回合：父会话慢慢回话（九秒上下），这时才答子会话的题，子会话在这期间做完
    const second = await client.call('turn/start', {
      threadId: parentId,
      input: [{ type: 'text', text: '慢慢说' }],
    })
    client.answer(question.id, {
      answers: { [(question.params as any).questions[0].id]: { answers: ['先看设备服务'] } },
    })
    await ended(second.turn.id)
    const steered = client.notifications.filter(
      (frame) =>
        frame.method === 'item/started' &&
        (frame.params as any).item.type === 'userMessage' &&
        JSON.stringify((frame.params as any).item.content).includes('<litch-session-event kind='),
    )
    assert.equal(steered.length, 1, '插了一次')
    const inserted = steered[0]?.params as any
    assert.equal(inserted.turnId, second.turn.id, '插在第二回合里')
    assert.match(inserted.item.clientId, /^litch-sessions-[a-z0-9]+-\d+$/)
    await pause(2000)
    const read = await client.call('thread/read', { threadId: parentId, includeTurns: true })
    assert.equal(read.thread.turns.length, 2, '没有另开唤醒回合')
    const items: any[] = read.thread.turns[1].items
    const at = items.findIndex(
      (item) =>
        item.type === 'userMessage' && JSON.stringify(item.content).includes('kind=\\"notes\\"'),
    )
    assert.ok(at > 0, '记录里留着插进去的回报，在回合中间')
    // 假模型认出只有回报的那条消息，照着回一句（client-fixture-sessions.mjs）：模型在这一回合里看到了它，是这个子会话的
    const answer = items.slice(at + 1).find((item) => item.type === 'agentMessage')?.text ?? ''
    assert.match(answer, /^收到子会话的回报：1 条/)
    assert.ok(answer.includes(childId), answer.slice(0, 400))
    client.close()
  } finally {
    const exited = new Promise((resolve) => fixture.child.once('exit', resolve))
    fixture.child.kill('SIGTERM')
    await exited
  }
})

test('端到端：Claude Code 的父会话回合结束时后台命令还在跑，子会话做完不唤醒；后台跑完 CLI 自己续跑时回报跟着交出去', async () => {
  const fixture = await startFixture(['--managed', '--engines', 'claude'])
  try {
    const client = await TestClient.overSocket(fixture.socket)
    await client.initialize(['harness', 'deviceWorkspaces', 'sessionTree', 'clientTools'])
    for (let attempt = 0; ; attempt++) {
      const info = await client.call('runtime/info')
      if (info.harnesses.some((item: any) => item.id === 'claude-code' && item.available)) break
      assert.ok(attempt < 300, '等了 30 秒，Claude Code 还没连上')
      await pause(100)
    }
    // 后台命令不用人批
    const started = await client.call('thread/start', {
      harness: 'claude-code',
      cwd: fixture.engines?.cwd,
      approvalPolicy: 'never',
      dynamicTools: [sessionTools(false)],
    })
    const parentId: string = started.thread.id
    const ended = (turnId: string) =>
      client.waitFor(
        (frame) => frame.method === 'turn/completed' && (frame.params as any).turn.id === turnId,
        120_000,
      )
    // 子会话先问用户一道题等着，什么时候做完由这里定：父会话这一回合结束、后台命令还在跑的时候再答
    const spec = {
      title: '问一句的子会话',
      prompt:
        '问一句：这个仓库先看哪一部分？用户答了之后照答复说一句就结束这一回合，不要做别的事情。',
      background:
        '这是一次隔离验证：父会话的回合已经结束、它起的后台命令还在跑，这时子会话做完，回报要等后台命令跑完再交给父会话。',
      harness: 'claude-code',
      initiation: 'user_asked',
    }
    const first = await client.call('turn/start', {
      threadId: parentId,
      input: [{ type: 'text', text: `会话：start ${JSON.stringify(spec)}` }],
    })
    await ended(first.turn.id)
    const childId = client.notifications
      .map((frame) => (frame.params as any)?.thread)
      .find((thread) => thread?.litchLineage?.parentThreadId === parentId)?.id
    assert.ok(childId, '派出了子会话')
    await client.call('thread/resume', { threadId: childId })
    const question = await client.waitFor(
      (frame) =>
        frame.method === 'item/tool/requestUserInput' && (frame.params as any).threadId === childId,
      60_000,
    )
    // 第二回合：父会话起一条后台命令（睡 12 秒，scripts/client-fixture-background.mjs 的 BG_SECONDS）就停下
    const secondAt = Date.now()
    const second = await client.call('turn/start', {
      threadId: parentId,
      input: [{ type: 'text', text: '后台跑' }],
    })
    await ended(second.turn.id)
    client.answer(question.id, {
      answers: { [(question.params as any).questions[0].id]: { answers: ['先看设备服务'] } },
    })
    // 后台命令在跑时不唤醒（同 Claude 桌面端）；跑完后 CLI 自己续跑，回报插进那一回合（引擎没续跑的话设备进程唤醒）
    const report = await client.waitFor(
      (frame) =>
        frame.method === 'item/started' &&
        (frame.params as any).threadId === parentId &&
        (frame.params as any).item.type === 'userMessage' &&
        /kind=\\"(notes|wake)\\"/.test(JSON.stringify((frame.params as any).item.content)),
      90_000,
    )
    assert.ok(Date.now() - secondAt >= 11_000, '后台命令跑完之后才交回报')
    assert.notEqual((report.params as any).turnId, second.turn.id, '在另一个回合里交出去')
    client.close()
  } finally {
    const exited = new Promise((resolve) => fixture.child.once('exit', resolve))
    fixture.child.kill('SIGTERM')
    await exited
  }
})

test('端到端：设备级的工作区，从两个真的 Pi 现有的项目导入；建改删、移会话、置顶、带工作区新建；引擎没有被改；重新导入结果一样', async () => {
  const fixture = await startFixture(['--workspaces'])
  let second: ChildProcess | null = null
  try {
    const a = await TestClient.overSocket(fixture.socket)
    const b = await TestClient.overSocket(fixture.socket)
    // 握手会等导入做完
    await connected(a, BOTH)
    await connected(b, BOTH)
    const members = async (client: TestClient, params: Record<string, unknown>) =>
      (await client.call('thread/list', { limit: 100, ...params })).data
        .map((thread: any) => thread.id)
        .sort()

    // ---------- 导入来的 ----------
    const initial = await workspaceView(a)
    for (const project of initial.projects) assertProject(project)
    // 两个引擎里根目录相同的合成了一个，名字是建得早的那个（pi-b 的）；排的位置按 harness 的顺序
    assert.deepEqual(
      initial.projects.map((project) => [project.name, project.roots, project.position]),
      [
        ['应用（发布）', [{ path: fixture.dirs.app }], 0],
        ['笔记', [{ path: fixture.dirs.notes }], 1],
      ],
    )
    const [app, notes] = initial.projects
    assert.deepEqual(
      JSON.parse(app.metadata['litch.import.sources']).map((source: any) => [
        source.harness,
        source.name,
      ]),
      [
        ['pi', '应用'],
        ['pi-b', '应用（发布）'],
      ],
    )
    const all: any[] = (await a.call('thread/list', { limit: 100 })).data
    const named = (name: string) => {
      const thread = all.find((item) => item.name === name)
      assert.ok(thread, `没有找到会话：${name}`)
      return thread
    }
    const paging = named('给列表加上分页')
    const build = named('核对构建产物')
    const release = named('整理发布说明')
    const flaky = named('排查偶发的超时')
    assert.deepEqual(
      [paging.harness, build.harness, release.harness, flaky.harness],
      ['pi', 'pi', 'pi-b', 'pi-b'],
    )
    // 合成的那个工作区下面有两边的会话；归属、置顶、分区都带过来了
    assert.deepEqual(
      await members(a, { projectId: app.id }),
      [paging.id, release.id, flaky.id].sort(),
    )
    assert.equal((await members(a, { projectId: notes.id })).length, 1)
    assert.equal(build.projectId, null)
    assert.deepEqual(
      initial.sections.map((section) => section.name),
      ['Pinned', '稍后看'],
    )
    const later = initial.sections[1]
    assert.deepEqual([paging.section?.id, flaky.section?.id], [PINNED, later.id])
    assert.deepEqual(await members(a, { isPinned: true }), [paging.id])
    assert.deepEqual(await members(a, { sectionId: later.id }), [flaky.id])

    // ---------- 建、改名、改根目录、重排、删；第二条连接收得到通知 ----------
    const changed = (projectId: string, changeType: string) =>
      b.waitFor(
        (frame) =>
          frame.method === 'project/changed' &&
          (frame.params as any).projectId === projectId &&
          (frame.params as any).changeType === changeType,
      )
    const web = (
      await a.call('project/create', {
        name: '网页',
        roots: [{ path: fixture.dirs.web }],
        idempotencyKey: 'e2e-web',
      })
    ).project
    await changed(web.id, 'created')
    const edited = (
      await a.call('project/update', {
        projectId: web.id,
        name: '网页前端',
        roots: [{ path: fixture.dirs.web }, { path: fixture.dirs.notes }],
      })
    ).project
    assert.deepEqual([edited.name, edited.roots.length], ['网页前端', 2])
    await changed(web.id, 'updated')
    await a.call('project/move', { projectId: web.id, beforeProjectId: app.id })
    const scrap = (
      await a.call('project/create', { name: '临时的', roots: [], idempotencyKey: 'e2e-scrap' })
    ).project
    await a.call('project/delete', { projectId: scrap.id })
    await changed(scrap.id, 'deleted')
    assert.deepEqual(
      (await b.call('project/list', {})).data.map((project: any) => project.name),
      ['网页前端', '应用（发布）', '笔记'],
    )

    // ---------- 把会话移进另一个工作区（两个 harness 的都移） ----------
    const moved = await a.call('thread/metadata/update', { threadId: build.id, projectId: web.id })
    assert.deepEqual([moved.thread.projectId, moved.thread.harness], [web.id, 'pi'])
    await a.call('thread/metadata/update', { threadId: release.id, projectId: web.id })
    await b.waitFor(
      (frame) =>
        frame.method === 'thread/project/updated' &&
        (frame.params as any).threadId === release.id &&
        (frame.params as any).projectId === web.id,
    )
    assert.deepEqual(await members(b, { projectId: web.id }), [build.id, release.id].sort())
    assert.deepEqual(await members(b, { projectId: app.id }), [paging.id, flaky.id].sort())

    // ---------- 置顶和取消置顶 ----------
    const sectionOf = (threadId: string, pinned: boolean) =>
      b.waitFor(
        (frame) =>
          frame.method === SECTION_UPDATED &&
          (frame.params as any).threadId === threadId &&
          (frame.params as any).isPinned === pinned,
      )
    await a.call('thread/metadata/update', { threadId: release.id, isPinned: true })
    assertSectionUpdated((await sectionOf(release.id, true)).params)
    assert.deepEqual(await members(b, { isPinned: true }), [paging.id, release.id].sort())
    await a.call('thread/section/move', { threadId: paging.id, sectionId: null })
    await sectionOf(paging.id, false)
    assert.deepEqual(await members(b, { isPinned: true }), [release.id])
    assert.deepEqual(await members(b, { projectId: web.id, isPinned: true }), [release.id])

    // ---------- 带工作区新建会话：落在那个工作区里 ----------
    const started = await a.call('thread/start', {
      harness: 'pi-b',
      cwd: fixture.dirs.web,
      model: 'gate/gate',
      projectId: web.id,
    })
    assert.deepEqual([started.thread.harness, started.thread.projectId], ['pi-b', web.id])
    const announced = await a.waitFor(
      (frame) =>
        frame.method === 'thread/started' && (frame.params as any).thread.id === started.thread.id,
    )
    assert.equal((announced.params as any).thread.projectId, web.id)
    await b.waitFor(
      (frame) =>
        frame.method === 'thread/project/updated' &&
        (frame.params as any).threadId === started.thread.id,
    )
    assert.match(
      await runTurn(a, started.thread.id, '在工作区里新建的'),
      /^pi-b 收到：在工作区里新建的/,
    )
    assert.deepEqual(
      await members(b, { projectId: web.id }),
      [build.id, release.id, started.thread.id].sort(),
    )

    // ---------- 引擎自己那一份没有被动过：直接连各个运行时自己的入口看 ----------
    const direct = async (id: string) => {
      const upstream = fixture.upstreams.find((item) => item.id === id)
      assert.ok(upstream)
      const client = await TestClient.overSocket(upstream.socket)
      await client.initialize(null)
      return client
    }
    const engineThread = async (client: TestClient, threadId: string) =>
      (await client.call('thread/read', { threadId, includeTurns: false })).thread
    const pi = await direct('pi')
    assert.deepEqual(
      (await pi.call('project/list', {})).data.map((project: any) => project.name),
      ['应用', '笔记'],
    )
    assert.equal((await engineThread(pi, build.id)).projectId ?? null, null)
    // 聚合面上取消了置顶，引擎里它还置顶着
    assert.equal((await engineThread(pi, paging.id)).section?.id, PINNED)
    pi.close()
    const piB = await direct('pi-b')
    assert.deepEqual(
      (await piB.call('project/list', {})).data.map((project: any) => project.name),
      ['应用（发布）'],
    )
    // 聚合面上移走、置顶了的会话，在引擎里还在它原来的项目里、没有置顶；新建的那个在引擎里没有归属
    const engineRelease = await engineThread(piB, release.id)
    assert.deepEqual([engineRelease.projectId, engineRelease.section ?? null], [app.id, null])
    assert.equal((await engineThread(piB, started.thread.id)).projectId ?? null, null)
    piB.close()

    // ---------- 另起一个设备进程、状态目录是空的（等于删掉设备库）：重新导入，得到和一开始一样的结果 ----------
    const directory = join(fixture.root, 'h', 'd2')
    second = await startDevice(fixture, directory)
    const c = await TestClient.overSocket(join(directory, 'device.sock'))
    await connected(c, BOTH)
    const again = await workspaceView(c)
    assert.deepEqual(again.projects, initial.projects)
    assert.deepEqual(again.sections, initial.sections)
    const known = new Set(initial.threads.map((row) => row[0]))
    assert.deepEqual(
      again.threads.filter((row) => known.has(row[0])),
      initial.threads,
    )
    c.close()
    a.close()
    b.close()
  } finally {
    if (second && second.exitCode === null && second.signalCode === null) {
      const gone = new Promise((resolve) => second?.once('exit', resolve))
      second.kill('SIGTERM')
      await gone
    }
    const exited = new Promise((resolve) => fixture.child.once('exit', resolve))
    fixture.child.kill('SIGTERM')
    await exited
  }
  assert.equal(existsSync(fixture.root), false, '临时目录删掉了')
  const leftover = spawnSync('pgrep', ['-f', fixture.root], { encoding: 'utf8' })
  assert.equal(leftover.stdout.trim(), '', '没有残留的子进程')
})
