// 三引擎的隔离环境里后加的几个词，和 Pi 这一路（OpenAI 形态的假模型）对它们的应答。
// 早先就有的词各在各的模块里：问我（client-fixture-ask.mjs）、跑个命令（client-fixture-run.mjs）、
// 改个文件（client-fixture-edit.mjs）、出个计划（client-fixture-plan.mjs）。
// Claude Code 和 DeepSeek Harness 那一路（Anthropic 形态）在 client-fixture-anthropic.mjs，认的是同一套词。
//
//   写个文件   用引擎自己的写文件工具新写一个文件：对话里是“改了文件”那一条（“改个文件”是用命令写的，对话里是命令）
//   慢慢说     回话分成很多段慢慢发，打断来得及
//   问一句     只问一道题（只有会提问的引擎认；Pi 的提问是扩展一问一问发的，本来就是一道一道）
// 另外，收到的话里带着技能正文的记号（LITCH-SKILL-数字）时，回话末尾把记号带回来：
// 技能有没有真的到模型手里，看回话就知道。
//
// 最后两样（piReply、sendCompletion）是 Pi 这一路整个怎么回、怎么发，两个夹具
// （device-fixture.mjs、带 --engines 的 client-local-fixture.mjs）用的是这同一份，免得两头各改各的。
import { askReply } from './client-fixture-ask.mjs'
import { editReply } from './client-fixture-edit.mjs'
import { planReply } from './client-fixture-plan.mjs'
import { runReply } from './client-fixture-run.mjs'

/** 用户的话里有这些字样就用写文件的工具新写一个文件 */
export const WRITE_TRIGGER = /写个文件|write a file/i
/**
 * 新写的文件和它的内容：验收按这个名字去找。名字里带着是哪个 harness 写的：
 * 三家在同一个工作目录里各写各的，谁也不会写到别家已经写过的文件上
 */
export const writtenFile = (harness) => `agent-written.${harness}.txt`
export const WRITE_BODY = 'written by the fixture agent\n'

/** 用户的话里有这些字样就把回话拉长 */
export const SLOW_TRIGGER = /慢慢说|say it slowly/i
/** 拉长之后分多少段、每段停多久（毫秒）：一共九秒 */
export const SLOW_PIECES = 60
export const SLOW_PACE = 150

/** 用户的话里有这些字样就只问一道题 */
export const ONE_TRIGGER = /问一句|ask one/i

const SKILL_MARK = /LITCH-SKILL-\d+/g

/** 收到的字里有技能正文的记号就说一声，没有是空的 */
export function skillNote(text) {
  const marks = [...new Set(text.match(SKILL_MARK) ?? [])]
  return marks.length ? `\n\n（技能记号：${marks.join('、')}）` : ''
}

/** 夹具造的技能：名字、说明和正文。正文里的记号只在正文里有，清单里（名字和说明）看不到 */
export const FIXTURE_SKILL = {
  name: 'fixture-notes',
  description: '隔离环境里造出来的技能，验收输入框里的单子用',
  mark: 'LITCH-SKILL-7391',
}
export const skillFile = ({ name, description, mark } = FIXTURE_SKILL) =>
  [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `这是隔离环境里的技能正文。记号：${mark}。`,
    '',
  ].join('\n')

/** 拉长的回话：一段一句，句句带序号，看得出停在了第几段 */
export const slowText = (head) =>
  [head, ...Array.from({ length: SLOW_PIECES - 1 }, (_, index) => `第 ${index + 1} 段。`)].join(
    '\n\n',
  )

/** Pi 内置的写文件工具 */
const WRITE_TOOL = 'write'

const nameOf = (tool) => tool?.function?.name ?? tool?.name
const textOf = (content) =>
  typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('')

/**
 * Pi：这次请求要不要走写文件这条路。要的话返回假模型该给的回复，不要就是 null。
 * 要排在提问（client-fixture-ask.mjs 的 askReply）前面：那边见到工具结果就当成是提问的回答。
 */
export function writeReply(body, lastUserText, harness) {
  const messages = body.messages ?? []
  const last = messages.at(-1)
  if (last?.role === 'tool') {
    // 只认自己发起的那次调用的结果
    const asked = messages.findLast((message) => message.role === 'assistant' && message.tool_calls)
    if (!asked?.tool_calls.some((call) => nameOf(call) === WRITE_TOOL)) return null
    return { text: `写文件的结果：\n\n${textOf(last.content)}`, pace: 150 }
  }
  if (!WRITE_TRIGGER.test(lastUserText)) return null
  if (!(body.tools ?? []).some((tool) => nameOf(tool) === WRITE_TOOL)) return null
  return {
    tools: [{ name: WRITE_TOOL, args: { path: writtenFile(harness), content: WRITE_BODY } }],
  }
}

/**
 * Pi 这一路收到一次模型请求该怎么回：先看话里带没带那几个词，都没有就把话带回来，
 * 开头注明是哪个 harness 收到的、带了几张图。pace 是平常的回话每发一段停多久（毫秒）
 */
export function piReply(harness, body, pace = 150) {
  const content = body.messages?.findLast((message) => message.role === 'user')?.content
  const said = textOf(content)
  // 跑命令和改文件用的是同一个工具，改文件认得出自己那一次，要排在前面；提问见到工具结果就认，排最后
  const scripted =
    planReply(body, said) ??
    editReply(body, said) ??
    writeReply(body, said, harness) ??
    runReply(body, said) ??
    askReply(body, said)
  if (scripted) return scripted
  const images = Array.isArray(content)
    ? content.filter((part) => part.type === 'image_url').length
    : 0
  const head = `${harness} 收到：${said}${images ? `（图 ${images} 张）` : ''}`
  if (SLOW_TRIGGER.test(said)) return { text: slowText(head), pieces: SLOW_PIECES, pace: SLOW_PACE }
  return {
    text: `${head}${skillNote(said)}\n\n这是隔离设备里的假模型在回话，分成几段慢慢发，好让界面上看得到字是一点一点出来的。`,
    pace,
  }
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * 把一次回复按 OpenAI chat completions 的流式形态发出去：一组工具调用，或者一段文字（分几段、每段停一下）。
 * serial 是这是第几次请求，拿来编标识
 */
export async function sendCompletion(res, reply, { serial, model }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const base = { id: `mock_${serial}`, object: 'chat.completion.chunk', created: 1, model }
  const chunk = (delta, finish = null, extra = {}) =>
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`,
    )
  const calls = reply.tools?.map((tool, index) => ({
    index,
    id: `call_${serial}_${index}`,
    type: 'function',
    function: { name: tool.name, arguments: JSON.stringify(tool.args) },
  }))
  if (calls) chunk({ role: 'assistant', tool_calls: calls })
  else {
    // 文字分几段发，让运行时那边产生真实的增量
    const text = reply.text ?? '好的。'
    const size = Math.max(1, Math.ceil(text.length / (reply.pieces ?? 6)))
    for (let at = 0; at < text.length; at += size) {
      chunk(
        at === 0
          ? { role: 'assistant', content: text.slice(0, size) }
          : { content: text.slice(at, at + size) },
      )
      if (reply.pace) await pause(reply.pace)
      // 回合被打断时对面会断开这个请求，后面的不用发了
      if (res.destroyed) return
    }
  }
  chunk({}, calls ? 'tool_calls' : 'stop', {
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
  res.end('data: [DONE]\n\n')
}
