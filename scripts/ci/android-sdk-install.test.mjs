import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { clearSdkDownloadState, installSdkPackage, sdkRetryReason } from './android-sdk-install.mjs'

const zipError =
  'Warning: An error occurred while preparing SDK package Android Emulator: Error reading Zip content from a SeekableByteChannel.'
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'litch-sdk-install-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sdkRoot = join(root, 'sdk')
  const directory = join(root, 'logs')
  mkdirSync(join(sdkRoot, 'emulator'), { recursive: true })
  writeFileSync(join(sdkRoot, 'emulator/emulator'), 'installed')
  for (const path of ['.temp', '.downloadIntermediates', 'emulator/.installer']) {
    mkdirSync(join(sdkRoot, path), { recursive: true })
    writeFileSync(join(sdkRoot, path, 'stale'), 'bad download')
  }
  return { sdkRoot, directory, pkg: 'emulator' }
}

test('仅 SDK 准备阶段的归档/网络错误可重试，磁盘和产品错误不匹配', () => {
  assert.ok(sdkRetryReason(zipError))
  assert.ok(sdkRetryReason('java.net.SocketException: Connection reset'))
  for (const text of [
    'Error reading Zip content from a SeekableByteChannel',
    'Unable to launch app: device offline',
    'Assertion failed',
    'Unknown package',
    `${zipError}\nNo space left on device`,
    `${zipError}\nPermission denied`,
    `${zipError}\nlicenses were not accepted`,
  ])
    assert.equal(sdkRetryReason(text), null)
})

test('失败归档清场后重新下载，保留首败与已安装 SDK', async (t) => {
  const setup = fixture(t)
  const messages = []
  let attempts = 0
  await installSdkPackage({
    ...setup,
    run: () => {
      if (++attempts === 1) return { status: 1, stderr: zipError }
      assert.ok(!existsSync(join(setup.sdkRoot, '.temp')))
      assert.ok(!existsSync(join(setup.sdkRoot, '.downloadIntermediates')))
      assert.ok(!existsSync(join(setup.sdkRoot, 'emulator/.installer')))
      assert.equal(readFileSync(join(setup.sdkRoot, 'emulator/emulator'), 'utf8'), 'installed')
      return { status: 0, stdout: 'installed' }
    },
    delay: async () => {},
    report: (line) => messages.push(line),
  })
  assert.equal(attempts, 2)
  assert.match(
    readFileSync(join(setup.directory, 'emulator-attempt-1.log'), 'utf8'),
    /SeekableByteChannel/,
  )
  assert.match(messages[1], /已重试 1 次/)
})

test('已识别错误最多四次，未知错误首次失败且不清下载状态', async (t) => {
  for (const [error, expected] of [
    [zipError, 4],
    ['Unknown package', 1],
  ]) {
    const setup = fixture(t)
    let attempts = 0
    await assert.rejects(
      installSdkPackage({
        ...setup,
        run: () => {
          attempts++
          return { status: 1, stderr: error }
        },
        delay: async () => {},
        report: () => {},
      }),
      /不再重试/,
    )
    assert.equal(attempts, expected)
    if (expected === 1) assert.ok(existsSync(join(setup.sdkRoot, '.temp/stale')))
  }
})

test('拒绝越界包名、根目录及中间符号链接清理', (t) => {
  const setup = fixture(t)
  assert.throws(() => clearSdkDownloadState('/', 'emulator'), /非根路径/)
  assert.throws(() => clearSdkDownloadState(setup.sdkRoot, '../other'), /未允许/)
  const linked = join(setup.sdkRoot, 'system-images')
  symlinkSync(setup.directory, linked)
  mkdirSync(setup.directory)
  assert.throws(
    () => clearSdkDownloadState(setup.sdkRoot, 'system-images;android-35;google_apis;x86_64'),
    /符号链接/,
  )
})
