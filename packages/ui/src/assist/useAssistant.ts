// 配置助手按钮点下去之后，新建对话页上做的那一步：设备已经切到本机，看选中的 harness 有没有产品手册的技能，
// 有就放技能片，没有就把手册的位置写进正文；放进输入框最前面，原来写的接在后面（drafts.ts 的 prefillDraft）。
import type { DeviceView, HarnessView, SkillOption } from '@litch/core'
import { useEffect } from 'react'
import { useT } from '../app/appearance.ts'
import { useServices } from '../app/services.tsx'
import { prefillDraft } from '../composer/drafts.ts'
import { manualBridge } from './manual-bridge.ts'
import { assistPrefill, manualSkillIn } from './prefill.ts'

/** 问技能、问手册的位置最多等这么久：等不到就照没有的写，不让人干等 */
const WAIT_MS = 3000

const within = <T>(work: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([
    work.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ])

/** 手册的位置问过一次就记着（主进程第一次答要等登录 shell 的环境，最长八秒上下） */
let manualDir: string | null | undefined

/**
 * 点配置助手的序号：发号和“已经为第几次做过”都记在组件外面。新建页发送后会卸载，下次进来是新组件，
 * 记在组件里的话标记就丢了，App 那边的序号还是旧的，于是每次进新建页都会再放一遍
 */
let issued = 0
let handled = 0

/** 点了一次配置助手：发一个新序号（App 记下来传给新建页） */
export function nextAssistSeq(): number {
  issued += 1
  return issued
}

/** 先问一次手册在哪，点按钮的时候就不用等了 */
export function warmManualDir(): void {
  if (manualDir !== undefined) return
  void manualBridge()
    ?.status()
    .then((status) => {
      manualDir = status.dir
    })
    .catch(() => {})
}

/**
 * seq：第几次点配置助手（nextAssistSeq 发的号，0 是没点过）。每个号只做一次，要等设备切到本机了才做。
 * draftKey 是新建页那一份草稿的键
 */
export function useAssistant(
  seq: number,
  where: { device: DeviceView | undefined; harness: HarnessView | undefined; cwd: string | null },
  draftKey: string,
): void {
  const { channel } = useServices()
  const t = useT()
  const { device, harness, cwd } = where
  const deviceId = device?.id
  const online = device?.connection === 'online'
  const harnessId = harness?.id
  const skills = harness?.abilities?.skills !== false
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在点了新的一次、或者等的设备到了时做；语言用当时的
  useEffect(() => {
    if (seq === 0 || handled >= seq) return
    if (deviceId !== 'local') return
    handled = seq
    void (async () => {
      let skill: SkillOption | null = null
      if (online && harnessId && skills) {
        const listed = await within(
          channel.command('device.skills', { deviceId, harness: harnessId, cwd }),
          WAIT_MS,
        )
        skill = listed ? manualSkillIn(listed.skills) : null
      }
      let dir: string | null = null
      if (!skill) {
        if (manualDir === undefined) {
          const status = await within(manualBridge()?.status() ?? Promise.resolve(null), WAIT_MS)
          if (status) manualDir = status.dir
        }
        dir = manualDir ?? null
      }
      const { lead, extras } = assistPrefill(t.lang, skill, dir)
      prefillDraft(draftKey, lead, extras)
    })()
  }, [seq, deviceId, online, harnessId, cwd, channel, draftKey])
}
