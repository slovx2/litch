// 三个引擎各走一遍的验收：三家各是谁、每一步说什么话，和判定用的那几样类型。
// 每一步各家该是什么写在 probe-engines-judge-talk.mts（建会话、审批、提问、技能、打断）和
// probe-engines-judge-work.mts（其余）；把它们合起来出结果的是 probe-engines-judge.mts。
import type { DeviceSeen, EnginesPlace } from './probe-engines.mjs'

export interface EngineSpec {
  /** 头一句话，也是那个会话在侧栏里的标题 */
  opening: string
  /** 设备详情和徽标上的名字、两个字母的记号 */
  name: string
  badge: string
  /**
   * 审批之前要调到的权限档：跑命令会来问的那一档。
   * 空的是不用调：Pi 的审批是设备上的一项设置（夹具已经打开），它的权限档只有一个
   */
  asking: string
  /** 提问的工具是不是一张卡片能问几道题（是的话另外再试一次只问一道的） */
  single: boolean
  /** 计划写好之后它自己来问的那张卡片上：留在计划模式里的那一项、去执行的那一项。空的是不会计划模式 */
  planStay: string
  planGo: string
}

export const SPECS: Record<string, EngineSpec> = {
  'claude-code': {
    opening: '头一句（claude-code）',
    name: 'Claude Code',
    badge: 'CC',
    asking: ':workspace',
    single: true,
    planStay: '继续规划',
    planGo: '执行计划',
  },
  pi: {
    opening: '头一句（pi）',
    name: 'Pi',
    badge: 'PI',
    asking: '',
    single: false,
    planStay: 'Stay in Plan mode',
    planGo: 'Implement here',
  },
  dsh: {
    opening: '头一句（dsh）',
    name: 'DSH',
    badge: 'DS',
    asking: ':workspace',
    single: false,
    planStay: '',
    planGo: '',
  },
}

/** 每一步说的话。带着哪个词假模型就做哪件事（scripts/client-fixture-anthropic.mjs 开头有全表），一句里只带一个词 */
export const WORDS = {
  workspace: '三引擎验收',
  approve: '跑个命令，这一次会批准',
  refuse: '再跑个命令，这一次会拒绝',
  accept: '允许这一次',
  decline: '拒绝',
  ask: '问我两个问题',
  askOne: '问一句',
  typed: '自己填的回答',
  skill: '带着技能说一句',
  slow: '慢慢说，说到一半会被打断',
  afterStop: '打断之后再说一句',
  plan: '出个计划：给首页加一个状态条',
  write: '写个文件',
  image: '带图的一句',
  earlier: '分叉从这一句开始',
  later: '这一句不该进新会话',
  aside: '在岔出来的会话里说',
  again: '回退之后重发',
  afterCompact: '压缩之后再说一句',
}

export interface EnginesSeen {
  ids: string[]
  place: EnginesPlace
  device: DeviceSeen | null
  /** 每一步：harness 的标识 → 看到的（走不下去的是 { error, settled }） */
  steps: Record<string, Record<string, unknown>>
}

/** 判一步里的一家时用的那几样手 */
export interface Verdict {
  fail(what: string): void
  known(what: string): void
  note(what: string): void
  /** 不成立就是 fail */
  check(ok: unknown, what: string): void
  /** 表格里这一格写什么（不给的话按有没有 fail、known 来写） */
  cell(text: string): void
}

/** 一步怎么判：id 是哪一家，seen 是那一步在它上面看到的 */
export type StepJudge = (
  id: string,
  spec: EngineSpec,
  // 每一步看到的东西形状各不相同，各自的判定里再按那一步的类型去读
  seen: unknown,
  verdict: Verdict,
  place: EnginesPlace,
) => void
