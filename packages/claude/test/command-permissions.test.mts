import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

const full = { sandboxPolicy: { type: 'dangerFullAccess' } }

test('PERMISSION-command：只读、工作区边界和网络限制实际生效', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-command-permission-'))
  const model = new MockLLM()
  const url = await model.start()
  const client = await ProtocolClient.start(home, url)
  try {
    const result = await client.request('command/exec', {
      cwd: home,
      command: ['/bin/sh', '-c', 'printf forbidden > readonly.txt'],
      sandboxPolicy: { type: 'readOnly' },
    })
    assert.notEqual(result.exitCode, 0)
    await assert.rejects(access(join(home, 'readonly.txt')))
    const workspace = join(home, 'workspace')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(workspace)
    const workspacePolicy = {
      type: 'workspaceWrite',
      writableRoots: [workspace],
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
      networkAccess: false,
    }
    const inside = await client.request('command/exec', {
      cwd: workspace,
      command: ['/bin/sh', '-c', 'printf permitted > inside.txt'],
      sandboxPolicy: workspacePolicy,
    })
    assert.equal(inside.exitCode, 0, inside.stderr)
    assert.equal(await readFile(join(workspace, 'inside.txt'), 'utf8'), 'permitted')
    const outside = await client.request('command/exec', {
      cwd: workspace,
      command: ['/bin/sh', '-c', 'printf forbidden > ../outside.txt'],
      sandboxPolicy: workspacePolicy,
    })
    assert.notEqual(outside.exitCode, 0)
    await assert.rejects(access(join(home, 'outside.txt')))
    // 只访问本机 Mock 端口；禁网必须在操作系统层失败。
    const connect = `require('node:http').get(${JSON.stringify(url + '/api/hello')},()=>process.exit(0)).on('error',()=>process.exit(42)); setTimeout(()=>process.exit(43),2000)`
    const reachable = await client.request('command/exec', {
      ...full,
      cwd: workspace,
      command: [process.execPath, '-e', connect],
    })
    assert.equal(reachable.exitCode, 0, reachable.stderr)
    const network = await client.request('command/exec', {
      cwd: workspace,
      command: [process.execPath, '-e', connect],
      sandboxPolicy: workspacePolicy,
    })
    assert.equal(network.exitCode, 42, network.stderr)
    const unknown = await client.raw('command/exec', {
      cwd: home,
      command: ['/bin/sh', '-c', 'touch unsafe'],
      permissionProfile: 'unrecognized',
    })
    assert.equal(unknown.error.code, -32602)
    await assert.rejects(access(join(home, 'unsafe')))
    assert.equal(model.requests.length, 0)
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})
