// 可重连的终端（deviceProcesses 扩展）的测试用到的小工具：按扩展定义校验线上的形状、
// 把一条连接收到的输出按偏移拼起来、一个能停下不读的套接字客户端（试流量控制用）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv } from 'ajv'
import { WebSocket } from 'ws'
import type { Frame } from '../src/wire.mjs'
import { type Failure, REPO, type Rig, type TestClient } from './helpers.mjs'

export const text = (base64: string) => Buffer.from(base64, 'base64').toString('utf8')
export const b64 = (value: string) => Buffer.from(value).toString('base64')

/** 握手时声明的扩展：聚合面要求的 harness，加上可重连的终端 */
export const DECLARED = ['harness', 'deviceProcesses']

// ---------- 按扩展定义校验 ----------
const definition = JSON.parse(
  readFileSync(join(REPO, 'protocol/extensions/device-processes.json'), 'utf8'),
)
const ajv = new Ajv({ strict: false, allErrors: true })

const compiled = new Map<string, ReturnType<typeof ajv.compile>>()

function check(schema: unknown, value: unknown, what: string): void {
  // 输出的每一帧都要验，编译好的留着用
  const key = JSON.stringify(schema)
  let validate = compiled.get(key)
  if (!validate) {
    validate = ajv.compile({ ...(schema as object), definitions: definition.definitions })
    compiled.set(key, validate)
  }
  if (!validate(value))
    throw new Error(`${what} 和扩展定义对不上：${JSON.stringify(validate.errors)}`)
}

/** 取扩展定义里的一部分。key 是方法名或者它加在哪上面；不给时按 kind 取第一个 */
function part(kind: string, key?: string): any {
  const found = definition.parts.find(
    (item: any) =>
      item.kind === kind && (key === undefined || item.method === key || item.on === key),
  )
  if (!found) throw new Error(`扩展定义里没有 ${kind} ${key ?? ''}`)
  return found
}

const ref = (name: string) => ({ $ref: `#/definitions/${name}` })

export const assertProcess = (value: unknown) => check(ref('DeviceProcess'), value, '进程对象')
export const assertSpawnResponse = (value: unknown) =>
  check(part('ClientRequest', 'process/spawn').response, value, 'process/spawn 的应答')
export const assertListResponse = (value: unknown) =>
  check(part('ClientRequest', 'litch/process/list').response, value, 'litch/process/list 的应答')
export const assertAttachResponse = (value: unknown) =>
  check(
    part('ClientRequest', 'litch/process/attach').response,
    value,
    'litch/process/attach 的应答',
  )
export const assertChanged = (value: unknown) =>
  check(part('ServerNotification', 'litch/process/changed').params, value, '进程变化的通知')
export const assertOutputMark = (value: unknown) => check(ref('OutputMark'), value, '输出上的标注')
export const assertExitMark = (value: unknown) => check(ref('ExitMark'), value, '退出上的标注')
export const assertProcessErrorData = (value: unknown) =>
  check(part('Error').data, value, 'error.data')
/** 扩展定义里登记的错误码 */
export const processErrorCode = (reason: string): number =>
  part('Error').errors.find((item: any) => item.litch === reason).code

// ---------- 标准协议的形状（上游的结构定义快照），多一个字段都不行 ----------
const upstream = (name: string): object => ({
  ...JSON.parse(
    readFileSync(
      join(REPO, `protocol/codex-app-server/0.163.0/json-schema/v2/${name}.json`),
      'utf8',
    ),
  ),
  additionalProperties: false,
})

const standards = new Map<string, ReturnType<typeof ajv.compile>>()

/** 和标准协议逐字段相同：上游定义里有的都有，没有的一个都不多 */
export function assertStandard(
  name: 'ProcessOutputDeltaNotification' | 'ProcessExitedNotification' | 'ProcessSpawnResponse',
  value: unknown,
): void {
  let validate = standards.get(name)
  if (!validate) {
    // 上游的定义里有 int32 这类格式标注，这里只验结构，和引擎包的测试一样
    validate = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(
      upstream(name),
    )
    standards.set(name, validate)
  }
  if (!validate(value))
    throw new Error(`${name} 和标准协议对不上：${JSON.stringify(validate.errors)}`)
}

// ---------- 把一条连接收到的输出拼起来 ----------
export interface Collected {
  /** 收到的全部字节，按到达的先后 */
  data: Buffer
  /** 第一帧的偏移；一帧都没有是 null */
  start: number | null
  /** 手里有到哪了：最后一帧的偏移加它的长度 */
  end: number
  /** 各帧报的 missedBytes 加起来 */
  missed: number
  /** 回放的字节数 */
  replayed: number
  frames: number
  /** 帧和帧是不是首尾相接（报了 missedBytes 的地方按它说的跳） */
  contiguous: boolean
  /** 退出通知的参数；还没收到是 null */
  exit: any
}

/** frames：一条连接收到的通知。只看这个句柄的、带设备标注的 */
export function collect(frames: Frame[], handle: string): Collected {
  const parts: Buffer[] = []
  const result: Collected = {
    data: Buffer.alloc(0),
    start: null,
    end: 0,
    missed: 0,
    replayed: 0,
    frames: 0,
    contiguous: true,
    exit: null,
  }
  for (const frame of frames) {
    const params = frame.params as any
    if (params?.processHandle !== handle) continue
    if (frame.method === 'process/exited') result.exit = params
    if (frame.method !== 'process/outputDelta') continue
    const mark = params.litchDevice
    assertOutputMark(mark)
    const bytes = Buffer.from(params.deltaBase64, 'base64')
    if (result.start === null) result.start = mark.offset
    else if (mark.offset !== result.end + (mark.missedBytes ?? 0)) result.contiguous = false
    result.missed += mark.missedBytes ?? 0
    if (mark.replay) result.replayed += bytes.length
    result.end = mark.offset + bytes.length
    result.frames++
    parts.push(bytes)
  }
  result.data = Buffer.concat(parts)
  return result
}

// ---------- 经真的套接字连、能停下不读的客户端 ----------
export class SocketClient {
  /** 收到的通知，按到达顺序 */
  readonly notifications: Frame[] = []
  private readonly ws: WebSocket
  private readonly pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Failure): void }
  >()
  private nextId = 1

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Frame
      if (typeof frame.method === 'string') {
        this.notifications.push(frame)
        return
      }
      const entry = this.pending.get(frame.id as number)
      this.pending.delete(frame.id as number)
      if (frame.error) entry?.reject(frame.error as Failure)
      else entry?.resolve(frame.result)
    })
  }

  static async connect(path: string, extensions: string[] = DECLARED): Promise<SocketClient> {
    const ws = new WebSocket(`ws+unix://${path}:/`, { perMessageDeflate: false })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    const client = new SocketClient(ws)
    await client.call('initialize', {
      clientInfo: { name: 'device-test', title: null, version: '0.0.1' },
      capabilities: { experimentalApi: true, litchExtensions: extensions },
    })
    return client
  }

  call(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 停下不读：对面发来的东西先是堆在系统的缓冲里，满了之后就积在对面的发送队列上 */
  pause(): void {
    this.ws.pause()
  }

  resume(): void {
    this.ws.resume()
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve()
      this.ws.once('close', () => resolve())
      this.ws.resume()
      this.ws.close()
    })
  }
}

// ---------- 各组测试共用的进程和动作 ----------

/** 能发请求、攒着通知的客户端：直接接在设备上的 TestClient 和经套接字的 SocketClient 都是 */
export interface Caller {
  call(method: string, params?: unknown): Promise<any>
  notifications: Frame[]
}

/** 从标准输入一行一行读“起 止 等几秒”，等完把这一段数字各占一行打出来，再打一行 END */
export const FEED = [
  '/bin/sh',
  '-c',
  'while read a b d; do sleep "$d"; seq "$a" "$b"; echo END; done',
]
/** FEED 收到“from to”之后打出来的东西 */
export const lines = (from: number, to: number) =>
  `${Array.from({ length: to - from + 1 }, (_, index) => `${from + index}\n`).join('')}END\n`

export const SLEEP = ['/bin/sh', '-c', 'sleep 60']
/** 终端该带的两项：不带的话 10 秒后被结束、输出到 1 MiB 就不再读 */
export const OPEN = { timeoutMs: null, outputBytesCap: null }

export const write = (client: Caller, handle: string, input: string) =>
  client.call('process/writeStdin', { processHandle: handle, deltaBase64: b64(input) })

/** 设备上属于设备的进程，顺带按扩展定义验一遍形状 */
export async function list(client: Caller): Promise<any[]> {
  const response = await client.call('litch/process/list', {})
  assertListResponse(response)
  return response.data
}

/** 这条连接到现在为止收到的这个进程的输出 */
export const output = (client: Caller, handle: string) =>
  collect(client.notifications, handle).data.toString('utf8')

/** 等这个进程的退出通知，返回它的参数 */
export async function exited(client: Caller, handle: string, timeoutMs = 10_000): Promise<any> {
  const find = () =>
    client.notifications.find(
      (frame) =>
        frame.method === 'process/exited' && (frame.params as any).processHandle === handle,
    )
  await until(`${handle} 的退出通知`, () => find() !== undefined, timeoutMs)
  return find()?.params
}

/** 这条连接收到的、这个进程的变化通知，各是哪一种 */
export const changes = (client: Caller, handle: string): string[] =>
  client.notifications
    .filter((frame) => frame.method === 'litch/process/changed')
    .map((frame) => {
      assertChanged(frame.params)
      return frame.params as any
    })
    .filter((params) => params.processHandle === handle)
    .map((params) => params.change)

/** 一条握手时声明了这项扩展的连接，直接接在设备上 */
export async function declared(setup: Rig): Promise<TestClient> {
  const client = setup.connect()
  await client.initialize(DECLARED)
  return client
}

/** 属于连接的进程（标准的 process/spawn）到现在为止的输出：每一帧都得是标准协议的形状 */
export const plainOutput = (client: Caller, handle: string): string =>
  client.notifications
    .filter(
      (frame) =>
        frame.method === 'process/outputDelta' && (frame.params as any).processHandle === handle,
    )
    .map((frame) => {
      assertStandard('ProcessOutputDeltaNotification', frame.params)
      return text((frame.params as any).deltaBase64)
    })
    .join('')

/** 等到条件成立。到点还不成立就报错，说清楚等的是什么 */
export async function until(
  what: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs} 毫秒：${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
