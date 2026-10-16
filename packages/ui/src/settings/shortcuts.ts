// 快捷键的清单：设置页“快捷键”那一组照它画，它也是“现在到底有哪些键”的唯一一份记录。
// 键本身的处理散在各处（应用菜单、输入区、请求卡片、终端、文件树……），这里不接管它们，只登记；
// 两边不走样靠两道检查：
//   test/shortcuts.test.mjs  每一条的出处（source）里那段原文必须还在那个文件里：键改了、挪了，测试会指出是哪一条；
//   设置页的验收（apps/desktop/src/probe-settings-keys.mts）  拿真的应用菜单来对：菜单里带键的每一项这里都有、键一样，
//   这里说在菜单里的每一条菜单里也确实有。
// 加一个快捷键、改一个键位，要回来改这里的那一条；这个文件只用可擦除的语法，测试直接引它。
import type { Platform } from '../app/platform.ts'

export const SHORTCUT_GROUPS = [
  'app',
  'edit',
  'composer',
  'request',
  'terminal',
  'files',
  'common',
] as const
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number]

/**
 * 一种按法，用加号连起来：修饰键在前，键在后。Mod 是主修饰键（macOS 上是 Cmd，别处是 Ctrl）；
 * 加号这个键写成 Plus。一条快捷键可以有几种按法（数组里的几项是“或”）
 */
type Combos = readonly string[]

export interface Shortcut {
  id: string
  group: ShortcutGroup
  /** 各系统上一样的直接给；不一样的分开给，空的表示那种系统上没有这个键 */
  keys: Combos | Readonly<Record<Platform, Combos>>
  /** 它在应用菜单里的那一项：`id:标识` 或 `role:角色`（Electron 自带角色的键是它默认的） */
  menu?: string
  /** 出处：文件（相对仓库根目录）和那里搜得到的一段原文 */
  source: readonly { file: string; has: string }[]
}

const MENU = 'apps/desktop/src/menu.mts'
const UI = 'packages/ui/src'
const role = (name: string) => ({ file: MENU, has: `role: '${name}'` })

export const SHORTCUTS = [
  // ---------- 应用与窗口 ----------
  {
    id: 'settings',
    group: 'app',
    keys: ['Mod+,'],
    menu: 'id:settings.open',
    source: [
      { file: MENU, has: "accelerator: 'CmdOrCtrl+,'" },
      { file: `${UI}/app/App.tsx`, has: "event.key !== ','" },
    ],
  },
  {
    id: 'newSession',
    group: 'app',
    keys: ['Mod+N'],
    source: [{ file: `${UI}/app/App.tsx`, has: "event.key.toLowerCase() !== 'n'" }],
  },
  {
    id: 'sidebar',
    group: 'app',
    // 带 Shift：Linux 和 Windows 上 Ctrl+B 是终端里常用的键
    keys: ['Mod+Shift+B'],
    menu: 'id:sidebar.toggle',
    source: [
      { file: MENU, has: "accelerator: 'CmdOrCtrl+Shift+B'" },
      {
        file: `${UI}/sidebar/SidebarFrame.tsx`,
        has: "event.shiftKey && !event.altKey && event.code === 'KeyB'",
      },
    ],
  },
  {
    id: 'terminal',
    group: 'app',
    // macOS 上也是 Ctrl：Cmd+` 是系统切换窗口的
    keys: ['Ctrl+`'],
    menu: 'id:terminal.toggle',
    source: [
      { file: MENU, has: "accelerator: 'Ctrl+`'" },
      { file: `${UI}/terminal/TerminalSlot.tsx`, has: "event.code === 'Backquote'" },
    ],
  },
  {
    id: 'side',
    group: 'app',
    keys: ['Mod+Alt+B'],
    menu: 'id:side.toggle',
    source: [
      { file: MENU, has: "accelerator: 'CmdOrCtrl+Alt+B'" },
      { file: `${UI}/side/SideSlot.tsx`, has: "event.code === 'KeyB'" },
    ],
  },
  {
    id: 'zoomIn',
    group: 'app',
    keys: ['Mod+Plus', 'Mod+='],
    menu: 'id:zoom.in',
    source: [
      { file: MENU, has: "accelerator: 'CmdOrCtrl+Plus'" },
      { file: MENU, has: "accelerator: 'CmdOrCtrl+='" },
    ],
  },
  {
    id: 'zoomOut',
    group: 'app',
    keys: ['Mod+-'],
    menu: 'id:zoom.out',
    source: [{ file: MENU, has: "accelerator: 'CmdOrCtrl+-'" }],
  },
  {
    id: 'zoomReset',
    group: 'app',
    keys: ['Mod+0'],
    menu: 'id:zoom.reset',
    source: [{ file: MENU, has: "accelerator: 'CmdOrCtrl+0'" }],
  },
  {
    id: 'fullscreen',
    group: 'app',
    keys: { mac: ['Ctrl+Cmd+F'], win: ['F11'], linux: ['F11'] },
    menu: 'role:togglefullscreen',
    source: [role('togglefullscreen')],
  },
  {
    id: 'closeWindow',
    group: 'app',
    keys: ['Mod+W'],
    menu: 'role:close',
    source: [role('close')],
  },
  {
    id: 'minimize',
    group: 'app',
    keys: ['Mod+M'],
    menu: 'role:minimize',
    source: [role('minimize')],
  },
  {
    id: 'hide',
    group: 'app',
    keys: { mac: ['Cmd+H'], win: [], linux: [] },
    menu: 'role:hide',
    source: [role('hide')],
  },
  {
    id: 'hideOthers',
    group: 'app',
    keys: { mac: ['Cmd+Alt+H'], win: [], linux: [] },
    menu: 'role:hideothers',
    source: [role('hideOthers')],
  },
  {
    id: 'quit',
    group: 'app',
    // Windows 上这一项没有键，关窗口就是退出
    keys: { mac: ['Cmd+Q'], win: [], linux: ['Ctrl+Q'] },
    menu: 'role:quit',
    source: [role('quit')],
  },

  // ---------- 编辑 ----------
  { id: 'undo', group: 'edit', keys: ['Mod+Z'], menu: 'role:undo', source: [role('undo')] },
  {
    id: 'redo',
    group: 'edit',
    keys: { mac: ['Shift+Cmd+Z'], win: ['Ctrl+Y'], linux: ['Shift+Ctrl+Z'] },
    menu: 'role:redo',
    source: [role('redo')],
  },
  { id: 'cut', group: 'edit', keys: ['Mod+X'], menu: 'role:cut', source: [role('cut')] },
  { id: 'copy', group: 'edit', keys: ['Mod+C'], menu: 'role:copy', source: [role('copy')] },
  { id: 'paste', group: 'edit', keys: ['Mod+V'], menu: 'role:paste', source: [role('paste')] },
  {
    id: 'pastePlain',
    group: 'edit',
    keys: { mac: ['Cmd+Alt+Shift+V'], win: ['Shift+Ctrl+V'], linux: ['Shift+Ctrl+V'] },
    menu: 'role:pasteandmatchstyle',
    source: [role('pasteAndMatchStyle')],
  },
  {
    id: 'selectAll',
    group: 'edit',
    keys: ['Mod+A'],
    menu: 'role:selectall',
    source: [role('selectAll')],
  },

  // ---------- 输入区 ----------
  {
    id: 'send',
    group: 'composer',
    keys: ['Enter'],
    source: [
      { file: `${UI}/composer/Composer.tsx`, has: "event.key !== 'Enter' || event.shiftKey" },
    ],
  },
  {
    id: 'newline',
    group: 'composer',
    keys: ['Shift+Enter'],
    source: [
      { file: `${UI}/composer/Composer.tsx`, has: "event.key !== 'Enter' || event.shiftKey" },
    ],
  },
  {
    id: 'history',
    group: 'composer',
    keys: ['Up', 'Down'],
    source: [{ file: `${UI}/composer/Composer.tsx`, has: 'area.selectionStart === 0' }],
  },
  {
    id: 'suggestMove',
    group: 'composer',
    keys: ['Up', 'Down'],
    source: [
      {
        file: `${UI}/composer/Suggest.tsx`,
        has: "event.key === 'ArrowDown' || event.key === 'ArrowUp'",
      },
    ],
  },
  {
    id: 'suggestTake',
    group: 'composer',
    keys: ['Enter', 'Tab'],
    source: [
      {
        file: `${UI}/composer/Suggest.tsx`,
        has: "(event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey",
      },
    ],
  },
  {
    id: 'suggestClose',
    group: 'composer',
    keys: ['Esc'],
    source: [{ file: `${UI}/composer/Suggest.tsx`, has: "if (event.key === 'Escape') {" }],
  },

  // ---------- 请求卡片：审批、提问、表单 ----------
  {
    id: 'approve',
    group: 'request',
    keys: ['Enter'],
    source: [{ file: `${UI}/composer/RequestCard.tsx`, has: "event.key === 'Enter' ? primary" }],
  },
  {
    id: 'decline',
    group: 'request',
    keys: ['Esc'],
    source: [
      { file: `${UI}/composer/RequestCard.tsx`, has: "event.key === 'Escape' ? refuse" },
      { file: `${UI}/composer/FormCard.tsx`, has: "event.key === 'Escape'" },
    ],
  },
  {
    id: 'pickOption',
    group: 'request',
    keys: ['1–9'],
    source: [{ file: `${UI}/composer/QuestionCard.tsx`, has: '/^[1-9]$/.test(key)' }],
  },
  {
    id: 'moveOption',
    group: 'request',
    keys: ['Up', 'Down'],
    source: [
      { file: `${UI}/composer/QuestionCard.tsx`, has: "key === 'ArrowUp' || key === 'ArrowDown'" },
    ],
  },
  {
    id: 'turnQuestion',
    group: 'request',
    keys: ['Left', 'Right'],
    source: [
      {
        file: `${UI}/composer/QuestionCard.tsx`,
        has: "key === 'ArrowLeft' || key === 'ArrowRight'",
      },
    ],
  },
  {
    id: 'answer',
    group: 'request',
    keys: ['Enter'],
    source: [
      { file: `${UI}/composer/QuestionCard.tsx`, has: "if (key === 'Enter') {" },
      { file: `${UI}/composer/FormCard.tsx`, has: "event.key === 'Enter' && !link" },
    ],
  },

  // ---------- 终端 ----------
  {
    id: 'termClear',
    group: 'terminal',
    keys: { mac: ['Cmd+K'], win: [], linux: [] },
    source: [{ file: `${UI}/terminal/session.ts`, has: "key === 'k'" }],
  },
  {
    id: 'termCopy',
    group: 'terminal',
    // macOS 上就是“编辑”里的拷贝；别处 Ctrl+C 是给程序的中断键，选中了字的时候才是复制
    keys: { mac: [], win: ['Ctrl+Shift+C', 'Ctrl+C'], linux: ['Ctrl+Shift+C', 'Ctrl+C'] },
    source: [
      {
        file: `${UI}/terminal/session.ts`,
        has: "key === 'c' && (event.shiftKey || this.term.hasSelection())",
      },
    ],
  },
  {
    id: 'termPaste',
    group: 'terminal',
    keys: { mac: [], win: ['Ctrl+V'], linux: ['Ctrl+V'] },
    source: [{ file: `${UI}/terminal/session.ts`, has: "if (key === 'v') return false" }],
  },
  {
    id: 'termHeight',
    group: 'terminal',
    keys: ['Up', 'Down'],
    source: [{ file: `${UI}/terminal/TerminalPanel.tsx`, has: '{ ArrowUp: 24, ArrowDown: -24 }' }],
  },

  // ---------- 侧面板与文件 ----------
  {
    id: 'sideWidth',
    group: 'files',
    keys: ['Left', 'Right'],
    source: [
      { file: `${UI}/sidebar/SidebarFrame.tsx`, has: '{ ArrowLeft: -24, ArrowRight: 24 }' },
      { file: `${UI}/side/SidePanel.tsx`, has: '{ ArrowLeft: 24, ArrowRight: -24 }' },
      { file: `${UI}/files/FilesTab.tsx`, has: '{ ArrowLeft: -16, ArrowRight: 16 }' },
    ],
  },
  {
    id: 'treeMove',
    group: 'files',
    keys: ['Up', 'Down'],
    source: [{ file: `${UI}/files/nav.ts`, has: "case 'ArrowDown':" }],
  },
  {
    id: 'treeFold',
    group: 'files',
    keys: ['Left', 'Right'],
    source: [
      { file: `${UI}/files/nav.ts`, has: "case 'ArrowRight': {" },
      { file: `${UI}/files/nav.ts`, has: "case 'ArrowLeft': {" },
    ],
  },
  {
    id: 'treeEnds',
    group: 'files',
    keys: ['Home', 'End'],
    source: [
      { file: `${UI}/files/nav.ts`, has: "case 'Home':" },
      { file: `${UI}/files/nav.ts`, has: "case 'End':" },
    ],
  },
  {
    id: 'treePage',
    group: 'files',
    keys: ['PageUp', 'PageDown'],
    source: [
      { file: `${UI}/files/nav.ts`, has: "case 'PageUp': {" },
      { file: `${UI}/files/nav.ts`, has: "case 'PageDown': {" },
    ],
  },
  {
    id: 'treeOpen',
    group: 'files',
    keys: ['Enter'],
    source: [{ file: `${UI}/files/nav.ts`, has: "key === 'Enter' ? 'open' : 'preview'" }],
  },
  {
    id: 'treePreview',
    group: 'files',
    keys: ['Space'],
    source: [{ file: `${UI}/files/nav.ts`, has: "case ' ': {" }],
  },
  {
    id: 'treeMenu',
    group: 'files',
    keys: ['Shift+F10', 'Menu'],
    source: [{ file: `${UI}/files/FileTree.tsx`, has: "event.key === 'ContextMenu'" }],
  },
  {
    id: 'searchMove',
    group: 'files',
    keys: ['Up', 'Down'],
    source: [{ file: `${UI}/files/FilesTab.tsx`, has: "event.key === 'ArrowDown' ? 1 : -1" }],
  },
  {
    id: 'searchOpen',
    group: 'files',
    keys: ['Enter'],
    source: [{ file: `${UI}/files/FilesTab.tsx`, has: 'take(match, true)' }],
  },
  {
    id: 'searchClear',
    group: 'files',
    keys: ['Esc'],
    source: [
      { file: `${UI}/files/FilesTab.tsx`, has: 'if (!query) return' },
      { file: `${UI}/diff/ChangedTree.tsx`, has: "event.key !== 'Escape' || query === ''" },
    ],
  },
  {
    id: 'noteSave',
    group: 'files',
    keys: ['Mod+Enter'],
    source: [
      {
        file: `${UI}/diff/Notes.tsx`,
        has: "event.key === 'Enter' && (event.metaKey || event.ctrlKey)",
      },
    ],
  },
  {
    id: 'noteDrop',
    group: 'files',
    keys: ['Esc'],
    source: [{ file: `${UI}/diff/Notes.tsx`, has: "if (event.key === 'Escape') {" }],
  },

  // ---------- 到处都一样的 ----------
  {
    id: 'pageBack',
    group: 'common',
    keys: ['Esc'],
    source: [
      { file: `${UI}/devices/DevicesPage.tsx`, has: "event.key !== 'Escape'" },
      { file: `${UI}/devices/DeviceDetail.tsx`, has: "document.querySelector('dialog[open]')" },
      { file: `${UI}/archived/ArchivedPage.tsx`, has: "event.key !== 'Escape'" },
      { file: `${UI}/archived/ArchivedSession.tsx`, has: "event.key !== 'Escape'" },
      { file: `${UI}/settings/SettingsPage.tsx`, has: "event.key !== 'Escape'" },
    ],
  },
  {
    id: 'menuMove',
    group: 'common',
    keys: ['Up', 'Down', 'Home', 'End'],
    source: [
      { file: `${UI}/app/popover.ts`, has: '{ ArrowDown: 1, ArrowUp: -1 }' },
      { file: `${UI}/app/popover.ts`, has: "event.key !== 'Home' && event.key !== 'End'" },
      { file: `${UI}/files/ContextMenu.tsx`, has: '{ ArrowDown: 1, ArrowUp: -1 }' },
    ],
  },
  {
    id: 'dismiss',
    group: 'common',
    keys: ['Esc'],
    source: [
      { file: `${UI}/app/popover.ts`, has: "event.key === 'Escape'" },
      { file: `${UI}/files/ContextMenu.tsx`, has: "event.key === 'Escape'" },
      { file: `${UI}/app/Confirm.tsx`, has: 'showModal()' },
      { file: `${UI}/app/HoverCard.tsx`, has: "event.key === 'Escape'" },
      { file: `${UI}/app/toasts.tsx`, has: "event.key !== 'Escape'" },
    ],
  },
  {
    id: 'renameDone',
    group: 'common',
    keys: ['Enter'],
    source: [
      { file: `${UI}/sidebar/Sidebar.tsx`, has: "event.key === 'Enter') rename(true)" },
      { file: `${UI}/terminal/TerminalTabs.tsx`, has: "event.key === 'Enter') finish(true)" },
      { file: `${UI}/devices/DeviceDetail.tsx`, has: "event.key === 'Enter') rename(true)" },
    ],
  },
  {
    id: 'renameDrop',
    group: 'common',
    keys: ['Esc'],
    source: [
      { file: `${UI}/sidebar/Sidebar.tsx`, has: "event.key === 'Escape') rename(false)" },
      { file: `${UI}/terminal/TerminalTabs.tsx`, has: "event.key === 'Escape'" },
    ],
  },
] as const satisfies readonly Shortcut[]

export type ShortcutId = (typeof SHORTCUTS)[number]['id']

/** 这条快捷键在这种系统上的几种按法。没有就是空的 */
export function combosOn(shortcut: Shortcut, platform: Platform): readonly string[] {
  const { keys } = shortcut
  return (Array.isArray as (value: unknown) => value is readonly string[])(keys)
    ? keys
    : (keys as Readonly<Record<Platform, Combos>>)[platform]
}

/** 键帽上写什么。方向键画成箭头；修饰键写名字，macOS 上的 Alt 叫 Option */
const CAPS: Record<string, string> = {
  Plus: '+',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
}

/** 一种按法拆成一个个键帽上的字 */
export function capsOf(combo: string, platform: Platform): string[] {
  return combo.split('+').map((part) => {
    if (part === 'Mod') return platform === 'mac' ? 'Cmd' : 'Ctrl'
    if (part === 'Alt') return platform === 'mac' ? 'Option' : 'Alt'
    return CAPS[part] ?? part
  })
}

/**
 * 一种按法写成能比的样子：修饰键换成这种系统上的那一个、排好顺序、全小写。
 * 应用菜单的加速键（Electron 的写法：CmdOrCtrl+Alt+B、Control+Command+F）和这里的写法都换成它再比
 */
export function canonical(combo: string, platform: Platform): string {
  const names: Record<string, string> = {
    mod: platform === 'mac' ? 'cmd' : 'ctrl',
    cmdorctrl: platform === 'mac' ? 'cmd' : 'ctrl',
    commandorcontrol: platform === 'mac' ? 'cmd' : 'ctrl',
    command: 'cmd',
    control: 'ctrl',
    option: 'alt',
    plus: '+',
  }
  const parts = combo.split('+').map((part) => names[part.toLowerCase()] ?? part.toLowerCase())
  const key = parts.pop() ?? ''
  return [...parts.sort(), key].join('+')
}
