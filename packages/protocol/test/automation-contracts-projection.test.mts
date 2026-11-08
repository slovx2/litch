import assert from 'node:assert/strict'
import { test } from 'node:test'
import { negotiateChromeWire } from '../../../third_party/litch-automation/packages/automation-contracts/src/litch/index.mjs'
import {
  readBaseline,
  schemaHashes,
  schemaSources,
} from '../../../third_party/litch-automation/packages/automation-contracts/test/schema-baseline.mjs'
import { negotiateChromeWire as projectedWire } from '../src/chrome-browser.mjs'
import {
  browserToolsSpec as projectedBrowser,
  SIGN_IN_FILL_FAILURES as projectedFailures,
} from '../src/client-tools-browser.mjs'
import { computerToolsSpec as projectedComputer } from '../src/client-tools-computer.mjs'
import { portableComputerTools as projectedPortable } from '../src/client-tools-computer-portable.mjs'

const baseline = readBaseline()
const source = schemaSources()
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

// 基线只认哈希（说明见 schema-baseline.mts）。有意改工具定义时用 npm run update:automation-baseline 重录。
test('全部平台/批量/portable 的 schema、说明和指令与基线逐字相同，投影与唯一源一致', () => {
  assert.deepEqual(Object.keys(baseline), ['sha256'], '基线只记哈希，不记提交号等会过时的字段')
  assert.deepEqual(Object.keys(source).sort(), Object.keys(baseline.sha256).sort())
  const hashes = schemaHashes(source)
  const changed = Object.keys(hashes).filter((name) => hashes[name] !== baseline.sha256[name])
  assert.deepEqual(
    changed,
    [],
    `工具定义与基线不同：${changed.join('、')}。有意修改就运行 npm run update:automation-baseline 并在提交说明里写清改了什么；否则先查是什么改动波及了工具定义。`,
  )
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
