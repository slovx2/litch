// 三个引擎各走一遍的验收：建会话、审批、提问、技能、打断这几步各家该是什么。
// 怎么判、三种判定各是什么意思见 probe-engines-judge.mts。
import type { StartSeen } from './probe-engines.mjs'
import type { ApprovalSeen, QuestionSeen } from './probe-engines-asks.mjs'
import type { InterruptSeen, SkillSeen } from './probe-engines-more.mjs'
import { type StepJudge, type Verdict, WORDS } from './probe-engines-spec.mjs'

/** 假模型跑的那条命令和它真的跑了才有的输出（scripts/client-fixture-run.mjs）：42 是算出来的，命令的字里没有 */
const RUN_COMMAND = 'echo fixture-ran-$((6*7)) | tee fixture-ran.txt'
const RAN = 'fixture-ran-42'
/** 没有题目标签时卡片标题栏上的字 */
const QUESTION_HEAD = '有问题要你回答'
/** 假模型问的两道题里各选项（scripts/client-fixture-ask.mjs、client-fixture-anthropic.mjs） */
const FIRST_OPTIONS = ['只改客户端', '只改适配器', '两边一起改']

const PRESETS = [':read-only', ':workspace', ':danger-full-access']

const start: StepJudge = (id, spec, raw, v, place) => {
  const seen = raw as StartSeen
  const ids = (seen.harness?.options ?? []).map((option) => option.id)
  v.check(
    seen.harness?.current === spec.name,
    `新建页上选 harness 的选择器选着“${seen.harness?.current}”`,
  )
  v.check(ids.includes(id), `选 harness 的选择器里没有它（有：${ids.join('、')}）`)
  v.check(seen.crumbHarness === spec.name, `新建页标题栏上的徽标是“${seen.crumbHarness}”`)
  v.check(
    seen.device === '本机' && seen.workspace === place.workspace,
    '新建页上选着的不是那个项目',
  )
  // 模型和强度：清单是 harness 自己报的，这里只看画出来了、选着的是清单里的一个
  for (const [name, picker] of [
    ['模型', seen.model],
    ['强度', seen.effort],
  ] as const) {
    const titles = (picker?.options ?? []).map((option) => option.title)
    v.check(titles.length > 0, `新建页上没有${name}的选择器，或者里面是空的`)
    v.check(titles.includes(picker?.current ?? ''), `${name}选着的“${picker?.current}”不在清单里`)
  }
  // 权限：Claude Code 和 dsh 声明了三档；Pi 只有一档（没有沙箱），问不问是设备上的一项设置
  const presets = (seen.permission?.options ?? []).map((option) => option.id)
  const wanted = id === 'pi' ? [':danger-full-access'] : PRESETS
  v.check(
    presets.join() === wanted.join(),
    `权限的选择器里是 ${presets.join('、') || '空的'}，该是 ${wanted.join('、')}`,
  )
  // 计划模式的开关：Claude Code 和 Pi 会，dsh 没有声明
  v.check(seen.plan === Boolean(spec.planGo), `计划模式的开关${seen.plan ? '在' : '不在'}`)
  v.check(seen.bubbled, '头一句发出去，气泡没有当场出现')
  v.check(seen.landed, '头一句发出去，没有落到新会话里')
  // 流式：回答显示成过好几种样子，而且每一种都是最后那段文字开头的一截（没有闪回、没有重排）
  v.check(seen.shapes >= 3, `回答只显示成过 ${seen.shapes} 种样子，不像是一段一段出来的`)
  v.check(seen.stray.length === 0, `回答中途出现过不是最终文字开头的样子：${seen.stray.join('｜')}`)
  v.check(seen.foot === '完成', `头一个回合的结尾是“${seen.foot}”`)
  v.check(
    seen.answer.startsWith(`${id} 收到：${spec.opening}`),
    `头一句的回答是“${seen.answer.slice(0, 60)}”`,
  )
  v.check(seen.rowTitle === spec.opening, `侧栏里这一行的标题是“${seen.rowTitle}”`)
  v.check(seen.crumb === spec.opening, `标题栏上的标题是“${seen.crumb}”`)
  v.check(seen.rowHarness === spec.name, `侧栏里这一行的徽标是“${seen.rowHarness}”`)
  v.check(seen.rowWorkspace === place.workspace, `这一行落在了“${seen.rowWorkspace || '项目外面'}”`)
  // 建好之后底栏：权限选着的是它默认的那一档
  const preset = id === 'pi' ? '完全访问' : '项目内'
  v.check(
    seen.permissionAfter === preset,
    `建好之后权限选着“${seen.permissionAfter}”，该是“${preset}”`,
  )
  // 模型：建好之后选着的该是清单里的一个，强度也选着（dsh 入口此前建会话的应答里模型是空的）
  const models = (seen.model?.options ?? []).map((option) => option.title)
  v.check(models.includes(seen.modelAfter), `建好之后模型选着“${seen.modelAfter}”，不在清单里`)
  v.check(seen.effortAfter !== '', '建好之后强度的选择器没有了')
}

/** 审批卡片上三家都该有的东西 */
const cardLooks = (id: string, seen: ApprovalSeen, v: Verdict, cwd: string) => {
  const card = seen.card
  if (!card) return v.fail(`跑命令没有来问（权限选着“${seen.permission}”）`)
  v.check(card.head === '要你批准：运行一条命令', `卡片的标题是“${card.head}”`)
  v.check(card.body[0] === RUN_COMMAND, `卡片上的命令是“${card.body[0]}”`)
  v.check(card.focused, '卡片出来时焦点不在卡片上')
  v.check(seen.pending === '待审批', `卡片等着的时候，对话里那条命令右边写的是“${seen.pending}”`)
  v.check(seen.flagged, '卡片等着的时候，侧栏这一行上没有“等你”的记号')
  for (const label of [WORDS.accept, WORDS.decline]) {
    v.check(card.buttons.includes(label), `卡片上没有“${label}”（有：${card.buttons.join('、')}）`)
  }
  // 拒绝时附一句说明：Claude Code 和 Pi 声明了会收，dsh 没有
  const noted = card.buttons.includes('拒绝并说明')
  v.check(noted === (id !== 'dsh'), `卡片上${noted ? '有' : '没有'}“拒绝并说明”`)
  // 在哪个目录里跑（Claude Code 入口此前审批请求里的目录是空的，卡片上就没有这一行）
  v.check(
    card.body.includes(`目录 ${cwd}`),
    `卡片上没有写在哪个目录里跑（${card.body.join('｜')}）`,
  )
  // dsh 只在模型申请放宽沙箱时来问，卡片上要看得到申请的是什么
  if (id === 'dsh') {
    v.check(
      card.body.some((line) => line.includes('danger-full-access')),
      '卡片上没有写它申请的是什么权限',
    )
  }
}

const approve: StepJudge = (id, _spec, raw, v, place) => {
  const seen = raw as ApprovalSeen
  cardLooks(id, seen, v, place.cwd)
  v.check(seen.foot === '完成', `回合的结尾是“${seen.foot}”`)
  // 命令真的跑了：模型拿到的结果里有算出来的那个数，对话里那一条是“通过”，点开有输出
  v.check(
    seen.answer.includes(RAN),
    `批准之后模型拿到的结果里没有命令的输出：“${seen.answer.slice(0, 80)}”`,
  )
  v.check(
    seen.turn.some((line) => line === `运行 ${RUN_COMMAND}｜通过`),
    `对话里没有“通过”的那条命令：${seen.turn.join('｜')}`,
  )
  v.check(seen.output.includes(RAN), `那条命令点开，里面的输出是“${seen.output.slice(0, 60)}”`)
}

const decline: StepJudge = (id, _spec, raw, v, place) => {
  const seen = raw as ApprovalSeen
  cardLooks(id, seen, v, place.cwd)
  v.check(seen.foot === '完成', `回合的结尾是“${seen.foot}”`)
  // 命令没跑：哪里都没有那个算出来的数；模型收到了拒绝（它把工具的结果原样带了回来）
  v.check(!seen.answer.includes(RAN) && !seen.output.includes(RAN), '拒绝了，命令却跑了')
  v.check(
    /denied|rejected/i.test(seen.answer),
    `模型收到的不像是一次拒绝：“${seen.answer.slice(0, 100)}”`,
  )
  // 对话里那一条该写“已拒绝”（Claude Code 入口此前报成了失败、退出码 1）
  const line = seen.turn.find((entry) => entry.startsWith(`运行 ${RUN_COMMAND}｜`)) ?? ''
  v.check(line.endsWith('｜已拒绝'), `被拒绝的那条命令在对话里是“${line || seen.turn.join('｜')}”`)
  // 三家一个样子：灰色的“已拒绝”，不带耗时（dsh 入口此前带着退出码 1 和等审批的那段时长，显示成红色的“22 秒 已拒绝”）
  v.check(
    seen.meta.join('｜') === '已拒绝' && !seen.red,
    `被拒绝的那条命令右边是“${seen.meta.join('｜')}”${seen.red ? '（标红）' : ''}`,
  )
}

/** 题目的标签（卡片标题栏上那几个字）。没有标签时该是通用的那一句，不能是截下来的半截题目 */
export const headLooks = (head: string, question: string, v: Verdict) => {
  if (head === QUESTION_HEAD || !question.startsWith(head)) return
  v.fail(`提问卡片的标题栏是题目的前几个字：“${head}”`)
}

const question: StepJudge = (id, _spec, raw, v) => {
  const seen = raw as QuestionSeen
  v.check(seen.foot === '完成', `回合的结尾是“${seen.foot}”`)
  if (id === 'dsh') {
    // dsh 自己有提问的工具（ask_user_question），假模型调的就是它；入口把它转成提问卡片
    //（此前没接上，模型一调用就失败、界面上不来卡片）。答了的都该到模型手里
    if (seen.asked.length === 0) {
      return v.fail(`没来提问卡片，模型拿到的是“${seen.answer.slice(0, 100)}”`)
    }
    for (const each of seen.asked) {
      v.check(seen.answer.includes(each.replied), `模型收到的回答里没有“${each.replied}”`)
    }
    return
  }
  const [first, second] = seen.asked
  v.check(seen.asked.length === 2, `要答的题有 ${seen.asked.length} 道，该是两道`)
  if (!first || !second) return
  // Claude Code 的提问工具一次问两道：一张卡片、两页。Pi 的扩展一问一问发：先后两张卡片
  const steps = id === 'claude-code' ? 2 : 1
  v.check(
    first.steps === steps && second.steps === steps,
    `卡片上是 ${first.steps}、${second.steps} 道题`,
  )
  v.check(first.focused && second.focused, '提问卡片出来（翻到下一题）时焦点不在卡片上')
  v.check(first.body[0] === '这次先动哪一块？', `头一道题是“${first.body[0]}”`)
  v.check(
    FIRST_OPTIONS.every((option) => first.options.includes(option)),
    `头一道题的选项是 ${first.options.join('、')}`,
  )
  v.check(second.body[0] === '有什么要特别留意的？', `第二道题是“${second.body[0]}”`)
  // Pi 的第二问没有选项，自己填；Claude Code 的提问工具每道题都得有选项
  v.check(
    (second.options.length === 0) === (id === 'pi'),
    `第二道题的选项是 ${second.options.join('、') || '没有'}`,
  )
  for (const each of seen.asked)
    headLooks(each.head.replace(/第 \d+ 题，共 \d+ 题$/, ''), each.body[0] ?? '', v)
  for (const each of seen.asked) {
    v.check(
      seen.answer.includes(each.replied),
      `模型收到的回答里没有“${each.replied}”：${seen.answer.slice(0, 120)}`,
    )
  }
}

const questionOne: StepJudge = (_id, _spec, raw, v) => {
  const seen = raw as QuestionSeen
  const [only] = seen.asked
  v.check(seen.foot === '完成', `回合的结尾是“${seen.foot}”`)
  v.check(
    seen.asked.length === 1 && only?.steps === 1,
    `只问一道的时候来了 ${seen.asked.length} 道`,
  )
  // 一道题的卡片上没有题号那一排，也没有“上一题”“下一题”
  v.check(
    only?.buttons.join() === '提交,跳过',
    `一道题的卡片上的按钮是 ${only?.buttons.join('、')}`,
  )
  v.check(
    only && seen.answer.includes(only.replied),
    `模型收到的回答里没有选的那一项：${seen.answer.slice(0, 120)}`,
  )
}

const skill: StepJudge = (id, spec, raw, v, place) => {
  const seen = raw as SkillSeen
  const name = `/${place.skill.name}`
  // 三家找项目技能的位置不一样（.claude/skills、.pi/skills、.dsh/skills），夹具各放了一份
  v.check(
    seen.skills.includes(name),
    `单子上没有列出项目里的技能（列了：${seen.skills.join('、') || seen.note}）`,
  )
  // 内置的命令跟着声明走：dsh 不会计划模式、不会压缩
  for (const command of ['/plan', '/compact']) {
    v.check(
      seen.commands.includes(command) === (id !== 'dsh'),
      `单子上${seen.commands.includes(command) ? '有' : '没有'} ${command}`,
    )
  }
  if (!seen.skills.includes(name)) return
  v.check(seen.chip === name, `选了技能之后输入区里那一片上写的是“${seen.chip}”`)
  v.check(seen.foot === '完成', `回合的结尾是“${seen.foot}”`)
  // 技能的正文真的到了模型手里：记号只在正文里有
  v.check(
    seen.answer.includes(place.skill.mark),
    `模型没有收到技能的正文：“${seen.answer.slice(0, 100)}”`,
  )
  v.check(seen.rowTitle === spec.opening, `带着技能发了一句之后，侧栏的标题成了“${seen.rowTitle}”`)
  // 发出去的那条消息：气泡里是说的那句话，技能是带着的一片（dsh、Pi 入口此前把技能写成了字或展开的正文）
  if (seen.bubble === WORDS.skill && seen.carried.includes(place.skill.name)) return
  v.fail(
    `带着技能的那条消息在对话里是“${seen.bubble.slice(0, 80)}”，带着 ${seen.carried.join('、') || '没有东西'}`,
  )
}

const interrupt: StepJudge = (id, _spec, raw, v) => {
  const seen = raw as InterruptSeen
  v.check(seen.stopShown, '回答在流的时候发送按钮没有换成停止')
  v.check(seen.stopMs !== null, '点了停止，二十秒回合还没停')
  v.check(seen.foot === '已中断', `被打断的回合的结尾是“${seen.foot}”`)
  // 打断不是出错：被打断的回合里不出出错框（Claude Code 入口此前给这种回合带了一句 interrupted 当错误，
  // 界面照着画了一个红框；界面现在也照官方桌面端，只给失败的回合画回合级的出错框）
  v.check(seen.errorBox === '', `被打断的回合里出了出错框：“${seen.errorBox}”`)
  // 停在了半道上（一共六十段），停下之后不再长
  v.check(
    seen.endedAt < 30,
    `点停止时在第 ${seen.stoppedAt} 段，回答却一直流到了第 ${seen.endedAt} 段`,
  )
  // 照上游，打断之后这一回合不再出字：点停止之后多出来的只有路上的那一点（假模型一段 150 毫秒，
  // 界面放字追平要四分之一秒，三家实测多出 0 到 1 段）。真实窗口验收报过 Claude Code 多出十几段
  v.check(
    seen.endedAt - seen.stoppedAt <= 5,
    `点停止时在第 ${seen.stoppedAt} 段，停下时到了第 ${seen.endedAt} 段`,
  )
  v.check(seen.still, '回合停下之后回答还在长')
  v.check(seen.ready, '回合停下之后输入框没有回到能发的样子')
  v.check(seen.next.foot === '完成', `打断之后再发一句，回合的结尾是“${seen.next.foot}”`)
  v.check(
    seen.next.answer.startsWith(`${id} 收到：${WORDS.afterStop}`),
    `打断之后再发一句，回答是“${seen.next.answer.slice(0, 80)}”`,
  )
}

export const TALK: Record<string, StepJudge> = {
  start,
  approve,
  decline,
  question,
  questionOne,
  skill,
  interrupt,
}
