// 三个引擎各走一遍的验收：计划模式、写文件、图片、读历史、分叉、编辑重发、压缩这几步各家该是什么。
// 怎么判、三种判定各是什么意思见 probe-engines-judge.mts。
import type { ActsOffered, CompactSeen, EditSeen, ForkSeen } from './probe-engines-acts.mjs'
import { headLooks } from './probe-engines-judge-talk.mjs'
import type { ImageSeen, PlanSeen, WriteSeen } from './probe-engines-rest.mjs'
import { type StepJudge, WORDS } from './probe-engines-spec.mjs'

/** 假模型交的那份计划里的记号（scripts/client-fixture-plan.mjs） */
const PLAN_MARK = 'LITCH-PLAN-4827'
/** 假模型写进文件的那一行（scripts/client-fixture-marks.mjs） */
const WRITTEN = 'written by the fixture agent'
/** Claude Code 的假模型在交计划的工具有了结果之后说的话：确认了的、没确认的（scripts/client-fixture-anthropic.mjs） */
const PLAN_DONE = '计划写好了，在上面。'
const PLAN_HELD = '好，先不动手。'

/** go：选的是去执行的那一项；不是就是留在计划模式里的那一项 */
const plan =
  (go: boolean): StepJudge =>
  (id, spec, raw, v) => {
    const seen = raw as PlanSeen
    if (!spec.planGo) {
      // dsh 的入口没有声明计划模式：底栏上不出那个开关
      v.check(!seen.offered, '没有声明会计划模式，底栏上却有那个开关')
      return v.cell('没有（没声明计划模式）')
    }
    v.check(seen.offered && seen.on, '计划模式的开关点不开')
    v.check(seen.plan.includes(PLAN_MARK), `对话里没有计划那一块：${seen.turn.join('｜')}`)
    v.check(seen.foot === '完成', `回合的结尾是“${seen.foot}”`)
    // 计划写好之后 Claude Code 和 Pi 都是自己来问（一张提问卡片），这时客户端不另外问，回合结束之后也不再问
    if (!seen.card) return v.fail('计划写好了，harness 没有来问要不要执行')
    v.check(!seen.both, 'harness 自己在问的时候，客户端也问了一遍')
    v.check(seen.clientAsk === null, 'harness 问过了，回合结束之后客户端又问了一遍')
    v.check(
      seen.card.options.includes(spec.planStay) && seen.card.options.includes(spec.planGo),
      `那张卡片上的选项是 ${seen.card.options.join('、')}`,
    )
    headLooks(seen.card.head, seen.card.body[0] ?? '', v)
    // 交一次计划，对话里该只有一条工具调用（Claude Code 入口此前多报一条通用的，留在计划模式里时还写着“失败”）
    const calls = seen.turn.filter((line) => line.includes('ExitPlanMode'))
    v.check(
      calls.length <= 1,
      `同一次交计划在对话里是 ${calls.length} 条工具调用：${calls.join('、')}`,
    )
    if (go) {
      v.check(!seen.onAfter, '选了执行，底栏的计划开关没有跟着关')
      // Claude Code：工具的结果是“确认了”，假模型说一句就结束。Pi：插件就地实施，往模型那里发了一句话
      const said = id === 'claude-code' ? PLAN_DONE : 'pi 收到：Implement the plan.'
      v.check(seen.answer.startsWith(said), `选了执行之后的回答是“${seen.answer.slice(0, 60)}”`)
      v.check(!seen.plan.includes(PLAN_DONE), '计划那一块里混进了后面那句回答')
      return
    }
    v.check(seen.onAfter, '选了留在计划模式里，底栏的开关却关了')
    if (id === 'pi') {
      // Pi 的插件收下“留在计划模式”，回合直接结束，没有再去问模型
      return v.check(
        seen.answer === '',
        `留在计划模式里之后多了一段回答：“${seen.answer.slice(0, 60)}”`,
      )
    }
    // Claude Code：工具的结果是“还没确认”，假模型接着说一句，那该是计划下面单独的一段回答，不并进计划那一块
    if (seen.answer === PLAN_HELD && !seen.plan.includes(PLAN_HELD)) return
    v.fail(`留在计划模式里之后：计划那一块是“${seen.plan.slice(-40)}”，回答是“${seen.answer}”`)
  }

const write: StepJudge = (id, _spec, raw, v) => {
  const seen = raw as WriteSeen
  const file = `agent-written.${id}.txt`
  // 写之前问不问：Claude Code 的“项目内”档动手之前先问；Pi 的审批开着；dsh 的“项目内”档在项目里写文件不问
  if (id === 'dsh') v.check(seen.card === null, 'dsh 在“项目内”档上写项目里的文件，却来问了')
  else {
    v.check(
      seen.card?.head === '需要批准：修改文件',
      `写文件之前${seen.card ? `来的卡片是“${seen.card.head}”` : '没有来问'}`,
    )
    // 卡片上不写是哪个文件：要看对话里那一条，它这时已经在了、带着文件名和加减行数
    v.check(
      seen.pending.includes(file),
      `卡片等着的时候，对话里看不到要写的是哪个文件（${seen.pending}）`,
    )
  }
  v.check(seen.foot === '完成', `回合的结尾是“${seen.foot}”`)
  v.check(
    seen.turn.includes(`新建 ${file}｜+1 −0`),
    `对话里没有“改了文件”那一条：${seen.turn.join('｜')}`,
  )
  // 文件那一行上的路径是 harness 给的：有的给相对工作目录的，有的给完整的（Claude Code 的工具用完整路径）
  v.check(
    seen.files.length === 1 && seen.files[0]?.includes(file),
    `那一条点开，里面的文件是 ${seen.files.join('、') || '空的'}`,
  )
  v.check(seen.shown.includes(WRITTEN), '那一条点开，差异里没有写进去的那一行')
  if (!seen.diff) return v.fail('那一条上没有“在差异里看”的入口')
  v.check(seen.diff.opened, '点了“在差异里看”，侧面板的差异标签没有开')
  v.check(seen.diff.listed, '差异标签里没有列出这个文件')
  v.check(seen.diff.picked, '差异标签开了，选中的不是这个文件')
  // 夹具给界面的工作目录是 /tmp/… 的写法，Claude Code 给的文件路径是 /private/tmp/…：两种写法要认成一处
  v.check(
    seen.diff.missed === '',
    `点了“在差异里看”，却说“${seen.diff.missed}”（工作目录和文件路径的写法对不上？）`,
  )
  v.check(seen.diff.body.includes(WRITTEN), `差异标签里这个文件的内容是“${seen.diff.body}”`)
}

const image: StepJudge = (id, _spec, raw, v) => {
  const seen = raw as ImageSeen
  v.check(seen.attached, `图片没有贴进输入区（${seen.hint}）`)
  if (!seen.attached) return
  v.check(seen.foot === '完成', `带图的那个回合的结尾是“${seen.foot}”`)
  // 图真的到了模型手里：假模型数得出来
  v.check(
    seen.answer.startsWith(`${id} 收到：${WORDS.image}（图 1 张）`),
    `带图发出去，回答是“${seen.answer.slice(0, 80)}”`,
  )
  v.check(seen.pictured, '发出去的那条消息的气泡里没有缩略图')
}

/** 读回来的和之前的一模一样：没有丢、没有重复、状态没变 */
const history =
  (how: string): StepJudge =>
  (_id, _spec, raw, v) => {
    const seen = raw as { turns: number; lines: number; differs: object | null }
    v.check(seen.turns > 0, '读回来是空的')
    v.check(seen.differs === null, `${how}，内容和之前不一样：${JSON.stringify(seen.differs)}`)
    v.cell(`过（${seen.turns} 个回合、${seen.lines} 条）`)
  }

const acts: StepJudge = (id, _spec, raw, v) => {
  const seen = raw as ActsOffered
  v.check(
    seen.answers.length === 2 && seen.answers.every((answer) => answer.startsWith(`${id} 收到：`)),
    `先发的那两句的回答是 ${seen.answers.map((answer) => answer.slice(0, 30)).join('｜')}`,
  )
  // 分叉、编辑、压缩：Claude Code 和 Pi 的入口声明了会；dsh 的入口声明了不会，这三个入口都不出
  const able = id !== 'dsh'
  for (const [name, state] of [
    ['分叉', seen.fork],
    ['编辑', seen.edit],
    ['压缩上下文', seen.compact],
  ] as const) {
    v.check((state === '有') === able, `“${name}”的入口：${state}`)
  }
  if (!able) v.cell('没有（声明了不会分叉、回退、压缩）')
}

const fork: StepJudge = (id, spec, raw, v) => {
  const seen = raw as ForkSeen
  // 从先发的那一句分叉：新会话里到那一个回合为止，后发的那一句不在
  v.check(
    seen.turns === seen.turnsBefore - 1,
    `新会话里有 ${seen.turns} 个回合，原来的有 ${seen.turnsBefore} 个`,
  )
  v.check(seen.hasEarlier && !seen.hasLater, '新会话里该有先发的那一句、没有后发的那一句')
  v.check(seen.told.includes('分叉'), `分叉之后的提示是“${seen.told}”`)
  v.check(seen.rowHarness === spec.name, `新会话那一行的徽标是“${seen.rowHarness}”`)
  v.check(seen.next.foot === '完成', `在新会话里再发一句，回合的结尾是“${seen.next.foot}”`)
  v.check(
    seen.next.answer.startsWith(`${id} 收到：${WORDS.aside}`),
    `在新会话里再发一句，回答是“${seen.next.answer.slice(0, 60)}”`,
  )
  v.check(seen.sourceKept, '回到原来的会话，内容变了（少了回合，或者多了新会话里说的那句）')
}

const edit: StepJudge = (id, _spec, raw, v) => {
  const seen = raw as EditSeen
  v.check(seen.original === WORDS.later, `编辑框里原来是“${seen.original.slice(0, 40)}”`)
  v.check(seen.note.includes('无法恢复'), `编辑框下面的说明是“${seen.note.slice(0, 40)}”`)
  v.check(
    seen.replaced && seen.turns === seen.turnsBefore,
    `改过的那句没有替掉后发的那一句（${seen.turns}/${seen.turnsBefore} 个回合；${seen.told}）`,
  )
  v.check(seen.next.foot === '完成', `改过的那句开的回合，结尾是“${seen.next.foot}”`)
  v.check(
    seen.next.answer.startsWith(`${id} 收到：${WORDS.again}`),
    `改过的那句的回答是“${seen.next.answer.slice(0, 60)}”`,
  )
}

/** 界面在说不出具体原因时自己用的几句话（packages/ui 的 error.*、ability.unsupported） */
const GENERIC_REASONS = ['发生错误', '设备未连接', '设备响应超时', '已取消', '不支持该操作']

const compact: StepJudge = (id, _spec, raw, v) => {
  const seen = raw as CompactSeen
  v.check(
    seen.next.foot === '完成' && seen.next.answer.startsWith(`${id} 收到：${WORDS.afterCompact}`),
    `压缩之后再发一句：“${seen.next.foot}”“${seen.next.answer.slice(0, 60)}”`,
  )
  // Pi 自己不肯压缩太小的会话（夹具里的会话只有几百个词元）：不开回合，请求的错误是它的原话，
  // 界面出一条“压缩失败：原因”的提示。原因是对面说的，这里不写死它，只要求有、而且不是界面的套话。
  // 压缩本身在夹具里量不到
  const refused = /压缩失败：([^｜]*)/.exec(seen.told)
  if (id === 'pi' && refused) {
    const reason = (refused[1] ?? '').trim()
    v.check(!seen.ran, `Pi 没压，对话里却多出了一个回合：${seen.turn.join('｜')}`)
    v.check(
      reason !== '' && !GENERIC_REASONS.some((phrase) => reason.includes(phrase)),
      `没压的提示里没有 Pi 给的原因：“${refused[0]}”`,
    )
    v.note(`夹具里的会话太小，Pi 不压，提示是“${refused[0]}”：压缩本身量不到`)
    return v.cell('量不到（会话太小，Pi 不压）')
  }
  v.check(seen.ran, `点了“压缩上下文”，对话里没有多出一个回合（${seen.told}）`)
  v.check(seen.foot === '完成', `压缩的那个回合的结尾是“${seen.foot}”`)
  v.check(
    seen.turn.some((line) => line.startsWith('上下文已压缩')),
    `压缩的那个回合里没有“上下文已压缩”那一条：${seen.turn.join('｜')}`,
  )
  // 压缩的回合里只该有“上下文已压缩”那一条，而且不用点开就看得到（Claude Code 入口此前多发一条空的回答，
  // 界面上多出一块空的，“上下文已压缩”那一条被收进“活动 1 步”里）
  v.check(
    !seen.turn.includes('回答：') && !seen.folded,
    `压缩的那个回合是：${seen.turn.join('｜')}${seen.folded ? '（过程收着）' : ''}`,
  )
}

export const WORK: Record<string, StepJudge> = {
  planStay: plan(false),
  planGo: plan(true),
  write,
  image,
  historySwitch: history('换到别的会话再换回来'),
  historyRestart: history('核心重启、窗口重新加载之后'),
  acts,
  fork,
  edit,
  compact,
}
