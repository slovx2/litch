// 模拟核心里“写消息时要问的几样”那一组（真的那一份是 device/compose.mts）：这个 harness 上有哪些技能。
// 应答故意晚一点到，界面上看得到“正在取”；另外演两种没取到的情形：
// - 没有声明的 harness（示例里直接连的那台原生 codex，假装它是个旧版本）：不认识这个方法；
// - build-01 上工作目录是 /var/cache/ci 的那个会话（“缓存目录配额”，目录不在它的工作区里）：头一回取的时候
//   技能目录读不出来，再取一次就好了——看“没取到”和“再试一次”；取到的那一份里另有一项没列出来，看这种怎么交代。
import { ChannelError, type Clock, type Commands } from '../channel/protocol.mjs'
import type { DeviceView, HarnessView } from '../model.mjs'
import { phrase } from '../phrase.mjs'
import { SKILLS_FAILED, SKILLS_SKIPPED, sampleSkills } from './sample-compose.mjs'
import type { SampleLang } from './sample-text.mjs'

export interface MockComposeHost {
  clock: Clock
  /** 应答晚多久到。0 就是当场给 */
  delayMs: number
  lang: SampleLang
  device(deviceId: string): DeviceView | undefined
  /**
   * 本机的 harness 装着产品手册（litch-manual 技能）：技能单子里多这一项，配置助手按钮会放它的技能片。
   * 平常的示例里没有（看“没有技能就把手册的路径写进正文”那一种），开局 fresh 里有
   */
  manual?: boolean
}

/** 产品手册在本机的位置（真的那一份由桌面端装进 ~/.agents/skills） */
const MANUAL_SKILL = '/home/dev/.agents/skills/litch-manual/SKILL.md'

export interface MockCompose {
  /** 是这一组的命令就做掉并返回结果；不是返回 undefined */
  command(name: string, params: unknown): unknown
}

/** 头一回取技能会失败的地方：设备和工作目录 */
const FLAKY = { deviceId: 'build', cwd: '/var/cache/ci' }

export function createMockCompose(host: MockComposeHost): MockCompose {
  const { clock, delayMs, lang } = host
  /** 那个头一回会失败的地方失败过没有 */
  let flaked = false

  const later = <T,>(value: () => T): Promise<T> | T =>
    delayMs > 0
      ? new Promise<T>((resolve, reject) => {
          clock.setTimer(() => {
            try {
              resolve(value())
            } catch (error) {
              reject(error)
            }
          }, delayMs)
        })
      : value()

  /** 问的是哪个 harness：界面给了就是它，没给就是第一个可用的。设备没连上、它用不了都问不成 */
  const reach = (deviceId: string, wanted: string | undefined): HarnessView => {
    const device = host.device(deviceId)
    if (!device) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
    if (device.connection !== 'online') throw new ChannelError('offline', '设备没有连上')
    const harness = wanted
      ? device.harnesses.find((entry) => entry.id === wanted)
      : device.harnesses.find((entry) => entry.state === 'ready')
    if (!harness) {
      throw new ChannelError('rejected', '没有可用的 harness', phrase('fault.noHarness'))
    }
    if (harness.state !== 'ready') {
      const text = phrase('fault.harnessUnavailable', { name: harness.name })
      throw new ChannelError('remote', `${harness.name} 现在不可用`, text)
    }
    return harness
  }

  return {
    command(name, params) {
      if (name !== 'device.skills') return undefined
      const { deviceId, harness: wanted, cwd } = params as Commands['device.skills']['params']
      const harness = reach(deviceId, wanted)
      // 没有声明的：和真的一样，问了才知道它不认识
      if (!harness.abilities?.skills) {
        return later(() => {
          throw new ChannelError('unsupported', '对面不支持这个操作')
        })
      }
      return later(() => {
        if (deviceId === FLAKY.deviceId && cwd === FLAKY.cwd && !flaked) {
          flaked = true
          throw new ChannelError('remote', SKILLS_FAILED[lang])
        }
        const skipped = deviceId === FLAKY.deviceId && cwd === FLAKY.cwd
        const manual =
          host.manual && deviceId === 'local'
            ? [
                {
                  name: 'litch-manual',
                  title: 'litch-manual',
                  note:
                    lang === 'en'
                      ? 'Litch product manual and configuration assistant'
                      : 'Litch 产品手册与配置助手',
                  path: MANUAL_SKILL,
                  scope: 'user' as const,
                },
              ]
            : []
        return {
          skills: [...sampleSkills(harness.id, lang, cwd ?? null), ...manual],
          problems: skipped ? [SKILLS_SKIPPED[lang]] : [],
        }
      })
    },
  }
}
