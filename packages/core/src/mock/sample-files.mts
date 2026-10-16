// 模拟核心的示例文件树。内容全是编出来的，每个工作区的根下面都是这同一棵。
// 里面特意放了几样给界面试边角用的：
// - fixtures/many：三万个条目的目录，试“展开不卡”；
// - fixtures/long.ts：六千行的源文件，试大文件上色不卡；fixtures/minified.js：一行特别长的；
// - fixtures/big.log：超过显示上限的文件；fixtures/blob.dat：里面不是文字的；docs/images/shot.png：看扩展名就不读的；
// - fixtures/latin1.txt：不是 UTF-8 的；fixtures/gone.txt：列得出来、读的时候已经没了的；
// - fixtures/locked：列不了的目录；fixtures/empty：空目录；link-to-docs：指向目录的符号链接；
// - docs/snippet.html：里面有脚本和带事件的标记，试“内容只当字显示”；
// - 以点开头的 .github、.gitignore：隐藏的。
import type { SampleLang } from './sample-text.mjs'

/** fixtures/many 里一共这么多个条目：前面是目录，后面是文件 */
export const MANY_ENTRIES = 30_000
const MANY_DIRS = 40
const MANY_DIR = 'fixtures/many'

export type SampleData = string | Uint8Array

export interface SampleEntry {
  name: string
  /** link：符号链接，指向 target（相对于根） */
  kind: 'dir' | 'file' | 'link'
  target?: string
}

export interface SampleFiles {
  /** 一层目录里有什么。不是目录是 null */
  list(relative: string): SampleEntry[] | null
  /** 文件的内容。不是文件是 null */
  read(relative: string): SampleData | null
  /** 这个路径是什么。跟着符号链接走；没有是 null */
  kind(relative: string): 'dir' | 'file' | null
  /** 全部的文件和目录（相对路径），找文件用 */
  all(): { path: string; kind: 'dir' | 'file' }[]
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0')

/** serve.go：第 131 行正是示例对话里 grep 出来的那一行 */
function serveGo(zh: boolean): string {
  const lines = [
    'package main',
    '',
    'import (',
    '\t"fmt"',
    '\t"net"',
    ')',
    '',
    zh
      ? '// 运行时和 SSH 入口分两步启动：入口没起来只标这一个入口，运行时照常。'
      : '// The runtime and the SSH entry start in two steps: a failed entry only marks itself.',
    'type entry struct {',
    '\tport    int',
    '\tfailure string',
    '}',
    '',
  ]
  // 凑到第 127 行为止：下面那个函数的第四行正好落在第 131 行
  for (let n = 1; lines.length + 7 <= 127; n++) {
    lines.push(
      `func check${pad(n, 2)}(c *entry) error {`,
      `\tif c.port <= ${1000 + n} {`,
      `\t\treturn fmt.Errorf("port %d is reserved", c.port)`,
      '\t}',
      '\treturn nil',
      '}',
      '',
    )
  }
  while (lines.length < 127) lines.push('')
  lines.push(
    'func startSSHEntry(c *entry) error {',
    '\tlistener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", c.port))',
    '\t_ = listener',
    '\tif err != nil { return listenFailure(c.port, err) }',
    '\treturn nil',
    '}',
    '',
    'func listenFailure(port int, err error) error {',
    '\treturn fmt.Errorf("listen on %d: %w", port, err)',
    '}',
    '',
  )
  return lines.join('\n')
}

/** 六千来行的 TypeScript：有注释、字符串、模板串、类型，够上色库忙一阵 */
function longSource(zh: boolean): string {
  const blocks: string[] = [
    zh
      ? '// 这个文件是生成出来的，用来试大文件的上色。'
      : '// Generated file, used to try highlighting a large source.',
    "import { strict as assert } from 'node:assert'",
    '',
    'export interface Step {',
    '  id: number',
    '  label: string',
    '  run(input: number): number',
    '}',
    '',
  ]
  for (let n = 1; n <= 500; n++) {
    blocks.push(
      '/**',
      zh
        ? ` * 第 ${n} 步：把输入乘上 ${n}，再加上零头。`
        : ` * Step ${n}: multiply the input by ${n}, then add the remainder.`,
      ' */',
      `export function step${n}(input: number): number {`,
      `  const label = \`step-${n}: \${input}\``,
      `  assert.ok(label.length > 0, 'label must not be empty')`,
      `  if (input % ${n + 1} === 0) return input * ${n}`,
      `  return input * ${n} + (input % ${n + 1})`,
      '}',
      '',
      `export const STEP_${n}: Step = { id: ${n}, label: 'step-${n}', run: step${n} }`,
      '',
    )
  }
  return blocks.join('\n')
}

/** docs/guide.md：第 12 行是示例对话里链接指过去的那一行 */
function guide(zh: boolean): string {
  const lines = zh
    ? [
        '# 上手',
        '',
        '先看 `README.md`，再看 `packages/core/src/index.mts`。',
        '',
        '## 启动',
        '',
        '```sh',
        'make build',
        './bin/litch serve --port 7332',
        '```',
        '',
        '入口监听失败时，只有这一个入口标成失败，运行时照常。',
        '',
        '## 排查',
        '',
        '- 端口被占：换一个端口，或者停掉占着它的进程。',
        '- 连不上：先在那台机器上跑一遍诊断。',
        '',
      ]
    : [
        '# Getting started',
        '',
        'Read `README.md` first, then `packages/core/src/index.mts`.',
        '',
        '## Starting',
        '',
        '```sh',
        'make build',
        './bin/litch serve --port 7332',
        '```',
        '',
        'When an entry fails to listen, only that entry is marked failed; the runtime carries on.',
        '',
        '## Troubleshooting',
        '',
        '- Port in use: pick another port, or stop whatever holds it.',
        '- Cannot connect: run the diagnostics on that machine first.',
        '',
      ]
  return lines.join('\n')
}

function staticFiles(lang: SampleLang): Map<string, () => SampleData> {
  const zh = lang === 'zh-CN'
  const say = (a: string, b: string): string => (zh ? a : b)
  const files = new Map<string, () => SampleData>()
  const put = (path: string, content: string | (() => SampleData)) =>
    files.set(path, typeof content === 'string' ? () => content : content)

  put(
    'README.md',
    [
      '# litch',
      '',
      say(
        '示例工作区。这里的文件都是模拟核心编出来的。',
        'A sample workspace. Every file here is made up by the mock core.',
      ),
      '',
      '```sh',
      'npm ci',
      'npm run build',
      '```',
      '',
      say(
        '- 目录：`packages/`、`cmd/`、`scripts/`',
        '- Directories: `packages/`, `cmd/`, `scripts/`',
      ),
      '',
    ].join('\n'),
  )
  put(
    'AGENTS.md',
    say(
      '# 开发约定\n\n- 注释用中文。\n- 依赖写精确版本。\n',
      '# Conventions\n\n- Keep comments short.\n- Pin exact versions.\n',
    ),
  )
  put(
    'package.json',
    `${JSON.stringify({ name: 'litch', version: '0.5.1', private: true, type: 'module', scripts: { build: 'node scripts/build.mjs', test: 'node --test' } }, null, 2)}\n`,
  )
  put('Makefile', 'build:\n\tnpm run build\n\ntest: build\n\tnpm test\n\n.PHONY: build test\n')
  put('.gitignore', 'node_modules/\ndist/\n.env\n')
  put(
    '.github/workflows/ci.yml',
    'name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n',
  )
  put('cmd/codex-harness-adapter/serve.go', () => serveGo(zh))
  put(
    'cmd/codex-harness-adapter/serve_test.go',
    'package main\n\nimport "testing"\n\nfunc TestEntryFailureKeepsRuntime(t *testing.T) {\n\tc := &entry{port: 7332}\n\tif err := startSSHEntry(c); err != nil {\n\t\tt.Log(err)\n\t}\n}\n',
  )
  put(
    'packages/core/src/device/files.mts',
    [
      say(
        '// 一台设备上的文件：列目录、读文件、找文件。',
        '// Files on one device: list, read, search.',
      ),
      "import { normalizePath } from '../text/paths.mjs'",
      '',
      'export const LIST_TTL_MS = 5000',
      '',
      'export interface Listing {',
      '  path: string',
      '  names: string[]',
      '}',
      '',
      'export function inside(root: string, path: string): boolean {',
      '  const full = normalizePath(path)',
      '  return full === root || full.startsWith(`${root}/`)',
      '}',
      '',
    ].join('\n'),
  )
  put(
    'packages/core/src/index.mts',
    "export { inside, LIST_TTL_MS, type Listing } from './device/files.mjs'\n",
  )
  put(
    'packages/ui/src/app/App.tsx',
    [
      "import { useState } from 'react'",
      '',
      'export function App() {',
      '  const [count, setCount] = useState(0)',
      '  return (',
      '    <button type="button" onClick={() => setCount(count + 1)}>',
      say('      点了 {count} 次', '      Clicked {count} times'),
      '    </button>',
      '  )',
      '}',
      '',
    ].join('\n'),
  )
  put(
    'packages/ui/src/styles/base.css',
    ':root {\n  --ink: #191a21;\n}\n\nbody {\n  margin: 0;\n  color: var(--ink);\n}\n',
  )
  put(
    'scripts/build.sh',
    '#!/bin/sh\nset -eu\n\nfor name in core ui; do\n  echo "build $name"\ndone\n',
  )
  put(
    'scripts/tool.py',
    'import sys\n\n\ndef main(argv: list[str]) -> int:\n    print(f"args: {len(argv)}")\n    return 0\n\n\nif __name__ == "__main__":\n    sys.exit(main(sys.argv))\n',
  )
  put(
    'crates/pty/src/lib.rs',
    'pub struct Size {\n    pub rows: u16,\n    pub cols: u16,\n}\n\nimpl Size {\n    pub fn cells(&self) -> u32 {\n        u32::from(self.rows) * u32::from(self.cols)\n    }\n}\n',
  )
  put('docs/guide.md', guide(zh))
  // 里面有标记的文件：查看器要把它当字显示，不能当成页面的一部分
  put(
    'docs/snippet.html',
    '<!doctype html>\n<p id="litch-leak">hello</p>\n<img src="x" onerror="window.__litchLeak = 1">\n<script>window.__litchLeak = 2</script>\n',
  )
  put('docs/images/shot.png', () =>
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )
  put('fixtures/long.ts', () => longSource(zh))
  put(
    'fixtures/minified.js',
    () => `var a=[${Array.from({ length: 6000 }, (_, n) => n).join(',')}];console.log(a.length)\n`,
  )
  put(
    'fixtures/big.log',
    () =>
      `${'2026-10-13T08:00:00Z INFO  entry ready port=7332 runtime=pi elapsed=12ms\n'.repeat(42_000)}`,
  )
  put('fixtures/blob.dat', () => Uint8Array.from({ length: 2048 }, (_, n) => (n * 7) % 256))
  // “café”用的是单字节编码：é 是一个 0xE9，不是合法的 UTF-8
  put('fixtures/latin1.txt', () => Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  put('fixtures/gone.txt', '')
  return files
}

/** 没有文件在里面、但要有的目录 */
const EXTRA_DIRS = ['fixtures/empty', 'fixtures/locked', MANY_DIR]

export function sampleFiles(lang: SampleLang): SampleFiles {
  const files = staticFiles(lang)
  const dirs = new Set<string>([''])
  const addDirs = (path: string) => {
    for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
      dirs.add(path.slice(0, at))
    }
  }
  for (const path of files.keys()) addDirs(path)
  for (const dir of EXTRA_DIRS) {
    dirs.add(dir)
    addDirs(dir)
  }
  const links = new Map<string, string>([['link-to-docs', 'docs']])

  const manyName = (index: number): SampleEntry =>
    index < MANY_DIRS
      ? { name: `group-${pad(index, 2)}`, kind: 'dir' }
      : { name: `item-${pad(index - MANY_DIRS, 5)}.txt`, kind: 'file' }
  /** fixtures/many 下面的路径是什么：它里面的东西不放进表里，按名字现算 */
  const inMany = (relative: string): 'dir' | 'file' | null => {
    if (!relative.startsWith(`${MANY_DIR}/`)) return null
    const rest = relative.slice(MANY_DIR.length + 1)
    if (/^group-\d\d$/.test(rest)) return Number(rest.slice(6)) < MANY_DIRS ? 'dir' : null
    if (/^group-\d\d\/note-[1-3]\.md$/.test(rest)) return 'file'
    const item = /^item-(\d{5})\.txt$/.exec(rest)
    return item && Number(item[1]) < MANY_ENTRIES - MANY_DIRS ? 'file' : null
  }

  /** 路径开头是符号链接的，换成它指向的地方 */
  const resolve = (relative: string): string => {
    for (const [link, target] of links) {
      if (relative === link) return target
      if (relative.startsWith(`${link}/`)) return target + relative.slice(link.length)
    }
    return relative
  }

  const kind = (relative: string): 'dir' | 'file' | null => {
    const real = resolve(relative)
    if (dirs.has(real)) return 'dir'
    if (files.has(real)) return 'file'
    return inMany(real)
  }

  return {
    kind,
    list(relative) {
      const real = resolve(relative)
      if (kind(real) !== 'dir') return null
      if (real === MANY_DIR) return Array.from({ length: MANY_ENTRIES }, (_, n) => manyName(n))
      if (inMany(real) === 'dir')
        return [1, 2, 3].map((n) => ({ name: `note-${n}.md`, kind: 'file' }))
      const prefix = real === '' ? '' : `${real}/`
      const names = new Map<string, SampleEntry>()
      const child = (path: string, entry: SampleEntry['kind']) => {
        if (!path.startsWith(prefix) || path === real) return
        const rest = path.slice(prefix.length)
        if (rest && !rest.includes('/')) names.set(rest, { name: rest, kind: entry })
      }
      for (const dir of dirs) child(dir, 'dir')
      for (const path of files.keys()) child(path, 'file')
      for (const [path, target] of links) {
        child(path, 'link')
        const entry = names.get(path.slice(prefix.length))
        if (entry?.kind === 'link') entry.target = target
      }
      return [...names.values()]
    },
    read(relative) {
      const real = resolve(relative)
      const direct = files.get(real)
      if (direct) return direct()
      return inMany(real) === 'file' ? `${real}\n` : null
    },
    all() {
      const out: { path: string; kind: 'dir' | 'file' }[] = []
      for (const dir of dirs) if (dir) out.push({ path: dir, kind: 'dir' })
      for (const path of files.keys()) out.push({ path, kind: 'file' })
      for (let n = 0; n < MANY_ENTRIES; n++) {
        const entry = manyName(n)
        out.push({ path: `${MANY_DIR}/${entry.name}`, kind: entry.kind === 'dir' ? 'dir' : 'file' })
      }
      return out
    },
  }
}
