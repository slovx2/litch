// 界面产物与源码内容绑定，不依赖 checkout、复制或 CI 制品恢复后的时间戳。
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const stampName = 'litch-ui-build.json'
const sourceRoots = [
  'packages/ui/src',
  'packages/ui/public',
  'packages/core/src',
  'packages/protocol/src',
  'packages/shared/src',
]
const configs = [
  'packages/ui/index.html',
  'packages/ui/vite.config.ts',
  'tsconfig.json',
  'apps/desktop/src/ui-security.mts',
  'scripts/ui-build-state.mjs',
  ...['', 'packages/ui/', 'packages/core/', 'packages/protocol/', 'packages/shared/'].flatMap(
    (dir) => ['package.json', 'package-lock.json', 'tsconfig.json'].map((name) => dir + name),
  ),
]
const digest = (data) => createHash('sha256').update(data).digest('hex')

export function uiInputs(root = repo, extra = []) {
  const files = new Set([...configs, ...extra])
  const walk = (path) => {
    if (!existsSync(join(root, path))) return
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else files.add(child)
    }
  }
  for (const path of sourceRoots) walk(path)
  return Object.fromEntries(
    [...files]
      .sort()
      .map((path) => [
        path,
        existsSync(join(root, path)) ? digest(readFileSync(join(root, path))) : null,
      ]),
  )
}

export function assertUiBuildFresh(root = repo) {
  const dist = join(root, 'packages/ui/dist')
  let stamp
  try {
    stamp = JSON.parse(readFileSync(join(dist, stampName), 'utf8'))
  } catch {}
  const fail = (why) => {
    throw new Error(
      `界面构建产物缺失或已过期（${why}）；请先运行 npm run client:build，再执行桌面验收。`,
    )
  }
  if (stamp?.version !== 1 || !Array.isArray(stamp.extra) || !stamp.inputs)
    fail('没有有效的构建记录')
  const current = uiInputs(root, stamp.extra)
  const changed = [...new Set([...Object.keys(current), ...Object.keys(stamp.inputs)])].find(
    (path) => current[path] !== stamp.inputs[path],
  )
  if (changed) fail(changed)
  const index = join(dist, 'index.html')
  if (!existsSync(index) || digest(readFileSync(index)) !== stamp.index)
    fail('index.html 与构建记录不符')
}

export function uiBuildStatePlugin(root = repo) {
  let outDir
  let before
  let configFiles = []
  let extra = []
  return {
    name: 'litch:ui-build-state',
    apply: 'build',
    configResolved(config) {
      // 文件预览等独立夹具的构建不冒充完整 UI，也不覆盖它的记录。
      if (resolve(config.root, config.build.outDir) === join(root, 'packages/ui/dist'))
        outDir = join(root, 'packages/ui/dist')
      configFiles = config.configFileDependencies ?? []
    },
    buildStart() {
      if (outDir) before = uiInputs(root)
    },
    generateBundle() {
      if (!outDir) return
      // Vite 实际读取的仓库内文件也纳入，覆盖配置或新的跨包依赖；依赖安装由锁文件约束。
      extra = [...this.getModuleIds(), ...configFiles]
        .map((path) => relative(root, path.split('?')[0]).replaceAll('\\', '/'))
        .filter(
          (path) =>
            !path.startsWith('../') &&
            !path.includes('node_modules/') &&
            !path.startsWith('packages/ui/dist/') &&
            existsSync(join(root, path)) &&
            statSync(join(root, path)).isFile(),
        )
        .sort()
    },
    writeBundle() {
      if (!outDir || !existsSync(join(outDir, 'index.html'))) return
      if (JSON.stringify(before) !== JSON.stringify(uiInputs(root)))
        throw new Error('构建期间界面源码变化，请重新运行 npm run client:build。')
      writeFileSync(
        join(outDir, stampName),
        JSON.stringify({
          version: 1,
          extra,
          inputs: uiInputs(root, extra),
          index: digest(readFileSync(join(outDir, 'index.html'))),
        }),
      )
    },
  }
}
