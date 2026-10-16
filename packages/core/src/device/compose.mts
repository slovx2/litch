// 写消息的时候要向对面问的几样：这个 harness 上有哪些技能、会不会计划模式。
// 都是“针对某个 harness”的请求：聚合面上要指明问谁，别的对面不认识这个参数、不带。
// 有声明照声明：声明了带不了的不去问；没有声明的照常问，对面说不认识这个方法就报“不支持”。
// 这里不替界面记着“它不会”：问一次很便宜，重连之后对面可能升级过。
import type { ClientRequests } from '../../../protocol/src/index.mjs'
import { ChannelError } from '../channel/protocol.mjs'
import type { RpcRequestOptions } from '../connection/rpc.mjs'
import type { HarnessAbilities, HarnessId } from '../model.mjs'
import { projectSkills, type SkillCatalog } from '../projection/skills.mjs'
import { lacksMethod } from './faults.mjs'

export interface ComposeHost {
  online(): boolean
  /**
   * 这件事落在哪个 harness 上。聚合面上是界面给的那个（没给就是第一个可用的，一个可用的都没有就抛错）；
   * 别的对面只有一个 harness，返回 null：请求里不带这个参数
   */
  target(wanted: HarnessId | undefined): HarnessId | null
  /** 对面只有一个 harness（单 harness 模式）时是它；聚合面上是 null */
  sole(): HarnessId | null
  /** 这个 harness 事先声明的会什么、不会什么。没有声明是 null */
  declared(harness: HarnessId): HarnessAbilities | null
  request<M extends keyof ClientRequests>(
    method: M,
    params: ClientRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ClientRequests[M]['result']>
  /** 对面没做成：换成给人看的错误 */
  fail(error: unknown): ChannelError
}

export interface ComposeAids {
  /** 这个 harness 在 cwd 这个工作目录下能用的技能，和没列出来的那些。cwd 给 null 由对面按它自己的当前目录看 */
  skills(harness: HarnessId | undefined, cwd: string | null): Promise<SkillCatalog>
  /**
   * 这个 harness 会不会计划模式：它的协作模式清单里有没有 plan。
   * 没有专门的声明位，问了才知道；对面不认识这个方法、没问成都当不会（界面不出入口，别的不受影响）
   */
  plan(harness: HarnessId | undefined): Promise<boolean>
}

const UNSUPPORTED = '对面不支持这个操作'

export function createComposeAids(host: ComposeHost): ComposeAids {
  /** 发给谁，以及这件事它声明了会不会。没有声明就是 undefined：试了才知道 */
  const aim = (wanted: HarnessId | undefined, ability: keyof HarnessAbilities) => {
    if (!host.online()) throw new ChannelError('offline', '设备没有连上')
    const target = host.target(wanted)
    const owner = target ?? host.sole()
    const declared = owner === null ? null : host.declared(owner)
    if (declared && !declared[ability]) throw new ChannelError('unsupported', UNSUPPORTED)
    return target === null ? {} : { harness: target }
  }

  /** 对面说不认识这个方法：报“不支持”，别的错照常换成给人看的 */
  const ask = async <T,>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (lacksMethod(error)) throw new ChannelError('unsupported', UNSUPPORTED)
      throw host.fail(error)
    }
  }

  return {
    async skills(wanted, cwd) {
      const to = aim(wanted, 'skills')
      const response = await ask(() =>
        host.request('skills/list', { ...(cwd ? { cwds: [cwd] } : {}), ...to }),
      )
      return projectSkills(response)
    },
    async plan(wanted) {
      if (!host.online()) throw new ChannelError('offline', '设备没有连上')
      const target = host.target(wanted)
      try {
        const { data } = await host.request(
          'collaborationMode/list',
          target === null ? {} : { harness: target },
        )
        return Array.isArray(data) && data.some((entry) => entry?.mode === 'plan')
      } catch {
        return false
      }
    },
  }
}
