// 隔离环境里的假模型：话里带“后台跑”时起一条后台命令，回一句就停下，好在界面上看后台任务（输入框上方那一行、
// 右侧“后台任务”页、侧栏记号、跑完后的自发回合）。
//   Claude Code、dsh：命令工具带 run_in_background。命令跑完之后 Claude Code 自己再开一轮（结束通知），
//                     假模型照常把话带回来（client-fixture-anthropic.mjs）
//   原生 codex：exec_command 只等一小会儿就交回（命令留在后台终端里接着跑），回合结束时这条命令还是进行中；
//               codex 跑完不会自己接着做
// 命令只是睡一会儿再说一句话，什么都不改。
export const BG_TRIGGER = /后台跑/
export const BG_SECONDS = 12
export const BG_COMMAND = `sleep ${BG_SECONDS}; echo litch-bg-done`
export const BG_REPLY = '在后台跑着了，跑完再说。'

/** Responses 形态（原生 codex）的回复，不归这里管是 null */
export function backgroundResponses(body, said) {
  if (!BG_TRIGGER.test(said)) return null
  const input = Array.isArray(body.input) ? body.input : []
  const since = input.slice(input.findLastIndex((item) => item?.role === 'user') + 1)
  if (since.some((item) => item?.type === 'function_call_output'))
    return { text: BG_REPLY, pieces: 2, pace: 20 }
  const offered = new Set((body.tools ?? []).map((entry) => entry?.name))
  if (!offered.has('exec_command'))
    return { text: `这里没有能放到后台的命令工具（有：${[...offered].join('、')}）`, pieces: 1 }
  return {
    call: {
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: BG_COMMAND, yield_time_ms: 500 }),
    },
  }
}
