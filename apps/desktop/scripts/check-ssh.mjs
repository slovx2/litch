// 远程连接的自检：起一台假的远程机器（scripts/client-ssh-fixture.mjs），拿远程传输把每一种情形过一遍。
// 不起界面。验的是：经登录 shell 找到 codex、切掉启动脚本的杂音、服务不在时自己启动并常驻、
// 再连时一条 ssh 直达，以及每一种“没连上”都落在对应的阶段上，而不是一段 ssh 报错。
// 后半截是装了适配器的机器：先找设备服务、没有才是 codex；经 device-start 拉起真的设备服务并接到聚合面上
// （完整模式）；对面装上、卸掉适配器之后下一次连接自己换过去；旧服务、太旧、起不来各是哪个阶段。
// 最后打出量到的各步耗时。
//   npm run check:ssh
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const tool = fileURLToPath(new URL('../dist/ssh-check.mjs', import.meta.url))

/** 起假的远程机器，等它就绪 */
function startFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/client-ssh-fixture.mjs'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const onData = (chunk) => {
      output += chunk
      const line = output.split('\n').find((entry) => entry.startsWith('LITCH_SSH_FIXTURE '))
      if (!line) return
      resolve({
        ...JSON.parse(line.slice('LITCH_SSH_FIXTURE '.length)),
        stop: () =>
          new Promise((done) => {
            child.once('exit', done)
            child.kill('SIGTERM')
          }),
      })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) =>
      reject(new Error(`假的远程机器没起来（退出码 ${code}）：\n${output}`)),
    )
  })
}

const fixture = await startFixture()
/** 小工具的环境：只用假机器那份 ssh 配置，对面的 codex 和适配器都是替身的名字 */
const toolEnv = {
  ...process.env,
  LITCH_SSH_CONFIG: fixture.config,
  LITCH_REMOTE_CODEX: fixture.codex,
  LITCH_REMOTE_ADAPTER: fixture.adapter,
}

/** 跑一次小工具，返回它打出来的每一行 */
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tool, ...args], {
      env: toolEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', () => {
      try {
        resolve(
          stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        )
      } catch {
        reject(new Error(`小工具的输出读不懂：\n${stdout}\n${stderr}`))
      }
    })
  })
}

const connect = (alias, ...flags) => run([JSON.stringify({ kind: 'alias', alias }), ...flags])

/** 这次自检起的那些 ssh（按假机器的配置文件认，不会碰到别的 ssh） */
const sshPattern = `ssh -F ${fixture.config}`
const sshPids = () =>
  spawnSync('pgrep', ['-f', sshPattern], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean)
    .map(Number)
const sshCount = () => sshPids().length
/** 把这次自检起的那几条 ssh 结束掉：先按假机器的配置文件找出进程号，再逐个发信号 */
const signalSsh = (signal) => {
  for (const pid of sshPids()) {
    try {
      process.kill(pid, signal)
    } catch {
      // 刚好退了
    }
  }
}

/**
 * 连上之后不放手；见到 onHolding 要等的那一行就调它。
 * 返回小工具打出来的每一行，以及从调 onHolding 到它报断开隔了多久（没报就是 null）
 */
function hold(alias, onHolding) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tool, JSON.stringify({ kind: 'alias', alias }), '--hold'],
      { env: toolEnv, stdio: ['ignore', 'pipe', 'inherit'] },
    )
    let stdout = ''
    let told = false
    let toldAt = 0
    let closedAfterMs = null
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`等了两分钟连接也没有自己断开：\n${stdout}`))
    }, 120_000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (!told && stdout.includes('"holding":true')) {
        told = true
        toldAt = Date.now()
        onHolding()
      }
      if (told && closedAfterMs === null && stdout.includes('"closed":')) {
        closedAfterMs = Date.now() - toldAt
      }
    })
    child.on('error', reject)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve({
        lines: stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
        closedAfterMs,
      })
    })
  })
}
const stepsOf = (lines) => lines.filter((line) => line.step).map((line) => line.step)
const resultOf = (lines) => lines.find((line) => line.result) ?? {}
const daemonPid = () =>
  existsSync(fixture.daemonPid) ? readFileSync(fixture.daemonPid, 'utf8') : null
/** 一个状态目录上的设备服务自己记下的进程号。没起过就是 null */
const servicePid = (state) => {
  try {
    return JSON.parse(readFileSync(join(state, 'device', 'service.json'), 'utf8')).pid ?? null
  } catch {
    return null
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
/** 一次连接里各步各花了多久（毫秒）：每一步从它报出来算到下一行出来 */
const spans = (lines) =>
  lines
    .filter((line) => line.step)
    .map((line) => {
      const next = lines[lines.indexOf(line) + 1]
      return `${line.step.replace('ssh.step.', '')} ${(next?.at ?? line.at) - line.at}`
    })
    .join('，')
/** 量到的耗时，最后一起打出来 */
const timings = []

const { aliases } = fixture
const passed = []
const check = async (name, body) => {
  await body()
  passed.push(name)
  console.log(`  ✓ ${name}`)
}

try {
  await check('从 ssh 配置里发现主机，并解析出地址、用户、端口', async () => {
    const [{ hosts }] = await run(['--discover'])
    assert.deepEqual(hosts.map((host) => host.alias).sort(), Object.values(aliases).sort())
    const ok = hosts.find((host) => host.alias === aliases.ok)
    assert.equal(ok.host, '127.0.0.1')
    assert.ok(ok.user && ok.port > 0)
  })

  await check('添加之前看一眼：只有 codex 的机器报出版本，不启动任何东西', async () => {
    const result = resultOf(await connect(aliases.ok, '--probe'))
    assert.equal(result.result, 'ok', JSON.stringify(result))
    assert.equal(result.peer, 'codex')
    assert.match(result.version, /^\d+\.\d+\.\d+/)
    assert.equal(daemonPid(), null, '只是看一眼，不该把服务起起来')
  })

  let pid = null
  await check('第一次连：服务不在，探测、启动、再接上，列出了会话', async () => {
    const lines = await connect(aliases.ok)
    const result = resultOf(lines)
    assert.equal(result.result, 'ok', JSON.stringify(lines))
    assert.deepEqual(stepsOf(lines), [
      'ssh.step.connect',
      'ssh.step.probe',
      'ssh.step.start',
      'ssh.step.connect',
    ])
    assert.ok(result.threads > 0, '没有列出会话')
    assert.equal(result.mode, 'single', '只有 codex 的机器该是单 harness 模式')
    pid = daemonPid()
    assert.ok(pid, '服务没有起来')
    timings.push(`只有 codex，第一次连：${spans(lines)}；到列出会话共 ${result.at}`)
  })

  await check('再连：上一条 ssh 断了服务还在，这次一条 ssh 直达，没有起第二份', async () => {
    const lines = await connect(aliases.ok)
    assert.equal(resultOf(lines).result, 'ok', JSON.stringify(lines))
    assert.deepEqual(stepsOf(lines), ['ssh.step.connect'])
    assert.equal(daemonPid(), pid)
    timings.push(`只有 codex，再连：到列出会话共 ${resultOf(lines).at}`)
  })

  await check('ssh 进程被结束：几秒内报断开，不用等心跳', async () => {
    // 连着试几次：出过问题的是 ssh 的退出和它标准输出的结束谁先被处理，哪一种先到不由这边定
    for (let round = 0; round < 6; round++) {
      const { lines, closedAfterMs } = await hold(aliases.ok, () => signalSsh('SIGTERM'))
      assert.ok(
        lines.find((line) => line.closed),
        `第 ${round + 1} 次：${JSON.stringify(lines)}`,
      )
      assert.ok(
        closedAfterMs !== null && closedAfterMs < 5_000,
        `发现得太慢了：${closedAfterMs} 毫秒`,
      )
    }
    assert.equal(daemonPid(), pid, '服务不该跟着没了')
  })

  await check('ssh 假死：心跳在一分钟内发现并断开，卡住的 ssh 被结束，服务不受影响', async () => {
    const started = Date.now()
    // 让那条 ssh 停住不动：连接还在，但什么都不再传
    const { lines } = await hold(aliases.ok, () => signalSsh('SIGSTOP'))
    const closed = lines.find((line) => line.closed)
    assert.ok(closed, JSON.stringify(lines))
    assert.match(closed.closed, /^connect\.heartbeat/)
    assert.ok(Date.now() - started < 60_000, '发现得太慢了')
    assert.equal(sshCount(), 0, '卡住的 ssh 还留着')
    assert.equal(daemonPid(), pid, '服务不该跟着没了')
    // 之后照样连得上
    assert.equal(resultOf(await connect(aliases.ok)).result, 'ok')
  })

  const fails = async (alias, stage, text, more = () => {}) => {
    const lines = await connect(alias)
    const result = resultOf(lines)
    assert.equal(result.result, 'failed', JSON.stringify(lines))
    assert.equal(result.stage, stage, JSON.stringify(result))
    assert.match(result.text, text)
    more(result, lines)
  }

  await check('什么都没装：给出“没有安装”和两条路的安装指引，不再自动重试', () =>
    fails(aliases.bare, 'notInstalled', /^remote\.notInstalled/, (result) => {
      assert.equal(result.retriable, false)
      assert.equal(result.guide, 'install')
    }),
  )

  await check('版本太低：说明现在的版本和至少要多少', () =>
    fails(aliases.old, 'outdated', /^remote\.outdated .*"version":"0\.98\.0"/, (result) => {
      assert.equal(result.retriable, false)
      assert.equal(result.guide, 'upgradeCodex')
    }),
  )

  await check('服务起不来：给出“启动失败”，详情里是服务自己的日志', () =>
    fails(aliases.nostart, 'startFailed', /^remote\.startFailed/, (result) =>
      assert.match(result.detail ?? '', /启动失败/),
    ),
  )

  await check('主机密钥没被信任：不自动接受，提示先在终端里连一次', () =>
    fails(aliases.untrusted, 'hostKey', /^ssh\.hostKeyUnknown/, (result, lines) => {
      assert.equal(result.retriable, false)
      // ssh 自己就没连上，后面的探测和启动都不该走
      assert.deepEqual(stepsOf(lines), ['ssh.step.connect'])
    }),
  )

  await check('认证没过：提示把密钥加进代理，这里不输入密码', () =>
    fails(aliases.denied, 'auth', /^ssh\.auth/, (result) => assert.equal(result.retriable, false)),
  )

  await check('主机连不上：归到“连不到”，之后会自己再试', () =>
    fails(aliases.down, 'unreachable', /^ssh\.unreachable/, (result) =>
      assert.equal(result.retriable, true),
    ),
  )

  // ---------- 装了适配器的机器：先找设备服务 ----------
  const { states } = fixture
  /** 完整模式：对面是设备服务的聚合面，上面有那份隔离的 Pi，声明了我们要用的那几项扩展 */
  const isFull = (result, lines) => {
    assert.equal(result.result, 'ok', JSON.stringify(lines))
    assert.equal(result.mode, 'full', JSON.stringify(result))
    assert.ok(result.harnesses.includes('pi:ready'), JSON.stringify(result.harnesses))
    for (const name of ['harness', 'deviceSettings', 'deviceProcesses', 'deviceWorkspaces']) {
      assert.ok(result.extensions.includes(name), `聚合面没有声明 ${name}`)
    }
  }

  await check('添加之前看一眼：装了适配器的机器报出设备服务和版本，不启动任何东西', async () => {
    const result = resultOf(await connect(aliases.svc, '--probe'))
    assert.equal(result.result, 'ok', JSON.stringify(result))
    assert.equal(result.peer, 'service')
    assert.match(result.version, /^\d+\.\d+\.\d+/)
    assert.equal(result.running, false)
    assert.equal(servicePid(states.svc), null, '只是看一眼，不该把服务起起来')
    assert.equal(existsSync(states.svc), false, '只是看一眼，不该在状态目录里留下东西')
  })

  let service = null
  await check(
    '装了适配器，第一次连：服务不在，探测、device-start、再接上，是完整模式',
    async () => {
      const lines = await connect(aliases.svc)
      const result = resultOf(lines)
      isFull(result, lines)
      assert.deepEqual(stepsOf(lines), [
        'ssh.step.connect',
        'ssh.step.probe',
        'ssh.step.startService',
        'ssh.step.connect',
      ])
      service = servicePid(states.svc)
      assert.ok(service && alive(service), '设备服务没有起来')
      timings.push(`设备服务，第一次连：${spans(lines)}；到列出会话共 ${result.at}`)
    },
  )

  await check('起服务的那条 ssh 早退了，服务还在；再连一条 ssh 直达，没有起第二份', async () => {
    // 拉起服务的那条 ssh 已经结束：服务是脱离出去的，不靠那次登录活着
    assert.equal(sshCount(), 0, '起服务的那条 ssh 还没退')
    assert.ok(alive(service), '那条 ssh 一退，服务跟着没了')
    const lines = await connect(aliases.svc)
    isFull(resultOf(lines), lines)
    assert.deepEqual(stepsOf(lines), ['ssh.step.connect'])
    assert.equal(servicePid(states.svc), service)
    timings.push(`设备服务，再连：到列出会话共 ${resultOf(lines).at}`)
  })

  await check('看一眼正在跑的设备服务：说得出上面有哪些 harness、各自能不能用', async () => {
    const result = resultOf(await connect(aliases.svc, '--probe'))
    assert.equal(result.peer, 'service', JSON.stringify(result))
    assert.equal(result.running, true)
    assert.ok(result.harnesses.includes('pi:ready'), JSON.stringify(result.harnesses))
    // 没装的也列出来：Claude Code 的命令行指到了不存在的地方，codex 不在服务的 PATH 里
    assert.ok(result.harnesses.includes('claude-code:unavailable'))
    assert.ok(result.harnesses.includes('codex:unavailable'))
    assert.equal(servicePid(states.svc), service)
    timings.push(`看一眼正在跑的设备服务（探测加问 harness，两条 ssh）：共 ${result.at}`)
  })

  await check('适配器和 codex 都有：连的是设备服务，不是 codex', async () => {
    const probed = resultOf(await connect(aliases.both, '--probe'))
    assert.equal(probed.peer, 'service', JSON.stringify(probed))
    const lines = await connect(aliases.both)
    isFull(resultOf(lines), lines)
    assert.deepEqual(stepsOf(lines), ['ssh.step.connect'])
    assert.equal(servicePid(states.svc), service, '不该另起一份')
  })

  await check('设备服务：ssh 进程被结束，几秒内报断开；服务不受影响，之后照样连得上', async () => {
    const { lines, closedAfterMs } = await hold(aliases.svc, () => signalSsh('SIGTERM'))
    assert.ok(
      lines.find((line) => line.closed),
      JSON.stringify(lines),
    )
    assert.ok(
      closedAfterMs !== null && closedAfterMs < 5_000,
      `发现得太慢了：${closedAfterMs} 毫秒`,
    )
    assert.ok(alive(service), '服务不该跟着没了')
    const again = await connect(aliases.svc)
    isFull(resultOf(again), again)
    assert.deepEqual(stepsOf(again), ['ssh.step.connect'])
  })

  await check(
    '命令只在默认的安装位置（~/.local/bin）、不在 PATH 里：照样找得到并连上',
    async () => {
      const probed = resultOf(await connect(aliases.svcHome, '--probe'))
      assert.equal(probed.peer, 'service', JSON.stringify(probed))
      const lines = await connect(aliases.svcHome)
      isFull(resultOf(lines), lines)
      const own = servicePid(states.path)
      assert.ok(own && alive(own) && own !== service, '这台“机器”该有它自己的那份服务')
    },
  )

  await check('对面装上了适配器：下一次连接自己换成设备服务；卸掉之后自己换回 codex', async () => {
    const before = await connect(aliases.grow)
    assert.equal(resultOf(before).mode, 'single', JSON.stringify(before))
    assert.equal(resultOf(await connect(aliases.grow, '--probe')).peer, 'codex')
    // 装上：什么都不用在这边改，再连一次就是设备服务
    writeFileSync(fixture.growFlag, '')
    assert.equal(resultOf(await connect(aliases.grow, '--probe')).peer, 'service')
    const after = await connect(aliases.grow)
    isFull(resultOf(after), after)
    assert.deepEqual(stepsOf(after), ['ssh.step.connect'], '认对面是什么不该多一趟往返')
    // 卸掉：服务还在跑着，但命令没了，连的又是 codex
    rmSync(fixture.growFlag)
    const back = await connect(aliases.grow)
    assert.equal(resultOf(back).mode, 'single', JSON.stringify(back))
    assert.deepEqual(stepsOf(back), ['ssh.step.connect'])
  })

  await check('有一份不带聚合面的旧服务在跑：说明要重启它，不停它、不另起、不自动重试', () =>
    fails(aliases.legacy, 'outdated', /^remote\.serviceLegacy/, (result, lines) => {
      assert.equal(result.retriable, false)
      assert.equal(result.guide, 'restartService')
      assert.match(result.detail ?? '', /不带聚合面/)
      assert.deepEqual(stepsOf(lines), [
        'ssh.step.connect',
        'ssh.step.probe',
        'ssh.step.startService',
      ])
      // 旧服务的状态目录里什么都没多：没有起设备进程，也没有留下锁和日志
      assert.equal(existsSync(join(states.legacy, 'device')), false, '动了旧服务的状态目录')
      assert.deepEqual(readdirSync(states.legacy), ['pi'])
    }),
  )

  await check('适配器太旧（没有设备服务，报不出版本）：说明要升级，不自动重试', () =>
    fails(aliases.svcOld, 'outdated', /^remote\.serviceTooOld/, (result, lines) => {
      assert.equal(result.retriable, false)
      assert.equal(result.guide, 'upgradeService')
      assert.match(result.detail ?? '', /未知命令/)
      // 探测就定下来了，不去启动
      assert.deepEqual(stepsOf(lines), ['ssh.step.connect', 'ssh.step.probe'])
    }),
  )

  await check('设备服务起不来：给出“启动失败”，详情里是它的原话，之后会自己再试', () =>
    fails(aliases.svcDown, 'startFailed', /^remote\.serviceStartFailed/, (result) => {
      assert.equal(result.retriable, true)
      assert.match(result.detail ?? '', /Node\.js/)
      assert.equal(servicePid(states.down), null)
    }),
  )

  await check('设备配置和侧栏快照：存得下、读得回、删得掉，文件只有自己能读', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'litch-store-'))
    try {
      const [out] = await run(['--store', dir])
      assert.deepEqual(out.empty, { localWire: null, remotes: [] })
      assert.deepEqual(out.saved, {
        localWire: 'violet',
        remotes: [
          {
            id: 'ssh-1',
            name: '构建机',
            target: { kind: 'alias', alias: 'build-01' },
            wire: 'blue',
          },
        ],
      })
      assert.equal(out.before, null)
      assert.deepEqual(out.threads, ['t1'])
      assert.equal(out.forgotten, null)
      assert.deepEqual(readdirSync(dir).sort(), ['devices.json', 'snapshots'])
      assert.deepEqual(readdirSync(join(dir, 'snapshots')), [])
      assert.equal(statSync(join(dir, 'devices.json')).mode & 0o077, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  assert.equal(sshCount(), 0, '自检结束时还有 ssh 没退')
  console.log(`量到的耗时（毫秒，回环上的假远程机器）：\n  ${timings.join('\n  ')}`)
  console.log(`远程连接的自检通过：${passed.length} 项`)
} catch (error) {
  console.error(`远程连接的自检没过（已通过 ${passed.length} 项）：\n${error?.stack ?? error}`)
  process.exitCode = 1
} finally {
  await fixture.stop()
}
