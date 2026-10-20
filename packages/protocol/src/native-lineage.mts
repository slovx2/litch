// 别的应用派出的子会话（扩展名 nativeLineage）：harness 自己的原生会话里，有的是别的应用从另一个会话派出来的，
// 比如 Claude 桌面端用 start_session 起的会话。它们在原生记录里是普通的独立会话，Litch 的入口照常导进来；
// 入口认得出是派出来的，就在会话对象上带 `litchNativeLineage`，客户端据此决定显不显示、挂在哪里。
// 和会话树（session-tree.mts）不是一回事：那是 Litch 自己派的子会话，父子关系存在设备进程里。
// 定义的原文在仓库根目录 protocol/extensions/native-lineage.json。
//
// 这个文件不引用别的文件：各个入口和客户端核心都直接引用它。

/** 派出它的应用 */
export type NativeLineageApp =
  /** Claude 桌面端（Code 标签页）用 start_session 起的会话 */
  'claude-desktop'

/**
 * 会话对象上的 `litchNativeLineage`：只在声明了 nativeLineage 的连接上、只在认得出是派出来的会话上有。
 * 认不出父会话是哪一个时没有 parentThreadId，客户端把它当成“某个会话派出来的”。
 */
export interface NativeLineage {
  app: NativeLineageApp
  /** 父会话在同一个 harness 里的会话标识。认不出是哪一个时不带 */
  parentThreadId?: string
}

/** 认得出的应用：客户端遇到不认识的 app 按“别的应用派出来的”处理 */
export const NATIVE_LINEAGE_APPS: readonly NativeLineageApp[] = ['claude-desktop']
