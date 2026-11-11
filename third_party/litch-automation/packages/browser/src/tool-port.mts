import { automationRecovery } from '../../automation-contracts/src/recovery.mjs'
// 浏览器的工具宿主端口：结构保持 Litch 接线形状，不依赖 core、device 或 Electron。
export interface ClientToolCallParams {
  threadId: string
  turnId: string
  callId: string
  namespace: string | null
  tool: string
  arguments: unknown
}
export type ClientToolContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string }
export interface ClientToolCallResponse {
  success: boolean
  contentItems: ClientToolContentItem[]
}
export function clientToolFailure(kind: string, message: string): ClientToolCallResponse {
  return {
    success: false,
    contentItems: [
      { type: 'inputText', text: `[litch:${kind}] ${message}` },
      { type: 'inputText', text: JSON.stringify({ recovery: automationRecovery(kind, message) }) },
    ],
  }
}

/** 调用来自哪台设备 */
export interface ClientToolDevice {
  /** 桌面端给设备的标识（本机是 local） */
  id: string
  /** 给人看的名字 */
  name: string
  /** 本机还是经 ssh 连的远程设备 */
  kind: 'local' | 'ssh'
  /** 远程设备的 ssh 目标（别名或 user@host），本机是 null。远端 localhost 转发要用 */
  target: string | null
}

/** 交给执行器的一次调用：协议原有的参数，加上桌面端知道的上下文 */
export interface ClientToolInvocation extends ClientToolCallParams {
  /** 仅供浏览器使用的会话完全访问标志；从实际配置读取，不接受模型传参。 */
  fullAccess?: boolean
  /** 桌面批量编排的内部子调用，沿用批次开始前的观察。 */
  browserBatch?: boolean
  /** 会话标题，仅供浏览器标签组显示；尚未命名时为空。 */
  sessionTitle?: string | null
  /** 核心给的标识，取消、答复都按它对 */
  id: string
  device: ClientToolDevice
  /** 会话属于哪个 harness（claude-code、pi、codex……），只用来显示 */
  harness: string | null
  /** 会话的工作目录（设备上的路径），没有是 null */
  cwd: string | null
  /**
   * 这一回合是哪个定时任务跑的（核心按 deviceTasks 的运行记录对 threadId、turnId）；不是是 null，
   * 老的核心不给。内置浏览器的登录卡片按它出“以后直接用这个账号”的勾选、设过期
   */
  task?: { id: string; name: string } | null
}

/** 登录卡片上的一个账号（和 browser/passwords/signin.mts 的 SignInAccount 同形） */
export interface ClientToolSignInAccount {
  /** 这张卡片里随机的不透明编号，答复按它指 */
  ref: string
  /** 完整用户名：桌面端显示；给手机的那份核心只给 masked */
  username: string
  masked: string
  /** 毫秒，没填过是 null */
  lastUsed: number | null
}

/** 执行器请用户点头时出的卡片。文字由界面按语言拼，这里只给结构 */
export type ClientToolAsk =
  | { kind: 'browserDownload'; filename: string; origin: string; totalBytes: number | null }
  | { kind: 'computerSelf'; id: string; nonce: string; desktopId: string | null }
  | {
      kind: 'site'
      /** 要访问的网站来源，比如 https://example.com */
      origin: string
      url: string
      browser?: 'chrome'
    }
  | { kind: 'chromeSignIn'; origin: string; reason: string }
  | { kind: 'chromeInstance'; instanceId: string; name: string }
  | { kind: 'chromeTab'; url: string; title: string }
  | {
      /**
       * 内置浏览器请人登录（request_sign_in）：对话里和浏览器面板上同一张卡片（字段同 SignInRequest）。
       * 只在等人选的时候挂着；答复经浏览器桥 signIn.answer(id, …) 交给主进程（面板那张同一条路），
       * 主进程的 SignIns 是准，任何一处答了两处一起收。核心那条答复路回来的 decline 当拒绝
       */
      kind: 'signIn'
      /** 登录卡片的编号（SignInRequest.id） */
      id: string
      /** 主进程取到的真实来源 */
      origin: string
      /** 代理说的站名、原因，只作附注 */
      site: string
      reason: string
      accounts: ClientToolSignInAccount[]
      /** 预检不过的原因（SignInBlock），null 是能代填 */
      fillBlocked: string | null
      /** 定时任务的回合才有 */
      taskId: string | null
      /** 定时任务的回合：任务的号和名字（卡片上显示“定时任务 X 要登录”） */
      task?: { id: string; name: string } | null
      /** 毫秒，只有定时任务的回合有 */
      expiresAt: number | null
      /** 桌面端出的随机数：转给手机，手机的答复要签上它 */
      nonce: string
      /** 这台桌面端的号：有它核心才把卡片经会话所在设备转给手机；没有（验签没装好）不转 */
      desktopId?: string | null
    }

/** 卡片的答复。session：本会话都允许；always：一直允许（记下来）；decline：拒绝；null：没答就被取消了 */
export type ClientToolAnswer = 'once' | 'session' | 'always' | 'decline'

/** 执行器能用的东西 */
export interface ClientToolContext {
  /** 宿主按本次调用的设备准备上传源；远程源只在私有临时目录中物化。 */
  prepareUpload?(
    paths: readonly string[],
    limits: { fileBytes: number; totalBytes: number },
  ): Promise<{ paths: string[]; dispose(): Promise<void> }>

  /** 回合被打断、连接断了、超时时会被中止 */
  signal: AbortSignal
  /** 在这个会话的对话里出一张卡片等用户答复；被取消时回 null */
  ask(ask: ClientToolAsk): Promise<ClientToolAnswer | null>
  /**
   * 在别处等人（不出对话里的卡片，比如内置浏览器把标签交给人登录）：核心停表，等人的这段不算超时。
   * 回“不等了”的函数，表从头算；调用结束时自动不等
   */
  hold?(): () => void
  /**
   * 在对话里挂一张卡片但不等它（答复走别的路，比如登录卡片经浏览器桥）。回“撤掉”的函数；
   * 核心那条路回来的答复交给 onAnswer。调用结束时自动撤掉
   */
  show?(ask: ClientToolAsk, onAnswer?: (answer: ClientToolAnswer | null) => void): () => void
}

/** 一个命名空间的执行器，由主进程登记 */
export interface ClientToolExecutor {
  /** 命名空间，比如 litch_browser */
  namespace: string
  /** 执行一次调用。不许抛错：出错也要回一个 success:false 的答复，说明写给模型看 */
  call(
    invocation: ClientToolInvocation,
    context: ClientToolContext,
  ): Promise<ClientToolCallResponse>
  /** 回合结束（完成、打断、出错都算）时调用：收拾这个回合留下的临时东西 */
  turnEnded?(turn: { deviceId: string; threadId: string; turnId: string }): void
  /** 核心转来的一条手机答复（clientApprovals 的 litch/approval/answered，原样），由执行器自己验 */
  phoneAnswer?(answer: unknown): void
}
