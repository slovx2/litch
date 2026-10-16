import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

async function manifest(root: string, directory: string, name = directory): Promise<string> {
  const path = join(root, directory, 'SKILL.md')
  await mkdir(join(root, directory), { recursive: true })
  await writeFile(path, '---\nname: ' + name + '\ndescription: |\n  第一行\n  第二行\n---\nBODY\n')
  return path
}

async function changed(client: ProtocolClient, start: number): Promise<void> {
  const deadline = Date.now() + 5_000
  do {
    const message = client.trace.slice(start).find((entry) => entry.method === 'skills/changed')
    if (message) {
      assert.deepEqual(message.params, {})
      return
    }
    await delay(25)
  } while (Date.now() < deadline)
  assert.fail('真实技能变更未发送 skills/changed')
}

test('SKILLS-004：真实目录、原生设置、名称选择、失效通知及失败原子性，零模型调用', {
  timeout: 30_000,
}, async () => {
  const home = await realpath(await mkdtemp('/tmp/native-skills-management-'))
  const cwd = join(home, 'project')
  const root = join(cwd, '.claude', 'skills')
  const path = await manifest(root, 'project-name', 'shared-name')
  const userPath = await manifest(join(home, 'claude', 'skills'), 'user-name', 'shared-name')
  await writeFile(
    join(home, 'claude', 'settings.json'),
    JSON.stringify({
      skillOverrides: { 'shared-name': 'off' },
    }),
  )
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  const list = async () =>
    (await client.request('skills/list', { cwds: [cwd], forceReload: true })).data[0]
  try {
    const initial = await list()
    assert.deepEqual(initial.errors, [])
    assert.equal(initial.skills.length, 2)
    assert.equal(
      initial.skills.every((skill: any) => !skill.enabled),
      true,
    )
    assert.equal(initial.skills[0].description, '第一行\n第二行\n')
    const cursor = client.trace.length
    assert.deepEqual(
      await client.request('skills/config/write', {
        name: 'shared-name',
        path: null,
        enabled: true,
      }),
      { effectiveEnabled: true },
    )
    await changed(client, cursor)
    assert.equal(
      (await list()).skills.every((skill: any) => skill.enabled),
      true,
    )
    await client.raw('skills/config/write', { path, enabled: false }, -32602)
    assert.equal(
      (await list()).skills.every((skill: any) => skill.enabled),
      true,
      '同名相反权限不能误改另一个来源',
    )
    await client.request('skills/config/write', { name: 'shared-name', enabled: false })
    await client.request('skills/config/write', { path, enabled: false })
    await client.request('skills/config/write', { name: 'shared-name', enabled: true })
    assert.equal(
      (await list()).skills.every((skill: any) => skill.enabled),
      true,
      '按名称统一启用必须清理同名称的旧路径禁用',
    )
    for (const params of [
      {},
      { path },
      { path, enabled: 'false' },
      { enabled: false },
      { path, name: 'shared-name', enabled: false },
      { name: '', enabled: false },
      { name: '__proto__', enabled: false },
      { path: 'relative', enabled: false },
    ])
      await client.raw('skills/config/write', params, -32602)
    for (const params of [{ cwds: 'wrong' }, { cwds: ['relative'] }, { forceReload: 'yes' }])
      await client.raw('skills/list', params, -32602)
    for (const params of [{}, { extraRoots: 'wrong' }, { extraRoots: ['relative'] }])
      await client.raw('skills/extraRoots/set', params, -32602)
    const { thread } = await client.request('thread/start', { cwd })
    assert.equal((await client.request('skills/list', {})).data[0].cwd, cwd)
    assert.ok(thread.id)
    let offset = client.trace.length
    await writeFile(path, (await readFile(path, 'utf8')).replace('BODY', 'CHANGED_BODY'))
    await changed(client, offset)
    offset = client.trace.length
    const added = await manifest(root, 'new-skill')
    await changed(client, offset)
    assert.equal(
      (await list()).skills.some((skill: any) => skill.path === added),
      true,
    )
    offset = client.trace.length
    await rm(added)
    await changed(client, offset)
    assert.equal(
      (await list()).skills.some((skill: any) => skill.path === added),
      false,
    )
    const broken = await manifest(root, 'broken')
    await writeFile(broken, '---\nname: [invalid\n---\nBODY\n')
    const errors = (await list()).errors
    assert.equal(errors.length, 1)
    assert.equal(errors[0].path, broken)
    const extra = join(home, 'extra')
    const extraPath = await manifest(extra, 'extra-skill')
    const ledger = join(home, 'adapter', 'skill-links.json')
    await mkdir(ledger)
    try {
      await client.raw('skills/extraRoots/set', { extraRoots: [extra] }, -32000)
      await assert.rejects(
        access(join(home, 'claude', 'skills', 'extra-skill')),
        '账本保存失败不能留下原生可执行入口',
      )
      assert.equal(
        (await list()).skills.some((skill: any) => skill.path === extraPath),
        false,
      )
    } finally {
      await rm(ledger, { recursive: true })
    }
    await client.request('skills/extraRoots/set', { extraRoots: [extra, extra] })
    assert.equal((await list()).skills.filter((skill: any) => skill.path === extraPath).length, 1)
    const conflicting = join(home, 'conflicting')
    await manifest(conflicting, 'user-name', 'conflicting')
    await client.raw('skills/extraRoots/set', { extraRoots: [conflicting] }, -32602)
    assert.equal(
      (await list()).skills.some((skill: any) => skill.path === extraPath),
      true,
    )
    await access(userPath)
    await client.request('skills/extraRoots/set', { extraRoots: [] })
    await assert.rejects(access(join(home, 'claude', 'skills', 'extra-skill')))
    await access(extraPath)
    assert.equal(model.requests.length, 0, '技能管理和目录扫描不能调用模型')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
