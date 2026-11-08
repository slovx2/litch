// 由 Litch 自己的可执行文件以 ELECTRON_RUN_AS_NODE 模式运行；只处理一次输入便退出。
// 因此 Security.framework 看到的是 Litch 的可执行文件及签名，而不是 security 命令。
import { createRequire } from 'node:module'

const chunks = []
let size = 0
let secret
// 父进程取消时管道可能已关闭；不让 EPIPE 打印包含运行环境的异常。
process.stdout.on('error', () => {
  process.exitCode = 1
})
try {
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > 128) throw new Error('Invalid request.')
    chunks.push(chunk)
  }
  const browser = Buffer.concat(chunks).toString('utf8')
  const addon = createRequire(import.meta.url)('./keychain.node')
  const result = addon.read(browser)
  if (result.status !== 0) {
    // 退出码只表达状态，原生错误信息和 stderr 都不透传。
    process.exitCode = [-128, -25293, -25308].includes(result.status)
      ? 2
      : result.status === -4
        ? 3
        : 1
  } else {
    secret = result.bytes
    if (!Buffer.isBuffer(secret) || !secret.length || secret.length > 65536)
      throw new Error('Invalid result.')
    await new Promise((resolve, reject) =>
      process.stdout.write(secret, (error) => (error ? reject(error) : resolve())),
    )
  }
} catch {
  process.exitCode = 1
} finally {
  secret?.fill(0)
  for (const chunk of chunks) chunk.fill(0)
}
