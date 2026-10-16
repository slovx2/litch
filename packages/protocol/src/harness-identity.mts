// 各 harness 给人看的名字和两个字母的徽标。只在旁边的 harness-identity.json 里写一遍，谁用谁从这里取：
// 引擎在 `runtime/info` 里自报的 displayName 和 badge、设备进程给还没连上过的 harness 用的名字、
// 原生 codex 由设备进程替它整理的那一份；命令行（Go 层）把同一个文件嵌进二进制
// （packages/protocol/identity.go），设置里每个 harness 那一组的标题用的就是这里的 displayName。
// 加一个 harness、改一个名字只改那个 JSON 文件，不要在别处再写一遍。
//
// 名字用的是产品自己的叫法，不是命令名：Claude Code 的命令是 claude，DeepSeek Harness 的命令是 dsh。
//
// 这个文件只引用那份数据，自成一体：引擎包、设备进程都直接引用它。
import identities from './harness-identity.json' with { type: 'json' }

export interface HarnessIdentity {
  displayName: string
  /** 两个字母的徽标，例如 CC、PI */
  badge: string
}

/** 仓库里认识的 harness 的标识 */
export type KnownHarnessId = keyof typeof identities

export const HARNESS_IDENTITY: Readonly<Record<KnownHarnessId, HarnessIdentity>> = identities

/** 按标识（或者引擎自报的引擎名，两者对已知的 harness 是同一个词）取；不认识的是 undefined */
export function harnessIdentity(id: string): HarnessIdentity | undefined {
  return Object.hasOwn(HARNESS_IDENTITY, id) ? HARNESS_IDENTITY[id as KnownHarnessId] : undefined
}
