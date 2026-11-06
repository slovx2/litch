// 从已验证的夜间基线到候选提交计算影响范围；未知路径、无基线、历史分叉都全量。
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { verifyPatchBase } from './ci/release-patch-base.mjs'
import { selectNightlyBase } from './ci-nightly-base.mjs'

export const domains = [
  'adapters',
  'computer-use',
  'computer-use-windows',
  'client',
  'dsh',
  'opencode',
  'client-engines',
  'real-engines',
  'mobile',
]
// CI 负责其余包的单测、类型与契约；这三个领域补齐两个引擎单测和原生首回合。
export const mandatory = ['dsh', 'opencode', 'real-engines']
// 用户决定：候选始终排除手机模拟器 E2E，单测/类型/APK 验证另外必跑。
export const releaseDomains = domains.filter((domain) => domain !== 'mobile')

export function releaseImpact(result) {
  return {
    ...result,
    domains: result.domains.filter((domain) => domain !== 'mobile'),
    reasons: [...result.reasons, '用户决定：手机模拟器 E2E 仅按需手动开启，候选排除'],
  }
}

// 仅发版证明/编排本身由必跑策略测试覆盖；不豁免一般构建脚本、协议或设备代码。
const patchPolicyFiles = new Set([
  '.github/workflows/release.yml',
  '.github/workflows/gate.yml',
  'scripts/ci-impact.mjs',
  'scripts/ci-impact.test.mjs',
  'scripts/release-policy.mjs',
  'scripts/release-policy.test.mjs',
  'scripts/ci/release-patch-base.mjs',
  'scripts/ci/release-patch-base.test.mjs',
  'scripts/ci/release-gate-proof.mjs',
  'scripts/ci/release-candidate.mjs',
  'scripts/ci/release-candidate.test.mjs',
  'scripts/ci/release-seal.mjs',
  'scripts/ci/release-promote.mjs',
])

// 客户端权限记忆只消费设备协议，不实现设备持久化或引擎权限执行。
// 精确到模块及其验收；其他 core 文件仍按跨领域处理。
const patchClientFiles = new Set([
  'packages/core/src/device/project-permissions.mts',
  'packages/core/test/project-permissions.test.mts',
  'packages/core/test/project-permission-failures.test.mts',
  'scripts/check-permission-ui.mjs',
  // 只构造客户端差异测试输入，不改差异实现或设备文件访问。
  'packages/core/test/diff-cap.test.mts',
])

export function patchAffectedDomains(paths, { trustedBase, versionOnly = [] }) {
  if (!trustedBase) throw new Error('修复版必须有已核验的正式祖先基线')
  const selected = new Set()
  const reasons = []
  for (const path of paths) {
    if (versionOnly.includes(path)) {
      reasons.push(`仅自有包版本同步：${path}`)
      continue
    }
    if (patchPolicyFiles.has(path)) {
      reasons.push(`发版策略：必跑 CI 策略测试与工作流检查覆盖 ${path}`)
      continue
    }
    if (path === 'CONTRIBUTING.md') continue
    if (patchClientFiles.has(path)) {
      for (const domain of ['client', 'client-engines', 'mobile']) selected.add(domain)
      reasons.push(`客户端模块及验收：桌面完整领域、引擎界面集成与手机静态/APK覆盖 ${path}`)
      continue
    }
    // 每个路径仍沿用普通模式的保守规则；只去掉无改动也补跑的完整领域。
    const result = affectedDomains([path], { versionOnly, required: [] })
    const engine = /^packages\/(claude|pi|dsh|opencode|acp)\//.exec(path)?.[1]
    if (engine) {
      selected.add('real-engines')
      if (engine === 'dsh' || engine === 'opencode') selected.add(engine)
    }
    for (const domain of result.domains) selected.add(domain)
    reasons.push(...result.reasons)
  }
  return { domains: domains.filter((domain) => selected.has(domain)), reasons }
}

export function affectedDomains(
  paths,
  { trustedBase = true, versionOnly = [], required = mandatory } = {},
) {
  const selected = new Set(required)
  const reasons = []
  const all = (reason) => {
    for (const domain of domains) selected.add(domain)
    reasons.push(reason)
  }
  if (!trustedBase) all('没有可信的祖先基线')
  for (const path of paths) {
    if (versionOnly.includes(path)) {
      reasons.push(`仅自有包版本同步：${path}`)
      continue
    }
    if (/^(docs\/|skills\/|README\.md$|CHANGELOG\.md$|LICENSE$)/.test(path)) continue
    // 锁文件、包配置、共享协议/核心、设备/SSH、适配器里的 Chrome 转发库、构建脚本都跨领域，宁可多跑。
    // protocol 的 src 和 test 都在范围内；CI unit 的 npm run check 执行全部协议单测。
    if (
      /(^|\/)(package(-lock)?\.json|Cargo\.lock|go\.(mod|sum))$/.test(path) ||
      /^(packages\/(shared|core|protocol|device)\/|protocol\/|cmd\/|chromebridge\/|sshserver\/|\.github\/|scripts\/)/.test(
        path,
      )
    ) {
      all(`跨领域：${path}`)
    } else if (/^packages\/ui\//.test(path)) {
      selected.add('client')
      selected.add('client-engines')
      // 手机实际引用 UI 的 i18n、composer、tasks 等逻辑；只为纯桌面 CSS 缩小。
      if (!/^packages\/ui\/src\/styles\/.*\.css$/.test(path)) selected.add('mobile')
      reasons.push(`界面及共享手机逻辑：${path}`)
    } else if (/^(apps\/mobile\/|ios\/)/.test(path)) {
      selected.add('mobile')
      reasons.push(`手机完整领域：${path}`)
    } else if (/^apps\/computer-use-win\//.test(path)) {
      selected.add('computer-use-windows')
      reasons.push(`Windows 原生助手：${path}`)
    } else if (/^apps\/computer-use\//.test(path)) {
      selected.add('computer-use')
      selected.add('client')
      reasons.push(`macOS 原生助手：${path}`)
    } else if (/^packages\/chrome-(extension|bridge)\//.test(path)) {
      // Chrome 扩展库与 Node 桥：Litch 的扩展和桌面外壳从源码引用。
      selected.add('client')
      selected.add('client-engines')
      reasons.push(`Chrome 扩展与桥包：${path}`)
    } else if (/^packages\/browser\//.test(path)) {
      // 可嵌入的浏览器运行时：桌面外壳与 Chrome 扩展都从源码引用。
      selected.add('client')
      selected.add('client-engines')
      reasons.push(`浏览器运行时包：${path}`)
    } else if (/^packages\/computer-use\//.test(path)) {
      // 可嵌入的 CU 执行器：桌面外壳从源码引用，两个平台的原生助手都经它驱动。
      for (const domain of ['client', 'computer-use', 'computer-use-windows']) selected.add(domain)
      reasons.push(`Computer Use 执行器包：${path}`)
    } else if (/^apps\/desktop\/(src|test|assets)\//.test(path)) {
      selected.add('client')
      selected.add('client-engines')
      selected.add('computer-use')
      selected.add('computer-use-windows')
      reasons.push(`桌面外壳：${path}`)
    } else if (/^packages\/(claude|pi|dsh|opencode|acp)\//.test(path)) {
      for (const domain of ['adapters', 'client-engines', 'mobile']) selected.add(domain)
      reasons.push(`引擎及两端集成：${path}`)
    } else {
      all(`未知或构建配置：${path}`)
    }
  }
  return { domains: domains.filter((domain) => selected.has(domain)), reasons }
}

// 仅允许自有包的 version 变化；名称、依赖版本、resolved、integrity、lock 结构一律比较。
// localPackages 由 git 中两端真实 package.json 确认，不能因为 lock 写了一个路径就当自有包。
export function versionOnlyChange(path, before, after, localPackages = {}) {
  if (!/(^|\/)package(-lock)?\.json$/.test(path) && path !== 'apps/mobile/app.json') return false
  try {
    const left = JSON.parse(before)
    const right = JSON.parse(after)
    if (path === 'apps/mobile/app.json') {
      for (const [section, key, type] of [
        [null, 'version', 'string'],
        ['android', 'versionCode', 'number'],
        ['ios', 'buildNumber', 'string'],
      ]) {
        const a = section ? left.expo?.[section] : left.expo
        const b = section ? right.expo?.[section] : right.expo
        if (typeof a?.[key] === type && typeof b?.[key] === type) {
          delete a[key]
          delete b[key]
        }
      }
      return isDeepStrictEqual(left, right)
    }
    const stripVersion = (a, b) => {
      if (typeof a?.version !== 'string' || typeof b?.version !== 'string') return
      delete a.version
      delete b.version
    }
    stripVersion(left, right)
    if (path.endsWith('package-lock.json')) {
      stripVersion(left.packages?.[''], right.packages?.[''])
      for (const [location, name] of Object.entries(localPackages)) {
        if (!location || location.split('/').includes('node_modules')) continue
        const a = left.packages?.[location]
        const b = right.packages?.[location]
        if (a?.name === name && b?.name === name) stripVersion(a, b)
      }
    }
    return isDeepStrictEqual(left, right)
  } catch {
    return false
  }
}

export function gitImpact(
  base,
  sha,
  git = (...args) => execFileSync('git', args, { encoding: 'utf8' }),
  mode = 'standard',
) {
  if (!['standard', 'patch'].includes(mode)) throw new Error('未知发版模式')
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('候选必须是完整 SHA')
  let trustedBase = false
  if (base) {
    try {
      git('merge-base', '--is-ancestor', base, sha)
      trustedBase = true
    } catch {}
  }
  // 禁用 rename 检测，让跨领域移动同时包含删除路径和新增路径。
  const paths = trustedBase
    ? git('diff', '--name-only', '--no-renames', '-z', base, sha).split('\0').filter(Boolean)
    : []
  const versionOnly = paths.filter((path) => {
    if (!/(^|\/)package(-lock)?\.json$/.test(path) && path !== 'apps/mobile/app.json') return false
    try {
      const before = git('show', `${base}:${path}`)
      const after = git('show', `${sha}:${path}`)
      const localPackages = {}
      if (path.endsWith('package-lock.json')) {
        for (const location of Object.keys(JSON.parse(after).packages ?? {})) {
          if (
            !location ||
            location.split('/').some((part) => ['..', 'node_modules'].includes(part)) ||
            posix.isAbsolute(location)
          )
            continue
          const manifest = posix.join(posix.dirname(path), location, 'package.json')
          try {
            const oldPackage = JSON.parse(git('show', `${base}:${manifest}`))
            const newPackage = JSON.parse(git('show', `${sha}:${manifest}`))
            if (oldPackage.name && oldPackage.name === newPackage.name)
              localPackages[location] = oldPackage.name
          } catch {}
        }
      }
      return versionOnlyChange(path, before, after, localPackages)
    } catch {
      return false
    }
  })
  return {
    sha,
    base: trustedBase ? base : null,
    paths,
    versionOnly,
    ...(mode === 'patch' ? patchAffectedDomains : affectedDomains)(paths, {
      trustedBase,
      versionOnly,
    }),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sha = process.env.CANDIDATE_SHA
  const mode = process.env.RELEASE_MODE || 'standard'
  if (!['standard', 'patch'].includes(mode)) throw new Error('未知发版模式')
  if (mode === 'standard' && process.env.BASE_TAG) throw new Error('普通模式不能指定正式版基线')
  const baseline =
    mode === 'patch'
      ? verifyPatchBase({
          repository: process.env.GITHUB_REPOSITORY,
          sha,
          version: JSON.parse(readFileSync('package.json', 'utf8')).version,
          branch: process.env.GITHUB_REF_NAME,
          tag: process.env.BASE_TAG,
        })
      : selectNightlyBase(JSON.parse(readFileSync(process.env.NIGHTLY_RUNS_PATH, 'utf8')), {
          isAncestor: (base) => {
            try {
              execFileSync('git', ['merge-base', '--is-ancestor', base, sha], { stdio: 'ignore' })
              return true
            } catch {
              return false
            }
          },
        })
  const result = { ...releaseImpact(gitImpact(baseline.sha, sha, undefined, mode)), mode, baseline }
  console.log(JSON.stringify(result, null, 2))
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `domains=${JSON.stringify(result.domains)}\nsha=${result.sha}\nbaseline=${JSON.stringify(baseline)}\n`,
    )
  }
}
