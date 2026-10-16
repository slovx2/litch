// 客户端工具执行器的登记表：主进程启动时从这里取这台桌面能执行的命名空间（启动时报给核心，核心握手时照它声明）。
// 一个命名空间一个执行器（types.mts 的 ClientToolExecutor），由一个工厂函数给出；这台桌面上用不了的（系统不对、
// 开关没开）工厂返回 null，这个命名空间就不声明，建会话时也不带它的工具定义。
// 接一个新的执行器只要在 FACTORIES 里加一行（内置浏览器、Computer Use 两条线合并时各加一行，见下面的注释），
// 工具定义另外在 packages/protocol/src/client-tools-specs.mts 里加一行。

import { echoExecutor } from './echo.mjs'
import type { ClientToolExecutor } from './types.mjs'

/** 工厂拿到的：这台桌面的系统和环境变量，和一个记日志的函数 */
export interface ExecutorEnv {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  log(line: string): void
}

/** 给出一个执行器；这台桌面上用不了就是 null */
export type ExecutorFactory = (env: ExecutorEnv) => ClientToolExecutor | null

/** 测试用的 echo：只有开了 LITCH_CLIENT_TOOLS_ECHO=1 才登记 */
const echo: ExecutorFactory = ({ env }) =>
  env.LITCH_CLIENT_TOOLS_ECHO === '1' ? echoExecutor : null

const FACTORIES: ExecutorFactory[] = [
  echo,
  // 内置浏览器（丙线）合并时加在这里：browserExecutor,
  // Computer Use（丁线）合并时加在这里：computerExecutor,（只在 macOS 上给出）
]

/** 这台桌面上能用的执行器 */
export function createExecutors(env: ExecutorEnv): ClientToolExecutor[] {
  const executors: ClientToolExecutor[] = []
  for (const factory of FACTORIES) {
    try {
      const executor = factory(env)
      if (executor) executors.push(executor)
    } catch (error) {
      env.log(`有一个客户端工具执行器起不来：${String(error)}`)
    }
  }
  return executors
}
