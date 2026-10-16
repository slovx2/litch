// 测试用的客户端和搭设备的小工具。客户端不经套接字，直接接在设备进程的 attach 上。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ajv } from 'ajv'
import { WebSocket } from 'ws'
import { type DeviceOptions, DeviceServer } from '../src/device.mjs'
import type { SessionTiming } from '../src/session.mjs'
import type { Frame, Wire, WireHandlers } from '../src/wire.mjs'
import type { FakeUpstream } from './fake-upstream.mjs'

/** 套接字路径有长度上限，临时目录的名字要短 */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ld-'))
}

export interface Failure {
  code: number
  message: string
  data?: any
}

export class TestClient {
  /** 收到的通知，按到达顺序 */
  readonly notifications: Frame[] = []
  /** 对面发来、要答复的请求 */
  readonly requests: Frame[] = []
  /** 收到的每一帧的原文 */
  readonly raw: string[] = []
  closed = false
  private readonly handlers: WireHandlers
  private readonly pending = new Map<
    string,
    { resolve(value: any): void; reject(error: Failure): void }
  >()
  private readonly waiters = new Set<(frame: Frame) => boolean>()
  private nextId = 1

  /** 给设备就直接接在它的 attach 上；给一个接法就按那个接（经真的套接字时用） */
  constructor(target: DeviceServer | ((wire: Wire) => WireHandlers)) {
    const attach = typeof target === 'function' ? target : (wire: Wire) => target.attach(wire)
    this.handlers = attach({
      send: (text) => queueMicrotask(() => this.receive(text)),
      close: () => {
        this.closed = true
      },
    })
  }

  /** 经 unix 套接字上的 WebSocket 连到聚合面，和真的客户端走同一条路 */
  static async overSocket(path: string): Promise<TestClient> {
    const ws = new WebSocket(`ws+unix://${path}:/`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    const client = new TestClient((wire) => {
      ws.on('message', (data) => wire.send(data.toString()))
      ws.once('close', () => wire.close())
      return { message: (text) => ws.send(text), close: () => ws.close() }
    })
    return client
  }

  private receive(text: string): void {
    this.raw.push(text)
    const frame = JSON.parse(text) as Frame
    if (typeof frame.method !== 'string') {
      const entry = this.pending.get(String(frame.id))
      this.pending.delete(String(frame.id))
      if (frame.error) entry?.reject(frame.error as Failure)
      else entry?.resolve(frame.result)
      return
    }
    if (frame.id != null) this.requests.push(frame)
    else this.notifications.push(frame)
    for (const waiter of [...this.waiters]) if (waiter(frame)) this.waiters.delete(waiter)
  }

  /** 发一帧原文 */
  sendRaw(text: string): void {
    queueMicrotask(() => this.handlers.message(text))
  }

  call(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject })
      this.sendRaw(JSON.stringify({ id, method, params }))
    })
  }

  /** 调用并期待它失败，返回对面给的 error */
  async fails(method: string, params?: unknown): Promise<Failure> {
    try {
      await this.call(method, params)
    } catch (error) {
      return error as Failure
    }
    throw new Error(`${method} 应该失败，却成功了`)
  }

  /** 握手。extensions 传 null 表示不声明任何扩展 */
  initialize(extensions: string[] | null = ['harness'], more: Record<string, unknown> = {}) {
    return this.call('initialize', {
      clientInfo: { name: 'device-test', title: null, version: '0.0.1' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        ...(extensions ? { litchExtensions: extensions } : {}),
        ...more,
      },
    })
  }

  /** 答复对面发来的一个请求 */
  answer(id: unknown, result: unknown): void {
    this.sendRaw(JSON.stringify({ id, result }))
  }

  /** 等一帧对面主动发来的（通知或请求）。已经收到过的也算 */
  waitFor(predicate: (frame: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const seen = [...this.notifications, ...this.requests].find(predicate)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new Error(`等了 ${timeoutMs} 毫秒没有等到要的那一帧`))
      }, timeoutMs)
      const waiter = (frame: Frame) => {
        if (!predicate(frame)) return false
        clearTimeout(timer)
        resolve(frame)
        return true
      }
      this.waiters.add(waiter)
    })
  }

  close(): void {
    this.handlers.close('测试结束')
  }
}

/** 让已经排上的微任务和定时器走完 */
export const settle = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface Rig {
  device: DeviceServer
  stateDir: string
  connect(): TestClient
  close(): Promise<void>
}

/**
 * 用几个假上游搭一个设备。重试和等待都调得很短，测试不用干等。more 里可以给控制通道等别的选项。
 * 默认不从上游导入现有的项目：那要设备进程自己另开连接去读上游，和导入无关的测试里只会多出不相干的连接和请求。
 * 测导入的用例给 importExisting: true；要接着用上一个设备留下的状态目录的给 stateDir。
 */
export function rig(
  upstreams: Record<string, FakeUpstream>,
  timing: Partial<SessionTiming> = {},
  more: Partial<DeviceOptions> = {},
): Rig {
  const stateDir = more.stateDir ?? tempDir()
  const device = new DeviceServer({
    importExisting: false,
    ...more,
    stateDir,
    version: '9.9.9',
    upstreams: Object.entries(upstreams).map(([id, upstream]) => ({
      id,
      connect: upstream.connector,
    })),
    timing: { retryMs: [20], settleMs: 500, probeTimeoutMs: 500, listTimeoutMs: 500, ...timing },
  })
  return {
    device,
    stateDir,
    connect: () => new TestClient(device),
    async close() {
      await device.close()
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

// ---------- 按扩展定义校验线上的形状 ----------
function repoRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  while (directory !== dirname(directory)) {
    try {
      readFileSync(join(directory, 'protocol/extensions/harness.json'))
      return directory
    } catch {
      directory = dirname(directory)
    }
  }
  throw new Error('找不到仓库根目录')
}

export const REPO = repoRoot()
const definition = JSON.parse(readFileSync(join(REPO, 'protocol/extensions/harness.json'), 'utf8'))
const ajv = new Ajv({ strict: false, allErrors: true })

/** 取扩展定义里的一部分。method 不给时按 kind 取第一个 */
function part(kind: string, method?: string): any {
  const found = definition.parts.find(
    (item: any) => item.kind === kind && (method === undefined || item.method === method),
  )
  if (!found) throw new Error(`扩展定义里没有 ${kind} ${method ?? ''}`)
  return found
}

function check(schema: unknown, value: unknown, what: string): void {
  const validate = ajv.compile({ ...(schema as object), definitions: definition.definitions })
  if (!validate(value))
    throw new Error(`${what} 和扩展定义对不上：${JSON.stringify(validate.errors)}`)
}

export const assertRuntimeInfo = (value: unknown) =>
  check(part('ClientRequest', 'runtime/info').response, value, 'runtime/info 的应答')
export const assertStatusChanged = (value: unknown) =>
  check(part('ServerNotification').params, value, 'harness 状态变化的通知')
export const assertThreadList = (value: unknown) =>
  check(part('ClientRequest', 'thread/list').response, value, 'thread/list 的应答')
export const assertErrorData = (value: unknown) => check(part('Error').data, value, 'error.data')
/** 扩展定义里登记的错误码 */
export const errorCode = (reason: string): number =>
  part('Error').errors.find((item: any) => item.litch === reason).code

// ---------- 设备级的工作区与置顶（deviceWorkspaces 扩展）的形状 ----------
const workspacesDefinition = JSON.parse(
  readFileSync(join(REPO, 'protocol/extensions/device-workspaces.json'), 'utf8'),
)

function checkWorkspaces(schema: unknown, value: unknown, what: string): void {
  const validate = ajv.compile({
    ...(schema as object),
    definitions: workspacesDefinition.definitions,
  })
  if (!validate(value))
    throw new Error(`${what} 和工作区扩展的定义对不上：${JSON.stringify(validate.errors)}`)
}

const workspacesNotification = (method: string): unknown => {
  const found = workspacesDefinition.parts.find(
    (item: any) => item.kind === 'ServerNotification' && item.method === method,
  )
  if (!found) throw new Error(`工作区扩展的定义里没有通知 ${method}`)
  return found.params
}

/** 置顶用的那个分区的标识，取自扩展定义 */
export const PINNED: string = workspacesDefinition.definitions.PinnedSectionId.const
export const assertProject = (value: unknown) =>
  checkWorkspaces({ $ref: '#/definitions/Project' }, value, '工作区（项目）对象')
export const assertSection = (value: unknown) =>
  checkWorkspaces({ $ref: '#/definitions/ThreadSection' }, value, '分区对象')
export const assertSectionUpdated = (value: unknown) =>
  checkWorkspaces(
    workspacesNotification('litch/thread/section/updated'),
    value,
    '会话分区变化的通知',
  )
export const assertSectionsChanged = (value: unknown) =>
  checkWorkspaces(workspacesNotification('litch/threadSection/changed'), value, '分区变化的通知')

// ---------- 引擎自己的结构化声明（runtime-info.json）----------
const runtimeDefinition = JSON.parse(
  readFileSync(join(REPO, 'protocol/extensions/runtime-info.json'), 'utf8'),
)

/** 聚合面带过来的能力位和权限预设，形状要和引擎自己那份定义对得上 */
export function assertDeclaration(info: { features?: unknown; permissionPresets?: unknown }): void {
  const definitions = runtimeDefinition.response.definitions
  const check = (name: string, value: unknown) => {
    const validate = ajv.compile({ $ref: `#/definitions/${name}`, definitions })
    if (!validate(value))
      throw new Error(`${name} 和 runtime-info.json 对不上：${JSON.stringify(validate.errors)}`)
  }
  check('HarnessFeatures', info.features)
  if (!Array.isArray(info.permissionPresets)) throw new Error('没有带权限预设')
  for (const preset of info.permissionPresets) check('PermissionPreset', preset)
}

// ---------- 设备配置接口（deviceSettings 扩展）的形状 ----------
const settingsDefinition = JSON.parse(
  readFileSync(join(REPO, 'protocol/extensions/device-settings.json'), 'utf8'),
)

function settingsPart(kind: string, method?: string): any {
  const found = settingsDefinition.parts.find(
    (item: any) => item.kind === kind && (method === undefined || item.method === method),
  )
  if (!found) throw new Error(`设置扩展的定义里没有 ${kind} ${method ?? ''}`)
  return found
}

function checkSettings(schema: unknown, value: unknown, what: string): void {
  const validate = ajv.compile({
    ...(schema as object),
    definitions: settingsDefinition.definitions,
  })
  if (!validate(value))
    throw new Error(`${what} 和设置扩展的定义对不上：${JSON.stringify(validate.errors)}`)
}

/** 某个方法的应答和扩展定义对得上 */
export const assertSettingsResponse = (method: string, value: unknown) =>
  checkSettings(settingsPart('ClientRequest', method).response, value, `${method} 的应答`)
/** 某个方法的参数和扩展定义对得上 */
export const assertSettingsParams = (method: string, value: unknown) =>
  checkSettings(settingsPart('ClientRequest', method).params, value, `${method} 的参数`)
export const assertSettingsChanged = (value: unknown) =>
  checkSettings(settingsPart('ServerNotification').params, value, '设置变化的通知')
export const assertSettingsErrorData = (value: unknown) =>
  checkSettings(settingsPart('Error').data, value, '设置扩展的 error.data')
/** 设置扩展的定义里登记的错误码 */
export const settingsErrorCode = (reason: string): number =>
  settingsPart('Error').errors.find((item: any) => item.litch === reason).code

// ---------- 常驻服务报自己是哪一份（deviceService 扩展）的形状 ----------
const serviceDefinition = JSON.parse(
  readFileSync(join(REPO, 'protocol/extensions/device-service.json'), 'utf8'),
)

/** runtime/info 的 device.service 和扩展定义对得上 */
export function assertDeviceService(value: unknown): void {
  const field = serviceDefinition.parts.find(
    (item: any) => item.kind === 'Field' && item.name === 'service',
  )
  if (!field) throw new Error('服务来历扩展的定义里没有 service 这个字段')
  const validate = ajv.compile({ ...field.schema, definitions: serviceDefinition.definitions })
  if (!validate(value))
    throw new Error(`服务的来历和扩展定义对不上：${JSON.stringify(validate.errors)}`)
}
