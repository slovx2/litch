// 隔离入口里的“计划模式”：让假模型在计划模式下真的交出一份计划，客户端上看得到真实引擎发来的计划条目。
//
// Pi 的计划模式是一个插件：开着的时候它把交计划的工具（plan_mode_complete）交给模型，模型调用它，计划就成了。
// 用户的话里带“出个计划”、这个工具也在的时候，假模型调用它；工具结果回来之后说一句就结束。
//   用户（计划模式开着）：出个计划：给首页加一个状态条
//   → 对话里出现一张计划卡片，回合结束，客户端问要不要执行
const PLAN_TOOL = 'plan_mode_complete'

/** 用户的话里有这些字样就交计划 */
export const PLAN_TRIGGER = /出个计划|make a plan/i

export const FIXTURE_PLAN = [
  '# 给首页加一个状态条',
  '',
  '1. 加一个取状态的函数',
  '2. 首页顶上加一条',
  '',
  '记号：LITCH-PLAN-4827。',
].join('\n')

const named = (tool) => tool.function?.name ?? tool.name

/**
 * 这次请求要不要走交计划这条路。要的话返回假模型该给的回复，不要就是 null。
 * lastUserText 是请求里用户说的最后一句话。
 */
export function planReply(body, lastUserText) {
  const last = body.messages?.at(-1)
  const called = body.messages
    ?.findLast((message) => message.role === 'assistant')
    ?.tool_calls?.some((call) => named(call) === PLAN_TOOL)
  // 交计划的工具结果回来了：说一句就结束。要先判断，不然那句“出个计划”还在，会一直交下去
  if (last?.role === 'tool' && called) return { text: '计划写好了，在上面。', pace: 50 }
  if (
    !PLAN_TRIGGER.test(lastUserText) ||
    !(body.tools ?? []).some((tool) => named(tool) === PLAN_TOOL)
  )
    return null
  return { tools: [{ name: PLAN_TOOL, args: { plan: FIXTURE_PLAN } }] }
}
