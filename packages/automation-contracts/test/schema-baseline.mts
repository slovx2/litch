// 工具 schema 基线：只记各套定义序列化后的 SHA-256，不记提交号。
// 工具说明、参数或指令是有意改的，就运行 npm run update:automation-baseline 重录，并在提交说明里写清改了什么；
// 测试失败而你没打算改工具，说明改动波及了模型看到的定义，先查原因，不要重录。
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  browserToolsSpec,
  computerToolsSpec,
  portableComputerTools,
  SIGN_IN_FILL_FAILURES,
} from '../src/litch/index.mjs'

export const BASELINE_FILE = new URL('./litch-schema-baseline.json', import.meta.url)

export interface SchemaBaseline {
  sha256: Record<string, string>
}

export function schemaSources(): Record<string, unknown> {
  return {
    browser: browserToolsSpec(),
    browserBatch: browserToolsSpec(true),
    mac: computerToolsSpec('darwin'),
    macBatch: computerToolsSpec('darwin', true),
    windows: computerToolsSpec('win32'),
    windowsBatch: computerToolsSpec('win32', true),
    portable: portableComputerTools(),
    signInFailures: SIGN_IN_FILL_FAILURES,
  }
}

export function schemaHashes(sources = schemaSources()): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sources).map(([name, value]) => [
      name,
      createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    ]),
  )
}

export function readBaseline(): SchemaBaseline {
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as SchemaBaseline
}

export function writeBaseline(): SchemaBaseline {
  const baseline: SchemaBaseline = { sha256: schemaHashes() }
  writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`)
  return baseline
}
