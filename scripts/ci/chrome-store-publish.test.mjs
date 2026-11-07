import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { contentHash, hash, itemId, receiptName } from './chrome-store-package.mjs'
import { newer, publishedVersion, publishStore } from './chrome-store-publish.mjs'

const published = (version = '1.0.0') => ({
  publishedItemRevisionStatus: {
    state: 'PUBLISHED',
    distributionChannels: [{ crxVersion: version, deployPercentage: 100 }],
  },
})

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'litch-store-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bytes = Buffer.from('test ZIP')
  const candidate = {
    schema: 1,
    itemId,
    version: '1.1.0',
    sha: 'a'.repeat(40),
    contentHash: 'b'.repeat(64),
    zipName: 'litch-browser-1.1.0.zip',
    zipSha256: hash(bytes),
  }
  await writeFile(join(directory, receiptName), JSON.stringify(candidate))
  await writeFile(join(directory, candidate.zipName), bytes)
  const baseline = {
    ...candidate,
    version: '1.0.0',
    zipName: 'litch-browser-1.0.0.zip',
    contentHash: 'c'.repeat(64),
  }
  const calls = []
  const messages = []
  const env = {
    CWS_SERVICE_ACCOUNT_JSON: 'fake-key',
    CWS_PUBLISHER_ID: 'publisher',
    CWS_PACKAGE_DIR: directory,
    PROMOTE_MODE: 'publish',
    TAG: 'v1.1.0',
    CANDIDATE_SHA: candidate.sha,
  }
  const services = {
    summary: async (message) => messages.push(message),
    token: async () => {
      calls.push('token')
      return 'fake-token'
    },
    github: {
      verifyDesktop: async () => {
        calls.push('desktop')
      },
      baseline: async () => {
        calls.push('baseline')
        return baseline
      },
      archive: async () => {
        calls.push('archive')
      },
    },
    store: {
      status: async () => {
        calls.push('status')
        return published()
      },
      upload: async (zip, version) => {
        calls.push('upload')
        assert.deepEqual(zip, bytes)
        assert.equal(version, '1.1.0')
      },
      publish: async () => {
        calls.push('publish')
        return 'PENDING_REVIEW'
      },
    },
  }
  return { env, services, calls, messages, candidate, baseline, directory }
}

test('缺任一机密安静跳过，不读包、不认证、不请求网络，仅写 Summary', async () => {
  for (const env of [
    {},
    { CWS_PUBLISHER_ID: 'publisher' },
    { CWS_SERVICE_ACCOUNT_JSON: 'secret' },
  ]) {
    const messages = []
    assert.equal(
      await publishStore(env, { summary: async (message) => messages.push(message) }),
      'unconfigured',
    )
    assert.match(messages[0], /手动流程/)
  }
})

test('更改交付内容后，先核实桌面公开、留存 ZIP，再上传并自动送审', async (t) => {
  const f = await fixture(t)
  assert.equal(await publishStore(f.env, f.services), 'submitted')
  assert.deepEqual(f.calls, [
    'desktop',
    'token',
    'status',
    'baseline',
    'archive',
    'desktop',
    'status',
    'upload',
    'publish',
  ])
  assert.match(f.messages[0], /仍待审核/)
})

test('只改产品版本不上传；比较商店基线而不是上一次桌面版本', async (t) => {
  const f = await fixture(t)
  f.baseline.contentHash = f.candidate.contentHash
  assert.equal(await publishStore(f.env, f.services), 'unchanged')
  assert.deepEqual(f.calls, ['desktop', 'token', 'status', 'baseline'])
  assert.match(f.messages[0], /商店 1.0.0/)
})

test('保留已有审核/待发布版本，不覆盖用户刚提交的包', async (t) => {
  for (const state of ['PENDING_REVIEW', 'STAGED']) {
    const f = await fixture(t)
    f.services.store.status = async () => ({
      ...published(),
      submittedItemRevisionStatus: { state },
    })
    assert.equal(await publishStore(f.env, f.services), 'pending')
    assert.deepEqual(f.calls, ['desktop', 'token'])
    assert.match(f.messages[0], /本次没有上传/)
  }
})

test('拒绝、取消、政策警告、分批发布、无公开基线均停止', async (t) => {
  for (const status of [
    {},
    { ...published(), warned: true },
    { ...published(), takenDown: true },
    published('unknown'),
    {
      publishedItemRevisionStatus: {
        state: 'PUBLISHED',
        distributionChannels: [{ crxVersion: '1.0.0', deployPercentage: 50 }],
      },
    },
    ...['REJECTED', 'CANCELLED', 'UNKNOWN'].map((state) => ({
      ...published(),
      submittedItemRevisionStatus: { state },
    })),
  ]) {
    const f = await fixture(t)
    f.services.store.status = async () => status
    await assert.rejects(publishStore(f.env, f.services))
    assert.ok(!f.calls.includes('upload'))
  }
})

test('旧候选、内容摘要缺失、ZIP 篡改、桌面未公开和第二次检查变化均阻止上传', async (t) => {
  for (const scenario of [
    'old',
    'baseline',
    'tampered',
    'desktop',
    'changed',
    'archived',
    'draft',
  ]) {
    const f = await fixture(t)
    if (scenario === 'old') {
      f.services.store.status = async () => published('2.0.0')
      f.baseline.version = '2.0.0'
      f.baseline.zipName = 'litch-browser-2.0.0.zip'
    }
    if (scenario === 'baseline')
      f.services.github.baseline = async () => {
        throw new Error('TOP_SECRET')
      }
    if (scenario === 'tampered') await writeFile(join(f.directory, f.candidate.zipName), 'tampered')
    if (scenario === 'desktop')
      f.services.github.verifyDesktop = async () => {
        throw new Error('TOP_SECRET')
      }
    if (scenario === 'archived')
      f.services.github.archive = async () => {
        throw new Error('TOP_SECRET')
      }
    if (scenario === 'draft') f.env.PROMOTE_MODE = 'draft'
    if (scenario === 'changed') {
      let call = 0
      f.services.store.status = async () => (++call === 1 ? published() : published('2.0.0'))
    }
    await assert.rejects(publishStore(f.env, f.services), (e) => !e.message.includes('TOP_SECRET'))
    assert.ok(!f.calls.includes('upload'), scenario)
    assert.ok(f.messages.every((message) => !message.includes('TOP_SECRET')))
  }
})

test('上传失败不送审；送审失败不报告已提交', async (t) => {
  for (const phase of ['upload', 'publish']) {
    const f = await fixture(t)
    f.services.store[phase] = async () => {
      f.calls.push(phase)
      throw new Error('TOP_SECRET')
    }
    await assert.rejects(publishStore(f.env, f.services))
    if (phase === 'upload') assert.ok(!f.calls.includes('publish'))
    assert.ok(f.messages.every((message) => !message.includes('已上传')))
  }
})

test('内容规范化忽略版本和 manifest 排版/键顺序；资源、权限和代码变动仍检出', () => {
  const files = (manifest, code = 'shared runtime') => ({
    'background.js': Buffer.from(code),
    'manifest.json': Buffer.from(JSON.stringify(manifest)),
  })
  const a = files({ version: '1.0.0', permissions: ['tabs'], nested: { b: 1, a: 2 } })
  const b = files({ nested: { a: 2, b: 1 }, permissions: ['tabs'], version: '9.0.0' })
  assert.equal(contentHash(a), contentHash(b))
  assert.notEqual(contentHash(a), contentHash({ ...b, 'new.png': Buffer.from('icon') }))
  assert.notEqual(
    contentHash(a),
    contentHash({ ...b, 'background.js': Buffer.from('changed shared runtime') }),
  )
  assert.notEqual(
    contentHash(a),
    contentHash(files({ version: '1.0.0', permissions: ['debugger'] })),
  )
  assert.ok(newer('1.10.0', '1.9.9'))
  assert.ok(!newer('1.1.0', '1.1.0'))
  assert.equal(publishedVersion(published()), '1.0.0')
})

test('CLI 无凭据的真实子进程退出成功，stdout/stderr 空，Summary 指向手工流程', async (t) => {
  const f = await fixture(t)
  const summary = join(f.directory, 'summary')
  const stdout = execFileSync(process.execPath, ['scripts/ci/chrome-store-publish.mjs'], {
    env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary },
    encoding: 'utf8',
  })
  assert.equal(stdout, '')
  assert.match(await readFile(summary, 'utf8'), /未配置.*手动流程/)
})
