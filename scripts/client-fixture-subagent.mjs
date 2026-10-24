// 隔离环境里的假模型（Anthropic 形态，只认 Claude Code）：话里带“派子代理”时用 Agent 工具派一个前台子代理，
// 带“后台子代理”时派一个后台子代理（run_in_background）。子代理一步一步跑几条小命令（每步一个新的动作条目），
// 跑完回一句；主代理拿到结果再回一句。用来看回合进行中子代理不断出新条目时，输入框上方那一行和后台任务页的样子。
export const SUB_TRIGGER = /派子代理|后台子代理/
/** 子代理收到的任务里带的记号：子代理的请求按它认 */
export const SUB_MARK = 'LITCH_FIXTURE_SUBAGENT'
export const SUB_STEPS = 4
export const SUB_DONE = '子代理查完了：四步都跑过。'
export const SUB_REPLY = '子代理回来了，结果在上面。'

/**
 * 这次请求是派子代理这一出里的哪一步，返回要回的内容块；不归这里管是 null。
 * said：这次请求里最后一句用户的话；step：那句话之后模型已经说过几次；offered：请求里给的工具
 */
export function subagentAnthropic(said, step, offered) {
  if (said.includes(SUB_MARK)) {
    if (step < SUB_STEPS)
      return [
        { text: `第 ${step + 1} 步`, pace: 20 },
        {
          tool: 'Bash',
          input: {
            command: `sleep 2; echo litch-sub-${step + 1}`,
            description: `第 ${step + 1} 步`,
          },
        },
      ]
    return [{ text: SUB_DONE, pace: 20 }]
  }
  if (!SUB_TRIGGER.test(said) || !offered.has('Agent')) return null
  if (step > 0) return [{ text: SUB_REPLY, pace: 20 }]
  return [
    {
      tool: 'Agent',
      input: {
        description: '一步步查',
        prompt: `${SUB_MARK} 一步一步跑几条命令`,
        subagent_type: 'general-purpose',
        run_in_background: /后台子代理/.test(said),
      },
    },
  ]
}
