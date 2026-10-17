// 界面这一头所有开着的终端（session.ts）放在哪、谁在台上。
// 它们都挂在同一个“台子”元素里，台子由面板组件接到页面上；不在台上的只是看不见，没有被拆掉。
// 一个终端第一次被点到才建：应用刚打开时，设备上恢复出来的那些标签不会各自去取一遍输出。
import {
  type CoreChannel,
  keys,
  type Replica,
  type TerminalInfo,
  type TerminalMark,
} from '@litch/core'
import { currentLang } from '../app/appearance.ts'
import { currentPlatform } from '../app/platform.ts'
import { showToast } from '../app/toasts.tsx'
import { translator } from '../i18n/index.ts'
import type { LinkClick } from '../side/browser/link-logic.ts'
import { clickLink } from '../side/browser/links.ts'
import { latestOnly } from './latest.ts'
import { fontsReady, type Look, readLook, sizeText } from './look.ts'
import { TerminalSession } from './session.ts'

interface Entry {
  session: TerminalSession
  deviceId: string
  terminalId: string
  /** 不再盯着它在列表里的那一项 */
  unwatch(): void
}

export interface TerminalSessions {
  /** 所有终端都挂在它里面。面板把它接到页面上 */
  readonly stage: HTMLDivElement
  /** 让这个终端上台（没建过就建），别的都下去。null：谁都不上 */
  show(deviceId: string, terminalId: string | null): TerminalSession | null
  /** 现在在台上的那个 */
  current(): TerminalSession | null
  /** 把键盘焦点放进台上的那个。它还没画出来的话，等画出来再放 */
  focus(): void
  peek(deviceId: string, terminalId: string): TerminalSession | undefined
  /** 台子的大小变了，或者刚显示出来 */
  refit(): void
  /** 皮肤、明暗变了：配色和字体重读一遍 */
  restyle(): void
  /** 新开一个终端该报多大。有台上的就照它的；没有就按字号估一个，开起来之后再对 */
  sizeHint(): { rows: number; cols: number }
  /** 开着的终端一共几个。自检用 */
  count(): number
}

const keyOf = (deviceId: string, terminalId: string): string => `${deviceId}\n${terminalId}`

export function createTerminalSessions(options: {
  channel: CoreChannel
  replica: Replica
}): TerminalSessions {
  const { channel, replica } = options
  const stage = document.createElement('div')
  stage.className = 'term-stage'
  const entries = new Map<string, Entry>()
  let active: Entry | null = null
  let look: Look | null = null
  /** 有人要把焦点放进来，而台上的那个还没画出来 */
  let focusPending = false
  /** 换外观时等字体的那一步：连着换了几次，只让最后一次落地 */
  const whenFontsReady = latestOnly()
  const mac = currentPlatform() === 'mac'

  const lookNow = (): Look => {
    look ??= readLook(stage.isConnected ? stage : document.body)
    return look
  }

  const nameOf = (info: TerminalInfo | undefined, t: ReturnType<typeof translator>): string =>
    info?.title ?? t('terminal.defaultName', { n: info?.seq ?? 1 })

  // 和对话里的链接一样默认在内置浏览器里开（side/browser/links.ts）；终端在别的设备上、按着 Cmd/Ctrl 之类交给系统的浏览器，
  // 普通浏览器里的预览开一个新标签页
  const openLink = (deviceId: string) => (uri: string, click: LinkClick) => {
    if (!clickLink(uri, click, deviceId)) window.open(uri, '_blank', 'noopener,noreferrer')
  }

  const gapText = (mark: TerminalMark): string => {
    const t = translator(currentLang())
    return t(mark.kind === 'rejoined' ? 'terminal.gap.rejoined' : 'terminal.gap', {
      size: sizeText(mark.missed),
    })
  }

  const remove = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    entry.unwatch()
    if (active === entry) active = null
    entry.session.dispose()
  }

  const create = (deviceId: string, terminalId: string): Entry | null => {
    const infoKey = keys.terminal(deviceId, terminalId)
    const info = replica.store.get<TerminalInfo>(infoKey)
    if (!info) return null
    const key = keyOf(deviceId, terminalId)
    const session = new TerminalSession({
      channel,
      deviceId,
      terminalId,
      rows: info.rows,
      cols: info.cols,
      look: lookNow(),
      mac,
      openLink: openLink(deviceId),
      gapText,
      gapNotice(mark) {
        showToast({
          id: `terminal-gap:${key}`,
          text: (t) =>
            t('terminal.gap.toast', {
              name: nameOf(replica.store.get<TerminalInfo>(infoKey), t),
              size: sizeText(mark.missed),
            }),
          lifeMs: 6000,
        })
      },
    })
    session.setState(info.state)
    stage.appendChild(session.host)
    // 列表里这一项变了就跟着变；没了（关掉、在别处被清掉）就把这一头的也拆掉
    const unwatch = replica.store.subscribe(infoKey, () => {
      const next = replica.store.get<TerminalInfo>(infoKey)
      if (!next) remove(key)
      else session.setState(next.state)
    })
    const entry: Entry = { session, deviceId, terminalId, unwatch }
    entries.set(key, entry)
    return entry
  }

  /** 台子现在看不看得见：面板收起的时候它没有大小，这时候量不了字宽 */
  const visible = (): boolean => stage.isConnected && stage.clientHeight > 0

  /** 让台上的这个按台子现在的大小摆好。第一次要等字体到了再画：先按后备字体量的话，列数会算错 */
  const settle = (entry: Entry) => {
    if (!visible()) return
    const { session, deviceId, terminalId } = entry
    const sync = () => {
      const info = replica.store.get<TerminalInfo>(keys.terminal(deviceId, terminalId))
      if (info) session.syncSize(info.rows, info.cols)
    }
    if (session.opened) {
      session.fit()
      sync()
      return
    }
    void fontsReady(lookNow()).then(() => {
      if (active !== entry || !visible()) return
      session.open()
      session.fit()
      sync()
      if (focusPending) session.focus()
      focusPending = false
    })
  }

  const sessions: TerminalSessions = {
    stage,

    show(deviceId, terminalId) {
      const next =
        terminalId === null
          ? null
          : (entries.get(keyOf(deviceId, terminalId)) ?? create(deviceId, terminalId))
      if (active && active !== next) active.session.host.classList.remove('on')
      active = next
      if (!next) return null
      next.session.host.classList.add('on')
      settle(next)
      return next.session
    },

    current: () => active?.session ?? null,

    focus() {
      if (active?.session.opened) active.session.focus()
      else focusPending = true
    },

    peek: (deviceId, terminalId) => entries.get(keyOf(deviceId, terminalId))?.session,

    refit() {
      if (active) settle(active)
    },

    restyle() {
      look = null
      const next = lookNow()
      // 颜色不用等字体，马上换
      for (const entry of entries.values()) entry.session.setTheme(next.theme)
      // 字体要等它的文件到了再换（不然量出来的字宽是后备字体的）。等的这一会儿里又换过外观的话，以后换的为准
      whenFontsReady(fontsReady(next), () => {
        for (const entry of entries.values()) entry.session.setFont(next)
        active?.session.fit()
      })
    },

    sizeHint() {
      const term = active?.session.opened ? active.session.term : null
      if (term) return { rows: term.rows, cols: term.cols }
      const { fontSize, lineHeight } = lookNow()
      const width = stage.clientWidth || 800
      const height = stage.clientHeight || 200
      // 等宽字一格大约是字号的六成宽
      return {
        rows: Math.max(2, Math.floor(height / Math.ceil(fontSize * lineHeight))),
        cols: Math.max(20, Math.floor(width / (fontSize * 0.6))),
      }
    },

    count: () => entries.size,
  }
  return sessions
}
