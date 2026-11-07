// 只在桌面公开后提交扩展；不取消审核，不输出认证材料。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { StoreError, serviceAccountToken, storeClient } from './chrome-store-api.mjs'
import { hash, itemId, receiptName } from './chrome-store-package.mjs'

export function validateReceipt(receipt, version) {
  assert.equal(receipt.schema, 1, '摘要格式')
  assert.equal(receipt.itemId, itemId, '扩展 ID')
  assert.match(receipt.version, /^\d+\.\d+\.\d+$/)
  assert.equal(receipt.version, version, '摘要版本')
  assert.match(receipt.sha, /^[a-f0-9]{40}$/)
  assert.match(receipt.contentHash, /^[a-f0-9]{64}$/)
  assert.match(receipt.zipSha256, /^[a-f0-9]{64}$/)
  assert.equal(receipt.zipName, `litch-browser-${version}.zip`)
  return receipt
}

export function publishedVersion(status) {
  if (status.takenDown || status.warned) throw new StoreError('商店有政策提示，请先在后台处理。')
  const revision = status.publishedItemRevisionStatus
  if (
    revision?.state !== 'PUBLISHED' ||
    revision.distributionChannels?.length !== 1 ||
    revision.distributionChannels[0].deployPercentage !== 100
  )
    throw new StoreError('商店不是单版本全量公开状态，需人工核对基准。')
  const version = revision.distributionChannels[0].crxVersion
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new StoreError('商店版本无法识别。')
  return version
}

export function newer(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i]
  return false
}

export function githubServices(env, execute = execFileSync) {
  const repo = env.GITHUB_REPOSITORY
  assert.match(repo ?? '', /^[\w.-]+\/[\w.-]+$/)
  const ghEnv = { ...env }
  delete ghEnv.CWS_SERVICE_ACCOUNT_JSON
  delete ghEnv.CWS_PUBLISHER_ID
  const gh = (args, binary = false) =>
    execute('gh', args, {
      env: ghEnv,
      encoding: binary ? undefined : 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    })
  const api = (path) => JSON.parse(gh(['api', `repos/${repo}/${path}`]))
  const release = (version) => {
    const result = api(`releases/tags/v${version}`)
    assert.equal(result.tag_name, `v${version}`)
    assert.equal(result.draft, false, '配套桌面端尚未公开')
    assert.equal(result.prerelease, false, '不能以预发布版为配套桌面端')
    return result
  }
  const assetReceipt = (asset, version) => {
    const bytes = gh(
      [
        'api',
        `repos/${repo}/releases/assets/${asset.id}`,
        '-H',
        'Accept: application/octet-stream',
      ],
      true,
    )
    assert.equal(asset.digest, `sha256:${hash(bytes)}`, 'GitHub 摘要不符')
    return validateReceipt(JSON.parse(bytes), version)
  }
  return {
    async verifyDesktop(candidate) {
      release(candidate.version)
      let object = api(`git/ref/tags/v${candidate.version}`).object
      for (let i = 0; object.type === 'tag' && i < 5; i++)
        object = api(`git/tags/${object.sha}`).object
      assert.equal(object.type, 'commit')
      assert.equal(object.sha, candidate.sha, '公开标签不是候选源码')
    },
    async baseline(version) {
      const bootstrap = JSON.parse(
        await readFile(new URL('./chrome-store-baselines.json', import.meta.url)),
      )
      if (bootstrap[version]) return validateReceipt(bootstrap[version], version)
      const asset = release(version).assets.find((entry) => entry.name === receiptName)
      if (!asset)
        throw new StoreError('当前商店版本缺少交付摘要；请登记实际上传 ZIP，改走手动流程。')
      return assetReceipt(asset, version)
    },
    async archive(candidate, directory) {
      const existing = release(candidate.version).assets
      if (existing.some((asset) => [receiptName, candidate.zipName].includes(asset.name)))
        throw new StoreError('此版本已有商店上传记录；上次可能已上传，请核对后台，不自动重复写入。')
      // 在商店写入前永久保存实际 ZIP 与摘要；失败重跑也不会遗失比较基准。
      gh([
        'release',
        'upload',
        `v${candidate.version}`,
        '--repo',
        repo,
        join(directory, candidate.zipName),
        join(directory, receiptName),
      ])
      const saved = release(candidate.version).assets
      for (const [name, digest] of [
        [candidate.zipName, candidate.zipSha256],
        [receiptName, hash(await readFile(join(directory, receiptName)))],
      ]) {
        assert.equal(saved.find((asset) => asset.name === name)?.digest, `sha256:${digest}`)
      }
    },
  }
}

export async function publishStore(env = process.env, services = {}) {
  const summary =
    services.summary ??
    (async (message) => {
      if (env.GITHUB_STEP_SUMMARY)
        await appendFile(env.GITHUB_STEP_SUMMARY, `\nChrome Web Store：${message}\n`)
    })
  if (!env.CWS_SERVICE_ACCOUNT_JSON || !env.CWS_PUBLISHER_ID) {
    await summary(
      '未配置 CWS_SERVICE_ACCOUNT_JSON / CWS_PUBLISHER_ID，自动上传已跳过；本次需要时按手动流程提交。',
    )
    return 'unconfigured'
  }
  try {
    assert.equal(env.PROMOTE_MODE, 'publish', '只能在桌面端公开后运行')
    const directory = env.CWS_PACKAGE_DIR
    const candidate = validateReceipt(
      JSON.parse(await readFile(join(directory, receiptName))),
      env.TAG?.slice(1),
    )
    assert.equal(candidate.sha, env.CANDIDATE_SHA)
    const bytes = await readFile(join(directory, candidate.zipName))
    assert.equal(hash(bytes), candidate.zipSha256, '商店 ZIP 被修改')
    const github = services.github ?? githubServices(env)
    await github.verifyDesktop(candidate)
    const token = await (services.token ?? serviceAccountToken)(env.CWS_SERVICE_ACCOUNT_JSON)
    const store = services.store ?? storeClient(env.CWS_PUBLISHER_ID, token)
    const status = await store.status()
    const version = publishedVersion(status)
    if (status.submittedItemRevisionStatus) {
      // 包括人工选择延后发布的版本：不能擅自把它变成自动公开，也不取消审核。
      const state = status.submittedItemRevisionStatus.state
      if (state === 'PENDING_REVIEW' || state === 'STAGED') {
        await summary(
          '商店已有待审或待发布版本，保留现有提交；本次没有上传。待现有提交结束后重跑商店 job；人工延后发布仍需后台 Publish。',
        )
        return 'pending'
      }
      throw new StoreError('上次商店提交需要人工处理（拒绝、取消或未知状态）；未上传。')
    }
    const baseline = validateReceipt(await github.baseline(version), version)
    if (candidate.contentHash === baseline.contentHash) {
      await summary(`与商店 ${version} 的交付内容相同（忽略 manifest.version），无需上传。`)
      return 'unchanged'
    }
    if (!newer(candidate.version, version))
      throw new StoreError('候选版本不高于商店版本，禁止覆盖或倒退。')
    await github.archive(candidate, directory)
    await github.verifyDesktop(candidate)
    // 归档过程中可能有人工送审或审核完成，写入前再查一次，不依据过期状态操作。
    const latest = await store.status()
    if (publishedVersion(latest) !== version || latest.submittedItemRevisionStatus)
      throw new StoreError('商店状态在准备过程中变化，未上传；请核对后台。')
    await store.upload(bytes, candidate.version)
    const state = await store.publish()
    await summary(
      `已上传 ${candidate.version} 并提交审核；配套桌面端已公开，审核通过后自动公开扩展。${state === 'PUBLISHED' ? '商店已返回 PUBLISHED。' : '当前仍待审核。'}`,
    )
    return 'submitted'
  } catch (error) {
    // 不输出原始异常：Google/GitHub/JSON 解析器可能带回凭据或请求内容。
    const message =
      error instanceof StoreError
        ? error.message
        : '自动提交失败，未确认公开；请核对 GitHub 制品和商店后台，按手动流程处理。'
    await summary(message)
    throw new StoreError(message)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await publishStore()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
