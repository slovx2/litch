// 常驻服务的来历和忙闲，设备进程这一头的两件事（定义见 protocol/extensions/device-service.json）：
//
// 一、对客户端报“正在运行的是哪一份适配器服务”。来历是适配器主进程经控制通道给的（它才知道自己是哪个版本、
//     从哪份适配器起的），设备进程只是转述，放在 runtime/info 的 device.service 里，
//     而且只给握手时声明过 deviceService 扩展的连接。
//
// 二、答主进程问的“忙不忙”。`device-stop --if-idle` 停服务之前要看三样：有没有回合在跑、
//     有没有属于设备的终端在跑、有没有客户端连着。这三样只有设备进程知道，主进程经控制通道来问（control.mts）。
import type { DeviceInfo } from '../../protocol/src/device.mjs'
import type { DeviceServiceInfo } from '../../protocol/src/device-service.mjs'
import type { ControlState } from './control.mjs'
import { isObject } from './wire.mjs'

/** 主进程来问忙不忙时用的方法名 */
export const ACTIVITY_METHOD = 'activity'

/** 对“忙不忙”的回答。三样都是零（空）才算闲 */
export interface DeviceActivity {
  /** 有回合在跑的 harness；判断不了的也算在里面 */
  turns: string[]
  /** 在跑的、属于设备的终端（可重连的终端）有几个 */
  processes: number
  /** 聚合面上连着几个客户端 */
  connections: number
}

/**
 * 从主进程给的状态里取出它自己的来历。没有报，或者报的不成样子，都是 null：
 * 对客户端宁可不说，也不说一半。只取对客户端报的那几项，主进程多给的（启动参数）不带出去。
 */
export function serviceInfo(state: ControlState | null): DeviceServiceInfo | null {
  const given: unknown = state?.service
  if (!isObject(given)) return null
  const { pid, version, root, startedAt, detached, build } = given
  if (
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    typeof version !== 'string' ||
    !version ||
    typeof root !== 'string' ||
    typeof startedAt !== 'string' ||
    typeof detached !== 'boolean'
  )
    return null
  return {
    pid,
    version,
    root,
    startedAt,
    detached,
    ...(typeof build === 'string' && build ? { build } : {}),
  }
}

/**
 * 给一条连接看的设备信息。服务的来历属于 deviceService 扩展，只增不改：
 * 没声明这个扩展的连接看到的和没有这个扩展时一模一样。
 */
export function describeDevice(
  info: DeviceInfo,
  service: DeviceServiceInfo | null,
  declared: boolean,
): DeviceInfo {
  return declared && service ? { ...info, service } : info
}
