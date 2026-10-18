// 请求怎么路由。只看方法名、会话标识和 harness 参数，别的一概不看。
import { DEVICE_PROCESS_PREFIX } from './device-processes.mjs'
import { DEVICE_TASK_PREFIX } from './tasks.mjs'
import { isObject } from './wire.mjs'
import { isWorkspaceMethod } from './workspaces.mjs'

export type Route =
  /** 设备层自己处理，不转给运行时 */
  | { kind: 'device' }
  /** 设备级的工作区、分区与置顶：也是设备层自己处理，数据在设备进程自己的库里 */
  | { kind: 'workspace' }
  /** 发给全部上游，合并后返回 */
  | { kind: 'list' }
  /** 针对某个会话：查“会话属于哪个 harness”的索引。索引里没有时，harness 参数可以直接指路 */
  | { kind: 'thread'; threadId: string; harness: string | null }
  /** 针对某个 harness */
  | { kind: 'harness'; harness: string }
  /** 聚合面不支持，明确报错，不猜 */
  | { kind: 'unsupported'; hint: string }

/** 设备层处理的终端与进程方法 */
const PROCESS_METHODS = new Set([
  'process/spawn',
  'process/writeStdin',
  'process/resizePty',
  'process/kill',
])

const SEARCH_METHODS = new Set([
  'fuzzyFileSearch',
  'fuzzyFileSearch/sessionStart',
  'fuzzyFileSearch/sessionUpdate',
  'fuzzyFileSearch/sessionStop',
])

export function isProcessMethod(method: string): boolean {
  return PROCESS_METHODS.has(method)
}

export function isSearchMethod(method: string): boolean {
  return SEARCH_METHODS.has(method)
}

export function classify(method: string, params: unknown): Route {
  if (method === 'runtime/info') return { kind: 'device' }
  // 设备配置接口（设置、重启 harness、诊断、日志）：设备进程经控制通道交给适配器主进程
  if (method.startsWith('litch/device/')) return { kind: 'device' }
  if (method.startsWith('fs/')) return { kind: 'device' }
  if (PROCESS_METHODS.has(method) || SEARCH_METHODS.has(method)) return { kind: 'device' }
  // 属于设备的进程（可重连的终端，deviceProcesses 扩展）：列出、挂接、解除、结束、清除
  if (method.startsWith(DEVICE_PROCESS_PREFIX)) return { kind: 'device' }
  // 定时任务（deviceTasks 扩展）：任务存在设备进程自己的库里，由它按时执行
  if (method.startsWith(DEVICE_TASK_PREFIX)) return { kind: 'device' }
  // 终端与进程归设备层。这里没列的 process/* 不转给任何引擎：引擎里的那一份属于它自己的连接
  if (method.startsWith('process/')) return { kind: 'unsupported', hint: '设备层没有这个终端方法' }
  if (method === 'command/exec' || method.startsWith('command/exec/'))
    return { kind: 'unsupported', hint: '聚合面不提供 command/exec，跑命令用 process/*' }
  // 工作区、分区与置顶存在设备层。这几组方法绝不转给引擎：
  // 引擎各有一份互不相通的项目存储，写进去的归属和聚合面上的对不上。
  // `thread/metadata/update` 按会话走（下面），归属以外的字段还是要到引擎，由连接那一层拆开
  if (isWorkspaceMethod(method)) return { kind: 'workspace' }
  if (
    method.startsWith('project/') ||
    method.startsWith('threadSection/') ||
    method.startsWith('thread/section/')
  )
    return { kind: 'unsupported', hint: '设备层没有这个工作区或分区方法' }
  if (method === 'thread/list') return { kind: 'list' }
  const fields = isObject(params) ? params : {}
  const harness = typeof fields.harness === 'string' && fields.harness ? fields.harness : null
  if (typeof fields.threadId === 'string' && fields.threadId)
    return { kind: 'thread', threadId: fields.threadId, harness }
  if (harness) return { kind: 'harness', harness }
  return {
    kind: 'unsupported',
    hint: '不带会话标识的请求要用 harness 参数指明发给哪个 harness',
  }
}
