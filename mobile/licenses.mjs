// 原生 Go 依赖的许可随构建产物一起分发。版本与路径来自 go list，不维护另一份依赖表。
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const cwd = dirname(fileURLToPath(import.meta.url))
const go = (target, ...args) =>
  execFileSync('go', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GOTOOLCHAIN: 'go1.27.3',
      GOOS: target,
      GOARCH: 'arm64',
      CGO_ENABLED: '1',
    },
    maxBuffer: 16 * 1024 * 1024,
  })
export function collectGoLicenses(output, runGo = go) {
  if (!output) throw new Error('需要第三方许可输出路径')
  // gobind 生成的代码依赖 x/mobile，但 sshtransport 的依赖遍历不会下载它。
  // 不带 @版本，让 Go 从本模块的 go.mod 选择锁定版本；不能依赖另一个 Gradle 任务先填缓存。
  runGo('android', 'mod', 'download', 'golang.org/x/mobile')
  // 两个平台实际依赖的并集，加上 gomobile 生成的运行时；不带上游仅用于测试的工具依赖。
  const template =
    '{{if .Module}}{{if not .Module.Main}}{{.Module.Path}}\t{{.Module.Version}}\t{{.Module.Dir}}{{end}}{{end}}'
  const modules = [
    ...new Set(
      ['android', 'ios']
        .flatMap((target) =>
          runGo(target, 'list', '-deps', '-f', template, './sshtransport')
            .trim()
            .split('\n')
            .filter(Boolean),
        )
        .concat(
          runGo(
            'android',
            'list',
            '-m',
            '-f',
            '{{.Path}}\t{{.Version}}\t{{.Dir}}',
            'golang.org/x/mobile',
          ).trim(),
        ),
    ),
  ].sort()
  const sections = ['Litch mobile — Go third-party licenses\n']
  for (const entry of modules) {
    const [name, version, directory] = entry.split('\t')
    if (!directory) throw new Error(`未取得依赖源码：${name}`)
    const names = readdirSync(directory).filter((file) =>
      /^(licen[cs]e|copying|notice|authors)([._-].*)?$/i.test(file),
    )
    const licenses = names.flatMap((file) => {
      try {
        return [`--- ${file} ---\n${readFileSync(join(directory, file), 'utf8')}`]
      } catch {
        return []
      }
    })
    if (!licenses.length) throw new Error(`依赖缺少许可文件：${name}`)
    sections.push(`\n===== ${name} ${version} =====\n${licenses.join('\n')}\n`)
  }
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, sections.join('\n'))
  console.log(`已收集 ${modules.length} 个 Go 模块的许可`)
  return modules.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  collectGoLicenses(process.argv[2])
