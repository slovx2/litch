// 差异面板的示例仓库：编出来的三棵树（上一次提交、暂存区、工作区），假的 git（mock-git.mts）在上面回答。
// 工作区里的内容取自示例文件树（sample-files.mts），所以差异里的文件在“文件”标签里也打得开。
//
// - 本机 ~/work/litch：各种改动各有一个（改了的、暂存了一半的、新加的、删了的、改了名的、只变了权限的、
//   二进制的、末尾没有换行的、没跟踪的）。
// - 本机 ~/work/docs-site：一次改了几百个文件。
// - build-01 /srv/work/litch：有一个改了上万行的文件、一个几万行的没跟踪的日志、一个单行几万字的文件。
// - build-01 /srv/work/infra：干净的仓库，没有改动。
// 没列在这里的目录都不是 git 仓库。
import type { FakeBlob, FakeRepo, FakeTree } from './mock-git.mjs'
import { sampleFiles } from './sample-files.mjs'
import type { SampleLang } from './sample-text.mjs'

/** 示例数据里 ~ 指的目录（和 mock-files.mts 里的是同一个） */
export const SAMPLE_HOME = '/Users/dev'

/** “几百个文件”那个仓库里各种改动各有多少个 */
export const MANY = { modified: 300, untracked: 80, deleted: 40 }

const pad = (n: number): string => String(n).padStart(3, '0')

/** 把一段字换掉。示例内容里没有这段字就原样（那是示例数据改了，这里跟着不出错就行） */
const swap = (text: string, from: string, to: string): string =>
  text.includes(from) ? text.replace(from, to) : text

function mixed(lang: SampleLang, top: string): FakeRepo {
  const zh = lang === 'zh-CN'
  const tree = sampleFiles(lang)
  const at = (path: string): FakeBlob => ({ data: tree.read(path) ?? '' })
  const textAt = (path: string): string => {
    const data = tree.read(path)
    return typeof data === 'string' ? data : ''
  }
  const work: FakeTree = new Map()
  const tracked = [
    'README.md',
    'AGENTS.md',
    'package.json',
    'Makefile',
    '.gitignore',
    '.github/workflows/ci.yml',
    'cmd/codex-harness-adapter/serve.go',
    'packages/core/src/device/files.mts',
    'packages/core/src/index.mts',
    'packages/ui/src/app/App.tsx',
    'packages/ui/src/styles/base.css',
    'scripts/build.sh',
    'scripts/tool.py',
    'docs/guide.md',
    'docs/snippet.html',
    'docs/images/shot.png',
  ]
  for (const path of tracked) work.set(path, at(path))
  work.set('scripts/build.sh', { data: textAt('scripts/build.sh'), exec: true })
  const index: FakeTree = new Map(work)
  // 没跟踪的三个：两个文字的，一个不是文字的
  for (const path of [
    'cmd/codex-harness-adapter/serve_test.go',
    'crates/pty/src/lib.rs',
    'fixtures/blob.dat',
  ]) {
    work.set(path, at(path))
  }

  // 暂存了一半的：常量已经暂存，下面那个函数还没有
  const files = textAt('packages/core/src/device/files.mts')
  const withoutInside = files.slice(0, Math.max(0, files.indexOf('export function inside')))
  index.set('packages/core/src/device/files.mts', { data: withoutInside })
  // 只变了权限的：还没暂存
  index.set('scripts/build.sh', { data: textAt('scripts/build.sh') })
  // 二进制的：还没暂存
  const oldShot = { data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]) }
  index.set('docs/images/shot.png', oldShot)
  // 没暂存的改动：暂存区里还是上一次提交的样子
  const serve = textAt('cmd/codex-harness-adapter/serve.go')
  const oldServe = swap(
    serve
      .split('\n')
      .filter((line) => !line.startsWith('// '))
      .join('\n'),
    '\tif err != nil { return listenFailure(c.port, err) }',
    '\tif err != nil {\n\t\treturn err\n\t}',
  )
  index.set('cmd/codex-harness-adapter/serve.go', { data: oldServe })
  const guide = textAt('docs/guide.md').split('\n')
  const oldGuide = [...guide.slice(0, 11), ...guide.slice(13, 16), ''].join('\n')
  index.set('docs/guide.md', { data: oldGuide })
  const oldMake = 'build:\n\tnpm run build\n\ntest: build\n\tnpm test'
  index.set('Makefile', { data: oldMake })
  // 删了的：名字里有空格，中文界面下还有中文
  const gone = zh ? 'docs/旧 笔记.md' : 'docs/old notes.md'
  const goneText = zh
    ? '# 旧笔记\n\n- 入口和运行时是一起启动的。\n- 端口写死在代码里。\n'
    : '# Old notes\n\n- The entry and the runtime start together.\n- The port is hard-coded.\n'
  index.set(gone, { data: goneText })

  const head: FakeTree = new Map(index)
  // 暂存了的：上一次提交里是另一个样子
  head.set('packages/core/src/device/files.mts', {
    data: swap(withoutInside, 'export const LIST_TTL_MS = 5000\n\n', ''),
  })
  head.delete('packages/core/src/index.mts')
  head.set('packages/ui/src/app/App.tsx', {
    data: swap(
      textAt('packages/ui/src/app/App.tsx'),
      zh ? '      点了 {count} 次' : '      Clicked {count} times',
      '      {count}',
    ),
  })
  // 改了名的：内容没动
  head.delete('scripts/tool.py')
  head.set('scripts/helper.py', at('scripts/tool.py'))
  return { top, branch: 'main', head, index, work }
}

function many(lang: SampleLang, top: string): FakeRepo {
  const zh = lang === 'zh-CN'
  const head: FakeTree = new Map()
  const work: FakeTree = new Map()
  head.set('README.md', { data: '# docs-site\n' })
  work.set('README.md', { data: '# docs-site\n' })
  for (let n = 1; n <= MANY.modified; n++) {
    const path = `content/guides/topic-${pad(n)}.md`
    const body = zh
      ? `这一篇讲第 ${n} 个主题。\n\n- 先装好\n- 再配置\n\n有问题看排查那一节。\n`
      : `This page covers topic ${n}.\n\n- Install first\n- Then configure\n\nSee troubleshooting if stuck.\n`
    head.set(path, { data: `# Topic ${n}\n\n${body}` })
    work.set(path, {
      data: `# ${zh ? '主题' : 'Topic'} ${n}\n\n${body}\n${zh ? '上次核对：2026-10。' : 'Last checked: 2026-10.'}\n`,
    })
  }
  for (let n = 1; n <= MANY.deleted; n++) {
    head.set(`static/legacy/page-${pad(n)}.html`, {
      data: `<!doctype html>\n<title>page ${n}</title>\n<p>moved</p>\n`,
    })
  }
  const index: FakeTree = new Map(head)
  for (const path of head.keys()) {
    if (path.startsWith('static/legacy/')) index.delete(path)
  }
  for (let n = 1; n <= MANY.untracked; n++) {
    work.set(`content/api/ref-${pad(n)}.md`, {
      data: `# ref ${n}\n\n\`\`\`ts\nexport function ref${n}(): number {\n  return ${n}\n}\n\`\`\`\n`,
    })
  }
  return { top, branch: 'restructure', head, index, work }
}

function huge(lang: SampleLang, top: string): FakeRepo {
  const tree = sampleFiles(lang)
  const textAt = (path: string): string => {
    const data = tree.read(path)
    return typeof data === 'string' ? data : ''
  }
  const long = textAt('fixtures/long.ts')
  const minified = textAt('fixtures/minified.js')
  const readme = textAt('README.md')
  const head: FakeTree = new Map([
    // 每个函数都改过：上万行的增删
    ['fixtures/long.ts', { data: long.replace(/input/g, 'value').replace(/step-/g, 'stage-') }],
    ['fixtures/minified.js', { data: swap(minified, 'console.log(a.length)', 'void a') }],
    ['README.md', { data: swap(readme, 'npm ci\n', '') }],
  ])
  const index: FakeTree = new Map(head)
  const work: FakeTree = new Map([
    ['fixtures/long.ts', { data: long }],
    ['fixtures/minified.js', { data: minified }],
    ['README.md', { data: readme }],
    ['fixtures/big.log', { data: textAt('fixtures/big.log') }],
  ])
  return { top, branch: 'main', head, index, work }
}

function clean(top: string): FakeRepo {
  const head: FakeTree = new Map([
    ['README.md', { data: '# infra\n' }],
    ['deploy.sh', { data: '#!/bin/sh\nset -eu\necho deploy\n', exec: true }],
  ])
  return { top, branch: 'main', head, index: new Map(head), work: new Map(head) }
}

/** 设备 → 仓库顶层（完整路径）→ 怎么造这个仓库。用到了才造 */
export function sampleRepos(lang: SampleLang): Map<string, Map<string, () => FakeRepo>> {
  const litch = `${SAMPLE_HOME}/work/litch`
  const docs = `${SAMPLE_HOME}/work/docs-site`
  return new Map([
    [
      'local',
      new Map([
        [litch, () => mixed(lang, litch)],
        [docs, () => many(lang, docs)],
      ]),
    ],
    [
      'build',
      new Map([
        ['/srv/work/litch', () => huge(lang, '/srv/work/litch')],
        ['/srv/work/infra', () => clean('/srv/work/infra')],
      ]),
    ],
  ])
}
