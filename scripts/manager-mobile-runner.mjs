// 手机经理冒烟的进程生命周期：仅启动本工作树的预览，不接管已有服务器。
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { removeTestTree } from './ci/remove-test-tree.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const mobile = join(repo, 'apps/mobile')

async function freePort() {
  const reservation = createServer()
  await new Promise((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const { port } = reservation.address()
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

function launch(args, env, cwd, forward = false) {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let result
  const done = new Promise((resolve) => {
    const finish = (value) => {
      result = value
      resolve(value)
    }
    child.once('error', (error) => finish({ error }))
    // close 在 exit 之后，且已经等完继承管道的子进程，不能只等父进程退出。
    child.once('close', (code, signal) => finish({ code, signal }))
  })
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-32_768)
      // 诊断不写 fd 1：Node 进程隔离的测试报告在 stdout 上传二进制协议。
      if (forward) process.stderr.write(chunk)
    })
  const groupAlive = () => {
    if (!child.pid) return false
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (error) {
      if (error.code === 'ESRCH') return false
      // macOS 在组内进程退出的窗口可能返回 EPERM；先等组消失，超时后仍正常尝试终止。
      if (error.code === 'EPERM') return true
      error.message += `（检查进程组 ${child.pid}，父进程结果 ${JSON.stringify(result)}）`
      throw error
    }
  }
  return {
    done,
    result: () => result,
    output: () => output,
    async stop() {
      if (!child.pid) return
      if (process.platform === 'win32') {
        if (!result)
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        await done
        return
      }
      const kill = (signal) => {
        try {
          process.kill(-child.pid, signal)
        } catch (error) {
          if (error.code !== 'ESRCH') {
            error.message += `（${signal} 进程组 ${child.pid}，父进程结果 ${JSON.stringify(result)}）`
            throw error
          }
        }
      }
      kill('SIGTERM')
      const deadline = Date.now() + 5000
      while (groupAlive() && Date.now() < deadline) await pause(50)
      if (groupAlive()) {
        kill('SIGKILL')
        const killedDeadline = Date.now() + 5000
        while (groupAlive() && Date.now() < killedDeadline) await pause(50)
        if (groupAlive()) throw new Error(`进程组 ${child.pid} 在 SIGKILL 后仍未退出`)
      }
      await done
    },
  }
}

function isolatedEnvironment(source, home, browser) {
  const env = Object.fromEntries(
    Object.entries(source).filter(
      ([name]) =>
        [
          'PATH',
          'Path',
          'SystemRoot',
          'SYSTEMROOT',
          'WINDIR',
          'COMSPEC',
          'PATHEXT',
          'LANG',
          'LC_ALL',
        ].includes(name) || name.startsWith('LITCH_FIXTURE_'),
    ),
  )
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: join(home, 'tmp'),
    TMP: join(home, 'tmp'),
    TEMP: join(home, 'tmp'),
    EXPO_NO_TELEMETRY: '1',
    EXPO_NO_DOTENV: '1',
    EXPO_NO_TYPESCRIPT_SETUP: '1',
    EXPO_PUBLIC_LITCH_E2E: '1',
    BROWSER: 'none',
    FORCE_COLOR: '0',
    LITCH_CHROME_BINARY: browser,
    ...(source.LITCH_SUGGESTION_SHOTS
      ? { LITCH_SUGGESTION_SHOTS: source.LITCH_SUGGESTION_SHOTS }
      : {}),
    ...(source.LITCH_SMOKE_TRACE ? { LITCH_SMOKE_TRACE: source.LITCH_SMOKE_TRACE } : {}),
  }
}

function failed(message, child) {
  return new Error(`${message}\n${child.output()}`)
}

async function cleanup(probe, server, home) {
  const stopped = await Promise.allSettled([probe?.stop(), server?.stop()])
  const failures = stopped.filter((result) => result.status === 'rejected')
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      `子进程清理失败，保留临时目录：${home}`,
    )
  // Expo 的 DotSlash 缓存含只读目录；复用不跟随软链的临时树清理，有限重试仍失败就报错。
  removeTestTree(home)
}

export async function runManagerMobile({
  expo = join(mobile, 'node_modules/expo/bin/cli'),
  check = join(repo, 'scripts/check-manager-mobile.mjs'),
  env: source = process.env,
  readyTimeout = 90_000,
  signal,
} = {}) {
  signal?.throwIfAborted()
  const browser =
    source.LITCH_CHROME_BINARY ??
    globSync(
      join(
        homedir(),
        'Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ),
    )
      .sort()
      .at(-1)
  if (!browser) throw new Error('需要 LITCH_CHROME_BINARY 指向隔离的 Chrome for Testing')
  const home = mkdtempSync(join(tmpdir(), 'litch-manager-mobile-'))
  mkdirSync(join(home, 'tmp'))
  let server, probe, abort
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(signal.reason)
    signal?.addEventListener('abort', abort, { once: true })
  })
  // 分配端口期间也可能收到中断；先接住拒绝，随后由 race 交回调用方。
  interrupted.catch(() => {})
  try {
    const env = isolatedEnvironment(source, home, browser)
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    console.error(`手机经理预览：${base}`)
    server = launch([expo, 'start', '--web', '--offline', '--port', String(port)], env, mobile)
    const ready = async () => {
      const deadline = Date.now() + readyTimeout
      while (Date.now() < deadline) {
        signal?.throwIfAborted()
        if (server.result()) throw failed('Expo 在预览就绪前退出', server)
        // CLI 确认自己已监听后再探测，避免误用抢占同一端口的其他服务器。
        if (
          [`http://localhost:${port}`, base].some((url) =>
            server.output().includes(`Waiting on ${url}`),
          )
        ) {
          try {
            const response = await fetch(base, { signal: AbortSignal.timeout(2000) })
            await response.body?.cancel()
            if (response.ok) return
          } catch {}
        }
        await pause(100, undefined, { signal })
      }
      throw failed('Expo 预览就绪超时', server)
    }
    await Promise.race([ready(), interrupted])
    const url = `${base}/?app=1&scene=manager-console&skin=standard&appearance=light&lang=zh-CN`
    probe = launch([check, url], env, repo, true)
    const result = await Promise.race([
      probe.done,
      server.done.then(() => {
        throw failed('Expo 在验收结束前退出', server)
      }),
      interrupted,
    ])
    if (result.error) throw result.error
    if (result.code !== 0)
      throw Object.assign(new Error(`手机经理验收失败：退出码 ${result.code ?? result.signal}`), {
        exitCode: result.code ?? 1,
      })
  } finally {
    signal?.removeEventListener('abort', abort)
    await cleanup(probe, server, home)
  }
}
