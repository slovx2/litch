import { randomUUID } from 'node:crypto'
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'

export type ReverseCall = (method: string, params: any, signal?: AbortSignal) => Promise<any>

// 计划插件菜单里的“新开一个会话去实施”要扩展自己开会话，入口不支持（runtime.mts 里 newSession 不可用），
// 选了只会报错、计划原样留着。菜单写死在插件里、没有开关，只能在这里按字拿掉；插件版本是锁定的，
// plan-menu.test.mts 盯着菜单的样子，升级插件时字变了会被发现。菜单的题目里讲这一项的那行说明一起拿掉
const UNSUPPORTED_CHOICES = new Set(['Start fresh and implement'])
const UNSUPPORTED_LINES = new Set([
  'Start fresh transfers only the approved plan to a new session.',
])
// 计划插件交了计划之后弹的那一问（就绪菜单）的题目头一行。插件版本是锁定的，plan-menu.test.mts 盯着它
const PLAN_READY_TITLE = 'Proposed plan ready. What next?'

// 终端专属接口遵循官方 RPC 的空操作约定；可交互对话必须由客户端回答。
// asksPlan：交了计划之后要不要由入口问（发起这个回合的连接握手时声明了 planConfirmation）。
// 不问的时候就绪菜单不弹，等于用户把它关了：计划留着、计划模式不退出，回合正常结束，
// 客户端在回合结束后自己问（官方桌面端的做法），选了执行发来的回合由 turn.mts 交给插件去实施。
// 用户自己发 /plan 打开的菜单、计划过程中插件的提问都照常问。
export function createUi(
  call: ReverseCall,
  notify: (method: string, params: any) => void,
  asksPlan: () => boolean,
): ExtensionUIContext {
  const noop = () => {}
  const question = async (
    title: string,
    options?: string[],
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    const id = randomUUID()
    const reply = await call(
      'item/tool/requestUserInput',
      {
        isBlocking: true,
        questions: [
          {
            id,
            // header 是界面上的短标签（上游提问工具的说明：12 个字以内）。扩展问的时候只给一个题目，
            // 没有单独的标签，截题目的一段充数就是半截题目、或者和题目一字不差。协议里它是必填的字符串，
            // 所以给空的：上游的界面这时用题目，Litch 写一句通用的话
            header: '',
            question: title,
            isOther: !options,
            isSecret: false,
            options: options?.map((label) => ({ label, description: '' })) ?? null,
          },
        ],
      },
      signal,
    )
    return reply?.answers?.[id]?.answers?.[0]
  }
  return {
    select: async (title, options, opts) => {
      if (title.split('\n', 1)[0] === PLAN_READY_TITLE && !asksPlan()) return undefined
      return question(
        title
          .split('\n')
          .filter((line) => !UNSUPPORTED_LINES.has(line))
          .join('\n'),
        options.filter((label) => !UNSUPPORTED_CHOICES.has(label)),
        opts?.signal,
      )
    },
    confirm: async (title, message, opts) =>
      (await question(`${title}\n${message}`, ['确认', '取消'], opts?.signal)) === '确认',
    input: (title, placeholder, opts) =>
      question(placeholder ? `${title}\n${placeholder}` : title, undefined, opts?.signal),
    editor: (title, prefill) => question(prefill ? `${title}\n${prefill}` : title),
    notify: (message, type) => notify('warning', { message, severity: type ?? 'info' }),
    onTerminalInput: () => noop,
    setStatus: noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    custom: async () => undefined as any,
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: () => '',
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: () => undefined,
    theme: {
      fg: (_c: string, s: string) => s,
      bg: (_c: string, s: string) => s,
      bold: (s: string) => s,
    } as any,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'RPC 不支持主题切换' }),
    getToolsExpanded: () => false,
    setToolsExpanded: noop,
  }
}
