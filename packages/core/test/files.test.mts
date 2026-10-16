// 文件面板的三条命令（packages/core/src/device/files.mts）：一个真的核心，对面是假对端。
// 看的是：对面收到了什么（每层只问一次、出界的一条都不发）、读回来的东西怎么归类、对面不会时怎么降级。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type ChannelError,
  type DirectoryView,
  encodeBase64,
  type FileContent,
  type FileSearchView,
  LIST_TTL_MS,
  MAX_TEXT_BYTES,
  textToBase64,
} from '../src/index.mjs'
import { type Handler, INIT, RpcFailure } from './fake-server.mjs'
import { project, thread } from './fixtures.mjs'
import { settle } from './helpers.mjs'
import { setup } from './world.mjs'

const ROOT = '/work/app'

type Entry = { fileName: string; isDirectory: boolean; isFile: boolean }
const dir = (fileName: string): Entry => ({ fileName, isDirectory: true, isFile: false })
const file = (fileName: string): Entry => ({ fileName, isDirectory: false, isFile: true })
const link = (fileName: string): Entry => ({ fileName, isDirectory: false, isFile: false })

const meta = (kind: 'dir' | 'file' | 'other') => ({
  isDirectory: kind === 'dir',
  isFile: kind === 'file',
  isSymlink: false,
  createdAtMs: 0,
  modifiedAtMs: 0,
})

const noSuch = (path: string) =>
  new RpcFailure(-32603, `ENOENT: no such file or directory, stat '${path}'`)

/** 一个假的对面：目录和文件各一张表 */
async function open(extra: Record<string, Handler> = {}) {
  const dirs: Record<string, Entry[]> = {
    [ROOT]: [file('b.ts'), dir('src'), file('A.md'), dir('.git'), link('docs-link')],
    [`${ROOT}/src`]: [file('index.ts')],
    [`${ROOT}/docs`]: [file('guide.md')],
  }
  const files: Record<string, string> = {
    [`${ROOT}/b.ts`]: textToBase64('export const b = 1\n'),
    [`${ROOT}/A.md`]: textToBase64('# A\r\n'),
    [`${ROOT}/src/index.ts`]: textToBase64('export {}\n'),
    [`${ROOT}/blob`]: encodeBase64(new Uint8Array([1, 0, 2, 0])),
    [`${ROOT}/shot.png`]: encodeBase64(new Uint8Array([0x89, 0x50])),
  }
  const links: Record<string, 'dir' | 'file'> = { [`${ROOT}/docs-link`]: 'dir' }
  const handlers: Record<string, Handler> = {
    'fs/readDirectory': (params) => {
      const { path } = params as { path: string }
      const entries = dirs[path]
      if (!entries) throw noSuch(path)
      return { entries }
    },
    'fs/getMetadata': (params) => {
      const { path } = params as { path: string }
      if (dirs[path]) return meta('dir')
      if (files[path] !== undefined) return meta('file')
      if (links[path]) return meta(links[path])
      throw noSuch(path)
    },
    'fs/readFile': (params) => {
      const { path } = params as { path: string }
      const data = files[path]
      if (data === undefined) throw noSuch(path)
      return { dataBase64: data }
    },
    fuzzyFileSearch: () => ({ files: [] }),
    ...extra,
  }
  const world = setup([thread({ id: 'a', turns: [] })], handlers)
  world.core.start()
  await settle()
  const list = (path: string, more: object = {}) =>
    world.command('files.list', {
      deviceId: 'local',
      root: ROOT,
      path,
      ...more,
    }) as Promise<DirectoryView>
  const read = (path: string) =>
    world.command('files.read', { deviceId: 'local', root: ROOT, path }) as Promise<FileContent>
  const search = (query: string) =>
    world.command('files.search', {
      deviceId: 'local',
      root: ROOT,
      query,
    }) as Promise<FileSearchView>
  const paths = (method: string) =>
    world.sent(method).map((params) => (params as { path: string }).path)
  return { ...world, dirs, files, list, read, search, paths }
}

async function failureOf(run: Promise<unknown>): Promise<ChannelError> {
  try {
    await run
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('这条命令本该失败')
}

test('列目录：目录在前、隐藏的也在；符号链接去问一遍指向什么，指向目录的归到目录里', async () => {
  const { list, paths } = await open()
  const view = await list(ROOT)
  assert.equal(view.path, ROOT)
  assert.equal(view.total, 5)
  assert.deepEqual(
    view.entries.map((entry) => `${entry.kind}:${entry.name}`),
    ['dir:.git', 'dir:docs-link', 'dir:src', 'file:A.md', 'file:b.ts'],
  )
  assert.deepEqual(paths('fs/readDirectory'), [ROOT])
  assert.deepEqual(paths('fs/getMetadata'), [`${ROOT}/docs-link`])
})

test('列目录：断了的链接照旧算“别的”；路径不带 harness（聚合面上是设备自己读）', async () => {
  const { list, dirs, sent } = await open()
  dirs[`${ROOT}/src`] = [link('dangling'), file('index.ts')]
  const view = await list(`${ROOT}/src`)
  assert.deepEqual(
    view.entries.map((entry) => `${entry.kind}:${entry.name}`),
    ['other:dangling', 'file:index.ts'],
  )
  assert.deepEqual(sent('fs/readDirectory'), [{ path: `${ROOT}/src` }])
})

test('列目录：几秒之内再要直接给上次的；说了不用缓存、或者过了时限才重新问', async () => {
  const { list, dirs, paths, time } = await open()
  const first = await list(`${ROOT}/src`)
  dirs[`${ROOT}/src`] = [file('index.ts'), file('new.ts')]
  assert.deepEqual(await list(`${ROOT}/src`), first)
  // 路径写法不一样、理出来是同一层的也算
  assert.deepEqual(await list(`${ROOT}/src/../src/`), first)
  assert.equal(paths('fs/readDirectory').length, 1)

  const fresh = await list(`${ROOT}/src`, { fresh: true })
  assert.deepEqual(
    fresh.entries.map((entry) => entry.name),
    ['index.ts', 'new.ts'],
  )
  assert.equal(paths('fs/readDirectory').length, 2)

  time.advance(LIST_TTL_MS - 1)
  await list(`${ROOT}/src`)
  assert.equal(paths('fs/readDirectory').length, 2)
  time.advance(1)
  await list(`${ROOT}/src`)
  assert.equal(paths('fs/readDirectory').length, 3)
})

test('列目录：同时要同一层的只问对面一次；其中一个不等了，别的照样拿到', async () => {
  const { core, list, paths } = await open()
  let abort = () => {}
  const signal = {
    aborted: false,
    addEventListener(_type: string, listener: () => void) {
      abort = listener
    },
  }
  const impatient = failureOf(
    core.command('files.list', { deviceId: 'local', root: ROOT, path: ROOT }, signal),
  )
  const patient = [list(ROOT), list(ROOT)]
  abort()
  assert.equal((await impatient).code, 'cancelled')
  const [one, two] = await Promise.all(patient)
  assert.deepEqual(one, two)
  assert.deepEqual(paths('fs/readDirectory'), [ROOT])
  // 那一次的结果进了缓存
  await list(ROOT)
  assert.deepEqual(paths('fs/readDirectory'), [ROOT])
})

test('根之外的路径、不认识的根、Windows 的路径：当场拒掉，对面一条请求都没收到', async () => {
  const { command, list, read, search, peer } = await open()
  const before = peer.last().seen.length
  for (const path of [
    '/etc/passwd',
    `${ROOT}/../other/x.ts`,
    '/work/app-secrets/key',
    'relative.ts',
    '',
  ]) {
    const listed = await failureOf(list(path))
    assert.deepEqual([listed.code, listed.text?.key], ['rejected', 'files.outside'], path)
    const opened = await failureOf(read(path))
    assert.deepEqual([opened.code, opened.text?.key], ['rejected', 'files.outside'], path)
  }
  for (const root of ['/etc', '/work', '/', 'work/app']) {
    const error = await failureOf(
      command('files.list', { deviceId: 'local', root, path: `${root}/x` }),
    )
    assert.deepEqual([error.code, error.text?.key], ['rejected', 'files.unknownRoot'], root)
    const found = await failureOf(command('files.search', { deviceId: 'local', root, query: 'x' }))
    assert.deepEqual([found.code, found.text?.key], ['rejected', 'files.unknownRoot'], root)
  }
  const windows = await failureOf(
    command('files.list', { deviceId: 'local', root: 'C:\\work\\app', path: 'C:\\work\\app' }),
  )
  assert.deepEqual([windows.code, windows.text?.key], ['unsupported', 'files.windows'])
  assert.equal((await search('')).matches.length, 0)
  assert.equal(peer.last().seen.length, before)
})

test('macOS 上根的另一种写法（/private/tmp 和 /tmp）：路径换成根的写法再去取；对面是 Linux 时不认', async () => {
  const root = '/tmp/w/app'
  const real = `/private${root}`
  for (const platformOs of ['macos', 'linux']) {
    const world = setup([thread({ id: 'a', cwd: root, turns: [] })], {
      initialize: () => ({ ...INIT, platformOs }),
      'fs/getMetadata': () => meta('file'),
      'fs/readFile': () => ({ dataBase64: textToBase64('# A\n') }),
      fuzzyFileSearch: () => ({
        files: [
          {
            root: real,
            path: 'a.md',
            match_type: 'file',
            file_name: 'a.md',
            score: 9,
            indices: null,
          },
        ],
      }),
    })
    world.core.start()
    await settle()
    const read = world.command('files.read', { deviceId: 'local', root, path: `${real}/a.md` })
    const found = (await world.command('files.search', {
      deviceId: 'local',
      root,
      query: 'a',
    })) as FileSearchView
    if (platformOs === 'linux') {
      const error = await failureOf(read)
      assert.deepEqual([error.code, error.text?.key], ['rejected', 'files.outside'])
      assert.deepEqual(world.sent('fs/readFile'), [])
      assert.deepEqual(found.matches, [])
      continue
    }
    assert.equal(((await read) as FileContent).path, `${root}/a.md`)
    assert.deepEqual(world.sent('fs/readFile'), [{ path: `${root}/a.md` }])
    assert.deepEqual(found.matches, [
      { path: `${root}/a.md`, relative: 'a.md', kind: 'file', indices: null },
    ])
  }
})

test('认得的根：会话的工作目录，和工作区的根（末尾带不带斜杠都算）', async () => {
  const { command, sent } = await open({
    'project/list': () => ({ data: [project('p', 'repo', '/srv/repo/')], nextCursor: null }),
    'fs/readDirectory': () => ({ entries: [] }),
  })
  await command('files.list', { deviceId: 'local', root: '/srv/repo', path: '/srv/repo/pkg' })
  await command('files.list', { deviceId: 'local', root: '/work/app/', path: '/work/app' })
  assert.deepEqual(sent('fs/readDirectory'), [{ path: '/srv/repo/pkg' }, { path: '/work/app' }])
})

test('读文件：文字带着语言；先问是什么，再读；同时读同一个只读一次', async () => {
  const { read, paths } = await open()
  const [content, again] = await Promise.all([read(`${ROOT}/A.md`), read(`${ROOT}/A.md`)])
  assert.deepEqual(content, {
    kind: 'text',
    path: `${ROOT}/A.md`,
    text: '# A\n',
    bytes: 5,
    language: 'markdown',
    lossy: false,
  })
  assert.deepEqual(again, content)
  assert.deepEqual(paths('fs/getMetadata'), [`${ROOT}/A.md`])
  assert.deepEqual(paths('fs/readFile'), [`${ROOT}/A.md`])
})

test('读文件：目录、不在了的、不是文字的、看扩展名就不读的、太大的，各有各的结果，都不算出错', async () => {
  const { read, files, paths } = await open()
  assert.deepEqual(await read(`${ROOT}/src`), { kind: 'directory', path: `${ROOT}/src` })
  assert.deepEqual(await read(`${ROOT}/nope.ts`), { kind: 'missing', path: `${ROOT}/nope.ts` })
  assert.deepEqual(await read(`${ROOT}/blob`), {
    kind: 'binary',
    path: `${ROOT}/blob`,
    group: 'binary',
    bytes: 4,
  })
  // 图片：问过是什么之后不去读
  assert.deepEqual(await read(`${ROOT}/shot.png`), {
    kind: 'binary',
    path: `${ROOT}/shot.png`,
    group: 'image',
    bytes: null,
  })
  assert.equal(paths('fs/readFile').includes(`${ROOT}/shot.png`), false)

  files[`${ROOT}/big.log`] = textToBase64('x'.repeat(MAX_TEXT_BYTES + 1))
  assert.deepEqual(await read(`${ROOT}/big.log`), {
    kind: 'tooLarge',
    path: `${ROOT}/big.log`,
    bytes: MAX_TEXT_BYTES + 1,
    limit: MAX_TEXT_BYTES,
  })
})

test('读文件：问的时候还在、读的时候没了，算不在了；别的错照对面的原话报', async () => {
  const { read } = await open({
    'fs/getMetadata': () => meta('file'),
    'fs/readFile': (params) => {
      const { path } = params as { path: string }
      if (path.endsWith('gone.txt')) throw noSuch(path)
      throw new RpcFailure(-32603, `EACCES: permission denied, open '${path}'`)
    },
  })
  assert.deepEqual(await read(`${ROOT}/gone.txt`), { kind: 'missing', path: `${ROOT}/gone.txt` })
  const denied = await failureOf(read(`${ROOT}/secret.txt`))
  assert.equal(denied.code, 'remote')
  assert.match(denied.message, /EACCES/)
})

test('读文件：管道、套接字这类不是普通文件的不去读', async () => {
  const { read, paths } = await open({ 'fs/getMetadata': () => meta('other') })
  assert.deepEqual(await read(`${ROOT}/pipe`), {
    kind: 'binary',
    path: `${ROOT}/pipe`,
    group: 'binary',
    bytes: null,
  })
  assert.deepEqual(paths('fs/readFile'), [])
})

test('对面不会读目录读文件：说清楚是不支持，记住了不再去问；找文件不受牵连', async () => {
  const missing = () => {
    throw new RpcFailure(-32601, 'Method not found')
  }
  const { list, read, search, paths, sent } = await open({
    'fs/readDirectory': missing,
    'fs/getMetadata': missing,
    'fs/readFile': missing,
  })
  const first = await failureOf(list(ROOT))
  assert.deepEqual([first.code, first.text?.key], ['unsupported', 'files.unsupported'])
  const second = await failureOf(list(`${ROOT}/src`))
  const third = await failureOf(read(`${ROOT}/A.md`))
  assert.deepEqual([second.code, third.code], ['unsupported', 'unsupported'])
  assert.deepEqual(paths('fs/readDirectory'), [ROOT])
  assert.deepEqual(paths('fs/getMetadata'), [])
  assert.deepEqual(await search('a'), { query: 'a', matches: [] })
  assert.equal(sent('fuzzyFileSearch').length, 1)
})

test('对面不会找文件（原生 codex 的说法也认）：只停找文件；重连之后重新试', async () => {
  let known = false
  const { list, search, sent, peer, time } = await open({
    fuzzyFileSearch: () => {
      if (!known) throw new RpcFailure(-32600, 'Invalid request: unknown variant `fuzzyFileSearch`')
      return { files: [] }
    },
  })
  const first = await failureOf(search('a'))
  assert.deepEqual([first.code, first.text?.key], ['unsupported', 'files.searchUnsupported'])
  assert.equal((await failureOf(search('ab'))).code, 'unsupported')
  assert.equal(sent('fuzzyFileSearch').length, 1)
  assert.equal((await list(ROOT)).total, 5)

  known = true
  peer.last().drop()
  await settle()
  time.advance(500)
  await settle()
  assert.deepEqual(await search('a'), { query: 'a', matches: [] })
})

test('找文件：结果换成完整路径和相对路径；根之外的、没有路径的不收', async () => {
  const { search, sent } = await open({
    fuzzyFileSearch: () => ({
      files: [
        {
          root: ROOT,
          path: 'src/index.ts',
          match_type: 'file',
          file_name: 'index.ts',
          score: 90,
          indices: [4, 5],
        },
        {
          root: ROOT,
          path: 'src',
          match_type: 'directory',
          file_name: 'src',
          score: 80,
          indices: null,
        },
        {
          root: ROOT,
          path: '../other/x.ts',
          match_type: 'file',
          file_name: 'x.ts',
          score: 70,
          indices: null,
        },
        {
          root: '/elsewhere',
          path: 'y.ts',
          match_type: 'file',
          file_name: 'y.ts',
          score: 60,
          indices: null,
        },
        { root: ROOT, path: '', match_type: 'file', file_name: '', score: 50, indices: null },
      ],
    }),
  })
  assert.deepEqual(await search('  idx '), {
    query: 'idx',
    matches: [
      { path: `${ROOT}/src/index.ts`, relative: 'src/index.ts', kind: 'file', indices: [4, 5] },
      { path: `${ROOT}/src`, relative: 'src', kind: 'dir', indices: null },
    ],
  })
  assert.deepEqual(sent('fuzzyFileSearch'), [
    { query: 'idx', roots: [ROOT], cancellationToken: `litch-files:${ROOT}` },
  ])
})

test('找文件：同一个根上后来的一次让前一次以 cancelled 结束', async () => {
  // 对面一直不回：前一次只能靠后一次把它顶掉
  let answer = false
  const { search } = await open({
    fuzzyFileSearch: () => (answer ? { files: [] } : undefined),
  })
  const first = failureOf(search('a'))
  await settle()
  answer = true
  const second = search('ab')
  assert.equal((await first).code, 'cancelled')
  assert.deepEqual(await second, { query: 'ab', matches: [] })
})

test('要过几次：各层目录、各个文件真的向对面要的次数，走缓存的不算', async () => {
  const { command, list, read } = await open()
  await list(ROOT)
  await list(ROOT)
  await list(`${ROOT}/src`)
  await list(ROOT, { fresh: true })
  await read(`${ROOT}/A.md`)
  assert.deepEqual(await command('files.requests', { deviceId: 'local' }), {
    lists: { [ROOT]: 2, [`${ROOT}/src`]: 1 },
    reads: { [`${ROOT}/A.md`]: 1 },
  })
})

test('连接断了：命令以 offline 结束；重新连上之后缓存不算数，重新去问', async () => {
  const { list, read, search, peer, time, paths } = await open()
  await list(ROOT)
  peer.last().drop()
  await settle()
  assert.equal((await failureOf(list(ROOT))).code, 'offline')
  assert.equal((await failureOf(read(`${ROOT}/A.md`))).code, 'offline')
  assert.equal((await failureOf(search('a'))).code, 'offline')

  time.advance(500)
  await settle()
  assert.equal((await list(ROOT)).total, 5)
  assert.deepEqual(paths('fs/readDirectory'), [ROOT])
})
