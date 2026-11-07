import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { UPDATE_CHECK_INTERVAL_MS, type UpdateState } from '@litch/core'
import { createUpdater } from '../updater.mjs'
import { autoUpdater, fixture } from './updater-electron.mjs'

function setup(platform: 'windows-x64' | 'macos-arm64') {
  const root = mkdtempSync(join(tmpdir(), 'litch-updater-'))
  fixture.root = root
  fixture.checks = 0
  fixture.failPrepare = false
  fixture.installs = []
  autoUpdater.removeAllListeners()
  mkdirSync(join(root, 'A.app/Contents/MacOS'), { recursive: true })
  writeFileSync(
    join(root, 'A.app/Contents/Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.litch.update-test</string></dict></plist>',
  )
  let version = '1.0.1'
  let failure = ''
  let pause: Promise<void> | null = null
  let downloads = 0
  let feeds = 0
  const states: UpdateState[] = []
  fixture.download = async (url) => {
    if (url.endsWith('/feed')) {
      feeds++
      if (failure === 'feed') throw new Error('断网')
      const body = Buffer.from(version)
      return Response.json({
        version,
        assets: {
          [platform]: {
            url: `https://fixture.invalid/${version}`,
            size: body.length,
            sha256: createHash('sha256').update(body).digest('hex'),
          },
        },
      })
    }
    downloads++
    if (pause) await pause
    if (failure === 'network') throw new Error('断网')
    if (failure === 'not-available') return new Response(null, { status: 304 })
    return new Response(
      failure === 'hash' ? 'broken' : failure === 'size' ? 'x' : url.split('/').at(-1),
    )
  }
  const updater = createUpdater({
    version: '1.0.0',
    platform,
    dataDir: join(root, 'profile'),
    feedUrl: 'https://fixture.invalid/feed',
    allowHttp: false,
    auto: () => true,
    onState: (state) => states.push(state),
    log() {},
  })
  return {
    updater,
    states,
    offer(next: string) {
      version = next
    },
    fail(next: string) {
      failure = next
    },
    pause() {
      let release!: () => void
      pause = new Promise<void>((done) => {
        release = done
      })
      return () => {
        release()
        pause = null
      }
    },
    downloads: () => downloads,
    feeds: () => feeds,
    install() {
      if (platform === 'macos-arm64') {
        updater.quitAndInstall()
        return fixture.installs.at(-1)
      }
      const installer = updater.installer()
      assert.ok(installer)
      return readFileSync(installer, 'utf8')
    },
    close() {
      updater.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('夹具超时')
}

for (const platform of ['windows-x64', 'macos-arm64'] as const) {
  test(`${platform}：待装时继续查，下载与提示及安装同时切到新版`, async () => {
    const f = setup(platform)
    try {
      await f.updater.check()
      assert.equal(f.install(), '1.0.1')
      const old = f.updater.installer()
      const release = f.pause()
      f.offer('1.0.2')
      const check = f.updater.check()
      await until(() => f.downloads() === 2)
      assert.equal(f.updater.state().phase, 'ready')
      assert.equal(f.install(), '1.0.1')
      const concurrent = f.updater.check()
      assert.equal(concurrent, check)
      release()
      await check
      assert.deepEqual(f.updater.state(), { phase: 'ready', version: '1.0.2', notesUrl: '' })
      assert.equal(f.install(), '1.0.2')
      if (old) assert.equal(existsSync(old), false)
      assert.deepEqual(
        f.states.filter((s) => s.phase === 'ready').map((s) => s.version),
        ['1.0.1', '1.0.2'],
      )
      for (const version of ['1.0.2', '1.0.1', '1.0.0']) {
        f.offer(version)
        await f.updater.check()
      }
      assert.equal(f.downloads(), 2)
      assert.equal(f.install(), '1.0.2')
    } finally {
      f.close()
    }
  })

  test(`${platform}：连续下载/校验/清单失败仍可安装旧包，下一次成功能替换`, async () => {
    const f = setup(platform)
    try {
      await f.updater.check()
      f.offer('1.0.2')
      for (const failure of ['network', 'network', 'hash', 'size', 'feed']) {
        f.fail(failure)
        await f.updater.check()
        assert.equal(f.install(), '1.0.1')
        assert.deepEqual(f.updater.state(), { phase: 'ready', version: '1.0.1', notesUrl: '' })
      }
      f.fail('')
      await f.updater.check()
      assert.equal(f.install(), '1.0.2')
    } finally {
      f.close()
    }
  })
}

test('定时检查在 ready 时继续执行，手动检查共享同一入口', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const f = setup('windows-x64')
  try {
    await f.updater.check()
    f.updater.start()
    context.mock.timers.tick(30_000)
    await f.updater.check()
    assert.equal(f.feeds(), 2)
    f.offer('1.0.2')
    context.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS)
    await f.updater.check()
    assert.equal(f.feeds(), 3)
    assert.equal(f.install(), '1.0.2')
  } finally {
    f.close()
    context.mock.timers.reset()
  }
})

test('macOS：原生写入新请求后准备失败，恢复可安装的旧请求', async () => {
  const f = setup('macos-arm64')
  try {
    await f.updater.check()
    f.offer('1.0.2')
    fixture.failPrepare = true
    await f.updater.check()
    assert.equal(f.install(), '1.0.1')
    assert.deepEqual(f.updater.state(), { phase: 'ready', version: '1.0.1', notesUrl: '' })
    fixture.failPrepare = false
    await f.updater.check()
    assert.equal(f.install(), '1.0.2')
  } finally {
    f.close()
  }
})

test('macOS：304 清掉原生 available 后，仍能安排旧包安装并重开', async () => {
  const f = setup('macos-arm64')
  try {
    await f.updater.check()
    f.offer('1.0.2')
    f.fail('not-available')
    await f.updater.check()
    assert.deepEqual(f.updater.state(), { phase: 'ready', version: '1.0.1', notesUrl: '' })
    f.updater.quitAndInstall()
    await until(() => fixture.installs.length === 1)
    assert.deepEqual(fixture.installs, ['1.0.1'])
  } finally {
    f.close()
  }
})
