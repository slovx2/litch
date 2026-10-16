import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { ProtocolError, submissionHash } from './protocol-contract.mjs'

export type ConfigValues = Record<string, unknown>

export function isConfigObject(value: unknown): value is ConfigValues {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function readConfigFile(path: string): { values: ConfigValues; version: string } {
  let document: unknown
  try {
    document = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    document = {}
  }
  if (
    !isConfigObject(document) ||
    (document.overrides != null && !isConfigObject(document.overrides))
  )
    throw new Error('适配器配置文件格式无效')
  const values: ConfigValues = { ...((document.overrides as ConfigValues | undefined) ?? {}) }
  for (const key of ['model', 'model_reasoning_effort'])
    if (Object.hasOwn(document, key)) values[key] = document[key]
  return { values, version: submissionHash(document) }
}

export function validateConfigTarget(params: ConfigValues, path: string): void {
  if (
    params.filePath != null &&
    (typeof params.filePath !== 'string' ||
      !isAbsolute(params.filePath) ||
      resolve(params.filePath) !== resolve(path))
  )
    throw new ProtocolError(-32602, '只能写入当前 Claude 运行时的配置文件')
  if (params.expectedVersion != null && typeof params.expectedVersion !== 'string')
    throw new ProtocolError(-32602, 'expectedVersion 必须是字符串')
  if (params.reloadUserConfig != null && typeof params.reloadUserConfig !== 'boolean')
    throw new ProtocolError(-32602, 'reloadUserConfig 必须是布尔值')
}

function keySegments(key: unknown): string[] {
  if (typeof key !== 'string' || !key.length)
    throw new ProtocolError(-32602, 'keyPath 必须是非空字符串')
  // 支持 TOML 风格的引号键；禁止原型键，不能让客户端修改对象原型。
  const segments: string[] = []
  let offset = 0
  while (offset < key.length) {
    const match = /^(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)/.exec(key.slice(offset))
    if (!match) throw new ProtocolError(-32602, 'keyPath 格式无效')
    const token = match[0]
    let segment: string
    try {
      segment = token.startsWith('"') ? JSON.parse(token) : token
    } catch {
      throw new ProtocolError(-32602, 'keyPath 引号无效')
    }
    if (['__proto__', 'prototype', 'constructor'].includes(segment))
      throw new ProtocolError(-32602, 'keyPath 含有禁止的键')
    segments.push(segment)
    offset += token.length
    if (offset === key.length) break
    if (key[offset++] !== '.' || offset === key.length)
      throw new ProtocolError(-32602, 'keyPath 格式无效')
  }
  return segments
}

function mergeConfig(previous: unknown, next: unknown): unknown {
  if (!isConfigObject(previous) || !isConfigObject(next)) return structuredClone(next)
  const result = structuredClone(previous)
  for (const [key, value] of Object.entries(next)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key))
      throw new ProtocolError(-32602, '配置含有禁止的键')
    result[key] = mergeConfig(result[key], value)
  }
  return result
}

export function applyConfigEdits(
  values: ConfigValues,
  params: ConfigValues,
  batch: boolean,
): ConfigValues {
  const edits = batch ? params.edits : [params]
  if (!Array.isArray(edits)) throw new ProtocolError(-32602, 'edits 必须是数组')
  const result = structuredClone(values)
  for (const edit of edits) {
    if (
      !isConfigObject(edit) ||
      !Object.hasOwn(edit, 'value') ||
      (edit.mergeStrategy !== 'replace' && edit.mergeStrategy !== 'upsert')
    )
      throw new ProtocolError(-32602, '配置编辑必须包含 keyPath、value 和有效 mergeStrategy')
    const segments = keySegments(edit.keyPath)
    const last = segments.pop()!
    let target = result
    for (const segment of segments) {
      if (!Object.hasOwn(target, segment)) target[segment] = {}
      if (!isConfigObject(target[segment]))
        throw new ProtocolError(-32602, 'keyPath 的父键不是对象')
      target = target[segment] as ConfigValues
    }
    if (edit.value === null) delete target[last]
    else
      target[last] =
        edit.mergeStrategy === 'upsert'
          ? mergeConfig(target[last], edit.value)
          : structuredClone(edit.value)
  }
  return result
}

export function writeConfigFile(
  path: string,
  values: ConfigValues,
  expectedVersion: unknown,
): string {
  const before = readConfigFile(path)
  if (expectedVersion != null && expectedVersion !== before.version)
    throw new ProtocolError(-32009, '配置已变化，请重新读取后提交')
  const { model, model_reasoning_effort, ...overrides } = values
  const document = {
    ...(model == null ? {} : { model }),
    ...(model_reasoning_effort == null ? {} : { model_reasoning_effort }),
    overrides,
  }
  const temporary = path + '.' + randomUUID() + '.tmp'
  mkdirSync(dirname(path), { recursive: true })
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, JSON.stringify(document, null, 2) + String.fromCharCode(10))
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
  }
  return submissionHash(document)
}
