// 模拟核心的差异面板（packages/core/src/mock/mock-diffs.mts、sample-repos.mts）：几份示例各是什么样子，
// 和真的核心是同一条路（真的差异模块，对面是假的 git）；另外是“改文件”那句话演的那一出。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createMockCore,
  type DiffBundle,
  type DiffScope,
  type DiffView,
  type FileDiff,
  type SessionView,
} from '../src/index.mjs'
import { MANY } from '../src/mock/sample-repos.mjs'
import { fakeClock, settle } from './helpers.mjs'

const never = { aborted: false, addEventListener() {} }

function setup(deviceId: string, root: string, sessionId: string | null = null) {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, chunkMs: 0 })
  /** 把对面欠着的应答都放出来 */
  const drain = async (until: () => boolean, rounds = 400) => {
    for (let round = 0; round < rounds && !until(); round++) {
      await settle()
      time.advance(1)
    }
  }
  const run = async <T,>(name: string, params: object): Promise<T> => {
    const pending = core.command(
      name,
      { deviceId, root, sessionId, ...params },
      never,
    ) as Promise<T>
    let done = false
    const mark = () => {
      done = true
    }
    pending.then(mark, mark)
    await drain(() => done)
    return pending
  }
  const watch = (scope: DiffScope = 'all') => {
    let view: DiffView | null = null
    const stop = core.subscribe(
      { kind: 'diff', deviceId, root, scope, sessionId },
      {
        snapshot: (data) => {
          view = data as DiffView
        },
        delta: (ops) => {
          for (const op of ops as { view: DiffView }[]) view = op.view
        },
        error() {},
      },
    )
    const latest = (): DiffView => view as unknown as DiffView
    const settled = async (after = -1): Promise<DiffView> => {
      await drain(() => {
        const now = latest()
        return now.phase !== 'loading' && !now.refreshing && now.version !== after
      })
      return latest()
    }
    return { stop, latest, settled }
  }
  return { core, time, run, watch, drain }
}

const brief = (view: DiffView) =>
  view.entries.map((entry) => `${entry.status} ${entry.path} +${entry.added} -${entry.removed}`)

test('本机 litch：各种改动各有一个，三种范围各是各的', async () => {
  const { watch, run } = setup('local', '~/work/litch')
  const all = await watch('all').settled()
  assert.equal(all.phase, 'ready')
  assert.equal(all.branch, 'main')
  assert.equal(all.watching, true)
  assert.deepEqual(brief(all), [
    'modified Makefile +3 -1',
    'modified cmd/codex-harness-adapter/serve.go +2 -3',
    'untracked cmd/codex-harness-adapter/serve_test.go +10 -0',
    'untracked crates/pty/src/lib.rs +10 -0',
    'modified docs/guide.md +3 -0',
    'modified docs/images/shot.png +null -null',
    'deleted docs/旧 笔记.md +0 -4',
    'untracked fixtures/blob.dat +null -null',
    'modified packages/core/src/device/files.mts +6 -0',
    'added packages/core/src/index.mts +1 -0',
    'modified packages/ui/src/app/App.tsx +1 -1',
    'modified scripts/build.sh +0 -0',
    'renamed scripts/tool.py +0 -0',
  ])
  const flags = Object.fromEntries(all.entries.map((entry) => [entry.path, entry]))
  assert.deepEqual(flags['scripts/build.sh']?.mode, { from: '100644', to: '100755' })
  assert.equal(flags['scripts/tool.py']?.from, 'scripts/helper.py')
  const half = flags['packages/core/src/device/files.mts']
  assert.deepEqual([half?.staged, half?.unstaged], [true, true])
  assert.deepEqual(
    (await watch('staged').settled()).entries.map((entry) => entry.path),
    [
      'packages/core/src/device/files.mts',
      'packages/core/src/index.mts',
      'packages/ui/src/app/App.tsx',
      'scripts/tool.py',
    ],
  )
  assert.equal((await watch('unstaged').settled()).entries.length, 10)
  const bundle = await run<DiffBundle>('diff.files', { scope: 'all' })
  assert.equal(bundle.truncated, false)
  assert.deepEqual(
    bundle.files.map((file) => file.kind),
    [
      'text',
      'text',
      'text',
      'text',
      'text',
      'binary',
      'text',
      'binary',
      'text',
      'text',
      'text',
      'empty',
      'empty',
    ],
  )
  assert.equal(bundle.files[0]?.noEolOld, true)
  assert.equal(bundle.files[1]?.hunks.length, 2)
  assert.equal(bundle.files[1]?.language, 'go')
})

test('暂存、取消暂存、还原：假的仓库跟着变，面板自己换成新的', async () => {
  const { watch, run } = setup('local', '~/work/litch')
  const seen = watch('all')
  const first = await seen.settled()
  await run('diff.stage', { paths: ['Makefile'] })
  const staged = seen.latest()
  assert.ok(staged.version > first.version)
  assert.equal(staged.entries.find((entry) => entry.path === 'Makefile')?.staged, true)
  await run('diff.unstage', { paths: ['Makefile'] })
  assert.equal(seen.latest().entries.find((entry) => entry.path === 'Makefile')?.staged, false)
  await run('diff.discard', { scope: 'all', path: 'Makefile', expect: 'modified' })
  await run('diff.discard', {
    scope: 'all',
    path: 'cmd/codex-harness-adapter/serve_test.go',
    expect: 'untracked',
  })
  const paths = seen.latest().entries.map((entry) => entry.path)
  assert.equal(paths.includes('Makefile'), false)
  assert.equal(paths.includes('cmd/codex-harness-adapter/serve_test.go'), false)
  assert.equal(paths.length, 11)
})

test('本机 docs-site：几百个文件，概况照样一次取出来；内容不一次全给', async () => {
  const { watch, run } = setup('local', '~/work/docs-site')
  const view = await watch('all').settled()
  assert.equal(view.entries.length, MANY.modified + MANY.untracked + MANY.deleted)
  assert.equal(view.branch, 'restructure')
  const bundle = await run<DiffBundle>('diff.files', { scope: 'all' })
  assert.equal(bundle.truncated, true)
  const one = await run<FileDiff>('diff.file', {
    scope: 'all',
    path: 'content/guides/topic-007.md',
  })
  assert.deepEqual([one.kind, one.added, one.removed], ['text', 3, 1])
})

test('build-01 litch：改了上万行的文件照给，装不下的没跟踪文件只说太大', async () => {
  const { watch, run } = setup('build', '/srv/work/litch')
  const view = await watch('all').settled()
  const entries = Object.fromEntries(view.entries.map((entry) => [entry.path, entry]))
  assert.ok((entries['fixtures/long.ts']?.added ?? 0) > 2000)
  assert.equal(entries['fixtures/big.log']?.added, 42_000)
  const log = await run<FileDiff>('diff.file', { scope: 'all', path: 'fixtures/big.log' })
  assert.equal(log.kind, 'tooLarge')
  const long = await run<FileDiff>('diff.file', { scope: 'all', path: 'fixtures/long.ts' })
  assert.equal(long.kind, 'text')
  assert.equal(long.added, entries['fixtures/long.ts']?.added)
  const clean = setup('build', '/srv/work/infra')
  const empty = await clean.watch('all').settled()
  assert.deepEqual([empty.phase, empty.entries.length], ['ready', 0])
})

test('nas 起不了进程：说对面不支持；不是仓库的目录：照实说', async () => {
  const nas = setup('nas', '~/backup-scripts')
  const unsupported = await nas.watch('all').settled()
  assert.deepEqual([unsupported.phase, unsupported.why], ['absent', 'unsupported'])
  const plain = setup('local', '/Users/dev/notes/launchd', 's9')
  const view = await plain.watch('all').settled()
  assert.deepEqual([view.phase, view.why, view.source], ['absent', 'notRepo', 'turn'])
})

test('“改文件”：对话里出一条改了文件；差异面板等回合结束才跟着变', async () => {
  const { core, watch, run } = setup('local', '~/work/litch', 's3')
  const seen = watch('all')
  const first = await seen.settled()
  let session: SessionView | null = null
  core.subscribe(
    { kind: 'session', deviceId: 'local', sessionId: 's3' },
    { snapshot: (data) => (session = data as SessionView), delta() {}, error() {} },
  )
  await run('session.send', { text: '改文件', images: [] })
  const next = await seen.settled(first.version)
  assert.deepEqual(
    next.entries.filter((entry) => entry.path.startsWith('notes/')).map((entry) => entry.status),
    ['untracked', 'untracked'],
  )
  assert.ok(session)
  // “改大文件”：另外新写一个六百行的，对话里那一条带着它，差异面板里也有
  await run('session.send', { text: '改大文件', images: [] })
  const third = await seen.settled(next.version)
  assert.equal(third.entries.find((entry) => entry.path === 'notes/agent-big-2.md')?.added, 600)
  // 不是仓库的目录：harness 发了本回合差异的，面板用它
  const plain = setup('local', '/Users/dev/notes/launchd', 's9')
  const turn = plain.watch('all')
  await turn.settled()
  await plain.run('session.send', { text: 'edit files', images: [] })
  await plain.drain(() => turn.latest().phase === 'ready')
  assert.deepEqual(
    [turn.latest().source, turn.latest().writable, ...brief(turn.latest())],
    ['turn', false, 'added notes/agent-1.md +3 -0', 'added notes/agent-log.md +3 -0'],
  )
})
