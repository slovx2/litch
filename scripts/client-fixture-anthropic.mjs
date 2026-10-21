// 隔离环境里给 Claude Code 和 DeepSeek Harness（dsh）用的假模型：Anthropic Messages 形态的流式应答。
// Pi 那一路是 OpenAI 形态的，在各夹具自己的服务里；这里认的是同一套词，做同样的事，工具换成这两家自己的：
//
//   话里带的词   Claude Code                            dsh
//   跑个命令     Bash                                   bash，并申请放宽沙箱（dsh 只在这时来问）
//   改个文件     Bash（和 Pi 同一条命令）                 bash
//   （Windows 上 dsh 跑命令的工具叫 pwsh，命令换成 PowerShell 的写法；Claude Code 的 Bash 在 Windows 上走 Git Bash，命令不变）
//   写个文件     Write                                  write
//   问我         AskUserQuestion，一次两道题             ask_user_question，一次两道题
//   问一句       AskUserQuestion，一道题                 ask_user_question，一道题
//   出个计划     先说计划、再调 ExitPlanMode             没有计划模式：照常回话
//               （计划模式开着才有这个工具）
//   慢慢说       回话分很多段慢慢发
//   后台跑       Bash 带 run_in_background              bash 带 run_in_background（见 client-fixture-background.mjs）
//   本机：…、命令行：…、你在哪   操作本机，见 client-fixture-machine.mjs
//   别的         把收到的话带回来，开头注明是哪个 harness 收到的；带着技能正文的记号时把记号带回来
//
// 走到第几步按请求的内容算，不按到达的先后：引擎自己还会发别的请求（dsh 起标题、Claude Code 数词元），
// 一个回合里模型每拿到一次工具结果就是下一步。
// 排查时想看引擎到底给模型发了什么：给 LITCH_FIXTURE_DUMP 一个目录，每次模型请求的原文各存一个文件。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ASK_QUESTIONS, ASK_TRIGGER } from './client-fixture-ask.mjs'
import { BG_COMMAND, BG_REPLY, BG_TRIGGER } from './client-fixture-background.mjs'
import {
  EDIT_APPENDED,
  EDIT_COMMAND,
  EDIT_COMMAND_PWSH,
  EDIT_CREATED,
  EDIT_TRIGGER,
} from './client-fixture-edit.mjs'
import { machineAnthropic } from './client-fixture-machine.mjs'
import {
  ONE_TRIGGER,
  SLOW_PACE,
  SLOW_PIECES,
  SLOW_TRIGGER,
  skillNote,
  slowText,
  WRITE_BODY,
  WRITE_TRIGGER,
  writtenFile,
} from './client-fixture-marks.mjs'
import { FIXTURE_PLAN, PLAN_TRIGGER } from './client-fixture-plan.mjs'
import { RUN_COMMAND, RUN_COMMAND_PWSH, RUN_TRIGGER } from './client-fixture-run.mjs'
import { sessionsAnthropic } from './client-fixture-sessions.mjs'

/** 两家各自的工具名。没有的是 null */
const TOOLS = {
  'claude-code': { shell: 'Bash', write: 'Write', ask: 'AskUserQuestion', plan: 'ExitPlanMode' },
  dsh: { shell: 'bash', write: 'write', ask: 'ask_user_question', plan: null },
}

/** Claude Code 的提问工具每道题都要有选项（另外自己写由它自己加）；头两道和 Pi 那两问是同样的话 */
const ASK_HEADERS = ['范围', '留意']
const ASK_FALLBACK = ['别动数据库', '保持接口不变']
const asQuestion = (question, index) => ({
  question: question.title,
  header: ASK_HEADERS[index] ?? `第 ${index + 1} 题`,
  multiSelect: false,
  options: (question.options ?? ASK_FALLBACK).map((label) => ({
    label,
    description: `选“${label}”`,
  })),
})

const blocksOf = (message) =>
  typeof message?.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : (message?.content ?? [])
/** 用户自己说的话，不是工具结果 */
const isPrompt = (message) =>
  message.role === 'user' && !blocksOf(message).some((block) => block.type === 'tool_result')
/**
 * 引擎夹在用户消息里给模型看的东西不算用户说的话：两家都有的 <system-reminder> 段；
 * dsh 每条消息后面跟着的那一块运行环境说明、图片旁边注的那一句；
 * Claude Code 在图片后面注的“图存在哪”、手动压缩之后留给模型看的那几块本地命令的记录
 */
const ENGINE_NOTES = [
  'Current runtime context.',
  'Image sha256:',
  '[Image: source:',
  '<local-command-',
  '<command-name>/compact</command-name>',
]
const spoken = (text) =>
  ENGINE_NOTES.some((head) => text.startsWith(head))
    ? ''
    : text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
const textOf = (message) =>
  blocksOf(message)
    .map((block) => (block.type === 'text' ? spoken(block.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
/** 最后那条工具结果的字，和它是不是一次失败（被拒绝也算） */
function lastResult(messages) {
  const block = blocksOf(messages.at(-1)).findLast((entry) => entry.type === 'tool_result')
  if (!block) return { text: '', failed: false }
  const text =
    typeof block.content === 'string'
      ? block.content
      : (block.content ?? []).map((part) => part.text ?? '').join('')
  // Claude Code 会在工具结果后面也夹一段给模型看的提示
  return { text: spoken(text), failed: block.is_error === true }
}

/**
 * Claude Code 的写文件工具要完整的路径：会话的工作目录在它给模型的环境说明里。
 * 那段说明放在哪跟模型有关（系统提示里、头一条用户消息里、往来中间的 system 消息里），所以整个请求里找。
 * 找的是整个请求序列化之后的原文：换行成了 \n 两个字，反斜杠成了 \\ 两个（Windows 的路径 C:\Users\… 就是这样），
 * 所以一路认到引号或者 \n 为止，中间成对的反斜杠还原成一个
 */
function workingDirectory(body) {
  const said = JSON.stringify([body.system ?? '', body.messages ?? []])
  const found = /(?:Primary working|Working) directory: ((?:[^\\\n"]|\\\\)+)/.exec(said)
  return found?.[1]?.replaceAll('\\\\', '\\').trim() ?? ''
}

/** 起标题的请求里用户的头一句话，最多四十个字。认不出来就给一个固定的 */
function titleFrom(asked) {
  let first = ''
  try {
    first = JSON.parse(asked.slice(asked.indexOf('[')))[0]?.text ?? ''
  } catch {
    // 不是那种排法
  }
  return first.split('\n')[0]?.slice(0, 40) || '假模型起的标题'
}

/**
 * 这次请求该怎么答。返回一串内容块：{ text, pieces, pace } 是一段话（分几段、每段停多久），
 * { tool, input } 是一次工具调用。harness 是 claude-code 或 dsh
 */
export function anthropicReply(harness, body, pace) {
  // 用户和模型之间的往来。Claude Code 用新一些的模型时，给模型看的提示不夹在用户消息里，
  // 而是在往来中间另插一条 system 角色的消息：那不是谁说的话，也不是工具结果，先拿掉
  const messages = (body.messages ?? []).filter((message) => message.role !== 'system')
  const tools = TOOLS[harness]
  const offered = new Set((body.tools ?? []).map((tool) => tool.name))
  // 不带工具的请求是引擎在给会话起标题（dsh 把用户说过的话排成一个 JSON 数组交过来）：
  // 拿用户的头一句话当标题，侧栏里就对得上
  if (offered.size === 0) return [{ text: titleFrom(textOf(messages.find(isPrompt))) }]
  const asked = messages.findLastIndex(isPrompt)
  const said = asked < 0 ? '' : textOf(messages[asked])
  const step = messages.slice(asked + 1).filter((message) => message.role === 'assistant').length
  const result = lastResult(messages)
  const say = (text) => [{ text, pace }]
  // 操作本机（litch_machine 和 litch-machine 命令）的那几句，见 client-fixture-machine.mjs
  const machine = machineAnthropic(harness, body, said)
  if (machine) return machine
  // 会话树（litch_sessions 和设备注入的唤醒）的那几句，见 client-fixture-sessions.mjs
  const sessions = sessionsAnthropic(body, said)
  if (sessions) return sessions
  // Windows 上 dsh 给的跑命令的工具是 pwsh（参数和 bash 一样），命令要换成 PowerShell 的写法
  const pwsh = harness === 'dsh' && !offered.has(tools.shell) && offered.has('pwsh')
  const shell = pwsh ? 'pwsh' : tools.shell
  // 一句话里有好几个词时认最后出现的那个：被打断的回合留下的话，会和新的一句并在同一条消息里
  const marks = [
    [BG_TRIGGER, 'bg', shell],
    [RUN_TRIGGER, 'run', shell],
    [EDIT_TRIGGER, 'edit', shell],
    [WRITE_TRIGGER, 'write', tools.write],
    [ONE_TRIGGER, 'one', tools.ask],
    [ASK_TRIGGER, 'ask', tools.ask],
    [PLAN_TRIGGER, 'plan', tools.plan],
  ]
    .filter(([, , tool]) => tool && offered.has(tool))
    .map(([trigger, mark, tool]) => ({ mark, tool, at: said.search(trigger) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => b.at - a.at)
  const { mark, tool } = marks[0] ?? {}
  if (mark && step === 0) {
    if (mark === 'bg')
      return [
        {
          tool,
          input: { command: BG_COMMAND, description: 'fixture sleep', run_in_background: true },
        },
      ]
    if (mark === 'run' || mark === 'edit') {
      const commands = pwsh
        ? { run: RUN_COMMAND_PWSH, edit: EDIT_COMMAND_PWSH }
        : { run: RUN_COMMAND, edit: EDIT_COMMAND }
      const input = {
        command: commands[mark],
        description: '隔离环境里的固定命令',
        // dsh 只在模型申请放宽沙箱时来问
        ...(harness === 'dsh' && mark === 'run'
          ? {
              sandbox_permissions: 'danger-full-access',
              justification: '隔离环境里的假模型申请放宽沙箱。',
            }
          : {}),
      }
      return [{ tool, input }]
    }
    if (mark === 'write') {
      const base = harness === 'claude-code' ? workingDirectory(body) : ''
      const file = writtenFile(harness)
      // Windows 上的工作目录是 C:\…，接着用反斜杠
      const slash = /^[A-Za-z]:\\/.test(base) ? '\\' : '/'
      const path = base ? `${base.replace(/[\\/]$/, '')}${slash}${file}` : file
      return [{ tool, input: { file_path: path, content: WRITE_BODY } }]
    }
    if (mark === 'plan') return [{ text: FIXTURE_PLAN }, { tool, input: {} }]
    const asked = ASK_QUESTIONS.slice(0, mark === 'one' ? 1 : undefined)
    // dsh 的提问工具每道题要一个标识，选项可有可无（没有就是自己填）
    const questions =
      harness === 'dsh'
        ? asked.map((question, index) => ({
            id: `q${index + 1}`,
            question: question.title,
            header: ASK_HEADERS[index],
            ...(question.options
              ? {
                  options: question.options.map((label) => ({
                    label,
                    description: `选“${label}”`,
                  })),
                }
              : {}),
          }))
        : asked.map(asQuestion)
    return [{ tool, input: { questions } }]
  }
  if (mark === 'bg') return say(BG_REPLY)
  if (mark === 'run') {
    return say(`命令的结果：\n\n${result.text}\n\n这是隔离环境里的假模型在回话。`)
  }
  if (mark === 'edit') return say(`改好了：接着写了 ${EDIT_APPENDED}，新写了 ${EDIT_CREATED}。`)
  if (mark === 'write') return say(`写文件的结果：\n\n${result.text}`)
  if (mark === 'plan') return say(result.failed ? '好，先不动手。' : '计划写好了，在上面。')
  if (mark) return say(`收到你的回答：\n\n${result.text}\n\n这是隔离环境里的假模型在回话。`)
  const images = blocksOf(messages[asked]).filter((block) => block.type === 'image').length
  const head = `${harness} 收到：${said}${images ? `（图 ${images} 张）` : ''}`
  // 技能的正文可能在这句话里，也可能由引擎另放一条消息：这个回合里的都看
  const note = skillNote(JSON.stringify(messages.slice(Math.max(asked, 0))))
  if (SLOW_TRIGGER.test(said)) {
    return [{ text: slowText(head) + note, pieces: SLOW_PIECES, pace: SLOW_PACE }]
  }
  return say(
    `${head}${note}\n\n这是隔离设备里的假模型在回话，分成几段慢慢发，好让界面上看得到字是一点一点出来的。`,
  )
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms))
let served = 0
let uploaded = 0

/**
 * 应答一次 HTTP 请求。path 是去掉了 harness 那一段前缀之后的路径，raw 是请求体的原文；不是模型请求的回 404。
 * 模型请求之外，Claude Code 还会来数词元、打招呼，dsh 带图片时先把图传上来（表单，不是 JSON），各回一句固定的。
 * 这里出了错不往外抛（那会把整个夹具带倒，它起的进程就没人收了）：回一个 500，把错打出来。
 */
export async function serveAnthropic(harness, path, raw, res, pace) {
  try {
    await serve(harness, path, raw, res, pace)
  } catch (error) {
    console.error(`假模型应答 ${harness} ${path} 时出错：${error?.stack ?? error}`)
    if (res.headersSent) return res.destroy()
    res
      .writeHead(500, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(error) } }))
  }
}

async function serve(harness, path, raw, res, pace) {
  const json = (value, status = 200) =>
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
  if (path.endsWith('/api/hello')) return json({})
  if (path.includes('/v1/messages/count_tokens')) return json({ input_tokens: 100 })
  // dsh 的文件接口：带图片的消息先把图传上来，消息里只放它的标识
  if (path.endsWith('/v1/files')) {
    return json({
      id: `file_fixture_${++uploaded}`,
      type: 'file',
      filename: 'image.png',
      mime_type: 'image/png',
      size_bytes: raw.length,
      created_at: new Date().toISOString(),
    })
  }
  if (path.includes('/v1/files/')) return json({ id: path.split('/').pop(), type: 'file_deleted' })
  if (!path.includes('/v1/messages')) return json({}, 404)
  const body = JSON.parse(raw.toString() || '{}')
  const blocks = anthropicReply(harness, body, pace)
  const id = `msg_fixture_${++served}`
  const dump = process.env.LITCH_FIXTURE_DUMP
  if (dump) {
    mkdirSync(dump, { recursive: true })
    const name = `${String(served).padStart(4, '0')}-${harness}.json`
    writeFileSync(join(dump, name), JSON.stringify({ request: body, reply: blocks }, null, 1))
  }
  const calls = blocks.filter((block) => block.tool)
  const stop = calls.length ? 'tool_use' : 'end_turn'
  const usage = {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
  const content = blocks.map((block, index) =>
    block.tool
      ? {
          type: 'tool_use',
          id: `toolu_fixture_${served}_${index}`,
          name: block.tool,
          input: block.input,
        }
      : { type: 'text', text: block.text },
  )
  const message = { id, type: 'message', role: 'assistant', model: body.model, usage }
  if (!body.stream) {
    return json({ ...message, content, stop_reason: stop, stop_sequence: null })
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const emit = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  emit('message_start', {
    message: { ...message, content: [], stop_reason: null, stop_sequence: null },
  })
  for (const [index, block] of blocks.entries()) {
    if (block.tool) {
      emit('content_block_start', { index, content_block: { ...content[index], input: {} } })
      emit('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      })
    } else {
      emit('content_block_start', { index, content_block: { type: 'text', text: '' } })
      // 文字分几段发，让引擎那边产生真实的增量
      const size = Math.max(1, Math.ceil(block.text.length / (block.pieces ?? 6)))
      for (let at = 0; at < block.text.length; at += size) {
        emit('content_block_delta', {
          index,
          delta: { type: 'text_delta', text: block.text.slice(at, at + size) },
        })
        if (block.pace) await pause(block.pace)
        // 回合被打断时对面会断开这个请求，后面的不用发了
        if (res.destroyed) return
      }
    }
    emit('content_block_stop', { index })
  }
  emit('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage })
  emit('message_stop', {})
  res.end()
}
