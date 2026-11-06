import assert from 'node:assert/strict'
import { test } from 'node:test'
import { affectedDomains, domains, gitImpact, mandatory, versionOnlyChange } from './ci-impact.mjs'

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
    affectedDomains(['apps/computer-use-win/src/main.rs']).domains.includes('computer-use-windows'),
  )
  assert.ok(
    affectedDomains(['apps/computer-use/Sources/main.swift']).domains.includes('computer-use'),
  )
  for (const domain of ['client', 'computer-use', 'computer-use-windows']) {
    assert.ok(affectedDomains(['packages/computer-use/src/runtime.mts']).domains.includes(domain))
  }
  for (const domain of ['client', 'client-engines']) {
    assert.ok(affectedDomains(['packages/browser/src/driver.mts']).domains.includes(domain))
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

test('patch仅细化客户端权限记忆模块；设备、协议和其他core仍全域，普通模式不变', async () => {
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
    assert.deepEqual(affectedDomains([path]).domains, domains)
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
