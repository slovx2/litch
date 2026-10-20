// 发现：Mac、Windows 两套路径（假的主目录、LOCALAPPDATA、APPDATA），资料名和默认资料、各类有没有、拼不出根目录外面的路径。
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { firefoxRoots, sampleEnv } from '../browsers.mjs'
import { discoverSources, findProfile, firefoxProfiles } from '../discover.mjs'
import {
  ensureSample,
  SAMPLE_MARKER,
  sampleChromiumRoot,
  writeChromium,
  writeFirefox,
  writeSample,
} from './sample.mjs'

const scratch = (t: { after(fn: () => void): void }) => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-import-discover-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

for (const platform of ['darwin', 'win32'] as const) {
  test(`发现：${platform} 上的样本`, (t) => {
    const dir = scratch(t)
    const env = writeSample(dir, platform)
    const sources = discoverSources(env)
    // 按固定顺序；Arc、Chromium 没摆，不列
    assert.deepEqual(
      sources.map((source) => source.browser),
      ['chrome', 'edge', 'brave', 'vivaldi', 'firefox'],
    )
    const chrome = sources[0]
    assert.ok(chrome)
    assert.equal(chrome.name, 'Google Chrome')
    assert.equal(chrome.root, sampleChromiumRoot(env, 'chrome'))
    assert.deepEqual(
      chrome.profiles.map((profile) => [
        profile.id,
        profile.name,
        profile.isDefault,
        profile.account,
      ]),
      [
        ['Default', '个人', true, 'sample@example.com'],
        ['Profile 1', '工作', false, undefined],
      ],
    )
    assert.deepEqual(chrome.profiles[0]?.has, { cookies: true, passwords: true })
    const vivaldi = sources.find((source) => source.browser === 'vivaldi')
    assert.deepEqual(vivaldi?.profiles[0]?.has, { cookies: false, passwords: false })
    const firefox = sources.find((source) => source.browser === 'firefox')
    assert.equal(firefox?.root, firefoxRoots(env)[0])
    assert.deepEqual(
      firefox?.profiles.map((profile) => [profile.id, profile.isDefault, profile.has.cookies]),
      [
        ['Profiles/sample.default-release', true, true],
        ['Profiles/sample.default', false, false],
      ],
    )
  })
}

test('发现：Mac 和 Windows 的根目录在各自的位置', (t) => {
  const dir = scratch(t)
  const mac = sampleEnv(dir, 'darwin')
  const win = sampleEnv(dir, 'win32')
  assert.equal(
    sampleChromiumRoot(mac, 'chrome'),
    join(dir, 'Library', 'Application Support', 'Google', 'Chrome'),
  )
  assert.equal(
    sampleChromiumRoot(win, 'edge'),
    join(dir, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
  )
  assert.deepEqual(firefoxRoots(win), [join(dir, 'AppData', 'Roaming', 'Mozilla', 'Firefox')])
  assert.deepEqual(firefoxRoots(mac), [join(dir, 'Library', 'Application Support', 'Firefox')])
  // 别的平台一个都不列
  writeSample(dir, 'darwin')
  assert.deepEqual(discoverSources(sampleEnv(dir, 'linux')), [])
})

test('发现：Windows 上商店装的 Arc 和 Firefox 按包名前缀找', (t) => {
  const dir = scratch(t)
  const env = sampleEnv(dir, 'win32')
  const packages = join(dir, 'AppData', 'Local', 'Packages')
  writeChromium(
    join(packages, 'TheBrowserCompany.Arc_abc123', 'LocalCache', 'Local', 'Arc', 'User Data'),
    [{ dir: 'Default', name: 'Arc 资料', cookies: true }],
  )
  writeFirefox(
    join(packages, 'Mozilla.Firefox_n80bbvh6b1yt2', 'LocalCache', 'Roaming', 'Mozilla', 'Firefox'),
    [{ path: 'Profiles/x.default-release', name: 'store', isDefault: true }],
  )
  const sources = discoverSources(env)
  assert.deepEqual(
    sources.map((source) => [source.browser, source.profiles[0]?.name]),
    [
      ['arc', 'Arc 资料'],
      ['firefox', 'store'],
    ],
  )
})

test('发现：Local State 和 profiles.ini 里拼到根目录外面的不认', (t) => {
  const dir = scratch(t)
  const env = sampleEnv(dir, 'darwin')
  const root = sampleChromiumRoot(env, 'chromium')
  mkdirSync(join(root, 'Default'), { recursive: true })
  mkdirSync(join(dir, 'outside'), { recursive: true })
  writeFileSync(
    join(root, 'Local State'),
    JSON.stringify({
      profile: { info_cache: { '..': {}, '../outside': {}, Default: { name: 'ok' } } },
    }),
  )
  const firefox = firefoxRoots(env)[0] as string
  mkdirSync(join(firefox, 'Profiles', 'good'), { recursive: true })
  writeFileSync(
    join(firefox, 'profiles.ini'),
    [
      '[Profile0]',
      'Name=escape',
      'IsRelative=1',
      'Path=../../outside',
      '[Profile1]',
      'Name=good',
      'IsRelative=1',
      'Path=Profiles/good',
      '[Profile2]',
      'Name=relative-but-marked-absolute',
      'IsRelative=0',
      'Path=Profiles/good',
    ].join('\n'),
  )
  const sources = discoverSources(env)
  assert.deepEqual(
    sources.map((source) => [source.browser, source.profiles.map((profile) => profile.name)]),
    [
      ['chromium', ['ok']],
      ['firefox', ['good']],
    ],
  )
})

test('导入前按浏览器和资料标识重新找；资料没了就找不到', (t) => {
  const dir = scratch(t)
  const env = writeSample(dir, 'darwin')
  const found = findProfile(env, 'chrome', 'Profile 1')
  assert.equal(found?.profile.dir, join(sampleChromiumRoot(env, 'chrome'), 'Profile 1'))
  assert.equal(findProfile(env, 'chrome', 'Profile 9'), null)
  assert.equal(findProfile(env, 'arc', 'Default'), null)
  rmSync(join(sampleChromiumRoot(env, 'chrome'), 'Profile 1'), { recursive: true })
  assert.equal(findProfile(env, 'chrome', 'Profile 1'), null)
})

test('Firefox 装了几份时只留一个默认资料', (t) => {
  const dir = scratch(t)
  for (const name of ['a', 'b', 'c']) mkdirSync(join(dir, 'Profiles', name), { recursive: true })
  const write = (marked?: string) =>
    writeFileSync(
      join(dir, 'profiles.ini'),
      [
        '[Install1111]',
        'Default=Profiles/a',
        '[Install2222]',
        'Default=Profiles/b',
        ...['a', 'b', 'c'].flatMap((name) => [
          `[Profile-${name}]`,
          `Name=${name}`,
          'IsRelative=1',
          `Path=Profiles/${name}`,
          ...(name === marked ? ['Default=1'] : []),
        ]),
      ].join('\n'),
    )
  write()
  const defaults = (list: ReturnType<typeof firefoxProfiles>) =>
    list.filter((profile) => profile.isDefault).map((profile) => profile.name)
  // 按 profiles.ini 里的先后
  assert.deepEqual(defaults(firefoxProfiles(dir)), ['a'])
  // [Profile…] 也标了 Default=1 的优先
  write('b')
  assert.deepEqual(defaults(firefoxProfiles(dir)), ['b'])
})

test('样本模式：目录不空又没有样本标记时不写；空目录、不存在的目录、已有样本的照常', (t) => {
  const dir = scratch(t)
  const busy = join(dir, 'home')
  mkdirSync(join(busy, 'Documents'), { recursive: true })
  assert.throws(() => ensureSample(busy, 'darwin'), /non-empty/)
  assert.deepEqual(readdirSync(busy), ['Documents'])

  const fresh = join(dir, 'fresh')
  ensureSample(fresh, 'darwin')
  assert.ok(existsSync(join(fresh, SAMPLE_MARKER)))
  const empty = join(dir, 'empty')
  mkdirSync(empty)
  ensureSample(empty, 'darwin')
  assert.ok(existsSync(join(empty, SAMPLE_MARKER)))
  // 已有样本：原样用，手改的不被覆盖
  const local = join(sampleChromiumRoot(sampleEnv(fresh, 'darwin'), 'chrome'), 'Local State')
  writeFileSync(local, '{}')
  ensureSample(fresh, 'darwin')
  assert.equal(readFileSync(local, 'utf8'), '{}')
})
