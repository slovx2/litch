// Chrome 设置走既有主进程接口；扩大访问必须经桌面确认，不能代替网站来源授权。
import { parseSwitch } from './argv.mjs'
import { ConfigFailure, type OpSpec } from './context.mjs'

export const CHROME_OPS: Record<string, OpSpec> = {
  'chrome get': {
    args: [0, 0],
    usage: 'chrome get',
    summary: {
      zh: '读取 Chrome 控制开关、连接及远程设备授权',
      en: 'Read Chrome control, connections and allowed remote devices',
    },
    async run(ctx) {
      const data = await ctx.main({ kind: 'chrome.status' })
      return { text: JSON.stringify(data), data }
    },
  },
  'chrome set': {
    args: [1, 1],
    options: ['device'],
    usage: 'chrome set on|off [--device <device>]',
    summary: {
      zh: '切换 Chrome 控制或单台远程设备授权（开启需桌面确认）',
      en: 'Set Chrome control or access for one remote device (enabling needs desktop confirmation)',
    },
    async run(ctx) {
      const enabled = parseSwitch(ctx.cmd.positionals[0])
      if (enabled === null)
        throw new ConfigFailure('invalid', ctx.say('只能是 on 或 off', 'Use on or off'))
      const arg = ctx.cmd.options.get('device')
      const device = arg === undefined ? null : await ctx.device(arg)
      if (device?.kind === 'local')
        throw new ConfigFailure(
          'invalid',
          ctx.say(
            '本机使用总开关；--device 只用于远程设备',
            'Use the global switch for this computer; --device is for remote devices',
          ),
        )
      if (enabled)
        await ctx.confirm([{ kind: 'chrome', device: device ? ctx.nameOf(device) : null }])
      const data = await ctx.main(
        device
          ? { kind: 'chrome.device', deviceId: device.id, enabled }
          : { kind: 'chrome.enable', enabled },
      )
      return { text: JSON.stringify(data), data }
    },
  },
}
