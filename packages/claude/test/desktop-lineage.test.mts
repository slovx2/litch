import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DesktopLineage, desktopDataRoots, readDesktopSession } from '../src/desktop-lineage.mjs'

// Claude 桌面端的会话文件（desktop-lineage.mts）：用一份假的数据目录，看父子关系怎么认、
// 格式不对和读不到的怎么当作没有父会话。

const root = await mkdtemp(join(tmpdir(), 'desktop-lineage-'))
test.after(() => rm(root, { recursive: true, force: true }))
const dir = join(root, 'claude-code-sessions', 'acct', 'org')
await mkdir(dir, { recursive: true })

/** 照桌面端的样子写一个会话文件 */
async function session(localId: string, fields: Record<string, unknown>): Promise<string> {
  const path = join(dir, `${localId}.json`)
  await writeFile(path, JSON.stringify({ sessionId: localId, cwd: '/work', ...fields }))
  return path
}

const spawned = (parent: string) => ({
  sessionId: parent,
  taskId: 't',
  title: '派出',
  sideSession: true,
  name: 'x',
})

test('DSK-001：子会话按 spawnedFrom 找到父会话的会话号；脱离过的、父会话不在的、格式坏的都当没有父会话', async () => {
  await session('local_p', { cliSessionId: 'cli-p', priorCliSessionIds: ['cli-p0'] })
  await session('local_c', { cliSessionId: 'cli-c', spawnedFrom: spawned('local_p') })
  await session('local_d', {
    cliSessionId: 'cli-d',
    spawnedFrom: spawned('local_p'),
    lineageDetached: true,
  })
  await session('local_o', { cliSessionId: 'cli-o', spawnedFrom: spawned('local_gone') })
  // 换过会话号的子会话：旧号导进来也挂上
  await session('local_r', {
    cliSessionId: 'cli-r',
    priorCliSessionIds: ['cli-r0'],
    spawnedFrom: spawned('local_p'),
  })
  // 形状不对的：spawnedFrom 不是对象、没有会话号、不是 JSON
  await session('local_s', { cliSessionId: 'cli-s', spawnedFrom: 'local_p' })
  await session('local_n', { spawnedFrom: spawned('local_p') })
  await writeFile(join(dir, 'local_bad.json'), '{ 不是 JSON')
  // 不是会话文件的不看
  await writeFile(join(dir, 'scheduled-tasks.json'), JSON.stringify({ cliSessionId: 'x' }))

  const index = new DesktopLineage(() => [root, join(root, 'missing')])
  const { parents, replacedBy } = await index.refresh()
  assert.deepEqual(Object.fromEntries(parents), {
    'cli-c': ['cli-p', 'cli-p0'],
    'cli-r': ['cli-p', 'cli-p0'],
    'cli-r0': ['cli-p', 'cli-p0'],
  })
  // 换下来的旧号 → 后来换上的号
  assert.deepEqual(Object.fromEntries(replacedBy), { 'cli-p0': ['cli-p'], 'cli-r0': ['cli-r'] })

  // 用户在桌面端让它脱离：文件变了就重读
  const path = await session('local_c', {
    cliSessionId: 'cli-c',
    spawnedFrom: spawned('local_p'),
    lineageDetached: true,
  })
  await utimes(path, new Date(), new Date(Date.now() + 5000))
  assert.equal((await index.refresh()).parents.has('cli-c'), false)

  // 父会话的文件没了：子会话也没有父会话了
  await rm(join(dir, 'local_p.json'))
  assert.deepEqual(Object.fromEntries((await index.refresh()).parents), {})
})

test('DSK-004：换过几次号的：每个旧号对着它之后换上的号，先换上的在前', async () => {
  const many = await mkdtemp(join(tmpdir(), 'desktop-replaced-'))
  try {
    const at = join(many, 'claude-code-sessions', 'a', 'o')
    await mkdir(at, { recursive: true })
    await writeFile(
      join(at, 'local_m.json'),
      JSON.stringify({
        sessionId: 'local_m',
        cliSessionId: 'c3',
        priorCliSessionIds: ['c1', 'c2'],
      }),
    )
    const { replacedBy } = await new DesktopLineage(() => [many]).refresh()
    assert.deepEqual(Object.fromEntries(replacedBy), { c1: ['c2', 'c3'], c2: ['c3'] })
  } finally {
    await rm(many, { recursive: true, force: true })
  }
})

test('DSK-002：读单个文件：读不到、不是对象、自己挂自己都当没有父会话', async () => {
  assert.equal(await readDesktopSession(join(root, 'nope.json')), null)
  const array = join(root, 'array.json')
  await writeFile(array, '[1,2]')
  assert.equal(await readDesktopSession(array), null)
  const self = await session('local_self', {
    cliSessionId: 'cli-self',
    spawnedFrom: spawned('local_self'),
  })
  assert.deepEqual(await readDesktopSession(self), {
    localId: 'local_self',
    cliSessionId: 'cli-self',
    priorCliSessionIds: [],
    parentLocalId: null,
  })
})

test('DSK-003：数据目录在哪：给了变量只看它，给 0 不看；各平台的默认位置', () => {
  assert.deepEqual(desktopDataRoots({ CHA_CLAUDE_DESKTOP_DATA: '/x' }, 'darwin'), ['/x'])
  assert.deepEqual(desktopDataRoots({ CHA_CLAUDE_DESKTOP_DATA: '0' }, 'darwin'), [])
  const mac = desktopDataRoots({}, 'darwin')
  assert.ok(mac[0]?.endsWith(join('Library', 'Application Support', 'Claude')))
  const win = desktopDataRoots({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32')
  assert.equal(win[0], join('C:\\Users\\u\\AppData\\Roaming', 'Claude'))
  assert.deepEqual(desktopDataRoots({}, 'win32'), [])
  assert.equal(desktopDataRoots({ XDG_CONFIG_HOME: '/cfg' }, 'linux')[0], join('/cfg', 'Claude'))
})
