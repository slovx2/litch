// 配置 Litch（litch_config 执行器，14 号设计 3.3、3.4、3.5）在核心和界面、核心和主进程之间的约定。
// 执行器在核心里（config/）：属于界面的几项（外观、语言、两个本地偏好、打开某一页、出码对话框）由核心经 config 主题
// 发给界面，界面照做并用 config.reply 回话；放宽安全的那几项（E6）在界面上弹确认卡，人点了才执行（config.confirm）。
// 属于主进程的几项（浏览器网站、Computer Use）经核心↔主进程的客户端工具消息（model-client-tools.mts）。
// 核心不认识语言：卡片上只给结构，字由界面按当前语言拼。

/** 界面本地的几样偏好（外观里除了语言的五项、语言、链接用内置浏览器开、任务成功的通知） */
export interface ConfigPrefs {
  skin: string
  theme: string
  density: string
  /** 对话区宽度：wide、compact */
  chatWidth: string
  zoom: number
  lang: 'zh-CN' | 'en'
  /** 对话里的链接在内置浏览器里开 */
  linksInApp: boolean
  /** 定时任务成功跑完也发系统通知 */
  notifySuccess: boolean
  /** 会话回合结束、要人审批或回答时发系统通知（窗口不在前台时） */
  notifySessions: boolean
}

/** 打开哪一页 */
export type ConfigOpenPlace =
  | { where: 'settings'; section: string | null }
  | { where: 'device'; deviceId: string }
  | { where: 'tasks' }
  | { where: 'new' }

/** 要界面做的一件事。界面做完用 config.reply 回：成了带 data，没成带 reason */
export type ConfigUiRequest =
  /** 现在的偏好。回 ConfigPrefs */
  | { kind: 'prefs.get' }
  /** 改其中几项（和设置页上点是一回事）。回改完的 ConfigPrefs */
  | { kind: 'prefs.set'; patch: Partial<ConfigPrefs> }
  | { kind: 'open'; place: ConfigOpenPlace }
  /** 打开这台设备的出码对话框，地址可以预填几项。扫码、核对确认码、允许由人做（E2） */
  | {
      kind: 'pair'
      deviceId: string
      prefill: { host?: string; port?: number; user?: string }
    }

export interface ConfigUiAsk {
  id: string
  request: ConfigUiRequest
}

/** 确认卡上“要做什么”的一项。字由界面拼 */
export type ConfigConfirmItem =
  /** 给这台设备打开 Computer Use 或“操作这台电脑” */
  | { kind: 'tool'; tool: 'computer' | 'machine'; device: string }
  /** “操作这台电脑”的审批改成不问 */
  | { kind: 'approval'; device: string; approval: 'never' }
  /** “操作这台电脑”的访问范围放到全放开 */
  | { kind: 'access'; device: string; access: 'open' }
  /** 内置浏览器“一直允许”加一个网站 */
  | { kind: 'site'; origin: string }
  /** 内置浏览器信任所有网站、不再询问 */
  | { kind: 'trustAllSites' }
  /** 从内置浏览器的黑名单里去掉一项；host 是 null 是清空 */
  | { kind: 'unblock'; host: string | null }
  /** 撤不回的事（E7）：移除远程设备、撤掉手机钥匙、删定时任务、清内置浏览器数据、清“操作这台电脑”的记录。
   * device 是设备的显示名（浏览器数据不属于哪台设备，是 null）；name 是被删的那样东西的名字，设备本身和整份数据是 null */
  | {
      kind: 'erase'
      what: 'device' | 'phone' | 'task' | 'browserData' | 'machineLog'
      device: string | null
      name: string | null
    }

/** E6、E7 的确认卡：哪个会话、哪个 harness 要做什么 */
export interface ConfigConfirmView {
  id: string
  /** 调用者所在的会话（本机设备上的）；命令行找不到会话是 null */
  session: { deviceId: string; sessionId: string; title: string | null } | null
  /** 调用者是哪个 harness 的进程；不知道是 null */
  harness: string | null
  /** 原样的命令（litch config 之后的那几个词），给人核对 */
  command: string
  items: ConfigConfirmItem[]
  /** 到这个时刻（毫秒）没人理就当拒绝 */
  expiresAt: number
}

/** config 主题的快照：要这个窗口做的事（只发给一个窗口），和挂着的确认卡（每个窗口都有） */
export interface ConfigTopicView {
  asks: ConfigUiAsk[]
  confirms: ConfigConfirmView[]
}

export type ConfigTopicOp = { op: 'config.set'; view: ConfigTopicView }

// —— 主进程那几项 ——

/** 要主进程做的一件事。主进程用现成的实现（浏览器的网站簿、Computer Use 的设置）。应用自身的更新不归 litch config 管 */
export type ConfigMainRequest =
  | { kind: 'browser.sites' }
  | { kind: 'browser.allow'; origin: string }
  /** origin 给 null 是全删 */
  | { kind: 'browser.forget'; origin: string | null }
  | { kind: 'browser.clearData' }
  /** 信任所有网站的开关和黑名单 */
  | { kind: 'browser.policy' }
  | { kind: 'browser.trust'; on: boolean }
  /** site 是人写的网站，主进程认成主机名；认不出回失败 */
  | { kind: 'browser.block'; site: string }
  /** host 给 null 是清空 */
  | { kind: 'browser.unblock'; host: string | null }
  | { kind: 'computer.status' }
  | { kind: 'computer.apps' }
  | { kind: 'computer.forget'; bundleId: string }

/** 主进程的回话。data 的形状按 request.kind 定（见 config/ops-app.mts 里怎么读） */
export type ConfigMainResult = { ok: true; data: unknown } | { ok: false; reason: string }

/** “一直允许”的一个网站 */
export interface ConfigSiteView {
  origin: string
  at: number
}

/** 内置浏览器信任所有网站的开关和黑名单（主机名，含子域名） */
export interface ConfigSitePolicyView {
  trustAll: boolean
  blocked: string[]
}

/** Computer Use 的状态（主进程 computer-use/settings.mts 的 ComputerUseState 里执行器要的几样） */
export interface ConfigComputerView {
  platform: string
  helper: string
  permissions: { accessibility: boolean; screenRecording: boolean } | null
  reason?: string
}

/** “始终允许”的一个应用 */
export interface ConfigAppView {
  bundleId: string
  name: string
}
