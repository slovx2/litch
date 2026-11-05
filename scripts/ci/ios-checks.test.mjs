import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { affectedDomains, releaseImpact } from '../ci-impact.mjs'
import { iosCommands, iosReadiness } from './ios-checks.mjs'
import { nativePlan, selectedNative } from './mac-native-plan.mjs'

test('iOS原生未落地只延后构建；部分合入或缺podspec不能伪装成功', () => {
  const root = mkdtempSync(join(tmpdir(), 'litch-ios-plan-'))
  try {
    for (const name of ['litch-ssh', 'litch-update']) {
      mkdirSync(join(root, 'modules', name, 'ios'), { recursive: true })
      writeFileSync(
        join(root, 'modules', name, 'expo-module.config.json'),
        JSON.stringify({ platforms: ['android'] }),
      )
    }
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { 'test:ios': 'native-unit-command' } }),
    )
    assert.equal(iosReadiness(root).ready, false)
    assert.equal(iosCommands(root).commands.length, 5)
    assert.deepEqual(iosCommands(root).commands[0], ['go', ['test', './...'], 'mobile'])
    writeFileSync(
      join(root, 'modules/litch-ssh/expo-module.config.json'),
      JSON.stringify({ platforms: ['apple'] }),
    )
    assert.throws(() => iosReadiness(root), /一部分/)
    writeFileSync(
      join(root, 'modules/litch-update/expo-module.config.json'),
      JSON.stringify({ platforms: ['apple'] }),
    )
    assert.throws(() => iosReadiness(root), /podspec/)
    for (const name of ['litch-ssh', 'litch-update'])
      writeFileSync(join(root, 'modules', name, 'ios/Module.podspec'), 'spec')
    const plan = iosCommands(root)
    assert.equal(plan.state.ready, true)
    assert.ok(
      plan.commands.some(
        ([cmd, args]) =>
          cmd === 'xcodebuild' &&
          args.includes('CODE_SIGNING_ALLOWED=NO') &&
          args.includes('iphonesimulator'),
      ),
    )
    assert.ok(plan.commands.some(([, args]) => args.includes('test:ios')))
    assert.doesNotMatch(JSON.stringify(plan.commands), /maestro|e2e|archive|upload/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('iOS原生构建只在Full手机领域跑，CI与候选门禁不占模拟器构建资源', () => {
  assert.deepEqual(selectedNative('[]', true), ['browser'])
  assert.ok(
    !selectedNative(
      JSON.stringify(releaseImpact(affectedDomains(['apps/mobile/ios/App.swift'])).domains),
      true,
    ).includes('ios'),
  )
  assert.deepEqual(selectedNative('["mobile"]', false), ['ios'])
  assert.equal(nativePlan(['ios']).checks[0].id, 'ios:build-unit')
  assert.deepEqual(releaseImpact(affectedDomains(['apps/mobile/ios/App.swift'])).domains, [
    'dsh',
    'opencode',
    'real-engines',
  ])
  for (const path of [
    'ios/App.swift',
    'apps/mobile/modules/litch-ssh/ios/Module.swift',
    'apps/mobile/modules/litch-ssh/ios/Module.podspec',
  ])
    assert.ok(affectedDomains([path]).domains.includes('mobile'))
  assert.match(readFileSync('.github/workflows/ci.yml', 'utf8'), /domains: '\["browser"\]'/)
})
