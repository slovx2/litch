// 测试的归属与产品代码的传播范围不同；不把 core 的客户端测试当成共享运行时代码。
// 执行清单变化本身仍跨领域，所以这里复用清单不会静默漏掉删项、迁移或新增入口。
import { nightlyChecks } from '../../apps/desktop/scripts/nightly-checks.mjs'
import { checks, suites } from './check-catalog.mjs'

const client = ['client', 'client-engines', 'mobile']
const desktop = ['client', 'client-engines', 'computer-use', 'computer-use-windows']
const suiteDomains = {
  'desktop-unit': desktop,
  'desktop-portable-unit': desktop,
  'desktop-required': ['client', 'real-engines'],
  'client-engines': ['client-engines'],
  'real-engines': ['real-engines'],
  'real-engine-tools': ['real-engines'],
  'windows-native': client,
  dsh: ['dsh'],
  opencode: ['opencode'],
}
function add(owners, path, domains) {
  // 未识别的集合不能被同一入口在已知集合中的登记覆盖。
  if (!domains || (owners.has(path) && owners.get(path) === null)) owners.set(path, null)
  else owners.set(path, [...new Set([...(owners.get(path) ?? []), ...domains])])
}
export function registeredToolingOwners(catalog, groups, nightly) {
  const owners = new Map()
  // 同一入口可能出现在多个领域，必须取并集，而非以第一处登记为准。
  for (const [suite, group] of Object.entries(groups)) {
    for (const id of group.checks) {
      for (const argument of catalog.find((check) => check.id === id).command) {
        if (/^(scripts|apps)\/.*\.mjs$/.test(argument)) add(owners, argument, suiteDomains[suite])
      }
    }
  }
  for (const [, path] of nightly) add(owners, path, ['client'])
  return owners
}
const owners = registeredToolingOwners(checks, suites, nightlyChecks)

// 手动入口未必登记到 CI。这里仅列核对过的检查/夹具，不按 check-* 一概豁免。
// 两端看板共用 core 夹具；Chrome CDP、隔离环境等通用 helper 保持未知全量。
for (const path of [
  'scripts/check-console-cards.mjs',
  'scripts/check-permission-ui.mjs',
  'scripts/manager-board-mobile-fixture.mjs',
])
  add(owners, path, client)
add(owners, 'scripts/check-manager-session-open.mjs', ['client'])
add(owners, 'scripts/check-sidebar-projections.mjs', ['client'])
add(owners, 'scripts/check-recent-mobile.mjs', ['mobile'])

export function toolingDomains(path) {
  // 只匹配测试目录；包配置、构建和正式 src 不借此缩小。
  if (/^packages\/(core|ui)\/test\//.test(path)) return client
  if (/^apps\/mobile\/(test|e2e)\//.test(path)) return ['mobile']
  if (/^apps\/desktop\/test\//.test(path)) return desktop
  const engine = /^packages\/(claude|pi|dsh|opencode|acp|antigravity)\/test\//.exec(path)?.[1]
  if (engine) {
    return [
      'adapters',
      'client-engines',
      'real-engines',
      'mobile',
      ...(['dsh', 'opencode'].includes(engine) ? [engine] : []),
    ]
  }
  return owners.get(path) ?? null
}
