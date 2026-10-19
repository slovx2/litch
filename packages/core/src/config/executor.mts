// litch_config 的执行器（14 号设计 3.3）：本机 harness 里的模型跑 `litch config …`，命令行经设备进程的
// litch/clientTool/invoke 交给这台桌面端，核心收到 litch/clientTool/call（命名空间 litch_config、工具 run）交到这里。
// 拆参数、出帮助、执行 config-ops.mts 里的全部操作，回一段给模型读的字（--json 时是 JSON）。
// 放宽安全的几项先弹确认卡（E6），人点允许才执行；拒绝或两分钟没人理回 declined。
import {
  type ClientToolCallResponse,
  clientToolFailure,
} from '../../../protocol/src/client-tools.mjs'
import type { ConfigRunArguments } from '../../../protocol/src/client-tools-config.mjs'
import { CONFIG_OPS, configOpName } from '../../../protocol/src/config-ops.mjs'
import { ChannelError, type Topic } from '../channel/protocol.mjs'
import type { AppView, DeviceView, SidebarView } from '../model.mjs'
import { type ArgProblem, groups, parseHead, parseRest, parseSwitch } from './argv.mjs'
import { ConfigUiError } from './bridge.mjs'
import {
  type ConfigCaller,
  ConfigFailure,
  type ConfigHost,
  firstSnapshot,
  type Lang,
  type OpContext,
  type OpSpec,
  runCommand,
} from './context.mjs'
import { helpText } from './help.mjs'
import { APP_OPS } from './ops-app.mjs'
import { DEVICE_OPS } from './ops-devices.mjs'
import { HARNESS_OPS } from './ops-harness.mjs'
import { PLACE_OPS } from './ops-places.mjs'

/** 帮助本身也是清单里的一项 */
const HELP_OP: OpSpec = {
  args: [0, 1],
  usage: 'help [group]',
  summary: { zh: '帮助', en: 'Help' },
  run: async (ctx) => ({
    text: helpText(ctx.lang, ctx.cmd.positionals[0] ?? null, CONFIG_HANDLERS),
  }),
}

/** 全部操作，键是“组 动作”（configOpName）。和 CONFIG_OPS 必须一一对上（有测试） */
export const CONFIG_HANDLERS: Record<string, OpSpec> = {
  help: HELP_OP,
  ...APP_OPS,
  ...DEVICE_OPS,
  ...HARNESS_OPS,
  ...PLACE_OPS,
}

/** 拿主题快照最多等多久（设备的设置要先向设备取） */
const SNAPSHOT_MS = 8000

export interface ConfigExecutor {
  /** 执行一次。不抛错：出错也回 success:false 的答复 */
  run(args: unknown, caller: ConfigCaller): Promise<ClientToolCallResponse>
}

const isLang = (value: unknown): value is Lang => value === 'zh-CN' || value === 'en'

const readArgs = (raw: unknown): ConfigRunArguments | null => {
  const value = raw as Partial<ConfigRunArguments> | null
  if (
    !value ||
    !Array.isArray(value.argv) ||
    !value.argv.every((word) => typeof word === 'string')
  ) {
    return null
  }
  return {
    argv: value.argv,
    json: value.json === true,
    lang: isLang(value.lang) ? value.lang : null,
  }
}

const problemText = (lang: Lang, problem: ArgProblem, usage: string | null): string => {
  const zh = lang === 'zh-CN'
  const tail = usage
    ? zh
      ? `\n用法：litch config ${usage}`
      : `\nUsage: litch config ${usage}`
    : ''
  switch (problem.kind) {
    case 'empty':
      return zh ? '没有给命令。' : 'No command given.'
    case 'group':
      return zh
        ? `这一版 Litch 没有这个操作：${problem.group}。有：${groups().join('、')}。`
        : `This Litch has no such operation: ${problem.group}. Groups: ${groups().join(', ')}.`
    case 'action': {
      const actions = CONFIG_OPS.filter((op) => op.group === problem.group).map((op) => op.action)
      return zh
        ? `这一版 Litch 没有这个操作：${problem.group} ${problem.action ?? ''}。${problem.group} 下有：${actions.join('、')}。`
        : `This Litch has no such operation: ${problem.group} ${problem.action ?? ''}. ${problem.group} has: ${actions.join(', ')}.`
    }
    case 'option':
      return (
        (zh
          ? `不认识的选项：--${problem.name}。${problem.known.length ? `能用：${problem.known.join('、')}` : '这个操作没有选项'}`
          : `Unknown option --${problem.name}. ${problem.known.length ? `Options: ${problem.known.join(', ')}` : 'This operation takes no options'}`) +
        tail
      )
    case 'value':
      return (zh ? `--${problem.name} 后面要给值。` : `--${problem.name} needs a value.`) + tail
    case 'count':
      return (
        (zh
          ? `参数个数不对：要 ${problem.min === problem.max ? problem.min : `${problem.min} 到 ${problem.max}`} 个，给了 ${problem.got} 个。`
          : `Wrong number of arguments: expected ${problem.min === problem.max ? problem.min : `${problem.min}–${problem.max}`}, got ${problem.got}.`) +
        tail
      )
  }
}

/** 核心命令没做成：设备给了两种语言的按语言说，别的给错误码和原话 */
const channelText = (lang: Lang, error: ChannelError): string => {
  if (error.said) return error.said[lang]
  return `${error.code}: ${error.message}`
}

const LOCAL_NAMES = ['local', '本机', 'this computer', 'this mac']

export function createConfigExecutor(host: ConfigHost): ConfigExecutor {
  const devices = async (): Promise<DeviceView[]> =>
    (await firstSnapshot<AppView>(host.core, host.clock, { kind: 'app' }, SNAPSHOT_MS)).devices

  /** 调用者所在的会话：在哪台设备上、叫什么（确认卡上写） */
  const sessionOf = async (threadId: string | null) => {
    if (!threadId) return null
    for (const device of await devices()) {
      try {
        const sidebar = await firstSnapshot<SidebarView>(
          host.core,
          host.clock,
          { kind: 'sidebar', deviceId: device.id },
          2000,
        )
        const hit = sidebar.sessions.find((session) => session.id === threadId)
        if (hit)
          return {
            deviceId: device.id,
            sessionId: hit.id,
            title: typeof hit.title === 'string' ? hit.title || null : null,
          }
      } catch {
        // 这台取不到侧栏：看下一台
      }
    }
    return null
  }

  const contextOf = (
    lang: Lang,
    argv: readonly string[],
    cmd: OpContext['cmd'],
    caller: ConfigCaller,
  ): OpContext => {
    const say = (zh: string, en: string) => (lang === 'zh-CN' ? zh : en)
    const nameOf = (device: DeviceView) =>
      typeof device.name === 'string' ? device.name : say('本机', 'This computer')
    const ctx: OpContext = {
      cmd,
      lang,
      host,
      caller,
      argv,
      say,
      run: (name, params) => runCommand(host.core, name, params),
      first: (topic, ms = SNAPSHOT_MS) => firstSnapshot(host.core, host.clock, topic as Topic, ms),
      devices,
      nameOf,
      said: (value) => (value == null ? '' : typeof value === 'string' ? value : value[lang]),
      async device(arg) {
        const list = await devices()
        const key = (arg ?? '').trim()
        const lower = key.toLowerCase()
        const hit =
          list.find((device) => device.id === key) ??
          (LOCAL_NAMES.includes(lower)
            ? list.find((device) => device.kind === 'local')
            : undefined) ??
          list.find(
            (device) => typeof device.name === 'string' && device.name.toLowerCase() === lower,
          ) ??
          list.find((device) => device.host.toLowerCase() === lower) ??
          list.find((device) => device.target?.kind === 'alias' && device.target.alias === key)
        if (hit) return hit
        throw new ConfigFailure(
          'invalid',
          say(
            `${key ? `没有这台设备：${key}` : '要给设备'}。有：${list.map((device) => `${device.id}（${nameOf(device)}）`).join('、')}`,
            `${key ? `No such device: ${key}` : 'Pass a device'}. Devices: ${list.map((device) => `${device.id} (${nameOf(device)})`).join(', ')}`,
          ),
        )
      },
      async confirm(items) {
        const release = caller.hold()
        try {
          const outcome = await host.bridge.confirm({
            session: await sessionOf(caller.threadId),
            harness: caller.harness,
            command: argv.join(' '),
            items,
          })
          if (outcome === 'allow') return
          throw new ConfigFailure(
            'declined',
            outcome === 'decline'
              ? say('用户在桌面端拒绝了。', 'The user declined this on the desktop.')
              : outcome === 'timeout'
                ? say(
                    '两分钟内没人在桌面端点允许，算拒绝。',
                    'Nobody allowed it on the desktop within 2 minutes; treated as declined.',
                  )
                : say(
                    'Litch 窗口没开着，没人看得到确认卡。请用户打开 Litch 窗口再试。',
                    'No Litch window is open to show the confirmation. Ask the user to open the Litch window and try again.',
                  ),
          )
        } finally {
          release()
        }
      },
      ui: (request) => host.bridge.ask(request),
      async main(request) {
        const result = await host.main(request)
        if (result.ok) return result.data
        throw new ConfigFailure('failed', result.reason)
      },
      switchOf(name) {
        const raw = cmd.options.get(name)
        if (raw === undefined) return undefined
        const value = parseSwitch(raw)
        if (value === null) {
          throw new ConfigFailure(
            'invalid',
            say(`--${name} 只能是 on 或 off`, `--${name} must be on or off`),
          )
        }
        return value
      },
    }
    return ctx
  }

  const respond = (
    json: boolean,
    op: string,
    text: string,
    data: unknown,
  ): ClientToolCallResponse => ({
    success: true,
    contentItems: [
      {
        type: 'inputText',
        text: json ? JSON.stringify({ ok: true, op, data: data ?? null, text }) : text,
      },
    ],
  })

  const failure = (
    json: boolean,
    op: string | null,
    kind: Parameters<typeof clientToolFailure>[0],
    text: string,
  ): ClientToolCallResponse =>
    json
      ? {
          success: false,
          contentItems: [
            { type: 'inputText', text: JSON.stringify({ ok: false, op, kind, error: text }) },
          ],
        }
      : clientToolFailure(kind, text)

  return {
    async run(raw, caller) {
      const args = readArgs(raw)
      if (!args) return clientToolFailure('invalid', 'Malformed litch config arguments.')
      const lang = args.lang ?? host.lang()
      const head = parseHead(args.argv)
      if (head.kind === 'help') {
        return respond(args.json, 'help', helpText(lang, head.group, CONFIG_HANDLERS), null)
      }
      if (head.kind === 'problem') {
        return failure(args.json, null, 'invalid', problemText(lang, head.problem, null))
      }
      const name = configOpName({ group: head.group, action: head.action, write: false })
      const spec = CONFIG_HANDLERS[name]
      if (!spec) {
        return failure(
          args.json,
          name,
          'invalid',
          problemText(lang, { kind: 'group', group: name }, null),
        )
      }
      const parsed = parseRest(head, spec)
      if (!parsed.ok) {
        return failure(args.json, name, 'invalid', problemText(lang, parsed.problem, spec.usage))
      }
      try {
        const result = await spec.run(contextOf(lang, args.argv, parsed.command, caller))
        return respond(args.json, name, result.text, result.data)
      } catch (error) {
        if (error instanceof ConfigFailure)
          return failure(args.json, name, error.kind, error.message)
        if (error instanceof ConfigUiError) return failure(args.json, name, 'failed', error.message)
        if (error instanceof ChannelError) {
          const kind = error.code === 'invalid' || error.code === 'rejected' ? 'invalid' : 'failed'
          return failure(args.json, name, kind, channelText(lang, error))
        }
        host.log?.(`litch config ${name} 出错：${String(error)}`)
        return failure(
          args.json,
          name,
          'failed',
          error instanceof Error ? error.message : String(error),
        )
      }
    },
  }
}
