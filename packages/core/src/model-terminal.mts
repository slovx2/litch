// 终端面板看到的数据形状。和 model.mts 一样，界面只认识这里的类型，不认识协议类型。
// 终端的会话归核心管（device/terminals.mts）：界面发命令、订阅列表和各个终端的输出，终端控件只在界面里。

/**
 * 一个终端现在怎么样了：
 * - starting：正在起
 * - running：在跑
 * - exited：进程退出了（exitCode 是退出码），标签和内容留着，可以在原地重开
 * - lost：没了。随连接结束的终端断线了；或者属于设备的终端在设备上找不到了（设备服务重启过）
 * - away：设备没连着，终端还在设备上跑着，连回来之后自己接回（只有属于设备的终端才有这种状态）
 */
export type TerminalState = 'starting' | 'running' | 'exited' | 'lost' | 'away'

export interface TerminalInfo {
  id: string
  /** 挂在哪个工作区上。null：不属于任何工作区，是设备主目录的那一组 */
  workspaceId: string | null
  /** 用户起的名字。null：没起过，界面按序号说“终端 N” */
  title: string | null
  /** 默认名字里的序号 */
  seq: number
  /** 起的时候去的目录（请求的那个）。给人看的；实际落在哪要看对面那个目录在不在 */
  cwd: string | null
  state: TerminalState
  /** state 是 exited 时才有 */
  exitCode: number | null
  /** 属于设备：这边断线、退出应用它都还在跑。false：随连接结束，断线就没了 */
  durable: boolean
  /** 是不是开成了标签。false：留在设备上跑着，这边没在看（只有属于设备的终端才会这样） */
  shown: boolean
  rows: number
  cols: number
  /** 标签按它从小到大排 */
  order: number
}

export interface TerminalsView {
  deviceId: string
  /**
   * 这台设备上新开的终端是不是属于设备的（对面声明了可重连终端）。
   * null：这次运行里还没连上过，不知道
   */
  durable: boolean | null
  terminals: TerminalInfo[]
}

/**
 * 订阅一个终端的输出时先来的那一份。它不带数据，只说“从哪开始”：数据全部走后面的增量。
 * 输出的位置用字节偏移表示，从这个进程启动算起；同一个标签里重开一次，偏移从头再来，代号（epoch）换一个。
 */
export interface TerminalStreamView {
  /** 这次订阅的编号。回报“处理到哪了”的时候带上 */
  viewer: number
  epoch: number
  /** 接下来的输出从这个偏移开始 */
  from: number
  /** 界面说了自己有到哪，而那之后有这么多字节核心这里已经没有了。不是 0 就是中间缺了一段 */
  missed: number
  /**
   * 接下来的输出不是从进程的开头开始的（更早的已经不在了），也不是接着界面手里的：
   * 可能从一个转义序列的中间开始，全屏程序的画面也可能是半截的
   */
  truncated: boolean
}

/** 输出里一处要让人看得出来的地方 */
export type TerminalMark =
  /** 界面跟不上输出，中间略过了 missed 字节 */
  | { kind: 'backlog'; missed: number }
  /** 断线之后接回来了：补上了 replayed 字节；设备上已经没留着的有 missed 字节（没丢就是 0） */
  | { kind: 'rejoined'; missed: number; replayed: number }

export type TerminalOp =
  /** 一段输出：chunks 是 base64 的几块，按顺序拼起来是 [from, to) 这一段字节 */
  | { op: 'output'; from: number; to: number; chunks: string[] }
  /** 输出在这里不连续，或者断过线：之后的输出从 at + mark.missed 开始 */
  | { op: 'mark'; at: number; mark: TerminalMark }
  /** 进程在同一个标签里重开了：清屏，偏移从 0 重新算 */
  | { op: 'reset'; epoch: number }

export type TerminalsOp =
  | { op: 'terminal.upsert'; terminal: TerminalInfo }
  | { op: 'terminal.remove'; terminalId: string }
  | { op: 'terminals.durable'; durable: boolean | null }

/** 界面订阅输出时说的“我手里已经有到哪了”：同一个界面退订之后再订阅，只补后面的 */
export interface TerminalHave {
  epoch: number
  offset: number
}

/** 一共有多少终端还活着。退出应用之前问一句用 */
export interface TerminalsAlive {
  /** 属于设备、开成了标签、还在跑的：退出之后可以留着，也可以结束 */
  durable: number
  /** 随连接结束、还在跑的：退出就没了 */
  ephemeral: number
}
