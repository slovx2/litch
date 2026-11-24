// 界面预览的开发服务器：网页包对着模拟核心跑（src/preview/）。
// 模拟核心和测试链接只在 EXPO_PUBLIC_LITCH_E2E=1 时打开（src/shell/build-mode.ts），这里替预览带上；
// 发布包走 expo export 和原生构建，不经过这里。用 node 直接起 expo 的命令行，Windows 上也不依赖 shell 写法。
// 用法（apps/mobile 里）：npm run preview，后面的参数原样交给 expo start，例如 npm run preview -- --clear
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = resolve(mobile, 'node_modules/expo/bin/cli')
const child = spawn(
  process.execPath,
  [cli, 'start', '--web', '--port', '5189', ...process.argv.slice(2)],
  {
    cwd: mobile,
    // 不让 expo 起服务时改写 tsconfig.json（和 scripts/ 下的夹具一致）
    env: { ...process.env, EXPO_NO_TYPESCRIPT_SETUP: '1', EXPO_PUBLIC_LITCH_E2E: '1' },
    stdio: 'inherit',
  },
)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
