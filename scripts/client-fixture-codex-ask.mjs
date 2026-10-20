// 原生 codex 的“边做边问”（request_user_input_async）：真实窗口验收对话里的问题卡片用。
// 这个工具只有模型目录里声明了（experimental_supported_tools）的模型才有。夹具的假模型 fixture-gate 不在 codex
// 自带的目录里，所以要验它时（夹具带环境变量 LITCH_FIXTURE_CODEX_ASK=1）另写一份只有这一个模型的目录：
// 从这份 codex 自带的目录（codex debug models --bundled，隔离的环境里跑）里取一个模型做底子，
// 改名成 fixture-gate、声明 request_user_input_async，经 model_catalog_json 交给 codex。仓库里不存这份目录。
//
// 假模型认的话（见 askResponses）：
//   话里带“边做边问” → 调一次 request_user_input_async（两道题：一道有两个选项，一道只能自己写）；
//   工具回了“收到” → 停 ASK_WAIT_MS 再说“测试跑完了”（这段时间回合一直在跑，界面上答的话插进这个回合）；
//   用户消息整段是一份答复 → 把收到的答复原样带回来（“收到回答：…”）。
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TOOL = 'request_user_input_async'
const HEAD = '<send_user_message_question_reply>'
export const ASK_WORD = '边做边问'
/** 问完之后回合还要跑多久：够在界面上选好、写好、发出去 */
export const ASK_WAIT_MS = 20_000

/**
 * 写一份只有 fixture-gate 的模型目录到 codexHome 下，返回 config.toml 里要加的那一行。
 * env 是跑 codex 的环境（隔离的 HOME、CODEX_HOME、PATH），codex 是命令行
 */
export function askCatalog(codex, codexHome, env) {
  const dumped = spawnSync(codex, ['debug', 'models', '--bundled'], { env, encoding: 'utf8' })
  if (dumped.status !== 0) throw new Error(`codex debug models 没跑成：${dumped.stderr}`)
  const { models } = JSON.parse(dumped.stdout)
  // 假模型只会普通的函数调用：取一个不走精简请求（use_responses_lite）、不走代码模式（tool_mode）的模型做底子，
  // 只把异步提问加进它的工具里
  const base = models.find((entry) => !entry.use_responses_lite && entry.tool_mode == null)
  if (!base) throw new Error('这份 codex 自带的模型目录里没有能做底子的模型')
  const path = join(codexHome, 'fixture-models.json')
  const model = {
    ...base,
    slug: 'fixture-gate',
    display_name: 'Fixture Gate',
    experimental_supported_tools: [TOOL],
  }
  writeFileSync(path, JSON.stringify({ models: [model] }))
  return `model_catalog_json = ${JSON.stringify(path)}`
}

/** 请求里的最后一项 */
const lastOf = (body) => (Array.isArray(body.input) ? body.input.at(-1) : undefined)

/** 认得的话返回要发的回复（sendResponse 的 reply），别的返回 null */
export function askResponses(body, said) {
  const input = Array.isArray(body.input) ? body.input : []
  const last = lastOf(body)
  // 工具回了“收到”：模型接着干活，过一会儿再说话
  if (last?.type === 'function_call_output') {
    const call = input.find(
      (item) => item?.type === 'function_call' && item.call_id === last.call_id,
    )
    if (call?.name === TOOL) return { text: '测试跑完了，等你的回答。', delay: ASK_WAIT_MS }
    return null
  }
  if (last?.role !== 'user') return null
  if (said.trim().startsWith(HEAD)) return { text: `收到回答：${said.trim()}`, pieces: 2 }
  if (!said.includes(ASK_WORD)) return null
  if (!(body.tools ?? []).some((tool) => tool?.name === TOOL)) {
    return { text: `这一轮的工具里没有 ${TOOL}（模型目录没生效）。` }
  }
  return {
    call: {
      name: TOOL,
      arguments: JSON.stringify({
        questions: [
          {
            title: '测试里有 3 项依赖网络。这次先跳过它们，还是照常全跑？',
            options: ['先跳过，回头单独跑', '照常全跑'],
          },
          { title: '跑完之后结果发到哪个频道？' },
        ],
      }),
    },
  }
}
