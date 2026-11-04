// iOS只编译模拟器并跑单测；不启动Maestro，不创建签名归档或上传商店。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function iosReadiness(root = fileURLToPath(new URL('../../apps/mobile/', import.meta.url))) {
  const names = readdirSync(join(root, 'modules')).filter((name) => name.startsWith('litch-'))
  assert.ok(names.length > 0, '缺少本地原生模块目录')
  const declared = names.filter((name) => {
    const config = JSON.parse(readFileSync(join(root, 'modules', name, 'expo-module.config.json')))
    return config.platforms?.some((platform) => ['ios', 'apple'].includes(platform))
  })
  if (!declared.length) {
    assert.ok(
      names.every((name) => {
        const dir = join(root, 'modules', name, 'ios')
        return !existsSync(dir) || readdirSync(dir).length === 0
      }),
      '已有iOS源码但未声明平台，禁止跳过构建',
    )
    return { ready: false, reason: 'iOS原生模块尚未合入；只执行手机单测与类型检查' }
  }
  assert.deepEqual(declared, names, 'iOS原生模块只合入了一部分，禁止静默跳过')
  for (const name of names) {
    const dir = join(root, 'modules', name, 'ios')
    assert.ok(
      existsSync(dir) && readdirSync(dir).some((file) => file.endsWith('.podspec')),
      `缺少${name}的iOS podspec`,
    )
  }
  return { ready: true }
}

export function iosCommands(root = 'apps/mobile') {
  const state = iosReadiness(root)
  const commands = [
    ['npm', ['ci', '--prefix', root, '--no-audit', '--no-fund']],
    ['npm', ['run', 'mobile:test']],
    ['npm', ['run', 'typecheck', '--prefix', root]],
    ['npm', ['run', 'mobile:test:markdown']],
  ]
  if (state.ready) {
    commands.push(
      ['npm', ['run', 'web:build'], root],
      [
        'npx',
        ['--no-install', 'expo', 'prebuild', '--platform', 'ios', '--clean', '--no-install'],
        root,
      ],
      ['gem', ['install', 'cocoapods', '--version', '1.16.2', '--no-document']],
      ['pod', ['_1.16.2_', 'install'], join(root, 'ios')],
      [
        'xcodebuild',
        [
          '-workspace',
          'Litch.xcworkspace',
          '-scheme',
          'Litch',
          '-configuration',
          'Release',
          '-sdk',
          'iphonesimulator',
          '-destination',
          'generic/platform=iOS Simulator',
          '-derivedDataPath',
          resolve(root, '.ci-ios-build'),
          'CODE_SIGNING_ALLOWED=NO',
          'build',
        ],
        join(root, 'ios'),
      ],
    )
    const scripts = JSON.parse(readFileSync(join(root, 'package.json'))).scripts
    if (scripts['test:ios']) commands.push(['npm', ['run', 'test:ios'], root])
  }
  return { state, commands }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.platform, 'darwin')
  const gems = join(process.env.HOME, '.ci-gems')
  process.env.GEM_HOME = gems
  process.env.GEM_PATH = gems
  process.env.PATH = `${join(gems, 'bin')}:${process.env.PATH}`
  const { state, commands } = iosCommands()
  if (state.ready)
    assert.equal(
      execFileSync('ruby', ['-e', 'print RUBY_VERSION'], { encoding: 'utf8' }),
      '3.4.7',
      'iOS构建要求Ruby 3.4.7',
    )
  console.log(`IOS_BUILD_SCOPE ${JSON.stringify(state)}`)
  const manifest = 'apps/mobile/package.json'
  const before = readFileSync(manifest, 'utf8')
  try {
    for (const [command, args, cwd] of commands) {
      execFileSync(command, args, { cwd, env: { ...process.env, CI: '1' }, stdio: 'inherit' })
      if (command === 'npx') {
        // Expo会补run:ios等脚本；允许生成工程，但不允许悄悄改动锁定的依赖。
        const original = JSON.parse(before)
        const generated = JSON.parse(readFileSync(manifest, 'utf8'))
        for (const field of ['dependencies', 'devDependencies', 'overrides'])
          assert.deepEqual(generated[field], original[field], 'Expo改变了依赖，须先在源码里锁定')
      }
    }
  } finally {
    writeFileSync(manifest, before)
  }
}
