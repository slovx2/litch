// 整个仓库只有一个版本号：根目录 package.json 里的那个。
// 适配器的各个包、客户端的各个包（协议、核心、界面、桌面外壳）都跟它一样，各自的锁文件里记的也一样；
// 安卓应用的版本在 apps/mobile/app.json 的 expo.version（versionCode 由它算出，应用里也从它取）。
// 发版时改一处、别的跟着改；哪一个落下了，这里指出来。npm run check 会带上它。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => JSON.parse(readFileSync(join(repo, path), 'utf8'))

const wanted = read('package.json').version
const tracked = execFileSync('git', ['ls-files', '*package.json', '*package-lock.json'], {
  cwd: repo,
  encoding: 'utf8',
})
  .split('\n')
  // 只看仓库自己的包：根目录、packages 和 apps 下面一层
  .filter((path) => /^((packages|apps)\/[^/]+\/)?package(-lock)?\.json$/.test(path))

const wrong = []
for (const path of tracked) {
  const file = read(path)
  if (file.version !== wanted) wrong.push(`${path}：${file.version ?? '没写'}`)
  // 锁文件里还有一处：packages[""] 是这个包自己
  const self = path.endsWith('package-lock.json') ? file.packages?.['']?.version : wanted
  if (self !== wanted) wrong.push(`${path} 的 packages[""]：${self ?? '没写'}`)
}

const mobile = read('apps/mobile/app.json').expo?.version
if (mobile !== wanted) wrong.push(`apps/mobile/app.json 的 expo.version：${mobile ?? '没写'}`)

if (wrong.length > 0) {
  console.error(`版本号不一致（根目录 package.json 里是 ${wanted}）：\n  ${wrong.join('\n  ')}`)
  process.exit(1)
}
console.log(`版本号一致：${wanted}（${tracked.length + 1} 个文件）`)
