// 桌面偏好与配置助手：复用设置页的读写入口，不直接访问持久化文件。
import type { ConfigPrefs } from '../model-config.mjs'
import { parseSwitch } from './argv.mjs'
import { ConfigFailure, type OpContext, type OpSpec } from './context.mjs'
import { prefsLine } from './ops-app.mjs'

const readPrefs = async (ctx: OpContext) => {
  const data = (await ctx.ui({ kind: 'prefs.get' })) as ConfigPrefs
  return { text: `${prefsLine(data)} · send mode ${data.sendMode}`, data }
}

export const PREFERENCE_OPS: Record<string, OpSpec> = {
  'look get': {
    args: [0, 0],
    usage: 'look get',
    summary: {
      zh: '读取外观、语言和桌面偏好',
      en: 'Read appearance, language and desktop preferences',
    },
    run: readPrefs,
  },
  'notify get': {
    args: [0, 0],
    usage: 'notify get',
    summary: {
      zh: '读取会话通知、通知范围和定时任务成功通知',
      en: 'Read session notifications, their scope and scheduled-task success notifications',
    },
    async run(ctx) {
      const prefs = (await ctx.ui({ kind: 'prefs.get' })) as ConfigPrefs
      const data = {
        notifySessions: prefs.notifySessions,
        notifyScope: prefs.notifyScope,
        notifySuccess: prefs.notifySuccess,
      }
      return { text: JSON.stringify(data), data }
    },
  },
  'chat get': {
    args: [0, 0],
    usage: 'chat get',
    summary: { zh: '读取回合进行中的消息发送方式', en: 'Read how messages are sent during a turn' },
    async run(ctx) {
      const { sendMode } = (await ctx.ui({ kind: 'prefs.get' })) as ConfigPrefs
      return { text: `send mode ${sendMode}`, data: { sendMode } }
    },
  },
  'chat send-mode': {
    args: [1, 1],
    usage: 'chat send-mode now|queue',
    summary: {
      zh: '回合进行中的消息立即补充或排队',
      en: 'Send mid-turn messages immediately or queue them',
    },
    async run(ctx) {
      const sendMode = ctx.cmd.positionals[0]
      if (sendMode !== 'now' && sendMode !== 'queue')
        throw new ConfigFailure('invalid', ctx.say('只能是 now 或 queue', 'Use now or queue'))
      const data = await ctx.ui({ kind: 'prefs.set', patch: { sendMode } })
      return { text: `send mode ${sendMode}`, data }
    },
  },
  'assist get': {
    args: [0, 0],
    usage: 'assist get',
    summary: {
      zh: '读取产品手册安装开关和各目录状态',
      en: 'Read the manual installation switch and target status',
    },
    async run(ctx) {
      const data = await ctx.ui({ kind: 'manual.get' })
      return { text: JSON.stringify(data), data }
    },
  },
  'assist manual': {
    args: [1, 1],
    usage: 'assist manual on|off',
    summary: {
      zh: '安装或移除 Litch 管理的产品手册副本',
      en: 'Install or remove copies of the manual managed by Litch',
    },
    async run(ctx) {
      const enabled = parseSwitch(ctx.cmd.positionals[0])
      if (enabled === null)
        throw new ConfigFailure('invalid', ctx.say('只能是 on 或 off', 'Use on or off'))
      const data = await ctx.ui({ kind: 'manual.set', enabled })
      return { text: JSON.stringify(data), data }
    },
  },
}
