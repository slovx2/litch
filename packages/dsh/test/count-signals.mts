import { appendFileSync } from 'node:fs'

// 注入真的 dsh 进程（NODE_OPTIONS 的 --import）：它收到一个结束信号就往 DSH_TEST_SIGNALS 指的文件里记一行。
// 只在 dsh 自己的进程里记（适配器起它时头一个参数是 --profile）：这个选项入口进程和别的 node 子进程也带着。
const path = process.env.DSH_TEST_SIGNALS
if (path && process.argv[2] === '--profile')
  process.on('SIGTERM', () => appendFileSync(path, `${process.pid}\n`))
