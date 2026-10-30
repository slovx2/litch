// 修改 md4c 补丁后，以固定 Emscripten 重建网页解析器，再用 patch-package 保存两个产物。
// EMCC=/path/to/emscripten-4.0.19/emcc npm run markdown:wasm
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mobile = fileURLToPath(new URL('../', import.meta.url))
const dependency = join(mobile, 'node_modules/react-native-enriched-markdown')
const cpp = join(dependency, 'cpp')
const emcc = process.env.EMCC ?? 'emcc'
const version = execFileSync(emcc, ['--version'], { encoding: 'utf8' })
if (!/\b4\.0\.19(?:\b|-)/.test(version)) throw new Error('需要 Emscripten 4.0.19')
const packageVersion = JSON.parse(readFileSync(join(dependency, 'package.json'))).version
if (packageVersion !== '1.1.0') throw new Error('升级 Markdown 依赖时须重新审查解析补丁')
const sources = [
  'md4c/md4c.c',
  'md4c/md4c.h',
  'md4c/litch_cjk.h',
  'parser/MD4CParser.cpp',
  'parser/MD4CParser.hpp',
  'parser/MarkdownASTNode.hpp',
  'wasm/ASTSerializer.cpp',
  'wasm/ASTSerializer.hpp',
  'wasm/md4c_wasm.cpp',
]
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const work = mkdtempSync(join(tmpdir(), 'litch-md4c-wasm-'))
try {
  const object = join(work, 'md4c.o')
  const output = join(work, 'md4c.js')
  execFileSync(emcc, ['-O2', '-c', join(cpp, 'md4c/md4c.c'), '-o', object], { stdio: 'inherit' })
  execFileSync(
    emcc,
    [
      join(cpp, 'wasm/md4c_wasm.cpp'),
      join(cpp, 'wasm/ASTSerializer.cpp'),
      join(cpp, 'parser/MD4CParser.cpp'),
      object,
      '-I',
      cpp,
      '-O2',
      '-std=c++17',
      '-sWASM=1',
      '-sSINGLE_FILE=1',
      // 新版 Emscripten 默认嵌入含 NUL 的字符串，Git 会当二进制而 patch-package 无法保存。
      '-sSINGLE_FILE_BINARY_ENCODE=0',
      '-sEXPORTED_FUNCTIONS=["_parseMarkdown"]',
      '-sEXPORTED_RUNTIME_METHODS=["ccall","cwrap","UTF8ToString"]',
      '-sENVIRONMENT=web',
      '-sMODULARIZE=1',
      '-sEXPORT_NAME=createMd4cModule',
      '-sSTACK_SIZE=8MB',
      '-sINITIAL_MEMORY=16MB',
      '-sMAXIMUM_MEMORY=512MB',
      '-sALLOW_MEMORY_GROWTH=1',
      '-sGROWABLE_ARRAYBUFFERS=0',
      '-o',
      output,
    ],
    { stdio: 'inherit' },
  )
  // 编译后二进制不保留 C 头文件注释，随网页产物一起保留两份上游许可。
  const notices = ['md4c/md4c.c', 'md4c/litch_cjk.h'].map((path) => {
    const source = readFileSync(join(cpp, path), 'utf8')
    return source.slice(0, source.indexOf('*/') + 2)
  })
  writeFileSync(output, `${notices.join('\n')}\n${readFileSync(output, 'utf8')}`)
  if (readFileSync(output).includes(0)) throw new Error('WASM JS 含 NUL，无法保存成文本补丁')
  // 同时保存源码入口与发布入口，Metro 两条路径都不能退回依赖自带的旧 WASM。
  for (const dir of ['src', 'lib/module'])
    copyFileSync(output, join(dependency, dir, 'web/wasm/md4c-litch.js'))
  const manifest = {
    dependency: packageVersion,
    cjkExtension: '0.1.3',
    emscripten: '4.0.19',
    sources: Object.fromEntries(sources.map((path) => [path, hash(readFileSync(join(cpp, path)))])),
    wasm: hash(readFileSync(output)),
  }
  writeFileSync(
    join(mobile, 'test/fixtures/markdown-wasm.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  console.log('已重建 md4c WASM；请运行 npx patch-package react-native-enriched-markdown 保存补丁')
} finally {
  rmSync(work, { recursive: true, force: true })
}
