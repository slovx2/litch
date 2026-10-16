import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { mergeMcpConfig, readMcpConfig } from '../src/mcp.mjs'
import { sdkMcpServers } from '../src/mcp-config.mjs'

test('用户级 MCP 与任务请求头合并，保留连接、凭据和其他服务', () => {
  const base = {
    chrome: {
      type: 'http',
      url: 'http://127.0.0.1:8931/mcp',
      timeout: 120000,
      headers: { Authorization: 'Bearer isolated-token' },
    },
    other: { command: 'example' },
  }
  const merged = mergeMcpConfig(base, {
    chrome: { http_headers: { 'X-Tyrs-Browser-Task-Id': 'task-id' } },
  })
  const sdk = sdkMcpServers(merged)
  assert.deepEqual(sdk.chrome.headers, {
    Authorization: 'Bearer isolated-token',
    'X-Tyrs-Browser-Task-Id': 'task-id',
  })
  assert.equal(sdk.chrome.timeout, 120000)
  assert.equal(sdk.chrome.url, base.chrome.url)
  assert.equal(sdk.other.command, 'example')
  assert.deepEqual(base.chrome.headers, { Authorization: 'Bearer isolated-token' })
  assert.equal(sdkMcpServers(mergeMcpConfig(base, { chrome: {} })).chrome.url, base.chrome.url)
})

test('读取原生用户配置、显式覆盖并隐藏解析错误中的秘密', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-user-config-'))
  const previousDir = process.env.CLAUDE_CONFIG_DIR
  const previousServers = process.env.CHA_CLAUDE_MCP_SERVERS
  process.env.CLAUDE_CONFIG_DIR = dir
  delete process.env.CHA_CLAUDE_MCP_SERVERS
  try {
    assert.deepEqual(readMcpConfig(), {})
    writeFileSync(
      join(dir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          chrome: {
            type: 'http',
            url: 'http://127.0.0.1:8931/mcp',
            headers: { Authorization: 'Bearer native' },
          },
        },
      }),
    )
    process.env.CHA_CLAUDE_MCP_SERVERS = JSON.stringify({
      chrome: { headers: { 'X-Test': 'explicit' } },
    })
    const sdk = sdkMcpServers(readMcpConfig())
    assert.equal(sdk.chrome.headers.Authorization, 'Bearer native')
    assert.equal(sdk.chrome.headers['X-Test'], 'explicit')
    writeFileSync(join(dir, '.claude.json'), '{"secret":"do-not-print",invalid')
    assert.throws(
      () => readMcpConfig(),
      (error: any) => {
        assert.equal(error.message, '用户级 MCP 配置读取失败')
        return true
      },
    )
  } finally {
    if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousDir
    if (previousServers === undefined) delete process.env.CHA_CLAUDE_MCP_SERVERS
    else process.env.CHA_CLAUDE_MCP_SERVERS = previousServers
    rmSync(dir, { recursive: true, force: true })
  }
})
