import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runManagerMobile } from './manager-mobile-runner.mjs'

const fixture = fileURLToPath(new URL('./manager-mobile-runner-fixture.mjs', import.meta.url))
const rows = (path) =>
  existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []

for (const mode of [
  'success',
  'start-fail',
  'timeout',
  'probe-fail',
  'server-exit',
  'interrupt',
  'orphan',
]) {
  test(`手机经理生命周期：${mode}，清理自有进程且不动其他服务器`, { timeout: 15_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), 'manager-mobile-unit-'))
    const report = join(work, 'events.jsonl')
    const other = createServer((_, response) => response.end('unrelated'))
    await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve))
    const otherUrl = `http://127.0.0.1:${other.address().port}`
    const controller = new AbortController()
    const env = {
      ...process.env,
      CI: '1',
      HOME: '/fictional/private-home',
      OPENAI_API_KEY: 'fictional-test-key',
      LITCH_DEVICE_SOCKET: '/fictional/device.sock',
      LITCH_CHROME_BINARY: process.execPath,
      LITCH_FIXTURE_REPORT: report,
      LITCH_FIXTURE_MODE: mode,
    }
    try {
      const result = runManagerMobile({
        expo: fixture,
        check: fixture,
        env,
        readyTimeout: mode === 'timeout' ? 500 : 5000,
        signal: controller.signal,
      })
      if (mode === 'interrupt') {
        // 先登记拒绝处理，再等假验收真正开始，避免提前中断只测到分配端口。
        const rejected = assert.rejects(result, /虚构中断/)
        while (!rows(report).some((row) => row.phase === 'probe')) await pause(20)
        controller.abort(new Error('虚构中断'))
        await rejected
      } else if (mode === 'start-fail')
        await assert.rejects(result, /Expo 在预览就绪前退出[\s\S]*虚构 Expo 启动失败/)
      else if (mode === 'timeout') await assert.rejects(result, /Expo 预览就绪超时/)
      else if (mode === 'probe-fail') await assert.rejects(result, (error) => error.exitCode === 7)
      else if (mode === 'server-exit') await assert.rejects(result, /Expo 在验收结束前退出/)
      else await result
      const events = rows(report)
      const expo = events.find((row) => row.phase === 'expo')
      assert.ok(expo, '预览确实启动')
      assert.notEqual(expo.port, other.address().port, '不接管已占用端口')
      assert.notEqual(expo.home, env.HOME, '使用独立 HOME')
      assert.ok(
        events.every((row) => row.home === expo.home),
        '所有子进程沿用隔离 HOME',
      )
      assert.equal(existsSync(expo.home), false, '临时状态已清理')
      assert.equal(env.CI, '1', '不修改调用方环境')
      for (const { port } of events.filter((row) => row.port))
        await assert.rejects(
          fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }),
          '自有监听已结束',
        )
      assert.equal(await (await fetch(otherUrl)).text(), 'unrelated', '其他服务器仍正常')
    } finally {
      controller.abort(new Error('单测清理'))
      other.closeAllConnections()
      await new Promise((resolve) => other.close(resolve))
      rmSync(work, { recursive: true, force: true })
    }
  })
}
