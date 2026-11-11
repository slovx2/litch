// 显式真实模型验收：仅传公开的回环表单、工具合同与工具结果，浏览器使用隔离 HOME/profile。
// AUTOMATION_MODEL_KEY / AUTOMATION_MODEL_URL / AUTOMATION_MODEL 必须由调用者提供，不读个人配置。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { registerAutomationGuide } from '../packages/device/dist/device/src/automation-guide.mjs'
import { browserToolsSpec } from '../packages/device/dist/protocol/src/client-tools-browser.mjs'
import {
  resolveAutomationTools,
  withAutomationGuide,
} from '../packages/device/dist/shared/src/automation-tools.mjs'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const home = realpathSync(mkdtempSync(join(tmpdir(), 'litch-skill-model-')))
const model = process.env.AUTOMATION_MODEL,
  base = process.env.AUTOMATION_MODEL_URL,
  key = process.env.AUTOMATION_MODEL_KEY
assert.ok(model && base && key, '必须显式提供验收模型、接口和凭据')
const require = createRequire(join(root, 'third_party/litch-automation/package.json'))
const { build } = require('esbuild')
const electron = createRequire(
  join(root, 'third_party/litch-automation/packages/browser/package.json'),
)('electron')
let child
try {
  const entry = join(home, 'browser.mjs')
  await build({
    entryPoints: [join(root, 'scripts/fixtures/automation-skills-browser.mts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['electron'],
  })
  child = spawn(electron, withChromiumTestArgs([entry]), {
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: home,
      BROWSER_FIXTURE_PROFILE: join(home, 'profile'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let id = 0,
    ready
  const pending = new Map()
  let stderr = ''
  child.stderr.on('data', (c) => (stderr += c))
  const site = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`浏览器启动超时：${stderr.slice(-1500)}`)), 30000)
    ready = (value) => {
      clearTimeout(timer)
      resolve(value)
    }
    child.once('exit', () => {
      clearTimeout(timer)
      reject(Error(stderr.slice(-1500)))
    })
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m.ready) ready(m.ready)
    const p = pending.get(m.id)
    if (p) {
      pending.delete(m.id)
      clearTimeout(p.timer)
      m.error ? p.reject(Error(m.error)) : p.resolve(m.result)
    }
  })
  const callBrowser = (params) =>
    new Promise((resolve, reject) => {
      const k = ++id,
        timer = setTimeout(() => {
          pending.delete(k)
          reject(Error('browser timeout'))
        }, 30000)
      pending.set(k, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ id: k, params }) + '\n')
    })
  let guide
  registerAutomationGuide({
    register(_name, handler) {
      guide = handler
    },
  })
  const namespaces = resolveAutomationTools(withAutomationGuide([browserToolsSpec(true)]), 'acp', {
    env: { HOME: home },
  })
  const specs = namespaces.flatMap((ns) =>
    ns.tools.map((t, i) => ({
      type: 'function',
      function: {
        name: `${ns.name}__${t.name}`,
        description: `[${ns.name}.${t.name}] ${i === 0 ? ns.description + '\n' : ''}${t.description}`,
        parameters: t.inputSchema,
      },
    })),
  )
  const url = await site
  console.error('隔离浏览器已启动')
  const messages = [
    {
      role: 'system',
      content:
        'You operate the available tools to complete the task. Follow their descriptions. The local fixture form and its submission are authorized.',
    },
    {
      role: 'user',
      content: `Open ${url} in the browser, enter Ada in the Name field, click Save, and verify the saved result.`,
    },
  ]
  const calls = [],
    usage = []
  let final = '',
    saved = false
  for (let step = 0; step < 18; step++) {
    console.error(`模型请求 ${step + 1}`)
    const response = await fetch(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        tools: specs,
        max_tokens: 2048,
        temperature: 0,
        thinking: { type: 'disabled' },
      }),
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) throw Error(`模型接口 HTTP ${response.status}`)
    const body = await response.json(),
      answer = body.choices?.[0]?.message
    assert.ok(answer, '模型未返回消息')
    usage.push(body.usage)
    messages.push(answer)
    if (!answer.tool_calls?.length) {
      final = answer.content ?? ''
      break
    }
    for (const call of answer.tool_calls) {
      const [namespace, tool] = call.function.name.split('__'),
        args = JSON.parse(call.function.arguments)
      calls.push(`${namespace}.${tool}`)
      console.error(`工具 ${namespace}.${tool}`)
      const result =
        namespace === 'litch_automation'
          ? await guide(
              {
                harness: 'acp',
                threadId: 'fixture',
                turnId: 't',
                callId: call.id,
                namespace,
                tool,
                arguments: args,
              },
              { signal: new AbortController().signal },
            )
          : await callBrowser({ namespace, tool, arguments: args })
      const text =
        result.contentItems
          ?.filter((c) => c.type === 'inputText')
          .map((c) => c.text)
          .join('\n') ?? JSON.stringify(result)
      if (/Saved Ada/.test(text)) saved = true
      messages.push({ role: 'tool', tool_call_id: call.id, content: text })
    }
  }
  const firstAction = calls.findIndex((n) => n.startsWith('litch_browser.'))
  const firstGuide = calls.indexOf('litch_automation.guide')
  console.log(
    JSON.stringify(
      {
        model,
        calls,
        readBeforeAction: firstGuide >= 0 && firstGuide < firstAction,
        saved,
        final,
        usage,
      },
      null,
      2,
    ),
  )
  assert.ok(saved, '模型未核实 Saved Ada')
} finally {
  if (child && child.exitCode === null) {
    child.stdin.end()
    await new Promise((r) => {
      child.once('exit', r)
      setTimeout(() => {
        child.kill('SIGKILL')
        r()
      }, 3000).unref()
    })
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
