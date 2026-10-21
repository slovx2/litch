// 别处占着的原生会话（扩展名 nativeOwner）：入口导进来的原生会话，此刻正被本机另一个进程开着
// （Claude 桌面端、终端里的 claude --resume）。两个进程同时往一份原生记录里写会分叉，所以这时入口把这个会话
// 当成只读：会写原生记录的请求（turn/start、回退、压缩……）一律拒绝，内容照常跟着对方刷新。
// 对方退出后自动恢复可写。新增的东西只发给声明了这个扩展的连接；没声明的连接照样会被拒绝，只是看不到原因字段。
// 定义的原文在仓库根目录 protocol/extensions/native-owner.json。
//
// 这个文件不引用别的文件：各个入口和客户端核心都直接引用它。

/**
 * 会话对象上的 `litchNativeOwner`（thread/read、thread/list、thread/resume、thread/started 的会话对象），
 * 只在被别处占着时有
 */
export interface NativeOwner {
  /**
   * 占着它的是谁：原生登记里的入口（claude-desktop、cli……）。只是看到原生记录还在变长、
   * 登记里找不到是谁时是 unknown
   */
  entrypoint: string
  /** 对方正在跑一个回合（登记的状态是 busy，或者原生记录还在变长）；只是开着、空闲时为假 */
  running: boolean
}

/** 占用变了：owner 是 null 表示没人占着了，又可以写了 */
export interface NativeOwnerChangedNotification {
  threadId: string
  owner: NativeOwner | null
}

export const NATIVE_OWNER_NOTIFICATION = {
  changed: 'litch/thread/nativeOwner/changed',
} as const
