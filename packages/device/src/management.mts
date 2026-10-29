// 设备配置接口在聚合面上的门面（扩展名 deviceSettings）。
// 设置的结构、校验、落盘，运行时的起和停，都在适配器主进程里；这里把客户端的请求经控制通道转过去，
// 自己只管两件事：要重启一个 harness 之前，先看它有没有回合在跑；一次写入从头到尾只给客户端一个
// 定下来的结果，途中的样子（先标成待重启、重新应用了再摘掉，SSH 入口没了又回来）不往外说。
//
// 给设备装 harness（扩展名 harnessInstall）的三个方法也在这个前缀下，同样只是转给主进程：装的事在 Go 那边做，
// 进度由主进程推过来（control.mts 的 onInstall），设备进程转给声明了 harnessInstall 的连接（device.mts）。
//
// 密钥只出现在写入请求的参数里，这个文件不把任何参数写进日志。
import { HARNESS_INSTALL_METHOD } from '../../protocol/src/device-harness-install.mjs'
import { DEVICE_POWER_READ } from '../../protocol/src/device-power.mjs'
import {
  DEVICE_DIAGNOSTICS_RUN,
  DEVICE_HARNESS_RESTART,
  DEVICE_LOGS_READ,
  DEVICE_SETTINGS_ERROR_CODE,
  DEVICE_SETTINGS_READ,
  DEVICE_SETTINGS_WRITE,
  DEVICE_SSH_CONFIG_READ,
  type DeviceSettingsErrorData,
  type DeviceSettingsErrorReason,
  type DeviceSettingsSnapshot,
  type LocalizedText,
} from '../../protocol/src/device-settings.mjs'
import { type ControlChannel, ControlFailure } from './control.mjs'
import { DeviceError, isObject } from './wire.mjs'

/** 这个扩展的方法都在这个前缀下，由设备进程自己处理，不转给任何运行时 */
export const MANAGEMENT_PREFIX = 'litch/device/'

/** 这个扩展自己回的错误：原因在 `error.data.litch`，说明的两种语言版本在 `error.data.text` */
export class ManagementError extends Error {
  readonly code: number
  readonly data: DeviceSettingsErrorData

  constructor(
    reason: DeviceSettingsErrorReason,
    text: LocalizedText,
    detail: Omit<DeviceSettingsErrorData, 'litch' | 'text'> = {},
  ) {
    super(text['zh-CN'])
    this.code = DEVICE_SETTINGS_ERROR_CODE[reason]
    this.data = { litch: reason, text, ...detail }
  }
}

export interface ManagementHost {
  /** 和适配器主进程之间的控制通道。null：没有主进程在管这个设备进程 */
  control: ControlChannel | null
  /** 这个 harness 是不是有回合在跑。判断不了的时候返回 true */
  busy(harness: string): Promise<boolean>
  /**
   * 一次写入开始了：从现在到它有结果，设置变化的通知先攒着不发。
   * 返回的函数在写入有了结果（成了、没成都算）时调用一次：把这段工夫里的变化并成一条发出去，
   * 并给出这时候设置的现状（手上还没有主进程给的状态时是 null）。
   */
  settling(): () => DeviceSettingsSnapshot | null
  log(line: string): void
}

/**
 * 等主进程应答最多等多久。重新应用设置要等运行时有结果、SSH 入口定下来，诊断要把几个 harness 都查一遍；
 * 查版本要逐个跑 `--version`（各两秒）、联网查最新版（五秒），几个一起查
 */
const WAIT = { quick: 30_000, apply: 100_000, diagnostics: 150_000 }

interface WriteResult {
  changed: string[]
  newlyPending: string[]
  snapshot: DeviceSettingsSnapshot
}

function translate(error: unknown): unknown {
  if (!(error instanceof ControlFailure)) return error
  const { reason, text, key, harness, snapshot } = error.detail
  switch (reason) {
    case 'conflict':
      return new ManagementError('settingsConflict', text, snapshot ? { snapshot } : {})
    case 'invalid':
      return new ManagementError('invalidSetting', text, key ? { key } : {})
    case 'unknownHarness':
      return new DeviceError('unknownHarness', text['zh-CN'], harness ? { harness } : {})
    case 'busy':
      return new ManagementError('harnessBusy', text, harness ? { harness } : {})
    case 'unavailable':
      return new ManagementError('settingsUnavailable', text)
    default:
      return new ManagementError('deviceActionFailed', text, harness ? { harness } : {})
  }
}

export class DeviceManagement {
  private readonly host: ManagementHost

  constructor(host: ManagementHost) {
    this.host = host
  }

  call(method: string, params: unknown): Promise<unknown> {
    const fields = isObject(params) ? params : {}
    switch (method) {
      case DEVICE_POWER_READ:
        return this.ask('power.read', {}, WAIT.quick)
      case DEVICE_SETTINGS_READ:
        return this.ask('settings.read', {}, WAIT.quick)
      case DEVICE_SETTINGS_WRITE:
        return this.write(fields)
      case DEVICE_HARNESS_RESTART:
        return this.restart(fields)
      case DEVICE_DIAGNOSTICS_RUN:
        return this.ask(
          'diagnostics.run',
          typeof fields.harness === 'string' ? { harness: fields.harness } : {},
          WAIT.diagnostics,
        )
      case DEVICE_LOGS_READ:
        return this.ask(
          'logs.tail',
          { source: fields.source, harness: fields.harness, maxBytes: fields.maxBytes },
          WAIT.quick,
        )
      case DEVICE_SSH_CONFIG_READ:
        return this.ask('ssh.config', {}, WAIT.quick)
      case HARNESS_INSTALL_METHOD.versions:
        return this.ask('harness.versions', { latest: fields.latest === true }, WAIT.quick)
      case HARNESS_INSTALL_METHOD.install:
        return this.ask(
          'harness.install',
          { harness: fields.harness, version: fields.version },
          WAIT.quick,
        )
      case HARNESS_INSTALL_METHOD.read:
        return this.ask('harness.install.read', {}, WAIT.quick)
      default:
        return Promise.reject(
          new DeviceError('unsupported', `聚合面不支持 ${method}：设备配置接口里没有这个方法`, {
            method,
          }),
        )
    }
  }

  private async ask(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const control = this.host.control
    if (!control)
      throw new ManagementError('settingsUnavailable', {
        'zh-CN':
          '这个设备服务不是由带设置功能的适配器主进程拉起的，设置和 harness 管理在这里用不了',
        en: 'This device service was not started by an adapter service with settings support, so settings and harness management are unavailable here',
      })
    try {
      return await control.request(method, params, timeoutMs)
    } catch (error) {
      throw translate(error)
    }
  }

  private async write(fields: Record<string, unknown>): Promise<unknown> {
    if (typeof fields.expectedVersion !== 'number' || !Array.isArray(fields.edits))
      throw new ManagementError('invalidSetting', {
        'zh-CN': '写入要带 expectedVersion（读到的版本号）和 edits（要改的键和值）',
        en: 'A write needs expectedVersion (the version you read) and edits (the keys and values to change)',
      })
    // 从这里到有结果，设置变化的通知先攒着：主进程每走一步都推一条现状过来，中间那几条转眼就作废
    const settle = this.host.settling()
    let written: WriteResult
    let outcomes: (DeviceSettingsSnapshot | null)[]
    try {
      written = (await this.ask(
        'settings.write',
        { expectedVersion: fields.expectedVersion, edits: fields.edits },
        WAIT.quick,
      )) as WriteResult
      // 改了要重启才生效的设置：那个 harness 没有回合在跑就现在重新应用；有（或者判断不了）就留着，
      // 标成待重启，由用户决定什么时候重启。之前就留着等用户的不在这份名单里，不借这次写入去动它。
      // 几个 harness 各做各的，不排队：重新应用要等它起来
      outcomes = await Promise.all(written.newlyPending.map((harness) => this.reapply(harness)))
    } catch (error) {
      settle()
      throw error
    }
    // 定下来的样子取手上最新的那份现状：主进程每个应答之前都先把现状推过来，它不比哪个应答旧，
    // 而且和刚发出去的那条通知是同一份。手上没有（不该发生）才退回应答里带的
    const snapshot = settle() ?? outcomes.findLast((item) => item !== null) ?? written.snapshot
    return {
      snapshot,
      changed: written.changed,
      restarted: written.newlyPending.filter((_, index) => outcomes[index] !== null),
    }
  }

  /** 写入之后把一个 harness 现在就重新应用。做了返回主进程那时的快照；没做（有回合在跑、没做成）返回 null */
  private async reapply(harness: string): Promise<DeviceSettingsSnapshot | null> {
    if (await this.host.busy(harness)) {
      this.host.log(`${harness} 有回合在跑（或者判断不了），改了的设置留待重启`)
      return null
    }
    try {
      const applied = (await this.ask('harness.apply', { harness }, WAIT.apply)) as {
        snapshot: DeviceSettingsSnapshot
      }
      return applied.snapshot
    } catch (error) {
      // 设置已经写进去了，这一步没成只是它还待重启，不能让整个写入看起来失败
      this.host.log(
        `${harness} 的设置没能现在就重新应用，留待重启：${error instanceof Error ? error.message : String(error)}`,
      )
      return null
    }
  }

  private async restart(fields: Record<string, unknown>): Promise<unknown> {
    const harness = typeof fields.harness === 'string' ? fields.harness : ''
    const state = this.host.control?.state
    if (state && !state.harnesses.some((item) => item.id === harness))
      throw new DeviceError(
        'unknownHarness',
        `这台设备上没有 ${harness || '（空）'} 这个 harness`,
        {
          harness,
        },
      )
    if (this.host.control && fields.force !== true && (await this.host.busy(harness)))
      throw new ManagementError(
        'harnessBusy',
        {
          'zh-CN': `${harness} 有回合在跑（或者现在判断不了）。等它结束再重启，或者明确要求有回合在跑也照做`,
          en: `${harness} has a turn in progress (or that cannot be determined right now). Restart it once the turn ends, or explicitly ask to restart anyway`,
        },
        { harness },
      )
    return this.ask('harness.apply', { harness }, WAIT.apply)
  }
}
