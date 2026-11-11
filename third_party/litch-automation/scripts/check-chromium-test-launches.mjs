import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromiumTestLaunches } from './chromium-test-launches.mjs'

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)))
const ignored = new Set(['node_modules', 'dist', 'build', 'target', 'generated'])
const errors = []
let launches = 0
function check(directory, relative = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ignored.has(entry.name)) continue
    const path = resolve(directory, entry.name)
    const name = `${relative}${entry.name}`
    if (entry.isDirectory()) {
      check(path, `${name}/`)
    } else if (
      entry.isFile() &&
      /\.(?:mjs|mts|js|ts|tsx)$/.test(name) &&
      /(?:^|\/)(?:scripts|probes|test|tests)\//.test(name)
    ) {
      const source = readFileSync(path, 'utf8')
      for (const launch of chromiumTestLaunches(source)) {
        launches++
        if (!launch.protected)
          errors.push(
            `${name}:${launch.node.loc.start.line}：启动参数必须经过 withChromiumTestArgs`,
          )
      }
    }
  }
}
for (const directory of ['scripts', 'apps', 'packages'])
  check(resolve(root, directory), `${directory}/`)
if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else console.log(`Chromium 测试启动检查通过：${launches} 个入口，均使用隔离钥匙串参数`)
