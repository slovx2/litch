// 重新生成 README 用的界面截图：两种语言各起一次外壳，对着模拟核心，窗口不显示。
//   npm run shots            （在 apps/desktop 里；根目录用 npm run client:shots，会先构建界面）
// 图片写到仓库的 docs/images/zh 和 docs/images/en。
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electron = require('electron')
const appDir = fileURLToPath(new URL('..', import.meta.url))
const images = fileURLToPath(new URL('../../../docs/images/', import.meta.url))

function run(lang, dir) {
  return new Promise((resolve, reject) => {
    // 用一份临时的用户数据目录，不碰平时用的那一份
    const profile = mkdtempSync(join(tmpdir(), 'litch-shots-'))
    const child = spawn(electron, [appDir], {
      env: { ...process.env, LITCH_SHOTS: dir, LITCH_LANG: lang, LITCH_PROFILE: profile },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const onData = (chunk) => {
      output += chunk
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      rmSync(profile, { recursive: true, force: true })
      const done = output.split('\n').filter((line) => line.startsWith('LITCH_SHOT ')).length
      if (code === 0) resolve(done)
      else reject(new Error(`截图没有完成（退出码 ${code}，截了 ${done} 张）：\n${output}`))
    })
  })
}

for (const [lang, folder] of [
  ['zh-CN', 'zh'],
  ['en', 'en'],
]) {
  const count = await run(lang, `${images}${folder}`)
  console.log(`${folder}：${count} 张`)
}
