import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { hash, itemId, receiptName } from './chrome-store-package.mjs'
import { githubServices } from './chrome-store-publish.mjs'

const receipt = {
  schema: 1,
  itemId,
  version: '1.2.3',
  sha: 'a'.repeat(40),
  contentHash: 'b'.repeat(64),
  zipName: 'litch-browser-1.2.3.zip',
  zipSha256: 'c'.repeat(64),
}
const bytes = Buffer.from(JSON.stringify(receipt))
const release = {
  tag_name: 'v1.2.3',
  draft: false,
  prerelease: false,
  assets: [{ id: 42, name: receiptName, digest: `sha256:${hash(bytes)}` }],
}
const env = {
  GITHUB_REPOSITORY: 'fixture/repo',
  GH_TOKEN: 'github-fake',
  CWS_SERVICE_ACCOUNT_JSON: 'do-not-inherit',
  CWS_PUBLISHER_ID: 'do-not-inherit',
}

function transport(overrides = {}) {
  return (command, args, options) => {
    assert.equal(command, 'gh')
    assert.equal(options.env.CWS_SERVICE_ACCOUNT_JSON, undefined)
    assert.equal(options.env.CWS_PUBLISHER_ID, undefined)
    assert.equal(options.env.GH_TOKEN, 'github-fake')
    assert.equal(args[0], 'api')
    const path = args[1].replace('repos/fixture/repo/', '')
    const routes = {
      'releases/tags/v1.2.3': release,
      'git/ref/tags/v1.2.3': { object: { type: 'tag', sha: 'annotated' } },
      'git/tags/annotated': { object: { type: 'commit', sha: receipt.sha } },
      'releases/assets/42': bytes,
      ...overrides,
    }
    assert.ok(path in routes, path)
    if (Buffer.isBuffer(routes[path])) {
      assert.deepEqual(args.slice(2), ['-H', 'Accept: application/octet-stream'])
      return routes[path]
    }
    return JSON.stringify(routes[path])
  }
}

test('GitHub 公开检查解引用 annotated tag，拒绝草稿、预发布及源码不符', async () => {
  await githubServices(env, transport()).verifyDesktop(receipt)
  for (const overrides of [
    { 'releases/tags/v1.2.3': { ...release, draft: true } },
    { 'releases/tags/v1.2.3': { ...release, prerelease: true } },
    { 'git/tags/annotated': { object: { type: 'commit', sha: 'wrong' } } },
  ])
    await assert.rejects(githubServices(env, transport(overrides)).verifyDesktop(receipt))
})

test('从商店版本对应 Release 下载摘要并回验 GitHub digest；未知基准不猜测', async () => {
  assert.deepEqual(await githubServices(env, transport()).baseline('1.2.3'), receipt)
  await assert.rejects(
    githubServices(env, transport({ 'releases/assets/42': Buffer.from('{}') })).baseline('1.2.3'),
  )
  await assert.rejects(
    githubServices(env, transport({ 'releases/tags/v1.2.3': { ...release, assets: [] } })).baseline(
      '1.2.3',
    ),
    /缺少交付摘要/,
  )
  const bootstrap = await githubServices(env, () => {
    throw new Error('不应调用 API')
  }).baseline('0.36.0')
  assert.equal(
    bootstrap.zipSha256,
    '4b23a6e5a4a64f8d1b9a9c27c3031c7eabb8761f29e577a048510e3de42e042a',
  )
})

test('归档只新增两项资产，不 clobber，回验 SHA-256；既有记录不得盲重试', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'litch-store-assets-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, receiptName), bytes)
  const calls = []
  const github = githubServices(env, (command, args, options) => {
    assert.equal(command, 'gh')
    assert.equal(options.env.CWS_SERVICE_ACCOUNT_JSON, undefined)
    calls.push(args)
    if (calls.length === 1) return JSON.stringify({ ...release, assets: [] })
    if (calls.length === 2) return ''
    return JSON.stringify({
      ...release,
      assets: [...release.assets, { name: receipt.zipName, digest: `sha256:${receipt.zipSha256}` }],
    })
  })
  await github.archive(receipt, directory)
  assert.deepEqual(calls[1], [
    'release',
    'upload',
    'v1.2.3',
    '--repo',
    'fixture/repo',
    join(directory, receipt.zipName),
    join(directory, receiptName),
  ])
  await assert.rejects(
    githubServices(env, transport()).archive(receipt, directory),
    /已有商店上传记录/,
  )
})

test('工作流只在桌面 publish 成功后处理商店；机密未配置时不构建、不调用发布器', async () => {
  const workflow = parse(await readFile('.github/workflows/promote.yml', 'utf8'))
  const job = workflow.jobs['chrome-store']
  assert.equal(job.needs, 'promote')
  assert.equal(job.if, "inputs.mode == 'publish'")
  assert.equal(workflow.concurrency.group, 'release-promotion')
  const source = job.steps.find((step) => step.with?.path === 'store-source')
  assert.equal(source.with.ref, '${{ inputs.candidate-sha }}')
  assert.equal(source.with['persist-credentials'], false)
  const build = job.steps.find((step) => step.run?.includes('chrome-store-package.mjs'))
  const publish = job.steps.find((step) => step.run?.includes('chrome-store-publish.mjs'))
  assert.equal(build.if, "steps.config.outputs.ready == 'true'")
  assert.equal(publish.if, build.if)
  assert.equal(build.env.CWS_SERVICE_ACCOUNT_JSON, undefined)
  assert.equal(publish.env.CWS_SERVICE_ACCOUNT_JSON, '${{ secrets.CWS_SERVICE_ACCOUNT_JSON }}')
  assert.equal(publish.env.CWS_PUBLISHER_ID, '${{ secrets.CWS_PUBLISHER_ID }}')
  assert.ok(job.steps.find((step) => step.run?.includes('npm ci --ignore-scripts')))
})
