// 隔离进程、随机调试端口与原生窗口审计，供完整 Office 验收复用。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { build } from '../../node_modules/esbuild/lib/main.js'
import { until } from '../chrome-m0/cdp.mjs'

export async function startElectron(root, out, home) {
  const probe = join(out, 'host.mjs'),
    trace = join(out, 'host.jsonl')
  writeFileSync(trace, '')
  await build({
    entryPoints: [join(root, 'scripts/office-preview/host.mjs')],
    outfile: probe,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['electron'],
  })
  const audit = join(root, '.local/office-window-state')
  execFileSync('swiftc', [join(root, 'scripts/office-preview/window-state.swift'), '-o', audit])
  const sample = () => JSON.parse(execFileSync(audit, { encoding: 'utf8' }))
  const samples = [sample()],
    tracked = new Set()
  const free = createServer()
  await new Promise((r) => free.listen(0, '127.0.0.1', r))
  const port = free.address().port
  assert.notEqual(port, 9333)
  await new Promise((r) => free.close(r))
  const child = spawn(
    join(root, 'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    [probe, `--remote-debugging-port=${port}`, '--use-mock-keychain', '--password-store=basic'],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: home,
        LITCH_OFFICE_HOME: home,
        LITCH_OFFICE_ASSETS: join(out, 'assets'),
        LITCH_OFFICE_TRACE: trace,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let log = '',
    violation = false
  child.stderr.on('data', (b) => {
    log += b
  })
  const descendants = () => {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
    const pids = new Set([child.pid])
    let changed = true
    while (changed) {
      changed = false
      for (const [pid, parent] of rows)
        if (pids.has(parent) && !pids.has(pid)) {
          pids.add(pid)
          changed = true
        }
    }
    for (const pid of pids) tracked.add(pid)
    return pids
  }
  const kill = () => {
    for (const pid of [...descendants()].reverse()) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
  const timer = setInterval(() => {
    const state = sample(),
      pids = descendants()
    samples.push({ ...state, pids: [...pids] })
    if (pids.has(state.front) || state.visible.some((p) => pids.has(p))) {
      violation = true
      kill()
    }
  }, 200)
  const stop = async () => {
    clearInterval(timer)
    descendants()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once('exit', r))
      child.kill('SIGTERM')
      const deadline = setTimeout(kill, 3000)
      await exited
      clearTimeout(deadline)
    }
    await new Promise((r) => setTimeout(r, 300))
    samples.push(sample())
    const living = [...tracked].filter((pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })
    writeFileSync(
      join(out, 'windows.json'),
      JSON.stringify({ port, pid: child.pid, samples, living, violation }, null, 2),
    )
    writeFileSync(join(out, 'electron.log'), log)
    assert.equal(violation, false, '不允许出现窗口或抢焦点')
    assert.deepEqual(living, [], '不允许残留进程')
  }
  try {
    const ws = await until(
      () => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1],
      'Electron CDP',
    )
    const owner = execFileSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    }).trim()
    assert.equal(Number(owner), child.pid, '调试端口属于本次隔离进程')
    return {
      ws,
      stop,
      trace: () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
    }
  } catch (error) {
    await stop()
    throw error
  }
}
