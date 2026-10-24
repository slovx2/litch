// 三个引擎各走一遍的验收在主进程这一头的编排：一步一步来，每一步三家挨个做，做完打一行
// LITCH_ENGINES {"step":…,"claude-code":…,"pi":…,"dsh":…}，三家的结果并排着看。
// 哪一家哪一步走不下去：记下原因、把那个会话收拾干净，接着做下一家、下一步，不让一处不通挡住后面的。
// 各家各步该是什么在 probe-engines-judge.mts；起这一遍的是 scripts/check-engines.mjs。
import type { BrowserWindow } from 'electron'
import { installDiffKit } from './probe-diff-kit.mjs'
import {
  type DeviceSeen,
  type EnginesPlace,
  enginesDevice,
  enginesStart,
} from './probe-engines.mjs'
import { enginesActs, enginesCompact, enginesEdit, enginesFork } from './probe-engines-acts.mjs'
import { enginesApproval, enginesQuestion, enginesSettle } from './probe-engines-asks.mjs'
import { judgeEngines } from './probe-engines-judge.mjs'
import { type EnginesKit, installEnginesKit } from './probe-engines-kit.mjs'
import {
  enginesInterrupt,
  enginesOpen,
  enginesOutline,
  enginesSkill,
} from './probe-engines-more.mjs'
import { enginesImage, enginesPlan, enginesWrite } from './probe-engines-rest.mjs'
import { type EnginesSeen, SPECS, WORDS } from './probe-engines-spec.mjs'
import { installFilesKit } from './probe-files-kit.mjs'
import type { SmokeHooks } from './smoke.mjs'

/** 一遍最多跑这么久。到点不死等：把走到哪一步、页面当时的样子报出来 */
const DEADLINE_MS = 900_000

/** 走到哪一步了。只记在内存里，跑不完的时候才报出去 */
const steps: string[] = []
const started = Date.now()
const step = (name: string) => {
  steps.push(`${((Date.now() - started) / 1000).toFixed(1)}s ${name}`)
}

async function inPage<T, A extends unknown[]>(
  window: BrowserWindow,
  probe: (...args: A) => Promise<T> | T,
  ...args: A
): Promise<T> {
  step(probe.name)
  const list = args.map((arg) => JSON.stringify(arg)).join(', ')
  return (await window.webContents.executeJavaScript(`(${probe.toString()})(${list})`, true)) as T
}

const installKits = async (window: BrowserWindow) => {
  await inPage(window, installFilesKit)
  await inPage(window, installDiffKit)
  await inPage(window, installEnginesKit)
}

/** 两份骨架头一处不一样的地方。一样是 null */
function firstDifference(was: string[][], now: string[][]): object | null {
  for (let turn = 0; turn < Math.max(was.length, now.length); turn++) {
    const [a, b] = [was[turn] ?? [], now[turn] ?? []]
    for (let line = 0; line < Math.max(a.length, b.length); line++) {
      if (a[line] !== b[line]) {
        return {
          turn: turn + 1,
          turns: [was.length, now.length],
          was: a[line] ?? '（没有这一条）',
          now: b[line] ?? '（没有这一条）',
        }
      }
    }
  }
  return null
}

async function run(window: BrowserWindow, hooks: SmokeHooks): Promise<readonly [object, string[]]> {
  const fixture = JSON.parse(process.env.LITCH_SMOKE_ENGINES ?? '{}') as {
    ids: string[]
    cwd: string
    skill: { name: string; mark: string }
  }
  const ids = fixture.ids
  // 排查时只走其中几步（scripts/check-engines.mjs --steps）：建项目和建会话那两步照走，别的没点到的跳过
  const picked = (process.env.LITCH_SMOKE_STEPS ?? '').split(',').filter(Boolean)
  const wanted = (name: string) => picked.length === 0 || name === 'start' || picked.includes(name)
  const place: EnginesPlace = { cwd: fixture.cwd, workspace: WORDS.workspace, skill: fixture.skill }
  const seen: EnginesSeen = { ids, place, device: null, steps: {} }
  /** 会话没建成的那几家：后面的步骤都做不了，不一遍遍去等 */
  const dead = new Map<string, string>()
  const line = (name: string, row: object) => {
    console.log(`LITCH_ENGINES ${JSON.stringify({ step: name, ...row })}`)
  }
  /**
   * 一步：三家挨个做。open：先点开那一家的会话；给的是函数的时候，要的是对话里有它返回的那句话的那一个
   * （分叉之后同一个标题有两行）
   */
  const each = async (
    name: string,
    probe: (id: string) => Promise<unknown>,
    only: (id: string) => boolean = () => true,
    open: boolean | ((id: string) => string) = true,
  ) => {
    if (!wanted(name)) return
    const row: Record<string, unknown> = {}
    for (const id of ids.filter(only)) {
      const stuck = dead.get(id)
      if (stuck) {
        row[id] = { error: `前面没走通，这一步做不了：${stuck}` }
        continue
      }
      try {
        if (open) {
          const has = typeof open === 'function' ? open(id) : undefined
          await inPage(window, enginesOpen, SPECS[id]?.opening ?? id, has)
        }
        row[id] = await probe(id)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const settled = await inPage(window, enginesSettle).catch((failure: unknown) => [
          `收拾不了：${String(failure)}`,
        ])
        row[id] = { error: reason, settled }
        if (name === 'start') dead.set(id, reason.slice(0, 200))
      }
    }
    seen.steps[name] = row
    line(name, row)
  }

  await installKits(window)
  // ---- 一、设备和三个 harness；给三家共用的工作目录建一个项目 ----
  seen.device = (await inPage(window, enginesDevice, place, ids)) as DeviceSeen
  line('device', seen.device)
  // ---- 二、各建一个会话、发头一句 ----
  await each(
    'start',
    (id) => inPage(window, enginesStart, { id, opening: SPECS[id]?.opening ?? id }, place),
    undefined,
    false,
  )
  // ---- 三、审批：批准一次、拒绝一次 ----
  await each('approve', (id) =>
    inPage(window, enginesApproval, WORDS.approve, WORDS.accept, SPECS[id]?.asking ?? ''),
  )
  await each('decline', () => inPage(window, enginesApproval, WORDS.refuse, WORDS.decline, ''))
  // ---- 四、提问：一次两道题；会一张卡片问几道的再来一次只问一道的 ----
  await each('question', () => inPage(window, enginesQuestion, WORDS.ask, 0, WORDS.typed))
  await each(
    'questionOne',
    () => inPage(window, enginesQuestion, WORDS.askOne, 1, WORDS.typed),
    (id) => SPECS[id]?.single === true,
  )
  // ---- 五、技能 ----
  await each('skill', () => inPage(window, enginesSkill, place.skill.name, WORDS.skill))
  // ---- 六、打断 ----
  await each('interrupt', () => inPage(window, enginesInterrupt, WORDS.slow, WORDS.afterStop))
  // ---- 八、计划模式：先留在计划模式里，再来一次选执行 ----
  await each('planStay', (id) => inPage(window, enginesPlan, WORDS.plan, SPECS[id]?.planStay ?? ''))
  await each(
    'planGo',
    (id) => inPage(window, enginesPlan, WORDS.plan, SPECS[id]?.planGo ?? ''),
    (id) => Boolean(SPECS[id]?.planGo),
  )
  // ---- 九、写文件：对话里“改了文件”那一条，侧面板的差异标签 ----
  await each('write', (id) =>
    inPage(window, enginesWrite, WORDS.write, WORDS.accept, `agent-written.${id}.txt`),
  )
  // ---- 十（上）、带图片发一条 ----
  await each('image', () => inPage(window, enginesImage, WORDS.image))

  // ---- 七、读历史：换到别的会话再换回来；核心重启（窗口重新加载，和应用重开差不多）之后再读 ----
  const before: Record<string, string[][]> = {}
  await each('historySwitch', async (id) => {
    const was = await inPage(window, enginesOutline)
    before[id] = was
    const other = ids.find((entry) => entry !== id && !dead.has(entry))
    if (other) await inPage(window, enginesOpen, SPECS[other]?.opening ?? other)
    await inPage(window, enginesOpen, SPECS[id]?.opening ?? id)
    const now = await inPage(window, enginesOutline)
    return { turns: was.length, lines: was.flat().length, differs: firstDifference(was, now) }
  })
  if (wanted('historyRestart')) {
    const reloaded = new Promise<void>((done) => {
      window.webContents.once('did-finish-load', () => done())
    })
    step('重启核心')
    hooks.restartCore()
    await reloaded
    await installKits(window)
  }
  await each('historyRestart', async (id) => {
    const was = before[id]
    if (!was) throw new Error('重启之前没读到这个会话的骨架')
    const now = await inPage(window, enginesOutline)
    return { turns: now.length, lines: now.flat().length, differs: firstDifference(was, now) }
  })

  // ---- 十（下）、分叉、编辑重发、压缩：声明了会的才有入口 ----
  await each('acts', () => inPage(window, enginesActs, WORDS.earlier, WORDS.later))
  const offered = (id: string, what: string) =>
    (seen.steps.acts?.[id] as Record<string, unknown> | undefined)?.[what] === '有'
  await each(
    'fork',
    () => inPage(window, enginesFork, WORDS.earlier, WORDS.later, WORDS.aside),
    (id) => offered(id, 'fork'),
  )
  await each(
    'edit',
    () => inPage(window, enginesEdit, WORDS.later, WORDS.again),
    (id) => offered(id, 'edit'),
    () => WORDS.later,
  )
  const went = (name: string, id: string) => {
    const result = seen.steps[name]?.[id] as { error?: string } | undefined
    return result !== undefined && !result.error
  }
  await each(
    'compact',
    () => inPage(window, enginesCompact, WORDS.afterCompact),
    (id) => offered(id, 'compact'),
    // 原来的那个会话：编辑成了的话里面是改过的那一句，没成（没试）的话后发的那一句还在
    (id) => (went('edit', id) ? WORDS.again : WORDS.later),
  )
  const { failed, known, table } = judgeEngines(seen)
  return [{ ids, picked, table, known, device: seen.device, steps: seen.steps }, failed]
}

/** 到点还没跑完：走到哪一步、页面当时什么样（页面答得上来的话） */
async function overdue(window: BrowserWindow): Promise<string> {
  const page = await Promise.race([
    window.webContents
      .executeJavaScript(
        `(${(() => (window as unknown as { __enginesKit?: EnginesKit }).__enginesKit?.where() ?? '页面里还没装上验收的工具').toString()})()`,
        true,
      )
      .catch((error: unknown) => `页面问不到：${String(error)}`),
    new Promise<string>((done) => setTimeout(() => done('页面三秒没有应答'), 3000)),
  ])
  return `验收跑了 ${DEADLINE_MS / 1000} 秒还没完。走过的步骤：${steps.slice(-12).join(' → ')}。页面：${String(page)}`
}

export async function runEnginesChecks(
  window: BrowserWindow,
  hooks: SmokeHooks,
): Promise<readonly [object, string[]]> {
  let stop: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<readonly [object, string[]]>((done) => {
    stop = setTimeout(() => {
      void overdue(window).then((what) => done([{ steps }, [what]]))
    }, DEADLINE_MS)
  })
  try {
    return await Promise.race([
      run(window, hooks).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message}（走过的步骤：${steps.slice(-12).join(' → ')}）`)
      }),
      late,
    ])
  } finally {
    clearTimeout(stop)
  }
}
