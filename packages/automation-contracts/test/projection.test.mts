import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { negotiateChromeWire as projectedWire } from '../../protocol/src/chrome-browser.mjs'
import {
  browserToolsSpec as projectedBrowser,
  SIGN_IN_FILL_FAILURES as projectedFailures,
} from '../../protocol/src/client-tools-browser.mjs'
import { computerToolsSpec as projectedComputer } from '../../protocol/src/client-tools-computer.mjs'
import { portableComputerTools as projectedPortable } from '../../protocol/src/client-tools-computer-portable.mjs'
import {
  browserToolsSpec,
  computerToolsSpec,
  negotiateChromeWire,
  portableComputerTools,
  SIGN_IN_FILL_FAILURES,
} from '../src/litch/index.mjs'

const baseline = JSON.parse(
  readFileSync(new URL('./litch-schema-baseline.json', import.meta.url), 'utf8'),
) as { commit: string; sha256: Record<string, string> }
const source = {
  browser: browserToolsSpec(),
  browserBatch: browserToolsSpec(true),
  mac: computerToolsSpec('darwin'),
  macBatch: computerToolsSpec('darwin', true),
  windows: computerToolsSpec('win32'),
  windowsBatch: computerToolsSpec('win32', true),
  portable: portableComputerTools(),
  signInFailures: SIGN_IN_FILL_FAILURES,
}
const projected = {
  browser: projectedBrowser(),
  browserBatch: projectedBrowser(true),
  mac: projectedComputer('darwin'),
  macBatch: projectedComputer('darwin', true),
  windows: projectedComputer('win32'),
  windowsBatch: projectedComputer('win32', true),
  portable: projectedPortable(),
  signInFailures: projectedFailures,
}

// 基线取自最近一次反合的 main 提交里 protocol 的定义；反合带来 schema 变化时，先核对与 main 逐字相同再更新。
test('全部平台/批量/portable 的 schema、说明和指令与 main 基线逐字相同', () => {
  assert.equal(baseline.commit, 'f52180dbc96584f414db3f48725b27c375ed85d5')
  assert.deepEqual(Object.keys(source).sort(), Object.keys(baseline.sha256).sort())
  for (const [name, value] of Object.entries(source)) {
    assert.equal(
      createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      baseline.sha256[name],
      name,
    )
  }
  assert.deepEqual(projected, source)
})

test('协议投影保持 Chrome 协商范围而非产品版本相等判定', () => {
  for (const peer of [
    { protocol: 1, minProtocol: 1 },
    { protocol: 2, minProtocol: 1 },
    { protocol: 2, minProtocol: 2 },
  ]) {
    assert.deepEqual(projectedWire(peer), negotiateChromeWire(peer))
  }
})
