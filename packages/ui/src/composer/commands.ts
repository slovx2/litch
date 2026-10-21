// 输入框里打 `/` 能叫出来的、客户端自己的那几条命令：都是界面上本来就有的操作，这里只是多一个从键盘过去的入口。
// 纯逻辑：哪几条现在叫得出来。怎么做在输入区里（Composer.tsx）。
// test/suggest.test.mjs 直接引这个文件，所以只用可擦除的语法、不引样式和组件。

/** 命令的名字，打出来就是 `/名字` */
export type BuiltinId =
  | 'new'
  | 'compact'
  | 'plan'
  | 'goal'
  | 'model'
  | 'effort'
  | 'permissions'
  | 'terminal'

/** 定“哪几条叫得出来”要看的东西 */
export interface BuiltinFacts {
  /** 是在一个已有的会话里。新建对话页上是假：那里没有会话可以压缩，也已经是新对话了 */
  inSession: boolean
  /** 现在能压缩：这个会话做得了，而且没有回合在跑 */
  canCompact: boolean
  /** 这个 harness 会计划模式（底栏上有那个开关） */
  plan: boolean
  /** 这个 harness 会持续目标：/goal 留下前缀，接着写目标，发出去就是设目标。新建对话页上也有 */
  goal?: boolean
  /** 底栏上现在有哪几个选择器（模型、强度、权限各是 model、effort、permission） */
  pickers: readonly string[]
  /** 这个词是不是输入框里唯一的东西。对会话办一件事的命令不夹在写了一半的话里 */
  alone: boolean
}

/** 命令 → 它点开的是底栏上的哪个选择器 */
export const PICKER_OF: Partial<Record<BuiltinId, string>> = {
  model: 'model',
  effort: 'effort',
  permissions: 'permission',
}

const ORDER: readonly BuiltinId[] = [
  'new',
  'compact',
  'plan',
  'goal',
  'model',
  'effort',
  'permissions',
  'terminal',
]

/** 现在叫得出来的命令，按单子上的顺序。做不了的不列：列出来也只能告诉人做不了 */
export function builtinCommands(facts: BuiltinFacts): BuiltinId[] {
  if (!facts.alone) return []
  return ORDER.filter((id) => {
    if (id === 'new') return facts.inSession
    if (id === 'compact') return facts.inSession && facts.canCompact
    if (id === 'plan') return facts.plan
    if (id === 'goal') return facts.goal === true
    const picker = PICKER_OF[id]
    return picker === undefined || facts.pickers.includes(picker)
  })
}
