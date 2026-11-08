// 专用测试证书是可选加固；未设置时沿用探针原有的显式签名配置。
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { PROBE_IDENTITY } from './identity.mjs'

export const TEST_CERTIFICATE_NAME = 'Litch CU Probe Local'

export function probeSigningPlan(localIdentity, originalIdentity, identities = '') {
  if (localIdentity !== undefined) {
    return {
      identity: localIdentity,
      requirement: signingRequirement(localIdentity, identities),
      timestamp: '--timestamp=none',
    }
  }
  if (!originalIdentity)
    throw new Error('请提供原有 LITCH_SIGN_IDENTITY 或可选 LITCH_CU_SIGN_IDENTITY')
  return { identity: originalIdentity, requirement: null, timestamp: '--timestamp' }
}

export function signingRequirement(fingerprint, identities) {
  if (!/^[A-Fa-f0-9]{40}$/.test(fingerprint ?? ''))
    throw new Error(
      '请用 LITCH_CU_SIGN_IDENTITY 指定测试专用证书的 SHA-1；不接受 ad-hoc 或产品签名',
    )
  const sha = fingerprint.toUpperCase()
  const found = identities.split('\n').some((line) => {
    const match = /^\s*\d+\) ([A-F0-9]{40}) "([^"]+)"$/.exec(line)
    return match?.[1] === sha && match[2] === TEST_CERTIFICATE_NAME
  })
  if (!found)
    throw new Error(
      `找不到有效的测试签名身份 ${TEST_CERTIFICATE_NAME}；请用户先在钥匙串中创建并信任代码签名证书`,
    )
  return `identifier "${PROBE_IDENTITY.helperId}" and certificate leaf = H"${sha}"`
}

export function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function sourceFingerprint(roots, configuration) {
  const hash = createHash('sha256').update(JSON.stringify(configuration))
  function add(root, path) {
    hash.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0')
  }
  function walk(root, directory) {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, item.name)
      if (item.isDirectory()) walk(root, path)
      else if (item.isFile()) add(root, path)
      else throw new Error(`探针构建输入不接受符号链接：${path}`)
    }
  }
  for (const { path, directory } of roots) {
    // 相同源码换工作树后仍可复用固定路径产物，绝对源码路径不构成版本变化。
    hash.update(basename(path)).update('\0')
    if (directory) walk(path, path)
    else add(path, path)
  }
  return hash.digest('hex')
}

export function reusableBuild(recordPath, fingerprint, appPath) {
  if (!existsSync(recordPath)) return false
  try {
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    return (
      record.fingerprint === fingerprint &&
      record.executable ===
        fileHash(join(appPath, 'Contents/MacOS', PROBE_IDENTITY.executableName)) &&
      record.plist === fileHash(join(appPath, 'Contents/Info.plist'))
    )
  } catch {
    return false
  }
}
