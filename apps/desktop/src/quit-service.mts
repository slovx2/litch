// 退出应用之前：本机的后台服务（常驻的设备服务）要不要一起关。
// 它默认是常驻的：退出之后定时任务照跑、没跑完的回合接着跑完、别的设备随时连得进来；
// 不想让它在后台一直开着的人，退出时可以一起关。所以退出时问一声；选过之后可以记住，以后不再问，
// 在“文件”菜单里能改回每次都问。
// 只问 device-start 拉起的那一份：前台运行的、brew services 或 systemd 管着的，有别的东西管它的生死，不归我们关。
// 关的事在应用真的要退出时才做（核心先退出，它和服务之间的连接断了，服务才不把它算成还连着的客户端）。
import { type BrowserWindow, dialog, type MessageBoxOptions } from 'electron'
import type { BusyReason } from './adapter-upgrade.mjs'
import type { StopOutcome } from './local-adapter.mjs'
import { readPreferences, writePreference } from './preferences.mjs'

/** ask：每次都问；keep：不问，留着它；stop：不问，一起关 */
export type ServiceQuitChoice = 'ask' | 'keep' | 'stop'

const CHOICES: readonly string[] = ['ask', 'keep', 'stop']
const KEY = 'quitService'

/** 选择记在用户数据目录下的 preferences.json 里（preferences.mts）。读不到、读不懂都当作“每次都问” */
export function readServiceQuitChoice(dataDir: string): ServiceQuitChoice {
  const saved = readPreferences(dataDir)[KEY]
  return CHOICES.includes(saved as string) ? (saved as ServiceQuitChoice) : 'ask'
}

export function writeServiceQuitChoice(dataDir: string, choice: ServiceQuitChoice): void {
  writePreference(dataDir, KEY, choice)
}

const WORDS = {
  'zh-CN': {
    message: '是否同时关闭后台服务？',
    detail:
      '后台服务关着时，定时任务不会运行；还没跑完的回合、设备上的终端会停下。' +
      '下次打开 Litch 会自动重新启动它。\n\n保留的话它在后台接着运行，上面这些都照常。',
    stop: '关闭后台服务',
    keep: '保留后台服务',
    cancel: '取消',
    remember: '记住我的选择，下次不再提醒',
    busy: '后台服务还在忙',
    busyDetail: (reasons: string) =>
      `${reasons}\n\n仍然关闭会把它们中断；也可以保留后台服务，让它们接着运行。`,
    force: '仍然关闭',
    turns: (names: string) => `${names} 有回合在跑`,
    someTurns: '有回合在跑',
    processes: (count: number) => `有 ${count} 个终端在设备上运行`,
    clients: (count: number) => `还有 ${count} 个别的客户端连着（比如手机或另一台电脑）`,
    unknown: '后台服务没有应答，判断不了它在做什么',
  },
  en: {
    message: 'Also stop the background service?',
    detail:
      'While it is stopped, scheduled tasks don’t run, and unfinished turns and device terminals stop. ' +
      'Litch starts it again the next time you open it.\n\n' +
      'If you keep it, it keeps running in the background and all of this carries on.',
    stop: 'Stop Background Service',
    keep: 'Keep It Running',
    cancel: 'Cancel',
    remember: 'Remember my choice and don’t ask again',
    busy: 'The background service is still busy',
    busyDetail: (reasons: string) =>
      `${reasons}\n\nStopping it now interrupts them. You can also keep the service running so they can finish.`,
    force: 'Stop Anyway',
    turns: (names: string) => `Turns are running in ${names}`,
    someTurns: 'Turns are running',
    processes: (count: number) =>
      count === 1
        ? 'A terminal is running on the device'
        : `${count} terminals are running on the device`,
    clients: (count: number) =>
      count === 1
        ? 'Another client is connected (a phone or another computer)'
        : `${count} other clients are connected (a phone or another computer)`,
    unknown: 'The background service didn’t answer, so it’s unclear what it is doing',
  },
} as const

type Lang = keyof typeof WORDS

/** 服务说的忙的原因，按界面的语言一条一行 */
export function describeBusy(lang: Lang, busy: readonly BusyReason[]): string {
  const words = WORDS[lang]
  const lines = busy.map((item) => {
    if (item.reason === 'activeTurns')
      return item.harnesses.length ? words.turns(item.harnesses.join(', ')) : words.someTurns
    if (item.reason === 'deviceProcesses') return words.processes(item.count)
    if (item.reason === 'clients') return words.clients(item.count)
    return words.unknown
  })
  return [...new Set(lines)].join('\n')
}

export interface ServiceQuitDeps {
  lang: Lang
  /** 本机连着的是不是 device-start 拉起的那份服务（问核心）。不是、问不到都是 false，那就不问 */
  stoppable(): Promise<boolean>
  choice(): ServiceQuitChoice
  remember(choice: 'keep' | 'stop'): void
  window(): BrowserWindow | null
  /** 自检时不弹窗：这里给出“用户点了什么”。不给就真的弹 */
  answer?: 'keep' | 'stop' | 'cancel'
}

/** 这一次问出来的结果 */
export interface ServiceQuitOutcome {
  /** 接着退出，还是用户说算了 */
  proceed: boolean
  /** 退出时要不要关后台服务 */
  stop: boolean
  /** 问没问（记住过选择、或者没有可关的服务，就不问） */
  asked: boolean
}

/** 退出之前走一遍：该问就问。关的事由调用方在应用真的退出时做（stopServiceOnQuit） */
export async function askServiceBeforeQuit(deps: ServiceQuitDeps): Promise<ServiceQuitOutcome> {
  if (!(await deps.stoppable())) return { proceed: true, stop: false, asked: false }
  const remembered = deps.choice()
  if (remembered !== 'ask') return { proceed: true, stop: remembered === 'stop', asked: false }
  const words = WORDS[deps.lang]
  const options: MessageBoxOptions = {
    type: 'question',
    message: words.message,
    detail: words.detail,
    buttons: [words.stop, words.keep, words.cancel],
    // 顺手按回车落在不关任何东西的那一项上
    defaultId: 1,
    cancelId: 2,
    checkboxLabel: words.remember,
    checkboxChecked: false,
  }
  let picked: number
  let remember = false
  if (deps.answer) {
    picked = { stop: 0, keep: 1, cancel: 2 }[deps.answer]
  } else {
    const window = deps.window()
    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
    picked = result.response
    remember = result.checkboxChecked
  }
  if (picked === 2) return { proceed: false, stop: false, asked: true }
  const did = picked === 0 ? 'stop' : 'keep'
  if (remember) deps.remember(did)
  return { proceed: true, stop: did === 'stop', asked: true }
}

export interface ServiceStopDeps {
  lang: Lang
  /** 请服务停下：ifIdle 为 true 时它忙就不停（device-stop --if-idle） */
  stop(ifIdle: boolean): Promise<StopOutcome>
  /** 自检时不弹窗：服务忙时“用户点了什么”。不给就真的弹 */
  answer?: 'force' | 'keep'
  log(line: string): void
}

/** 核心刚被结束，它和服务之间的连接可能还没断干净，服务会因此说自己忙：只是这个原因时隔一会儿再问 */
const LINGER_RETRIES = 3
const LINGER_WAIT_MS = 1000

/**
 * 应用真的要退出时把服务停下。闲着就停；忙（有回合、终端在跑，有别的客户端连着）就问一声，
 * 用户说仍然关闭才不管忙不忙地停。返回最后是怎么了结的，给日志和自检看
 */
export async function stopServiceOnQuit(
  deps: ServiceStopDeps,
): Promise<'stopped' | 'kept' | 'failed'> {
  let outcome = await deps.stop(true)
  for (let attempt = 1; outcome.kind === 'busy' && attempt < LINGER_RETRIES; attempt++) {
    if (!outcome.busy.every((item) => item.reason === 'clients')) break
    await new Promise((resolve) => setTimeout(resolve, LINGER_WAIT_MS))
    outcome = await deps.stop(true)
  }
  if (outcome.kind === 'busy') {
    const words = WORDS[deps.lang]
    let force: boolean
    if (deps.answer) force = deps.answer === 'force'
    else {
      const result = await dialog.showMessageBox({
        type: 'warning',
        message: words.busy,
        detail: words.busyDetail(describeBusy(deps.lang, outcome.busy)),
        buttons: [words.force, words.keep],
        defaultId: 1,
        cancelId: 1,
      })
      force = result.response === 0
    }
    if (!force) return 'kept'
    outcome = await deps.stop(false)
  }
  if (outcome.kind === 'stopped') return 'stopped'
  deps.log(`后台服务没停（${outcome.kind}）：${'detail' in outcome ? outcome.detail : ''}`)
  return 'failed'
}
