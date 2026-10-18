// 设备层：终端与进程、文件访问与监听、模糊找文件。
// 直接复用 packages/shared 里现有的实现，在设备进程里跑一份；聚合面的 process/*、fs/* 由它处理，不再转给任何引擎。
// process/* 不加沙箱，与现状一致：它是用户自己开的 shell，信任级别等同于用户登录到这台机器。
//
// 进程有两种。协议原本的那种属于发起它的连接，连接一断就结束；`process/spawn` 带了扩展参数的属于设备
// （可重连的终端，扩展名 deviceProcesses，见 device-processes.mts）。两种的输出都经连接的流量控制发。
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  DEVICE_PROCESS_ATTACH,
  DEVICE_PROCESS_DETACH,
  DEVICE_PROCESS_FIELD,
  DEVICE_PROCESS_KILL,
  DEVICE_PROCESS_LIST,
  DEVICE_PROCESS_REMOVE,
} from '../../protocol/src/device-processes.mjs'
import { FilesystemRpc } from '../../shared/src/filesystem-rpc.mjs'
import { FuzzyFileSearch, FuzzySearchSessions } from '../../shared/src/fuzzy-session.mjs'
import { nativeWirePaths } from '../../shared/src/native-path.mjs'
import { ProcessRpc } from '../../shared/src/process-rpc.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import {
  DEFAULT_PROCESS_LIMITS,
  DEVICE_PROCESS_PREFIX,
  DeviceProcesses,
  type ProcessAudience,
  type ProcessLimits,
} from './device-processes.mjs'
import { ConnectionFlow, DEFAULT_FLOW, type FlowLimits } from './flow.mjs'
import { DeviceError, isObject } from './wire.mjs'

export interface DeviceLayerOptions {
  /** 属于设备的进程的上限和期限。没给的用默认值 */
  processes?: Partial<ProcessLimits>
  /** 发送积压的两条线。只有测试会改 */
  flow?: Partial<FlowLimits>
  /** 发给所有握手时声明过这个扩展的连接 */
  announce?(method: string, params: unknown, extension: string): void
  log?(line: string): void
}

/** 进程里共用的一份。终端、文件监听按连接记账，连接断开时各自清理 */
export class DeviceLayer {
  // command/exec 在聚合面不提供，命令策略用不上
  readonly processes = new ProcessRpc((command) => command)
  readonly files = new FilesystemRpc()
  /** 属于设备的进程。起进程用的是上面那一份实现，所以设备进程退出时它们一起结束 */
  readonly deviceProcesses: DeviceProcesses
  readonly flow: FlowLimits

  constructor(options: DeviceLayerOptions = {}) {
    this.flow = { ...DEFAULT_FLOW, ...options.flow }
    this.deviceProcesses = new DeviceProcesses({
      rpc: this.processes,
      limits: { ...DEFAULT_PROCESS_LIMITS, ...options.processes },
      announce: options.announce ?? (() => {}),
      log: options.log ?? (() => {}),
    })
  }

  /** 一条连接断了：它自己的进程结束，它挂着的设备进程只是解除挂接 */
  closePeer(peerId: string): void {
    this.processes.closePeer(peerId)
    this.files.closePeer(peerId)
    this.deviceProcesses.closeConnection(peerId)
  }

  async close(): Promise<void> {
    this.files.close()
    this.deviceProcesses.close()
    // 连接自己的和属于设备的进程都在这一份里，一起结束并等它们退出，不留孤儿
    await this.processes.close()
  }
}

/** 设备层眼里的一条客户端连接 */
export interface DeviceConnection extends RpcPeer {
  /** flushed：这一帧（连同排在它前面的）已经交给系统了 */
  send(message: WireMessage, flushed?: () => void): void
  /** 握手时声明过这个扩展 */
  declares(extension: string): boolean
  /** 已经交出去、系统还没有收下的字节数 */
  backlog(): number
}

/** 一条客户端连接上的设备层调用 */
export class DeviceCalls {
  private readonly layer: DeviceLayer
  private readonly connection: DeviceConnection
  private readonly flow: ConnectionFlow
  private readonly audience: ProcessAudience
  /** 这条连接自己的进程（协议原本的那种）登记在它名下：通知的内容和先后照旧，只是输出经流量控制发 */
  private readonly peer: RpcPeer
  /** 因为这条连接堵着而按住不读的、它自己的进程 */
  private readonly held = new Set<string>()
  private readonly search = new FuzzyFileSearch()
  // 找文件的会话每条连接各有一份：共用的话，不同连接起了同名的会话会互相顶掉
  private readonly searches = new FuzzySearchSessions((peer, message) => peer.send(message))

  constructor(layer: DeviceLayer, connection: DeviceConnection) {
    this.layer = layer
    this.connection = connection
    this.flow = new ConnectionFlow(connection, layer.flow)
    this.audience = { id: connection.id, flow: this.flow }
    this.peer = {
      id: connection.id,
      send: (message) => this.relay(message),
      close: () => connection.close(),
    }
    this.flow.onDrain(() => this.release())
  }

  call(method: string, params: unknown): unknown {
    const raw = isObject(params) ? params : {}
    const fields = nativeWirePaths(raw)
    if (method.startsWith('fs/')) return this.layer.files.call(this.connection, method, fields)
    if (method.startsWith(DEVICE_PROCESS_PREFIX)) return this.deviceProcess(method, fields)
    const devices = this.layer.deviceProcesses
    const id = this.connection.id
    switch (method) {
      case 'process/spawn': {
        // 扩展参数只有声明过这项扩展的连接带了才算数；没声明的连接带了等于没带，
        // 和别的不认识的字段一样略过，行为与标准协议相同。
        // 取的是没做过路径改写的原文：里面的标记是客户端的东西，不能动
        const option = raw[DEVICE_PROCESS_FIELD]
        if (option != null && this.connection.declares(EXTENSION.deviceProcesses))
          return devices.spawn(this.audience, fields, option)
        // 这条连接正挂着同名的设备进程：对它来说这个句柄已经在用，和协议原有的重复句柄一样报
        if (devices.attached(id, fields.processHandle))
          throw new ProtocolError(
            -32600,
            `duplicate active process handle: ${JSON.stringify(fields.processHandle)}`,
          )
        return this.layer.processes.start(this.peer, 'process', fields)
      }
      // 下面三个：句柄是这条连接挂着的设备进程就落到它上面，否则是这条连接自己的进程
      case 'process/writeStdin':
        if (devices.attached(id, fields.processHandle)) return devices.write(fields)
        return this.layer.processes.followup(this.peer, 'process', 'write', fields)
      case 'process/resizePty':
        if (devices.attached(id, fields.processHandle)) return devices.resize(fields)
        return this.layer.processes.followup(this.peer, 'process', 'resize', fields)
      case 'process/kill':
        if (devices.attached(id, fields.processHandle)) return devices.killAttached(fields)
        return this.layer.processes.followup(this.peer, 'process', 'kill', fields)
      case 'fuzzyFileSearch':
        return this.search.search(fields)
      case 'fuzzyFileSearch/sessionStart':
        return this.searches.start(this.connection, fields)
      case 'fuzzyFileSearch/sessionUpdate':
        return this.searches.update(this.connection, fields)
      case 'fuzzyFileSearch/sessionStop':
        return this.searches.stop(fields)
      default:
        throw new ProtocolError(-32601, `设备层没有这个方法：${method}`)
    }
  }

  /** deviceProcesses 扩展自己的方法：只给握手时声明过它的连接 */
  private deviceProcess(method: string, fields: Record<string, unknown>): unknown {
    if (!this.connection.declares(EXTENSION.deviceProcesses))
      throw new DeviceError(
        'extensionRequired',
        `${method} 属于 ${EXTENSION.deviceProcesses} 扩展，握手时在 capabilities.litchExtensions 里声明了它才能用`,
        { method, required: [EXTENSION.deviceProcesses] },
      )
    const devices = this.layer.deviceProcesses
    switch (method) {
      case DEVICE_PROCESS_LIST:
        return devices.list()
      case DEVICE_PROCESS_ATTACH:
        return devices.attach(this.audience, fields)
      case DEVICE_PROCESS_DETACH:
        return devices.detach(this.connection.id, fields)
      case DEVICE_PROCESS_KILL:
        return devices.kill(fields)
      case DEVICE_PROCESS_REMOVE:
        return devices.remove(fields)
      default:
        throw new DeviceError('unsupported', `聚合面不支持 ${method}：设备层没有这个进程方法`, {
          method,
        })
    }
  }

  /**
   * 这条连接自己的进程发来的通知。输出经流量控制发：发完积压过了线，就按住这个进程不读它的输出，
   * 连接通了再放开。通知本身一个字都不改。
   */
  private relay(message: WireMessage): void {
    if (!('method' in message) || message.method !== 'process/outputDelta') {
      this.connection.send(message)
      return
    }
    this.flow.send(message)
    if (!this.flow.congested) return
    const handle = (message.params as { processHandle: string }).processHandle
    this.held.add(handle)
    this.layer.processes.hold(this.connection.id, 'process', handle, true)
  }

  private release(): void {
    for (const handle of this.held)
      this.layer.processes.hold(this.connection.id, 'process', handle, false)
    this.held.clear()
  }

  close(): void {
    this.flow.close()
    this.layer.closePeer(this.connection.id)
  }
}
