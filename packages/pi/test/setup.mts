import { fileURLToPath } from 'node:url'

// 测试默认把开发依赖里的基线版本当作用户安装的 Pi；设置 PI_CLI 可改测本机的其他版本。
process.env.PI_CLI ||= fileURLToPath(
  new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')),
)
