// 应用里带着的第三方代码的许可文本：打包时收成一个目录，放进应用的资源目录（Contents/Resources/licenses）。
//
// 界面和外壳都打成了单个文件，依赖的代码在里面，但它们各自的许可文件不在：MIT、BSD 这类许可要求
// 分发时带着版权声明和许可全文，字体的 OFL 也一样。这里从两份 package.json 的 dependencies 出发，
// 顺着各个包自己的 dependencies 走到底，把走到的每个包的许可文件原样收进来。
// 只走 dependencies：开发依赖（构建工具、类型）不进应用，可选依赖和同伴依赖装了才算、这里没有装的不管。
//
// Electron 自己的许可（LICENSE、LICENSES.chromium.html）由打包器放在应用里，不在这里管；
// 自带的适配器那一份在 Contents/Resources/adapter 下面，带着它自己的 node_modules 和里面的许可文件。

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))

/** 从哪几个包出发：界面和外壳。各自的依赖装在各自的 node_modules 里 */
const ROOTS = [here('../../../packages/ui'), here('..')]

/** 许可文件的名字：LICENSE、LICENCE、COPYING、NOTICE，带不带后缀都算 */
const LICENSE_FILE = /^(licen[sc]e|copying|notice)(\.|-|$)/i

// Office 使用 ExcelJS 的预构建浏览器包；其内嵌依赖与 Node 入口的 dependencies 不同。
// 逐包声明依据发布包 source map 收齐并固化；换版本或更换产物必须重新审计。
function browserNotice(dir, manifest) {
  if (manifest.name !== 'exceljs') return null
  const hash = createHash('sha256')
    .update(readFileSync(join(dir, 'dist/exceljs.min.js')))
    .digest('hex')
  if (
    manifest.version !== '4.4.0' ||
    hash !== '7e49da68588e250dbb8bba190d2caa8ab3787cc0284bda1d8b2f805c4df742c9'
  )
    throw new Error('ExcelJS 浏览器产物已改变，必须重新收集其内嵌依赖许可')
  return here('../licenses/exceljs-4.4.0-browser.txt')
}

/** 顺着 dependencies 走到底。返回 名字@版本 → 包的目录 */
function dependencyDirectory(from, name) {
  for (let current = realpathSync(from); ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dirname(current) === current) break
  }
  throw new Error(`${from} 的依赖 ${name} 没有装，先装依赖再打包`)
}

function closure(roots) {
  const found = new Map()
  for (const root of roots) {
    const walk = (from, name) => {
      // 每个包从自身位置找依赖，保留嵌套安装的不同版本；不能只查项目顶层。
      const dir = dependencyDirectory(from, name)
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const key = `${manifest.name}@${manifest.version}`
      if (found.has(key)) return
      const bundled = browserNotice(dir, manifest)
      found.set(key, { dir, manifest, bundled })
      if (bundled) return
      for (const dependency of Object.keys(manifest.dependencies ?? {})) walk(dir, dependency)
    }
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    for (const name of Object.keys(manifest.dependencies ?? {})) walk(root, name)
  }
  return found
}

/**
 * 把许可文本收进 out 目录：每个包一个文件（名字@版本.txt，开头是包名、版本、声明的许可、主页，后面是许可文件的原文），
 * 外加两份清单：给人看的 INDEX.txt，给应用读的 index.json（包名、版本、声明的许可、文件名）。
 * 有包找不到许可文件就报错，不出一个缺着的包。返回收了哪些包。
 */
export function collectLicenses(out, roots = ROOTS) {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const packages = [...closure(roots)].sort(([a], [b]) => a.localeCompare(b))
  const index = []
  /** 给应用自己读的清单（“关于”里的许可一览，见 src/about.mts） */
  const listed = []
  const missing = []
  for (const [key, { dir, manifest, bundled }] of packages) {
    const files = readdirSync(dir).filter((file) => LICENSE_FILE.test(file))
    // PDF 的字体、CMap、WASM 分别附带许可，根目录的 Apache 许可不能替代它们。
    if (manifest.name === 'pdfjs-dist') {
      for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
        for (const file of readdirSync(join(dir, folder))) {
          if (/^(LICENSE|NOTICE)([_.-]|$)/i.test(file) && !file.includes('QCMS'))
            files.push(join(folder, file))
        }
      }
    }
    // 这两份 npm 发布包漏了独立 LICENSE：保留固定版本的上游/README 原文。
    const supplemental = {
      'saxes@5.0.1': here('../licenses/saxes-5.0.1.txt'),
      'isarray@1.0.0': here('../licenses/isarray-1.0.0.txt'),
    }[key]
    if (files.length === 0 && !supplemental) {
      missing.push(key)
      continue
    }
    const license = typeof manifest.license === 'string' ? manifest.license : '见下文'
    const home = manifest.homepage ?? manifest.repository?.url ?? manifest.repository ?? ''
    const head = [`${manifest.name} ${manifest.version}`, `License: ${license}`, home]
      .filter(Boolean)
      .join('\n')
    const texts = files.map((file) => readFileSync(join(dir, file), 'utf8').trimEnd())
    for (const file of [supplemental, bundled])
      if (file) texts.push(readFileSync(file, 'utf8').trimEnd())
    // 包名里的斜杠（@scope/name）换掉，免得变成子目录
    const file = `${key.replaceAll('/', '__')}.txt`
    writeFileSync(join(out, file), `${head}\n\n${texts.join('\n\n')}\n`)
    index.push(`${manifest.name} ${manifest.version} — ${license}`)
    listed.push({ name: manifest.name, version: manifest.version, license, file })
  }
  if (missing.length > 0) {
    throw new Error(`这几个包里没有找到许可文件，不能就这么打进应用：${missing.join('、')}`)
  }
  writeFileSync(
    join(out, 'INDEX.txt'),
    `Third-party software bundled in this application. One file per package in this directory.\n\n${index.join('\n')}\n`,
  )
  writeFileSync(join(out, 'index.json'), `${JSON.stringify(listed, null, 2)}\n`)
  return index
}
