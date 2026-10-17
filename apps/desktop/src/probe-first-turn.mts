// 首回合验收：每个真的 harness 上，从界面新建会话、发头一句、收到回话。用户最先走、也最不能断的一条路。
// 0.8.0 在原生 codex 上就断在这里（带的工具定义过不了它的校验，整个 thread/start 被拒），当时的自检都对着
// 模拟核心或 Claude、Pi 的夹具，没有一条在真的 codex 上从界面建过会话。
// 对面是由真的适配器主进程管着的隔离设备（scripts/device-fixture.mjs --managed --engines …），模型是回环上的假模型，
// 只会把话带回来（“<标识> 收到：<那句话>”）。新建页上的东西（harness、项目）和建会话、发头一句都用三引擎验收的
// 那一套（probe-engines.mts 的 enginesDevice、enginesStart），这里只走这一步、只判这条主路径上的几项。
// 建会话时外壳带的工具定义（浏览器、Computer Use，测试用的回声）有没有交到模型手里，由起这一遍的
// scripts/check-first-turn.mjs 看假模型那一头。
import type { BrowserWindow } from 'electron'
import { type DeviceSeen, enginesDevice, enginesStart, type StartSeen } from './probe-engines.mjs'
import { installEnginesKit } from './probe-engines-kit.mjs'
import { installFilesKit } from './probe-files-kit.mjs'

/** 一遍最多跑这么久（真的 codex 冷起来要十来秒，一家一个回合十来秒） */
const DEADLINE_MS = 300_000
const WORKSPACE = '首回合验收'
const opening = (id: string) => `从界面新建的头一句（${id}）`

async function inPage<T, A extends unknown[]>(
  window: BrowserWindow,
  probe: (...args: A) => Promise<T> | T,
  ...args: A
): Promise<T> {
  const list = args.map((arg) => JSON.stringify(arg)).join(', ')
  return (await window.webContents.executeJavaScript(`(${probe.toString()})(${list})`, true)) as T
}

/** 出错时给人看的话：没建成时输入框下面那一行（原话在里面），和提示条 */
const notes = () =>
  [...document.querySelectorAll('.dock .cmp-hint.err, .toast-text')].map(
    (entry) => entry.textContent ?? '',
  )

type Row = (StartSeen & { notes: string[] }) | { error: string; notes: string[] }

/** 一家该是什么样：只看主路径（建成、发出、回话对得上、回合正常结束、落在对的 harness 和项目里） */
function judge(id: string, row: Row | undefined, device: DeviceSeen): string[] {
  const shown = device.harnesses.find((entry) => entry.id === id)
  const failed: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) failed.push(`${id}：${what}`)
  }
  check(
    shown?.state === 'ready',
    `设备详情里的状态是“${shown?.state ?? '没有它'}”（${shown?.said ?? ''}）`,
  )
  if (!row || 'error' in row) {
    failed.push(
      `${id}：没走通——${row?.error ?? '没有结果'}；页面上说的：${row?.notes.join('｜') || '无'}`,
    )
    return failed
  }
  const said = opening(id)
  check(row.harness?.current === shown?.name, `新建页上选着的 harness 是“${row.harness?.current}”`)
  check(row.workspace === WORKSPACE, `新建页上选着的项目是“${row.workspace}”`)
  check(row.bubbled, '头一句发出去，气泡没有当场出现')
  check(row.landed, `头一句发出去，没有落到新会话里（页面上说的：${row.notes.join('｜') || '无'}）`)
  check(row.foot === '完成', `头一个回合的结尾是“${row.foot}”`)
  check(row.answer.startsWith(`${id} 收到：${said}`), `回话是“${row.answer.slice(0, 80)}”`)
  check(row.stray.length === 0, `回话中途出现过不是最终文字开头的样子：${row.stray.join('｜')}`)
  // 标题先是头一句；会自己起标题的 harness 随后换成它起的（OpenCode 用小模型起，夹具里小模型也是假模型，
  // 起出来的是带着这句话的回声）
  check(row.rowTitle.includes(said), `侧栏里这一行的标题是“${row.rowTitle}”`)
  check(row.rowHarness === shown?.name, `侧栏里这一行的徽标是“${row.rowHarness}”`)
  check(row.rowWorkspace === WORKSPACE, `这一行落在了“${row.rowWorkspace || '项目外面'}”`)
  return failed
}

async function run(window: BrowserWindow): Promise<readonly [object, string[]]> {
  const fixture = JSON.parse(process.env.LITCH_SMOKE_ENGINES ?? '{}') as {
    ids: string[]
    cwd: string
    skill: { name: string; mark: string }
  }
  const { ids } = fixture
  const place = { cwd: fixture.cwd, workspace: WORKSPACE, skill: fixture.skill }
  await inPage(window, installFilesKit)
  await inPage(window, installEnginesKit)
  const device = await inPage(window, enginesDevice, place, ids)
  const rows: Record<string, Row> = {}
  for (const id of ids) {
    const started = Date.now()
    try {
      const seen = await inPage(window, enginesStart, { id, opening: opening(id) }, place)
      rows[id] = { ...seen, notes: await inPage(window, notes) }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      rows[id] = { error: reason, notes: await inPage(window, notes).catch(() => []) }
    }
    const row = rows[id]
    console.log(
      `LITCH_FIRST_TURN ${JSON.stringify({ id, seconds: (Date.now() - started) / 1000, ...(row && 'error' in row ? row : { foot: row?.foot, answer: row?.answer.slice(0, 80) }) })}`,
    )
  }
  const failed = ids.flatMap((id) => judge(id, rows[id], device))
  return [{ ids, device, rows }, failed]
}

export async function runFirstTurnChecks(
  window: BrowserWindow,
): Promise<readonly [object, string[]]> {
  let stop: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<readonly [object, string[]]>((done) => {
    stop = setTimeout(
      () => done([{}, [`首回合验收跑了 ${DEADLINE_MS / 1000} 秒还没完`]]),
      DEADLINE_MS,
    )
  })
  try {
    return await Promise.race([run(window), late])
  } finally {
    clearTimeout(stop)
  }
}
