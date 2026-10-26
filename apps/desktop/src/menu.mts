// 应用菜单。Electron 自带的那一份是英文的，还带着“重新加载”“开发者工具”和指向 Electron 网站的帮助，
// 不是给用这个应用的人准备的：这里按界面的语言自己排一份，只留用得上的。
// 系统自己往菜单里加的几项（听写、表情与符号、窗口排列）跟的是系统语言，管不了。
import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  shell,
  type WebContents,
} from 'electron'

export type MenuLang = 'zh-CN' | 'en'

const HOME = 'https://github.com/slovx2/litch'

const WORDS = {
  'zh-CN': {
    about: '关于 {name}',
    settings: '设置…',
    services: '服务',
    hide: '隐藏 {name}',
    hideOthers: '隐藏其他',
    unhide: '全部显示',
    quit: '退出 {name}',
    file: '文件',
    close: '关闭窗口',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '拷贝',
    paste: '粘贴',
    pasteAndMatchStyle: '粘贴并匹配样式',
    delete: '删除',
    selectAll: '全选',
    view: '显示',
    resetZoom: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    fullscreen: '切换全屏',
    sidebar: '侧栏',
    terminal: '终端',
    side: '侧面板',
    askOnQuit: '退出时询问正在运行的终端',
    askServiceOnQuit: '退出时询问是否关闭后台服务',
    reload: '重新加载',
    devTools: '开发者工具',
    window: '窗口',
    minimize: '最小化',
    zoom: '缩放',
    front: '前置全部窗口',
    help: '帮助',
    home: '{name} 项目主页',
    issues: '反馈问题',
    checkUpdates: '检查更新…',
  },
  en: {
    about: 'About {name}',
    settings: 'Settings…',
    services: 'Services',
    hide: 'Hide {name}',
    hideOthers: 'Hide Others',
    unhide: 'Show All',
    quit: 'Quit {name}',
    file: 'File',
    close: 'Close Window',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    pasteAndMatchStyle: 'Paste and Match Style',
    delete: 'Delete',
    selectAll: 'Select All',
    view: 'View',
    resetZoom: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    fullscreen: 'Toggle Full Screen',
    sidebar: 'Sidebar',
    terminal: 'Terminal',
    side: 'Side Panel',
    askOnQuit: 'Ask About Running Terminals on Quit',
    askServiceOnQuit: 'Ask About the Background Service on Quit',
    reload: 'Reload',
    devTools: 'Developer Tools',
    window: 'Window',
    minimize: 'Minimize',
    zoom: 'Zoom',
    front: 'Bring All to Front',
    help: 'Help',
    home: '{name} on GitHub',
    issues: 'Report an Issue',
    checkUpdates: 'Check for Updates…',
  },
} as const

type Word = keyof (typeof WORDS)['en']

/** “终端”“侧面板”两项在菜单里的标识。标识是给验收找这一项用的 */
export const TERMINAL_ITEM = 'terminal.toggle'
export const SIDE_ITEM = 'side.toggle'
/** “侧栏”那一项在菜单里的标识 */
export const SIDEBAR_ITEM = 'sidebar.toggle'
/** “设置…”和“关于”两项的标识。点了都是打开设置页，后一个直接到“关于”那一组 */
export const SETTINGS_ITEM = 'settings.open'
export const ABOUT_ITEM = 'settings.about'
export const CHECK_UPDATES_ITEM = 'update.check'
/** “显示”里管缩放的三项。缩放有哪几档、走到哪一档由界面定（它记着），这里只转告点的是哪一项 */
export const ZOOM_ITEMS = { in: 'zoom.in', out: 'zoom.out', reset: 'zoom.reset' } as const

/** 菜单里要主进程来办的几项 */
export interface MenuHooks {
  /** 开合左边的侧栏：转给眼前的窗口 */
  toggleSidebar(): void
  /** 开合终端面板：转给眼前的窗口 */
  toggleTerminal(): void
  /** 开合右边的侧面板（文件）：转给眼前的窗口 */
  toggleSide(): void
  /** 打开设置页：转给眼前的窗口。about：直接到“关于”那一组 */
  openSettings(section?: 'about'): void
  /** 界面缩放往大、往小走一档，或者回到 100%：转给眼前的窗口 */
  zoom(step: 'in' | 'out' | 'reset'): void
  /** 退出时还有终端在运行，问不问 */
  askOnQuit(): boolean
  setAskOnQuit(ask: boolean): void
  /** 退出时要不要一起关后台服务，问不问 */
  askServiceOnQuit(): boolean
  setAskServiceOnQuit(ask: boolean): void
  /** 检查更新：打开“关于”并现在查一次。这台机器不出更新（没打包、平台没有包）时是 null，菜单里不放这一项 */
  checkUpdates: (() => void) | null
}

/** 按这种语言排好菜单并装上。语言变了再调一次 */
export function installMenu(lang: MenuLang, hooks: MenuHooks): void {
  const say = (word: Word) => WORDS[lang][word].replace('{name}', app.name)
  const mac = process.platform === 'darwin'
  const line: MenuItemConstructorOptions = { type: 'separator' }
  // macOS 上在应用自己的菜单里，别的平台在“文件”里；键都是“主修饰键加逗号”
  const settings: MenuItemConstructorOptions = {
    id: SETTINGS_ITEM,
    label: say('settings'),
    accelerator: 'CmdOrCtrl+,',
    click: () => hooks.openSettings(),
  }
  // 系统自带的“关于”面板只有名字和版本；应用里的那一页还有许可文本和项目主页
  const about: MenuItemConstructorOptions = {
    id: ABOUT_ITEM,
    label: say('about'),
    click: () => hooks.openSettings('about'),
  }

  const checkUpdates: MenuItemConstructorOptions[] = hooks.checkUpdates
    ? [{ id: CHECK_UPDATES_ITEM, label: say('checkUpdates'), click: hooks.checkUpdates }]
    : []

  const template: MenuItemConstructorOptions[] = [
    // macOS 上第一个菜单是应用自己的菜单，标题由系统写成应用的名字
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              about,
              ...checkUpdates,
              line,
              settings,
              line,
              { role: 'services', label: say('services') },
              line,
              { role: 'hide', label: say('hide') },
              { role: 'hideOthers', label: say('hideOthers') },
              { role: 'unhide', label: say('unhide') },
              line,
              { role: 'quit', label: say('quit') },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: say('file'),
      submenu: [
        { role: 'close', label: say('close') },
        line,
        ...(mac ? [] : [settings, line]),
        // 记住了“留着”或者“结束”之后，在这里改回每次都问
        {
          type: 'checkbox',
          label: say('askOnQuit'),
          checked: hooks.askOnQuit(),
          click: (item) => hooks.setAskOnQuit(item.checked),
        },
        // 记住了“关闭”或者“保留”之后，在这里改回每次都问
        {
          type: 'checkbox',
          label: say('askServiceOnQuit'),
          checked: hooks.askServiceOnQuit(),
          click: (item) => hooks.setAskServiceOnQuit(item.checked),
        },
        ...(mac ? [] : [line, { role: 'quit', label: say('quit') } as const]),
      ],
    },
    {
      label: say('edit'),
      submenu: [
        { role: 'undo', label: say('undo') },
        { role: 'redo', label: say('redo') },
        line,
        { role: 'cut', label: say('cut') },
        { role: 'copy', label: say('copy') },
        { role: 'paste', label: say('paste') },
        { role: 'pasteAndMatchStyle', label: say('pasteAndMatchStyle') },
        { role: 'delete', label: say('delete') },
        { role: 'selectAll', label: say('selectAll') },
      ],
    },
    {
      label: say('view'),
      submenu: [
        // 不用 Electron 自带的那三项：缩放是外观的一项，记在界面那边（设置页里也能改），
        // 自带的会绕过它直接改页面，两边就对不上了
        {
          id: ZOOM_ITEMS.reset,
          label: say('resetZoom'),
          accelerator: 'CmdOrCtrl+0',
          click: () => hooks.zoom('reset'),
        },
        {
          id: ZOOM_ITEMS.in,
          label: say('zoomIn'),
          accelerator: 'CmdOrCtrl+Plus',
          click: () => hooks.zoom('in'),
        },
        // 加号要按着 Shift 才打得出来，等号不用：这一项不显示，只为了让不按 Shift 的那个键也管用
        {
          id: `${ZOOM_ITEMS.in}.plain`,
          label: say('zoomIn'),
          accelerator: 'CmdOrCtrl+=',
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: () => hooks.zoom('in'),
        },
        {
          id: ZOOM_ITEMS.out,
          label: say('zoomOut'),
          accelerator: 'CmdOrCtrl+-',
          click: () => hooks.zoom('out'),
        },
        line,
        { role: 'togglefullscreen', label: say('fullscreen') },
        line,
        {
          // 带 Shift：Linux 和 Windows 上 Ctrl+B 是终端里常用的键，不能占
          id: SIDEBAR_ITEM,
          label: say('sidebar'),
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => hooks.toggleSidebar(),
        },
        // macOS 上也用 Ctrl：Cmd+` 是系统切换窗口的
        {
          id: TERMINAL_ITEM,
          label: say('terminal'),
          accelerator: 'Ctrl+`',
          click: () => hooks.toggleTerminal(),
        },
        {
          // 标识是给验收找这一项用的
          id: SIDE_ITEM,
          label: say('side'),
          accelerator: 'CmdOrCtrl+Alt+B',
          click: () => hooks.toggleSide(),
        },
        // 重新加载和开发者工具只在开发时有，装好的应用里不放
        ...(app.isPackaged
          ? []
          : [
              line,
              { role: 'reload', label: say('reload') } as const,
              { role: 'toggleDevTools', label: say('devTools') } as const,
            ]),
      ],
    },
    {
      // 标上 window，系统才会把开着的窗口列在这个菜单里
      role: 'window',
      label: say('window'),
      submenu: [
        { role: 'minimize', label: say('minimize') },
        { role: 'zoom', label: say('zoom') },
        ...(mac ? [line, { role: 'front', label: say('front') } as const] : []),
      ],
    },
    {
      role: 'help',
      label: say('help'),
      submenu: [
        { label: say('home'), click: () => void shell.openExternal(HOME) },
        { label: say('issues'), click: () => void shell.openExternal(`${HOME}/issues`) },
        ...(mac ? [] : [line, ...checkUpdates, about]),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * 右键菜单：输入框里给系统那几项（撤销、重做、剪切、拷贝、粘贴、全选），
 * 在别处选中了文字只给“拷贝”。Electron 默认右键什么都不出；也不放“检查元素”。
 * 界面自己画了菜单的地方（文件树、侧栏）会拦掉右键，走不到这里。
 */
export function installContextMenu(contents: WebContents, langOf: () => MenuLang): void {
  contents.on('context-menu', (_event, params) => {
    const say = (word: Word) => WORDS[langOf()][word]
    const flags = params.editFlags
    const line: MenuItemConstructorOptions = { type: 'separator' }
    let template: MenuItemConstructorOptions[]
    if (params.isEditable) {
      template = [
        { role: 'undo', label: say('undo'), enabled: flags.canUndo },
        { role: 'redo', label: say('redo'), enabled: flags.canRedo },
        line,
        { role: 'cut', label: say('cut'), enabled: flags.canCut },
        { role: 'copy', label: say('copy'), enabled: flags.canCopy },
        { role: 'paste', label: say('paste'), enabled: flags.canPaste },
        line,
        { role: 'selectAll', label: say('selectAll'), enabled: flags.canSelectAll },
      ]
    } else if (params.selectionText.trim()) {
      template = [{ role: 'copy', label: say('copy') }]
    } else {
      return
    }
    const window = BrowserWindow.fromWebContents(contents)
    Menu.buildFromTemplate(template).popup(window ? { window } : {})
  })
}
