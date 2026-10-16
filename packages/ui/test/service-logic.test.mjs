// 设备详情里“设备服务”一节的判断：换版本的结果哪几种要说、各说哪一句，不闲的原因怎么说，
// 要用户手工结束时给哪几条命令。不起浏览器：service.ts 只有判断。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  busyLine,
  endSteps,
  FOREGROUND_STEPS,
  noticeOf,
  olderLine,
  originOf,
  pillOf,
  replacedLine,
  staleService,
} = await import('../src/devices/service.ts')
const { translate } = await import('../src/i18n/index.ts')

const BUNDLED = { version: '0.7.0', root: '/Applications/Litch.app/Contents/Resources/adapter' }
const upgrade = (patch) => ({
  action: 'kept',
  bundled: BUNDLED,
  previous: '0.6.0',
  order: 'older',
  reason: 'same',
  busy: [],
  detail: null,
  pid: 4821,
  ...patch,
})
const device = (patch) => ({ connection: 'online', service: null, upgrade: null, ...patch })
/** 一句话用两种语言都说得出来，里面要填的值都填上了 */
const said = ({ key, args }) => {
  const both = ['zh-CN', 'en'].map((lang) => translate(lang, key, args))
  for (const text of both) assert.doesNotMatch(text, /\{\w+\}/, `${key} 里有没填上的值`)
  return both
}

test('要说的只有五种：换上了新版，和四种没换成；别的都不打扰', () => {
  assert.equal(noticeOf(null), null)
  assert.equal(noticeOf(upgrade({ action: 'launched', previous: null, reason: null })), null)
  assert.equal(noticeOf(upgrade({ action: 'replaced', reason: null })), 'replaced')
  for (const reason of ['same', 'newer', 'incomparable']) {
    assert.equal(noticeOf(upgrade({ reason })), null, reason)
  }
  for (const reason of ['busy', 'foreground', 'unsupported', 'failed']) {
    assert.equal(noticeOf(upgrade({ reason })), reason)
  }
})

test('列表行上的记号只给“旧而且没换成”的，而且要连着', () => {
  const busy = upgrade({ reason: 'busy' })
  assert.equal(staleService(device({ upgrade: busy })), true)
  assert.equal(staleService(device({ upgrade: busy, connection: 'reconnecting' })), false)
  assert.equal(staleService(device({ upgrade: busy, connection: 'offline' })), false)
  assert.equal(
    staleService(device({ upgrade: upgrade({ action: 'replaced', reason: null }) })),
    false,
  )
  assert.equal(
    staleService(device({ upgrade: upgrade({ reason: 'newer', order: 'newer' }) })),
    false,
  )
  // 远程设备没有换版本这一项
  assert.equal(staleService(device({})), false)
})

test('来自哪份适配器：按根目录比，末尾的斜杠不算；同一个位置但程序换过的另说；远程设备给路径', () => {
  const service = {
    version: '0.7.0',
    root: `${BUNDLED.root}/`,
    startedAt: 0,
    detached: true,
    pid: 1,
  }
  assert.equal(originOf(service, upgrade({})), 'bundled')
  assert.equal(originOf(service, upgrade({ action: 'replaced', reason: null })), 'bundled')
  // 应用原地升级了，在跑的还是升级之前从同一个位置起的那一份
  assert.equal(
    originOf({ ...service, version: '0.6.0' }, upgrade({ reason: 'busy' })),
    'bundledBefore',
  )
  assert.equal(
    originOf(service, upgrade({ reason: 'busy', previous: '0.7.0', order: 'rebuilt' })),
    'bundledBefore',
  )
  assert.equal(originOf({ ...service, root: '/opt/homebrew/opt/x/libexec' }, upgrade({})), 'path')
  assert.equal(originOf(service, null), 'path')
  for (const kind of ['bundled', 'bundledBefore']) said({ key: `service.origin.${kind}`, args: {} })
})

test('换上了新版：说从哪版到哪版；原来那份没报版本、版本号没变的各有说法', () => {
  const replaced = upgrade({ action: 'replaced', reason: null })
  assert.deepEqual(replacedLine(replaced), {
    key: 'service.replaced',
    args: { from: '0.6.0', to: '0.7.0' },
  })
  const [zh, en] = said(replacedLine(replaced))
  assert.match(zh, /0\.6\.0 → 0\.7\.0/)
  assert.match(en, /0\.6\.0 → 0\.7\.0/)
  assert.deepEqual(pillOf(replaced), {
    tone: 'ok',
    key: 'service.sum.replaced',
    args: { from: '0.6.0' },
  })

  const unknown = { ...replaced, previous: null, order: 'unknown' }
  assert.equal(replacedLine(unknown).key, 'service.replaced.unknown')
  assert.equal(pillOf(unknown).key, 'service.sum.replaced.plain')
  const rebuilt = { ...replaced, previous: '0.7.0', order: 'rebuilt' }
  assert.equal(replacedLine(rebuilt).key, 'service.replaced.rebuilt')
  assert.equal(pillOf(rebuilt).key, 'service.sum.replaced.plain', '不说“从 0.7.0 换上来”')
  for (const line of [unknown, rebuilt].map(replacedLine)) said(line)
})

test('没换成：开头一句说清两边各是哪版；小标只说旧，没有要说的没有小标', () => {
  assert.deepEqual(olderLine(upgrade({ reason: 'busy' })), {
    key: 'service.older',
    args: { from: '0.6.0', to: '0.7.0' },
  })
  assert.equal(
    olderLine(upgrade({ reason: 'unsupported', previous: null, order: 'unknown' })).key,
    'service.older.unknown',
  )
  assert.equal(
    olderLine(upgrade({ reason: 'busy', previous: '0.7.0', order: 'rebuilt' })).key,
    'service.older.rebuilt',
  )
  for (const reason of ['busy', 'foreground', 'unsupported', 'failed']) {
    assert.deepEqual(pillOf(upgrade({ reason })), {
      tone: 'wait',
      key: 'service.sum.stale',
      args: {},
    })
    said({ key: `service.${reason}`, args: {} })
  }
  assert.equal(pillOf(upgrade({})), null)
  assert.equal(pillOf(null), null)
})

test('不闲的原因：harness 说名字，终端和客户端说个数，不认识的照原样说', () => {
  const nameOf = (id) => ({ claude: 'Claude Code', dsh: 'DSH' })[id] ?? id
  const line = (entry) => busyLine({ harnesses: [], count: 0, ...entry }, nameOf, '、')
  assert.deepEqual(line({ reason: 'activeTurns', harnesses: ['claude', 'dsh'] }), {
    key: 'service.busy.turns',
    args: { names: 'Claude Code、DSH' },
  })
  assert.equal(line({ reason: 'activeTurns' }).key, 'service.busy.turnsUnnamed')
  assert.deepEqual(line({ reason: 'deviceProcesses', count: 2 }), {
    key: 'service.busy.terminals',
    args: { count: 2 },
  })
  assert.deepEqual(line({ reason: 'clients', count: 1 }), {
    key: 'service.busy.clients',
    args: { count: 1 },
  })
  assert.deepEqual(line({ reason: 'undetermined', harnesses: ['pi'] }), {
    key: 'service.busy.undetermined',
    args: { names: 'pi' },
  })
  assert.equal(line({ reason: 'undetermined' }).key, 'service.busy.undeterminedUnnamed')
  assert.deepEqual(line({ reason: 'somethingNew' }), {
    key: 'service.busy.other',
    args: { reason: 'somethingNew' },
  })
  // 英文的单复数
  assert.deepEqual(
    [1, 2].map((count) => translate('en', 'service.busy.terminals', { count })),
    ['1 terminal is running', '2 terminals are running'],
  )
  assert.deepEqual(
    [1, 3].map((count) => translate('en', 'service.busy.clients', { count })),
    ['1 other client is connected', '3 other clients are connected'],
  )
  for (const reason of ['activeTurns', 'deviceProcesses', 'clients', 'undetermined', 'x']) {
    said(line({ reason, harnesses: ['claude'], count: 1 }))
  }
})

test('太旧、停不了：先确认那个进程号上是它，再结束；命令行没报进程号就不给命令', () => {
  const steps = endSteps(4821)
  assert.deepEqual(
    steps.map((step) => step.command),
    [null, 'ps -p 4821 -o command=', 'kill 4821', null],
  )
  for (const step of steps) said({ key: step.text, args: { pid: 4821 } })
  assert.match(translate('zh-CN', 'service.unsupported.check', { pid: 4821 }), /4821 号进程/)
  assert.deepEqual(endSteps(null), [])
  said({ key: 'service.unsupported.noPid', args: {} })
})

test('前台的、有服务管理器管着的：几种办法都说，brew 的两条命令和远程升级指引是同一份', () => {
  assert.deepEqual(
    FOREGROUND_STEPS.map((step) => step.command),
    [
      'brew upgrade codex-harness-adapter',
      'brew services restart codex-harness-adapter',
      null,
      null,
    ],
  )
  for (const step of FOREGROUND_STEPS) said({ key: step.text, args: {} })
})
