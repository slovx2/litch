// 退出应用之前：还有终端在运行的话问一声。
// 属于设备的终端退出之后可以留在设备上接着跑（下次打开时接回来），也可以现在结束；随连接结束的终端
// 一退出就没了，只能提醒。选过之后可以记住，以后不再问；在“文件”菜单里能改回每次都问。
// 主进程只知道“有几个”，终端里是什么它不知道：清点和结束都是问核心（见 core-host.mts）。
import { type BrowserWindow, dialog, type MessageBoxOptions } from 'electron'
import { readPreferences, writePreference } from './preferences.mjs'

/** ask：每次都问；leave：不问，留在设备上；end：不问，结束它们 */
export type QuitChoice = 'ask' | 'leave' | 'end'

export interface AliveCount {
  /** 属于设备、开成标签、还在跑的 */
  durable: number
  /** 随连接结束、还在跑的 */
  ephemeral: number
}

const CHOICES: readonly string[] = ['ask', 'leave', 'end']

/** 选择记在用户数据目录下的 preferences.json 里（preferences.mts）。读不到、读不懂都当作“每次都问” */
export function readQuitChoice(dataDir: string): QuitChoice {
  const saved = readPreferences(dataDir).quitTerminals
  return CHOICES.includes(saved as string) ? (saved as QuitChoice) : 'ask'
}

export function writeQuitChoice(dataDir: string, choice: QuitChoice): void {
  writePreference(dataDir, 'quitTerminals', choice)
}

const WORDS = {
  'zh-CN': {
    durable: (count: number) => `还有 ${count} 个终端在设备上运行`,
    durableDetail: '可以让它们留在设备上继续运行，下次打开时接回来；也可以现在就结束。',
    alsoEphemeral: (count: number) => `另有 ${count} 个终端跟着连接走，退出时会一起结束。`,
    ephemeral: (count: number) => `还有 ${count} 个终端在运行`,
    ephemeralDetail: '这些终端跟着连接走：退出应用，里面正在运行的程序会一起结束。',
    leave: '留在设备上',
    end: '结束它们',
    quit: '退出',
    cancel: '取消',
    remember: '记住我的选择，以后不再问（可以在“文件”菜单里改回来）',
  },
  en: {
    durable: (count: number) =>
      count === 1
        ? 'A terminal is still running on its device'
        : `${count} terminals are still running on their devices`,
    durableDetail:
      'They can keep running on the device and be picked up again next time, or be ended now.',
    alsoEphemeral: (count: number) =>
      count === 1
        ? 'Another terminal lives with the connection and will end when you quit.'
        : `${count} more terminals live with the connection and will end when you quit.`,
    ephemeral: (count: number) =>
      count === 1 ? 'A terminal is still running' : `${count} terminals are still running`,
    ephemeralDetail:
      'These terminals live with the connection: quitting ends whatever is running in them.',
    leave: 'Keep Running',
    end: 'End Them',
    quit: 'Quit',
    cancel: 'Cancel',
    remember: 'Remember my choice and don’t ask again (change it back in the File menu)',
  },
} as const

export interface QuitDeps {
  lang: 'zh-CN' | 'en'
  /** 问核心还有几个终端活着。核心没应答就是 null */
  count(): Promise<AliveCount | null>
  /** 让核心把开成标签、属于设备的终端都结束 */
  end(): Promise<void>
  choice(): QuitChoice
  remember(choice: QuitChoice): void
  window(): BrowserWindow | null
  /** 自检时不弹窗：这里给出“用户点了什么”。不给就真的弹 */
  answer?: 'leave' | 'end' | 'cancel'
}

/** 这一次问出来的结果，自检要看 */
export interface QuitOutcome {
  /** 接着退出，还是用户说算了 */
  proceed: boolean
  alive: AliveCount | null
  /** 问没问（记住过选择、或者没有终端活着，就不问） */
  asked: boolean
  /** 最后是怎么处置的。none：没有需要处置的 */
  did: 'none' | 'leave' | 'end' | 'cancel'
}

/** 退出之前走一遍：该问就问，该结束就结束。返回要不要接着退出 */
export async function settleTerminalsBeforeQuit(deps: QuitDeps): Promise<QuitOutcome> {
  const alive = await deps.count()
  if (!alive || alive.durable + alive.ephemeral === 0) {
    return { proceed: true, alive, asked: false, did: 'none' }
  }
  const words = WORDS[deps.lang]
  const remembered = deps.choice()
  let did: 'leave' | 'end' | 'cancel'
  let asked = false
  if (remembered !== 'ask') {
    did = remembered
  } else {
    asked = true
    // 没有属于设备的：留不住，只有“退出”和“取消”
    const keepable = alive.durable > 0
    const options: MessageBoxOptions = {
      type: 'question',
      message: keepable ? words.durable(alive.durable) : words.ephemeral(alive.ephemeral),
      detail: keepable
        ? [words.durableDetail, alive.ephemeral > 0 ? words.alsoEphemeral(alive.ephemeral) : '']
            .filter(Boolean)
            .join('\n\n')
        : words.ephemeralDetail,
      buttons: keepable ? [words.leave, words.end, words.cancel] : [words.quit, words.cancel],
      // 顺手按回车落在不结束任何东西的那一项上
      defaultId: keepable ? 0 : 1,
      cancelId: keepable ? 2 : 1,
      checkboxLabel: words.remember,
      checkboxChecked: false,
    }
    let picked: number
    let remember = false
    if (deps.answer) {
      picked = keepable
        ? { leave: 0, end: 1, cancel: 2 }[deps.answer]
        : deps.answer === 'cancel'
          ? 1
          : 0
    } else {
      const window = deps.window()
      const result = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options)
      picked = result.response
      remember = result.checkboxChecked
    }
    if (keepable) did = picked === 0 ? 'leave' : picked === 1 ? 'end' : 'cancel'
    else did = picked === 0 ? 'leave' : 'cancel'
    if (remember && did !== 'cancel') deps.remember(did)
  }
  if (did === 'cancel') return { proceed: false, alive, asked, did }
  if (did === 'end' && alive.durable > 0) await deps.end()
  return { proceed: true, alive, asked, did }
}
