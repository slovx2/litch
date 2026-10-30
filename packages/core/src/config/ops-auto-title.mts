// 自动起名是 Litch 自己的开关，位于 Codex 详情设置；不包装 harness 原生账号或配置。
import { ChannelError, type HarnessConfigOp } from '../channel/protocol.mjs'
import type { HarnessConfigTopicView, HcConfigView } from '../model-harness-config.mjs'
import { parseSwitch } from './argv.mjs'
import { ConfigFailure, type OpContext, type OpSpec } from './context.mjs'

const KEY = 'litch.autoTitle'

/** 首份快照可能仍在加载，等配置就绪或明确失败后再退订。 */
async function read(ctx: OpContext, deviceId: string): Promise<HcConfigView> {
  return new Promise((resolve, reject) => {
    let done = false
    let close: (() => void) | undefined
    const finish = (data: HcConfigView | null, error?: unknown) => {
      if (done) return
      done = true
      cancel()
      close?.()
      if (data) resolve(data)
      else reject(error)
    }
    const cancel = ctx.host.clock.setTimer(
      () =>
        finish(
          null,
          new ConfigFailure(
            'failed',
            ctx.say('读取自动起名设置超时', 'Timed out reading automatic naming'),
          ),
        ),
      10_000,
    )
    const take = (view: HarnessConfigTopicView) => {
      if (view.supported === false)
        return finish(
          null,
          new ConfigFailure(
            'invalid',
            ctx.say('设备不支持 Codex 详情设置', 'Codex settings are not supported on this device'),
          ),
        )
      if (view.config.error)
        return finish(null, new ChannelError(view.config.error.code, view.config.error.message))
      if (!view.config.loading && view.config.data) finish(view.config.data)
    }
    try {
      close = ctx.host.core.subscribe(
        { kind: 'harnessConfig', deviceId, harness: 'codex' },
        {
          snapshot: (view) => take(view as HarnessConfigTopicView),
          delta: (ops) => {
            for (const op of ops as HarnessConfigOp[]) take(op.view)
          },
          error: (error) => finish(null, error),
        },
      )
      if (done) close()
    } catch (error) {
      finish(null, error)
    }
  })
}

export const AUTO_TITLE_OPS: Record<string, OpSpec> = {
  'harness auto-title': {
    args: [1, 2],
    usage: 'harness auto-title <device> [on|off]',
    summary: {
      zh: '读取或切换 Litch 为新建 Codex 会话自动起名',
      en: 'Read or set Litch automatic naming for new Codex sessions',
    },
    async run(ctx) {
      const device = await ctx.device(ctx.cmd.positionals[0])
      const raw = ctx.cmd.positionals[1]
      const enabled = raw === undefined ? undefined : parseSwitch(raw)
      if (enabled === null)
        throw new ConfigFailure('invalid', ctx.say('只能是 on 或 off', 'Use on or off'))
      const config = await read(ctx, device.id)
      const spec = config.settings.find((item) => item.key === KEY)
      if (!spec)
        throw new ConfigFailure(
          'invalid',
          ctx.say('设备没有自动起名设置', 'This device has no automatic naming setting'),
        )
      if (enabled !== undefined) {
        await ctx.run('harnessConfig.write', {
          deviceId: device.id,
          harness: 'codex',
          edits: [{ key: KEY, value: enabled }],
          expectedVersion: config.version,
        })
      }
      const data = { enabled: enabled ?? config.values[KEY] ?? spec.default }
      return { text: JSON.stringify(data), data }
    },
  },
}
