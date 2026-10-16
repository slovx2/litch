// 可重连的终端（扩展名 deviceProcesses）：进程可以属于设备，而不是属于发起它的那条连接。
// 这里的东西都不是 codex 原有的。定义的原文在仓库根目录 protocol/extensions/device-processes.json，
// 设计见 design/harness-client/03-adapter-device-service.md 第 6.3 节，规矩见第十五节。
//
// 这个文件不引用别的文件：设备进程（packages/device）和客户端核心（packages/core）都直接引用它。
// 进程的输出和退出用的还是协议原有的 `process/outputDelta`、`process/exited`，写输入、改行列数、
// 结束挂着的进程用的还是 `process/writeStdin`、`process/resizePty`、`process/kill`；
// 这里只有协议里没有的那几样。

/** 标记里能放的值：任意 JSON */
export type DeviceProcessTag =
  | null
  | string
  | number
  | boolean
  | DeviceProcessTag[]
  | { [key: string]: DeviceProcessTag }

/** 标记序列化成 JSON 之后最多这么多字节（UTF-8） */
export const DEVICE_PROCESS_TAG_MAX_BYTES = 4096

/**
 * `process/spawn` 上的扩展参数，也是输出和退出通知上扩展字段的名字。
 * 带了它（哪怕是空对象）的进程属于设备；不带、或者给 null，就是协议原本的属于连接的进程。
 * 只有握手时声明了 deviceProcesses 的连接带它才生效，没声明的连接带了等于没带。
 */
export const DEVICE_PROCESS_FIELD = 'litchDevice'

export interface DeviceProcessSpawnOption {
  /** 客户端自己的标记，设备不看，列出来时原样带回。桌面端用它把终端对回工作区 */
  tag?: DeviceProcessTag
}

/** 握手时声明过 deviceProcesses 的连接，`process/spawn` 的参数上可以多这一项 */
export interface DeviceProcessSpawnParams {
  litchDevice?: DeviceProcessSpawnOption | null
}

/** 伪终端的行列数 */
export interface DeviceProcessSize {
  rows: number
  cols: number
}

/** 设备上的一个这类进程 */
export interface DeviceProcessInfo {
  /** 句柄。在设备范围内唯一，不是按连接的 */
  processHandle: string
  command: string[]
  cwd: string
  /** 是不是伪终端 */
  tty: boolean
  /** 伪终端现在的行列数（几条连接都改过的话是最后一次的）；不是伪终端为 null */
  size: DeviceProcessSize | null
  /** 启动时间，Unix 秒 */
  startedAt: number
  running: boolean
  /** 退出状态；还在跑是 null */
  exit: { exitCode: number; exitedAt: number } | null
  /** 现在有几条连接挂着 */
  attached: number
  /** 发起时带的标记，原样带回；没带是 null */
  tag: DeviceProcessTag
  /**
   * 设备上留着的输出是哪一段，按字节偏移算，含头不含尾：`to` 是这个进程到现在为止输出的总字节数
   * （两路输出合在一起数），`from` 之前的已经不在缓冲里了。
   */
  retained: { from: number; to: number }
}

/** `process/spawn` 带了扩展参数并且生效时，应答里多这一项；没有它就是没生效，进程属于连接 */
export interface DeviceProcessSpawnResponse {
  litchDevice?: DeviceProcessInfo
}

/** 列出设备上这类进程，按启动的先后。刚退出、记录还留着的也在里面 */
export const DEVICE_PROCESS_LIST = 'litch/process/list'

export interface DeviceProcessListResponse {
  data: DeviceProcessInfo[]
}

/** 按句柄挂接：先回放留着的输出，再接着收新的。已经挂着的再调一次是从新给的位置重新回放 */
export const DEVICE_PROCESS_ATTACH = 'litch/process/attach'

export interface DeviceProcessAttachParams {
  processHandle: string
  /**
   * “我已经有到哪了”：这个偏移之前的输出客户端手里有，只补后面的。
   * 不带或 null 是把留着的输出全部回放一遍。
   */
  fromOffset?: number | null
}

export interface DeviceProcessAttachResponse {
  process: DeviceProcessInfo
  /** 回放从这个偏移开始 */
  replayFrom: number
  /** 回放到这个偏移为止（挂接这一刻的输出总量）；之后的是新输出 */
  replayTo: number
  /** 从客户端说的位置（没说就是 0）到回放起点之间、已经不在缓冲里的字节数。不是 0 就是中间丢了 */
  missedBytes: number
}

/** 解除挂接，不结束进程。没挂着也算成功 */
export const DEVICE_PROCESS_DETACH = 'litch/process/detach'

/** 按句柄结束进程，不要求挂着。已经退出的算成功 */
export const DEVICE_PROCESS_KILL = 'litch/process/kill'

export interface DeviceProcessKillParams {
  processHandle: string
  /** 退出之后不留记录（等于结束之后再清掉） */
  remove?: boolean
}

/** 把已经退出的那条记录清掉。进程还在跑时失败 */
export const DEVICE_PROCESS_REMOVE = 'litch/process/remove'

/** detach、remove 的参数 */
export interface DeviceProcessHandleParams {
  processHandle: string
}

/** 设备上这类进程多了、少了、变了。只发给声明过 deviceProcesses 的连接，每条都发，发起的那条也收 */
export const DEVICE_PROCESS_CHANGED = 'litch/process/changed'

export interface DeviceProcessChangedNotification {
  processHandle: string
  /**
   * started：新起了一个；updated：挂着的连接数或者行列数变了；exited：退出了，记录还在；
   * removed：记录没了（被清掉，或者留到期了）
   */
  change: 'started' | 'updated' | 'exited' | 'removed'
  /** 变化之后的样子；removed 时是 null */
  process: DeviceProcessInfo | null
}

/** 属于设备的进程，发给挂着的连接的 `process/outputDelta` 上多的那一项 */
export interface DeviceProcessOutputMark {
  /** 这一块的第一个字节的偏移。加上这一块的字节数就是“已经有到哪了” */
  offset: number
  /** 这一块是挂接时回放的旧输出 */
  replay?: true
  /** 这一块之前有这么多字节没有发给这条连接：它落后太多，中间那段已经不在缓冲里了 */
  missedBytes?: number
}

/** 属于设备的进程，`process/exited` 上多的那一项 */
export interface DeviceProcessExitMark {
  /** 这个进程一共输出了多少字节。和客户端手里的位置一样，就是一个字节都没落下 */
  offset: number
}

/**
 * 这个扩展自己回的错误，原因在 `error.data.litch` 里。除了数量上限都用标准的 -32600：
 * 和协议原有的“句柄重复”“没有这个进程”是同一个码，只认标准错误码的客户端照样能处理。
 * 没声明扩展的连接调这几个方法，回的是 harness 扩展里的 extensionRequired。
 */
export const DEVICE_PROCESS_ERROR_CODE = {
  /** 设备上同时在跑的这类进程到了上限 */
  processLimitReached: -32060,
  /** 这个句柄在设备上已经有一个这类进程在用（还在跑，或者退出后记录还留着） */
  processHandleInUse: -32600,
  /** 设备上没有这个句柄的这类进程 */
  unknownProcess: -32600,
  /** 要清掉的那条记录，进程还在跑 */
  processRunning: -32600,
} as const

export type DeviceProcessErrorReason = keyof typeof DEVICE_PROCESS_ERROR_CODE

export interface DeviceProcessErrorData {
  litch: DeviceProcessErrorReason
  processHandle?: string
  /** processLimitReached：上限是多少 */
  limit?: number
}
