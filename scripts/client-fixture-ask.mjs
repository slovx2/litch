// 隔离入口里的“提问”：让假模型能向用户发问，客户端上看得到真实引擎发来的提问卡片。
//
// Pi 引擎向用户提问走的是扩展的界面接口（select、input），适配器把它折成协议里的
// item/tool/requestUserInput。这里给隔离入口装一个只会提问的小扩展，注册一个工具；
// 用户的话里带“问我”时，假模型调用这个工具，问完之后把回答带在回话里。
//   用户：问我两个问题
//   → 第一张卡片：三个选项里选一个
//   → 第二张卡片：自己写一句
//   → 回话里是这两个回答
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const ASK_TOOL = 'fixture_ask'

/** 用户的话里有这些字样就提问 */
export const ASK_TRIGGER = /问我|ask me/i

/** 问哪几个问题。有选项的是单选，没有的自己写 */
export const ASK_QUESTIONS = [
  { title: '这次先动哪一块？', options: ['只改客户端', '只改适配器', '两边一起改'] },
  { title: '有什么要特别留意的？' },
]

// 扩展的源码。写成不引用任何包的样子：参数用普通的 JSON Schema，放到哪个目录都能装载
const EXTENSION = `// 由 scripts/client-fixture-ask.mjs 写出，只给隔离入口用
export default function (pi) {
  pi.registerTool({
    name: '${ASK_TOOL}',
    label: '提问',
    description: '向用户提几个问题，把回答带回来。',
    // 只是提问，什么都不改：打开了 Pi 的审批（动手之前先问）时，不用为“要不要提问”再问一遍
    annotations: { readOnlyHint: true },
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
            },
            required: ['title'],
          },
        },
      },
      required: ['questions'],
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const lines = []
      for (const question of params.questions) {
        // 回合被打断时 signal 会让还在等的那一问结束
        const answer = question.options?.length
          ? await ctx.ui.select(question.title, question.options, { signal })
          : await ctx.ui.input(question.title, undefined, { signal })
        lines.push(question.title + ' → ' + (answer?.trim() ? answer : '（没有回答）'))
      }
      return { content: [{ type: 'text', text: lines.join('\\n') }], details: {} }
    },
  })
}
`

/** 把扩展放进引擎的配置目录，引擎建会话时会自己装载 */
export function installAskExtension(agentDir) {
  const dir = join(agentDir, 'extensions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'litch-fixture-ask.js'), EXTENSION)
}

const textOf = (content) =>
  typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('')

/** 这次模型请求里有没有把提问的工具交给模型 */
export const askOffered = (body) =>
  (body.tools ?? []).some((tool) => (tool.function?.name ?? tool.name) === ASK_TOOL)

/**
 * 这次请求要不要走提问这条路。要的话返回假模型该给的回复，不要就是 null。
 * lastUserText 是请求里用户说的最后一句话。
 */
export function askReply(body, lastUserText) {
  const last = body.messages?.at(-1)
  // 工具结果回来了：把回答带在回话里。这一条要先判断，不然用户那句“问我”还在，会一直问下去
  if (last?.role === 'tool') {
    return {
      text: `收到你的回答：\n\n${textOf(last.content)}\n\n这是隔离入口里的假模型在回话，分成几段慢慢发，好让界面上看得到字是一点一点出来的。`,
      pace: 200,
    }
  }
  if (!ASK_TRIGGER.test(lastUserText) || !askOffered(body)) return null
  return { tools: [{ name: ASK_TOOL, args: { questions: ASK_QUESTIONS } }] }
}
