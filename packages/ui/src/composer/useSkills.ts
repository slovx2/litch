import type { SkillOption, SkillProblem } from '@litch/core'
import { useCallback, useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'

/**
 * 技能取得怎么样了。loading 里的 skills 是上次在这里取到的那一份：先顶着，单子一打开就有东西看，
 * 新的回来再换掉；头一回取是 null
 */
export type SkillsState =
  | { state: 'idle' }
  | { state: 'loading'; skills: SkillOption[] | null }
  /** problems 是对面扫到了却没列出来的那些，带着它说的原因 */
  | { state: 'ready'; skills: SkillOption[]; problems: SkillProblem[] }
  /** 对面不认识这回事（旧版本，或者这个 harness 带不了技能） */
  | { state: 'unsupported' }
  | { state: 'failed'; reason: string }

/** 取到过的记着：一台设备的一个 harness 在一个工作目录下各记各的 */
const known = new Map<string, SkillOption[]>()

type Outcome = Exclude<SkillsState, { state: 'idle' | 'loading' }>

/**
 * 这个 harness 在这个工作目录下能用的技能。wanted 为真（单子打开了）才去取，每打开一次重新取一遍：
 * 技能是磁盘上的文件，随时会多、会少。again 是没取到时再试一次。
 */
export function useSkills(
  where: { deviceId: string; harness: string | undefined; cwd: string | null },
  wanted: boolean,
): { skills: SkillsState; again(): void } {
  const { deviceId, harness, cwd } = where
  const { channel } = useServices()
  const t = useT()
  const key = `${deviceId}\n${harness ?? ''}\n${cwd ?? ''}`
  const [got, setGot] = useState<{ key: string; outcome: Outcome } | null>(null)
  const [round, setRound] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: round 变了就是要再取一遍；说原因用的是当时的语言
  useEffect(() => {
    if (!wanted) return
    const controller = new AbortController()
    setGot(null)
    channel
      .command(
        'device.skills',
        { deviceId, ...(harness ? { harness } : {}), cwd },
        { signal: controller.signal },
      )
      .then(({ skills, problems }) => {
        known.set(key, skills)
        setGot({ key, outcome: { state: 'ready', skills, problems } })
      })
      .catch((error: unknown) => {
        // 单子收起来了、换了地方：这一次的结果不要了
        if (controller.signal.aborted) return
        const unsupported = (error as { code?: string } | null)?.code === 'unsupported'
        setGot({
          key,
          outcome: unsupported
            ? { state: 'unsupported' }
            : { state: 'failed', reason: whyNot(error, t) },
        })
      })
    return () => controller.abort()
  }, [channel, deviceId, harness, cwd, key, wanted, round])

  const again = useCallback(() => setRound((value) => value + 1), [])
  const skills: SkillsState = !wanted
    ? { state: 'idle' }
    : got?.key === key
      ? got.outcome
      : { state: 'loading', skills: known.get(key) ?? null }
  return { skills, again }
}
