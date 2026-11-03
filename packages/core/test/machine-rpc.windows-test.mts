// Windows 上用正式的 process/*、fs/* 跑执行器；不启动 harness，不使用模型或个人配置。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FilesystemRpc } from '../../shared/src/filesystem-rpc.mjs'
import { ProcessRpc } from '../../shared/src/process-rpc.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { createMachineExecutor } from '../src/device/machine/executor.mjs'
import { sensitivePresets } from '../src/device/machine/presets.mjs'
import type {
  MachineApprovalRequest,
  MachineCallContext,
  MachineFacts,
  MachineTarget,
} from '../src/device/machine/types.mjs'
import { windowsShortPath } from './machine-windows-fixture.mjs'

assert.equal(process.platform, 'win32', 'Windows 原生用例必须在 Windows 上执行')

test('Windows 正式执行链：读写复制、范围、中文、停止及全部停止整棵树', {
  timeout: 180_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'litch-machine-rpc-'))
  const facts: MachineFacts = {
    name: '隔离桌面',
    hostname: 'fixture',
    system: 'Windows',
    user: 'fixture',
    home: root,
    shell: 'powershell.exe',
  }
  const processes = new ProcessRpc((command) => command)
  const files = new FilesystemRpc()
  const listeners = new Set<(method: string, params: unknown) => boolean>()
  const peer: RpcPeer = {
    id: 'machine-windows-fixture',
    close() {},
    send(message) {
      if ('method' in message)
        for (const listener of listeners) listener(message.method, message.params)
    },
  }
  const isolated = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: join(root, '.codex'),
    CLAUDE_CONFIG_DIR: join(root, '.claude'),
    APPDATA: join(root, 'AppData/Roaming'),
    LOCALAPPDATA: join(root, 'AppData/Local'),
  }
  const dispatch = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'process/spawn')
      return processes.start(peer, 'process', {
        ...params,
        env: { ...isolated, ...((params.env as object) ?? {}) },
      })
    if (method === 'process/writeStdin') return processes.followup(peer, 'process', 'write', params)
    if (method === 'process/kill') return processes.followup(peer, 'process', 'kill', params)
    return files.call(peer, method, params)
  }
  const desktop: MachineTarget = {
    id: 'desktop',
    role: 'desktop',
    facts: async () => facts,
    request: dispatch as MachineTarget['request'],
    onProcessNotification(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  // 这里验证复制两端各自选命令；跨 SSH 的远程会话另在真实窗口验收。
  const session: MachineTarget = { ...desktop, id: 'session', role: 'session' }
  const asks: MachineApprovalRequest[] = []
  const context: MachineCallContext = {
    owner: { deviceId: 'fixture', threadId: 'a', harness: 'pi' },
    target: (id) => (id === 'desktop' ? desktop : id === 'session' ? session : null),
    targets: () => [desktop, session],
    policy: { mode: 'sensitive', denied: sensitivePresets(facts) },
    settings: { approval: 'each', access: 'sensitive' },
    approve: async (request) => {
      asks.push(request)
      return { kind: 'allowed' }
    },
    signal: new AbortController().signal,
    log() {},
  }
  const executor = createMachineExecutor({
    clock: {
      now: Date.now,
      setTimer: (callback, ms) => {
        const timer = setTimeout(callback, ms)
        return () => clearTimeout(timer)
      },
    },
  })
  const call = async (tool: string, args: object, success = true): Promise<string> => {
    const result = await executor.call(tool, args, context)
    const text = result.contentItems
      .map((one) => (one.type === 'inputText' ? one.text : ''))
      .join('\n')
    assert.equal(result.success, success, text)
    return text
  }
  const until = async (check: () => boolean): Promise<void> => {
    const end = Date.now() + 10_000
    while (!check()) {
      assert.ok(Date.now() < end, '等待进程树退出超时')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const startTree = async (): Promise<{ id: string; child: number }> => {
    const text = await call('exec', {
      command:
        "$child = Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep 120' -PassThru; Write-Output ('child:' + $child.Id); Start-Sleep 120",
      yield_ms: 1000,
      timeout_ms: 120_000,
    })
    const id = /process_id: (p\d+)/.exec(text)?.[1]
    assert.ok(id, text)
    let output = text
    const end = Date.now() + 10_000
    while (!/child:\d+/.test(output) && Date.now() < end)
      output += await call('process', { process_id: id, action: 'read', wait_ms: 1000 })
    const child = Number(/child:(\d+)/.exec(output)?.[1])
    assert.ok(child > 0, output)
    assert.equal(alive(child), true)
    return { id, child }
  }
  try {
    for (const directory of Object.values(isolated)) mkdirSync(directory, { recursive: true })
    const path = join(root, '中文 空格', "a'文件.txt")
    await call('write_file', { path, content: '第一行\r\n第二行😀\n' })
    await call('write_file', { path, mode: 'append', content: '追加' })
    assert.equal(readFileSync(path, 'utf8'), '第一行\r\n第二行😀\n追加')
    assert.match(await call('read_file', { path }), /第一行\r\n第二行😀\n追加/)
    assert.ok(asks.some((ask) => ask.ask.path?.includes("a'文件.txt")))
    assert.match(await call('list_dir', { path: root }), /中文 空格/)
    const commandOutput = await call('exec', {
      command: "Write-Output '中文输出😀'; [Console]::Error.WriteLine('错误输出')",
    })
    assert.match(commandOutput, /中文输出😀/)
    assert.match(commandOutput, /错误输出/)
    assert.doesNotMatch(commandOutput, /CLIXML|<Objs|litch-pid|�/)
    const secret = join(root, '.ssh', 'key')
    mkdirSync(join(root, '.ssh'))
    writeFileSync(secret, 'secret')
    assert.match(await call('read_file', { path: secret }, false), /\[litch:blocked\]/)
    assert.match(
      await call('read_file', { path: `${windowsShortPath(root)}/.SSH/key` }, false),
      /\[litch:blocked\]/,
    )
    context.policy = { mode: 'custom', denied: [join(root, '中文 空格')] }
    assert.match(await call('read_file', { path }, false), /\[litch:blocked\]/)
    context.policy = { mode: 'open', denied: [] }
    assert.match(await call('read_file', { path: secret }), /secret/)
    // 用真正的短名或 junction 定义禁止规则，验证正式入口的读写、目录和复制都守住同一范围。
    const aliasSource = join(root, 'Alias Source Directory')
    const denied = join(aliasSource, 'Confidential Directory')
    const junction = join(root, 'Forbidden Junction')
    mkdirSync(denied, { recursive: true })
    writeFileSync(join(denied, 'credential.txt'), 'fixture-secret')
    writeFileSync(join(aliasSource, 'public.txt'), 'fixture-public')
    symlinkSync(denied, junction, 'junction')
    for (const [index, rule] of [windowsShortPath(denied).toLowerCase(), junction].entries()) {
      context.policy = { mode: 'custom', denied: [rule] }
      const count = asks.length
      for (const deniedPath of [
        join(denied, 'credential.txt'),
        `${windowsShortPath(denied)}/credential.txt`,
      ]) {
        assert.match(await call('read_file', { path: deniedPath }, false), /\[litch:blocked\]/)
        assert.match(
          await call('write_file', { path: deniedPath, mode: 'append', content: 'bad' }, false),
          /\[litch:blocked\]/,
        )
      }
      assert.match(
        await call('write_file', { path: join(junction, 'new.txt'), content: 'bad' }, false),
        /\[litch:blocked\]/,
      )
      assert.match(
        await call(
          'copy',
          {
            from: { machine: 'desktop', path: join(denied, 'credential.txt') },
            to: { machine: 'session', path: join(root, `leak-${index}`) },
          },
          false,
        ),
        /\[litch:blocked\]/,
      )
      assert.match(
        await call(
          'copy',
          {
            from: { machine: 'session', path: join(aliasSource, 'public.txt') },
            to: { machine: 'desktop', path: join(junction, 'new.txt') },
          },
          false,
        ),
        /\[litch:blocked\]/,
      )
      assert.equal(asks.length, count, '被禁止的操作不能进入审批')
      const listed = await call('list_dir', { path: windowsShortPath(aliasSource), depth: 3 })
      assert.doesNotMatch(listed, /credential\.txt/)
      assert.match(listed, /public\.txt/)
      const destAlias = join(root, `export-${index}`)
      assert.match(
        await call('copy', {
          from: { machine: 'desktop', path: aliasSource },
          to: { machine: 'session', path: destAlias },
        }),
        /blocked locations/,
      )
      assert.equal(readFileSync(join(destAlias, 'public.txt'), 'utf8'), 'fixture-public')
      assert.throws(() => readFileSync(join(destAlias, 'Confidential Directory/credential.txt')), {
        code: 'ENOENT',
      })
      assert.equal(readFileSync(join(denied, 'credential.txt'), 'utf8'), 'fixture-secret')
      assert.throws(() => readFileSync(join(denied, 'new.txt')), { code: 'ENOENT' })
    }
    context.policy = { mode: 'open', denied: [] }
    // 目录根可写，但复制不能覆盖其中的自定义禁止子目录。
    const tree = join(root, 'source-tree')
    const targetDir = join(root, 'target-tree')
    mkdirSync(join(tree, 'private'), { recursive: true })
    mkdirSync(targetDir)
    writeFileSync(join(tree, 'private/key'), 'blocked')
    writeFileSync(join(tree, 'ok'), 'allowed')
    context.policy = { mode: 'custom', denied: [join(targetDir, 'source-tree/private')] }
    assert.match(
      await call('copy', {
        from: { machine: 'session', path: tree },
        to: { machine: 'desktop', path: targetDir },
      }),
      /blocked locations/,
    )
    assert.equal(readFileSync(join(targetDir, 'source-tree/ok'), 'utf8'), 'allowed')
    assert.throws(() => readFileSync(join(targetDir, 'source-tree/private/key')), {
      code: 'ENOENT',
    })
    context.policy = { mode: 'open', denied: [] }
    const big = Buffer.alloc(4 * 1024 * 1024 + 19)
    for (let at = 0; at < big.length; at++) big[at] = at % 251
    const source = join(root, 'binary.bin')
    const dest = join(root, 'copy.bin')
    writeFileSync(source, big)
    await call('copy', {
      from: { machine: 'desktop', path: source },
      to: { machine: 'session', path: dest },
    })
    assert.deepEqual(readFileSync(dest), big)
    const one = await startTree()
    assert.equal(executor.kill(one.id), true)
    await until(() => !alive(one.child))
    const two = await startTree()
    const three = await startTree()
    executor.stopAll()
    await until(() => !alive(two.child) && !alive(three.child))
    assert.deepEqual(executor.processes(), [])
  } finally {
    executor.dispose()
    await processes.close()
    rmSync(root, { recursive: true, force: true })
  }
})
