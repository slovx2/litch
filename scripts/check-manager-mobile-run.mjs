// npm run client:check:manager-mobile：自选空闲端口，自动起停隔离 Expo 和验收浏览器。
import { runManagerMobile } from './manager-mobile-runner.mjs'

const controller = new AbortController()
const stop = (signal) =>
  controller.abort(
    Object.assign(new Error(`验收被 ${signal} 中断`), {
      exitCode: signal === 'SIGINT' ? 130 : 143,
    }),
  )
const interrupt = () => stop('SIGINT')
const terminate = () => stop('SIGTERM')
process.once('SIGINT', interrupt)
process.once('SIGTERM', terminate)
try {
  await runManagerMobile({ signal: controller.signal })
} catch (error) {
  console.error(error.message)
  process.exitCode = error.exitCode ?? 1
} finally {
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', terminate)
}
