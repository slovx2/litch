import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { registeredToolingOwners, toolingDomains } from './ci/impact-tooling.mjs'
import {
  affectedDomains,
  domains,
  gitImpact,
  mandatory,
  patchAffectedDomains,
  releaseImpact,
  versionOnlyChange,
} from './ci-impact.mjs'

test('文档改动仍有各包单测与原生首回合', () => {
  assert.deepEqual(new Set(affectedDomains(['docs/guide.md']).domains), new Set(mandatory))
})
test('桌面样式不牵连手机，手机逻辑也必须完整跑手机', () => {
  const desktop = affectedDomains(['packages/ui/src/styles/theme.css']).domains
  assert.ok(desktop.includes('client') && desktop.includes('client-engines'))
  assert.ok(!desktop.includes('mobile'))
  assert.ok(
    affectedDomains(['packages/ui/src/composer/useProviderSwitch.ts']).domains.includes('mobile'),
  )
  assert.ok(affectedDomains(['packages/ui/src/i18n/zh-CN.ts']).domains.includes('mobile'))
  assert.ok(affectedDomains(['apps/mobile/src/detail/Composer.tsx']).domains.includes('mobile'))
})
for (const path of [
  'packages/shared/src/message.mts',
  'packages/core/src/connection.mts',
  'packages/protocol/src/types.mts',
  'packages/protocol/test/automation-surface.test.mts',
  'packages/protocol/test/new-contract.test.mts',
  'protocol/versions.json',
  'packages/device/src/server.mts',
  'sshserver/session.go',
  'cmd/codex-harness-adapter/main.go',
  'apps/mobile/package-lock.json',
  'apps/desktop/scripts/make-installer.mjs',
  'scripts/update-manifest.mjs',
  '.github/workflows/gate.yml',
  'unknown/new-module.mts',
  'chromebridge/claims.go',
  'third_party/litch-automation/packages/automation-contracts/src/runtime.mts',
  'package.json',
]) {
  test(`跨领域或无法判断时全量：${path}`, () => {
    assert.deepEqual(affectedDomains([path]).domains, domains)
  })
}
test('引擎变更覆盖两端集成，原生助手覆盖所属平台', () => {
  for (const domain of ['adapters', 'mobile', 'client-engines']) {
    assert.ok(affectedDomains(['packages/claude/src/server.mts']).domains.includes(domain))
  }
  assert.ok(
    affectedDomains([
      'third_party/litch-automation/apps/computer-use-win/src/main.rs',
    ]).domains.includes('computer-use-windows'),
  )
  assert.ok(
    affectedDomains([
      'third_party/litch-automation/apps/computer-use/Sources/main.swift',
    ]).domains.includes('computer-use'),
  )
  for (const domain of ['client', 'computer-use', 'computer-use-windows']) {
    assert.ok(
      affectedDomains([
        'third_party/litch-automation/packages/computer-use/src/runtime.mts',
      ]).domains.includes(domain),
    )
  }
  for (const domain of ['client', 'client-engines']) {
    assert.ok(
      affectedDomains([
        'third_party/litch-automation/packages/browser/src/driver.mts',
      ]).domains.includes(domain),
    )
  }
  for (const path of [
    'third_party/litch-automation/packages/chrome-extension/src/state.mts',
    'third_party/litch-automation/packages/chrome-bridge/src/index.mts',
  ]) {
    for (const domain of ['client', 'client-engines']) {
      assert.ok(affectedDomains([path]).domains.includes(domain))
    }
  }
})
test('缺失基线或历史分叉不能缩小范围', () => {
  assert.deepEqual(gitImpact('', 'a'.repeat(40)).domains, domains)
  assert.deepEqual(
    gitImpact('v1.0.0', 'a'.repeat(40), () => {
      throw Error('not ancestor')
    }).domains,
    domains,
  )
})
test('移动/删除仍按两端路径判断，带换行的路径也不能丢失', () => {
  const calls = []
  const result = gitImpact('v1.0.0', 'a'.repeat(40), (...args) => {
    calls.push(args)
    return args[0] === 'diff' ? 'packages/ui/old.ts\0packages/shared/new.ts\0odd\nname\0' : ''
  })
  assert.deepEqual(result.domains, domains)
  assert.equal(result.paths.length, 3)
  assert.ok(calls[1].includes('--no-renames'))
})

test('只同步自有包版本不扩大，版本和依赖一起改不能豁免', () => {
  const before = { name: 'litch', version: '1.0.0', dependencies: { ws: '8.0.0' } }
  const after = { ...before, version: '1.0.1' }
  assert.ok(versionOnlyChange('package.json', JSON.stringify(before), JSON.stringify(after)))
  assert.equal(
    versionOnlyChange(
      'package.json',
      JSON.stringify(before),
      JSON.stringify({ ...after, dependencies: { ws: '8.1.0' } }),
    ),
    false,
  )
  assert.equal(
    versionOnlyChange(
      'package.json',
      JSON.stringify(before),
      JSON.stringify({ ...after, name: 'another' }),
    ),
    false,
  )
  assert.equal(versionOnlyChange('package.json', 'invalid JSON', JSON.stringify(after)), false)
})

test('lock 只能豁免根和已确认的工作区包版本，第三方 version/resolved/integrity 一律不豁免', () => {
  const before = {
    name: 'litch',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'litch', version: '1.0.0' },
      'packages/core': { name: '@litch/core', version: '1.0.0' },
      'node_modules/ws': {
        version: '8.0.0',
        resolved: 'https://example.test/ws.tgz',
        integrity: 'sha512-one',
      },
    },
  }
  const after = structuredClone(before)
  after.version = '1.0.1'
  after.packages[''].version = '1.0.1'
  after.packages['packages/core'].version = '1.0.1'
  const local = { 'packages/core': '@litch/core' }
  const compare = (value, packages = local) =>
    versionOnlyChange('package-lock.json', JSON.stringify(before), JSON.stringify(value), packages)
  assert.ok(compare(after))
  assert.equal(compare(after, {}), false)
  for (const [field, value] of [
    ['version', '8.1.0'],
    ['resolved', 'https://other.test/ws.tgz'],
    ['integrity', 'sha512-two'],
  ]) {
    const changed = structuredClone(after)
    changed.packages['node_modules/ws'][field] = value
    assert.equal(compare(changed), false)
  }
  assert.deepEqual(
    new Set(affectedDomains(['package-lock.json'], { versionOnly: ['package-lock.json'] }).domains),
    new Set(mandatory),
  )
})

test('真实 git 比较透传语义豁免，新增或删掉 package 不能豁免', () => {
  const sha = 'a'.repeat(40)
  const git = (...args) => {
    if (args[0] === 'merge-base') return ''
    if (args[0] === 'diff') return 'package.json\0'
    return JSON.stringify({ name: 'litch', version: args[1].startsWith(sha) ? '1.0.1' : '1.0.0' })
  }
  assert.deepEqual(new Set(gitImpact('v1.0.0', sha, git).domains), new Set(mandatory))
  assert.deepEqual(
    gitImpact('v1.0.0', sha, (...args) => {
      if (args[0] === 'show') throw Error('不存在的文件')
      return git(...args)
    }).domains,
    domains,
  )
})

test('手机仅 expo.version/android.versionCode/ios.buildNumber 同步不扩大，原生配置改动仍完整跑', () => {
  const before = {
    expo: {
      name: 'Litch',
      version: '1.0.0',
      android: { versionCode: 1, package: 'test.litch' },
      ios: { buildNumber: '1', bundleIdentifier: 'test.litch' },
    },
  }
  const after = structuredClone(before)
  after.expo.version = '1.0.1'
  after.expo.android.versionCode = 2
  after.expo.ios.buildNumber = '2'
  const compare = (value) =>
    versionOnlyChange('apps/mobile/app.json', JSON.stringify(before), JSON.stringify(value))
  assert.ok(compare(after))
  for (const mutate of [
    (value) => {
      value.expo.android.package = 'test.other'
    },
    (value) => {
      value.expo.ios.bundleIdentifier = 'test.other'
    },
    (value) => {
      value.expo.plugins = ['new-plugin']
    },
    (value) => {
      value.expo.android.versionCode = '2'
    },
  ]) {
    const changed = structuredClone(after)
    mutate(changed)
    assert.equal(compare(changed), false)
  }
})

test('patch按改动选领域，不补无关完整领域；普通模式和未知路径仍保守', async () => {
  const { patchAffectedDomains } = await import('./ci-impact.mjs')
  const options = { trustedBase: true }
  assert.deepEqual(patchAffectedDomains(['docs/guide.md'], options).domains, [])
  assert.deepEqual(
    patchAffectedDomains(['packages/ui/src/composer/Permission.tsx'], options).domains,
    ['client', 'client-engines', 'mobile'],
  )
  assert.deepEqual(
    patchAffectedDomains(['packages/device/src/server.mts'], options).domains,
    domains,
  )
  assert.deepEqual(patchAffectedDomains(['scripts/build-cli.mjs'], options).domains, domains)
  assert.deepEqual(
    patchAffectedDomains(['.github/workflows/windows.yml'], options).domains,
    domains,
  )
  assert.deepEqual(
    patchAffectedDomains(
      ['.github/workflows/release.yml', 'scripts/ci/release-patch-base.mjs'],
      options,
    ).domains,
    [],
  )
  assert.deepEqual(affectedDomains(['.github/workflows/release.yml']).domains, domains)
  for (const engine of ['dsh', 'opencode']) {
    const result = patchAffectedDomains([`packages/${engine}/src/adapter.mts`], options)
    for (const domain of ['adapters', 'client-engines', 'mobile', 'real-engines', engine])
      assert.ok(result.domains.includes(domain))
  }
  assert.throws(() => patchAffectedDomains([], { trustedBase: false }), /正式祖先基线/)
})

test('权限模块的产品豁免仅在patch；归属明确的测试在两种模式共用规则', async () => {
  const { patchAffectedDomains, releaseImpact } = await import('./ci-impact.mjs')
  const paths = [
    'packages/core/src/device/project-permissions.mts',
    'packages/core/test/project-permissions.test.mts',
    'packages/core/test/project-permission-failures.test.mts',
    'scripts/check-permission-ui.mjs',
    'packages/core/test/diff-cap.test.mts',
  ]
  for (const path of paths) {
    assert.deepEqual(patchAffectedDomains([path], { trustedBase: true }).domains, [
      'client',
      'client-engines',
      'mobile',
    ])
    assert.deepEqual(
      affectedDomains([path]).domains,
      path.includes('/src/')
        ? domains
        : domains.filter((domain) =>
            [...mandatory, 'client', 'client-engines', 'mobile'].includes(domain),
          ),
    )
  }
  for (const path of [
    'packages/core/src/device/thread-start.mts',
    'packages/device/src/project-permissions.mts',
    'packages/protocol/src/project-permissions.mts',
    'scripts/check-permission-other.mjs',
  ]) {
    assert.deepEqual(patchAffectedDomains([path], { trustedBase: true }).domains, domains)
  }
  assert.deepEqual(releaseImpact(patchAffectedDomains(paths, { trustedBase: true })).domains, [
    'client',
    'client-engines',
  ])
})

test('patch引擎包纯版本同步不误触发引擎完整领域', async () => {
  const { patchAffectedDomains } = await import('./ci-impact.mjs')
  const paths = [
    'packages/dsh/package.json',
    'packages/opencode/package-lock.json',
    'packages/claude/package.json',
  ]
  assert.deepEqual(
    patchAffectedDomains(paths, { trustedBase: true, versionOnly: paths }).domains,
    [],
  )
})

const patchOptions = { trustedBase: true }
const patch = (paths) => patchAffectedDomains(paths, patchOptions).domains
for (const path of [
  'packages/core/test/new-projection.test.mts',
  'packages/core/test/console-cards-fixture.mts',
  'packages/core/test/fixtures/new-input.json',
  'packages/ui/test/new-layout.test.mjs',
  'scripts/check-console-cards.mjs',
  'scripts/manager-board-mobile-fixture.mjs',
]) {
  test(`客户端测试、夹具按所属包或已核验入口选择，不触发适配器/CU：${path}`, () => {
    assert.deepEqual(patch([path]), ['client', 'client-engines', 'mobile'])
    assert.deepEqual(affectedDomains([path], { required: [] }).domains, patch([path]))
    assert.ok(affectedDomains([path]).domains.includes('dsh'), '普通模式仍保留必跑补充领域')
  })
}

test('脚本归属来自现有执行清单，同一入口取所有领域并集', () => {
  assert.deepEqual(patch(['scripts/check-sidebar-projections.mjs']), ['client'])
  assert.deepEqual(patch(['scripts/check-native-codex.mjs']), ['client', 'real-engines'])
  assert.deepEqual(patch(['scripts/client-fixture-anthropic.test.mjs']), ['client-engines'])
  assert.deepEqual(patch(['scripts/check-manager-fixture.mjs']), ['real-engines'])
  assert.deepEqual(patch(['apps/desktop/scripts/check-engines.mjs']), ['client-engines'])
  assert.deepEqual(patch(['apps/desktop/scripts/smoke.mjs']), ['client', 'real-engines'])
})

test('新登记入口自动归属，未知执行集合不能被已知归属遮住', () => {
  const path = 'scripts/check-new.mjs'
  const catalog = [{ id: 'new', command: ['node', '--test', path] }]
  const groups = { 'client-engines': { checks: ['new'] } }
  const nightly = [['new', path]]
  assert.deepEqual(registeredToolingOwners(catalog, groups, nightly).get(path), [
    'client-engines',
    'client',
  ])
  assert.equal(
    registeredToolingOwners(catalog, { ...groups, unknown: { checks: ['new'] } }, nightly).get(
      path,
    ),
    null,
  )
})

test('新增领域测试自动归属，手动手机检查和桌面检查各守边界', () => {
  assert.deepEqual(patch(['scripts/check-recent-mobile.mjs']), ['mobile'])
  assert.deepEqual(patch(['scripts/check-manager-session-open.mjs']), ['client'])
  assert.deepEqual(patch(['apps/mobile/test/new-case.test.mjs']), ['mobile'])
  assert.deepEqual(patch(['apps/mobile/e2e/new-flow.yaml']), ['mobile'])
  assert.deepEqual(patch(['apps/desktop/test/new-case.test.mjs']), [
    'computer-use',
    'computer-use-windows',
    'client',
    'client-engines',
  ])
  assert.deepEqual(patch(['packages/dsh/test/new-case.test.mts']), [
    'adapters',
    'dsh',
    'client-engines',
    'real-engines',
    'mobile',
  ])
  assert.deepEqual(patch(['packages/opencode/test/fixtures/input.json']), [
    'adapters',
    'opencode',
    'client-engines',
    'real-engines',
    'mobile',
  ])
})

for (const path of [
  'scripts/check-unknown.mjs',
  'scripts/check-unknown.test.mjs',
  'scripts/new-fixture.mjs',
  'scripts/fixture-environment.mjs',
  'scripts/chrome-m0/cdp.mjs',
  'scripts/ci/check-catalog.mjs',
  'apps/desktop/scripts/nightly-checks.mjs',
  'packages/core/test/fixtures/package.json',
  'packages/shared/test/new-case.test.mts',
  'packages/device/test/new-case.test.mts',
  'packages/protocol/test/new-case.test.mts',
  'packages/core/src/replica/replica.mts',
  'packages/core/src/index.mts',
]) {
  test(`共享、依赖、编排与未知工具保持全量：${path}`, () => {
    assert.deepEqual(patch([path]), domains)
  })
}

test('识别出测试也不能豁免不可信基线，移动仍覆盖旧路径和新路径', () => {
  assert.deepEqual(
    affectedDomains(['packages/core/test/a.test.mts'], { trustedBase: false }).domains,
    domains,
  )
  assert.deepEqual(patch(['scripts/check-recent-mobile.mjs', 'scripts/renamed-check.mjs']), domains)
  assert.deepEqual(
    patch(['scripts/check-manager-session-open.mjs', 'scripts/check-recent-mobile.mjs']),
    ['client', 'mobile'],
  )
  assert.equal(toolingDomains('scripts/not-a-check.mjs'), null)
})

// 真实 tag diff 与旧规则输出固化，CI 浅克隆也能跑；没有删掉共享产品代码来制造提速。
const history = JSON.parse(
  readFileSync(new URL('./ci/impact-history.json', import.meta.url), 'utf8'),
)
for (const entry of history.cases) {
  test(`${entry.baseTag} → ${entry.tag}：完整改动与仅测试/夹具/验收改动的前后对照`, () => {
    const releaseAll = domains.filter((domain) => domain !== 'mobile')
    const options = { trustedBase: true, versionOnly: entry.versionOnly }
    const actual = releaseImpact(patchAffectedDomains(entry.paths, options)).domains
    assert.deepEqual(
      { before: entry.before, after: actual },
      { before: releaseAll, after: releaseAll },
    )
    const tooling = entry.paths.filter(
      (path) => /\/(test|e2e|scripts)\//.test(path) || path.startsWith('scripts/'),
    )
    const expected =
      entry.tag === 'v0.31.1'
        ? { count: 11, before: releaseAll, after: ['client', 'client-engines'] }
        : { count: 14, before: [], after: [] }
    assert.deepEqual(
      {
        count: tooling.length,
        before: entry.toolingBefore,
        after: releaseImpact(patchAffectedDomains(tooling, options)).domains,
      },
      expected,
    )
    assert.deepEqual(entry.toolingAfter, expected.after)
    assert.equal(entry.paths.length, entry.tag === 'v0.31.1' ? 62 : 59)
    assert.equal(entry.versionOnly.length, entry.tag === 'v0.31.1' ? 23 : 25)
    assert.match(entry.base, /^[a-f0-9]{40}$/)
    assert.match(entry.sha, /^[a-f0-9]{40}$/)
  })
}
