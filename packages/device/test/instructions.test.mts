// 统一模式（litch/device/instructions/unify|separate）：设备进程自己做的文件操作。
import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { readInstructions, writeInstructions } from '../src/instructions.mjs'
import { FakeUpstream } from './fake-upstream.mjs'
import { assertHcError, assertHcParams, assertHcResponse } from './hc-kit.mjs'
import { rig, tempDir } from './helpers.mjs'

const UNIFY = 'litch/device/instructions/unify'
const SEPARATE = 'litch/device/instructions/separate'

/** 一台设备上四个 harness 的指令文件：codex、claude 有，pi 的目录在但没文件，dsh 没装（目录都没有） */
function homes() {
  const root = tempDir()
  const paths = {
    codex: join(root, '.codex', 'AGENTS.md'),
    claude: join(root, '.claude', 'CLAUDE.md'),
    pi: join(root, '.pi', 'agent', 'AGENTS.md'),
    dsh: join(root, '.dsh', 'AGENTS.md'),
  }
  mkdirSync(join(root, '.codex'))
  mkdirSync(join(root, '.claude'))
  mkdirSync(join(root, '.pi', 'agent'), { recursive: true })
  writeFileSync(paths.codex, 'codex 原来的\n')
  writeFileSync(paths.claude, 'claude 原来的\n')
  return { root, paths }
}

const backupsIn = (directory: string, name: string) =>
  readdirSync(directory).filter((entry) => entry.startsWith(`${name}.litch-backup-`))

test('统一：source 写成真文件，其余备份后换成软链，父目录不在的跳过；再来一次不重复备份', async () => {
  const env = rig({ pi: new FakeUpstream('pi') })
  const { root, paths } = homes()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'harnessConfig'])
    const params = {
      sourcePath: paths.codex,
      content: '# 统一的\n',
      linkPaths: [paths.claude, paths.pi, paths.dsh, paths.codex],
    }
    assertHcParams(UNIFY, params)
    const result = await client.call(UNIFY, params)
    assertHcResponse(UNIFY, result)
    assert.equal(readFileSync(paths.codex, 'utf8'), '# 统一的\n')
    assert.ok(!lstatSync(paths.codex).isSymbolicLink())
    const [claude, pi, dsh] = result.results
    assert.equal(result.results.length, 3, 'source 自己不算')
    assert.deepEqual([claude.path, claude.outcome], [paths.claude, 'linked'])
    assert.match(claude.backup, /CLAUDE\.md\.litch-backup-\d{8}-\d{6}$/)
    assert.equal(readFileSync(claude.backup, 'utf8'), 'claude 原来的\n')
    assert.equal(readlinkSync(paths.claude), paths.codex)
    assert.equal(readFileSync(paths.claude, 'utf8'), '# 统一的\n')
    assert.deepEqual(
      pi,
      { path: paths.pi, outcome: 'linked', backup: null },
      '原来没有文件的不用备份',
    )
    assert.deepEqual(dsh, { path: paths.dsh, outcome: 'skipped', backup: null })
    assert.ok(!existsSync(join(root, '.dsh')), '没装的不替它建目录')
    // 之后在哪一份里改都是同一份
    const read = await readInstructions(paths.claude)
    assert.equal(read.linkTarget, paths.codex)
    await writeInstructions('claude-code', paths.claude, '# 改过\n', read.hash)
    assert.ok(lstatSync(paths.claude).isSymbolicLink(), '经软链写不把软链换掉')
    assert.equal(readFileSync(paths.codex, 'utf8'), '# 改过\n')
    // 再统一一次：已经指着 source 的不再备份
    const again = await client.call(UNIFY, { ...params, content: '# 第二次\n' })
    assert.deepEqual(
      again.results.map((item: any) => [item.outcome, item.backup]),
      [
        ['linked', null],
        ['linked', null],
        ['skipped', null],
      ],
    )
    assert.equal(backupsIn(join(root, '.claude'), 'CLAUDE.md').length, 1)
  } finally {
    await env.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('换 source：原来指向别处的软链（连同链接本身）备份后指向新的；source 原来是软链的换成真文件', async () => {
  const env = rig({ pi: new FakeUpstream('pi') })
  const { root, paths } = homes()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'harnessConfig'])
    await client.call(UNIFY, {
      sourcePath: paths.codex,
      content: 'A\n',
      linkPaths: [paths.claude, paths.pi],
    })
    // 改用 claude 那一份当底稿
    const result = await client.call(UNIFY, {
      sourcePath: paths.claude,
      content: 'B\n',
      linkPaths: [paths.codex, paths.pi],
    })
    assert.ok(!lstatSync(paths.claude).isSymbolicLink())
    assert.equal(readFileSync(paths.claude, 'utf8'), 'B\n')
    const [codex, pi] = result.results
    assert.equal(codex.outcome, 'linked')
    assert.equal(readFileSync(codex.backup, 'utf8'), 'A\n', '原来的真文件备份了')
    assert.equal(readlinkSync(paths.codex), paths.claude)
    assert.equal(pi.outcome, 'linked')
    assert.ok(lstatSync(pi.backup).isSymbolicLink(), '指向别处的软链备份的是链接本身')
    assert.equal(readlinkSync(paths.pi), paths.claude)
  } finally {
    await env.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('退出统一模式：指向 source 的软链换成副本，别的不动', async () => {
  const env = rig({ pi: new FakeUpstream('pi') })
  const { root, paths } = homes()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'harnessConfig'])
    await client.call(UNIFY, {
      sourcePath: paths.codex,
      content: '# 统一\n',
      linkPaths: [paths.claude],
    })
    writeFileSync(paths.pi, '自己的\n')
    const other = join(root, 'other', 'AGENTS.md')
    mkdirSync(join(root, 'other'))
    writeFileSync(join(root, 'other', 'x.md'), 'x')
    symlinkSync(join(root, 'other', 'x.md'), other)
    const result = await client.call(SEPARATE, {
      sourcePath: paths.codex,
      linkPaths: [paths.claude, paths.pi, other],
    })
    assertHcResponse(SEPARATE, result)
    assert.deepEqual(result.separated, [paths.claude])
    assert.ok(!lstatSync(paths.claude).isSymbolicLink())
    assert.equal(readFileSync(paths.claude, 'utf8'), '# 统一\n')
    assert.equal(readFileSync(paths.pi, 'utf8'), '自己的\n')
    assert.ok(lstatSync(other).isSymbolicLink(), '指向别处的不动')
  } finally {
    await env.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('参数不对：不是绝对路径、文件名不是 AGENTS.md 或 CLAUDE.md、目录，回 invalidValue', async () => {
  const env = rig({ pi: new FakeUpstream('pi') })
  const { root, paths } = homes()
  try {
    const client = env.connect()
    await client.initialize(['harness'])
    const cases = [
      { sourcePath: 'AGENTS.md', content: 'x', linkPaths: [] },
      { sourcePath: join(root, 'notes.txt'), content: 'x', linkPaths: [] },
      { sourcePath: paths.codex, content: 'x', linkPaths: [join(root, '.ssh', 'authorized_keys')] },
      { sourcePath: paths.codex, content: 1, linkPaths: [] },
    ]
    for (const params of cases) {
      const error = await client.fails(UNIFY, params)
      assert.equal(error.code, -32000)
      assert.equal(error.data.litch, 'invalidValue')
      assertHcError(error.data)
    }
    assert.equal(readFileSync(paths.codex, 'utf8'), 'codex 原来的\n', '参数不对时什么都不写')
    mkdirSync(join(root, '.claude', 'nested', 'CLAUDE.md'), { recursive: true })
    const dir = await client.fails(UNIFY, {
      sourcePath: paths.codex,
      content: 'x',
      linkPaths: [join(root, '.claude', 'nested', 'CLAUDE.md')],
    })
    assert.equal(dir.data.litch, 'invalidValue')
  } finally {
    await env.close()
    rmSync(root, { recursive: true, force: true })
  }
})
