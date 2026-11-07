// 单元测试跨平台模拟两个 macOS 文件命令；真实命令在签名应用验收中执行。
import { cp } from 'node:fs/promises'
import { promisify } from 'node:util'

export const execFile = Object.assign(() => {}, {
  [promisify.custom]: async (binary: string, args: string[]) => {
    if (binary === '/usr/libexec/PlistBuddy')
      return { stdout: 'dev.litch.update-test\n', stderr: '' }
    if (binary === '/usr/bin/ditto' && args[0] && args[1]) {
      await cp(args[0], args[1], { recursive: true, verbatimSymlinks: true })
      return { stdout: '', stderr: '' }
    }
    throw new Error(`夹具不允许执行：${binary}`)
  },
})
