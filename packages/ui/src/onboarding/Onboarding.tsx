// 首启引导（14 号设计第四节）：盖在主区域上，侧栏照常能用；右上角能关（等于“以后再说”）。
// 第一步“先装一个 harness”：本机一个可用的都没有时出，列出全部支持的 harness（一句介绍、状态、安装按钮、官方说明），
// 装的过程和没装成的回退和设备页是同一个组件；有一个变成可用就进第二步。
// 第二步“让配置助手帮你设置 Litch”：举几个例子，“打开配置助手”和“以后再说”，点哪个都算走完。
import { type DeviceView, type HarnessVersionView, keys } from '@litch/core'
import { useState } from 'react'
import { requestAssistant } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { nextStep } from '../app/device.ts'
import { Close } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import type { MessageKey } from '../i18n/index.ts'
import { DocsLink, InstallRow } from '../install/InstallRow.tsx'
import { useInstall } from '../install/useInstall.ts'
import { finishOnboarding, onboardingStep, useOnboardingState } from './state.ts'

/** 各 harness 的一句介绍。不认识的说一句通用的 */
const INTROS: Record<string, MessageKey> = {
  claude: 'onboard.intro.claude',
  codex: 'onboard.intro.codex',
  pi: 'onboard.intro.pi',
  dsh: 'onboard.intro.dsh',
  opencode: 'onboard.intro.opencode',
  gemini: 'onboard.intro.gemini',
  qwen: 'onboard.intro.qwen',
  acp: 'onboard.intro.acp',
}

/** 设备上没列、只在版本情况里出现的 harness 的名字 */
const NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
  dsh: 'dsh',
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  qwen: 'Qwen Code',
  acp: 'ACP',
}

const EXAMPLES: readonly MessageKey[] = [
  'onboard.assist.example.remote',
  'onboard.assist.example.phone',
  'onboard.assist.example.harness',
  'onboard.assist.example.look',
]

/** 第一步里的一项 */
function HarnessEntry(props: {
  device: DeviceView
  id: string
  info: HarnessVersionView | undefined
  view: ReturnType<typeof useInstall>
}) {
  const { device, id, info, view } = props
  const t = useT()
  const harness = device.harnesses.find((entry) => entry.id === id)
  const name = harness?.name ?? NAMES[id] ?? id
  const intro = INTROS[id] ?? 'onboard.intro.other'
  const ready = harness?.state === 'ready'
  const failed = view?.jobs.some(
    (job) => job.harness === id && (job.state === 'failed' || job.state === 'lost'),
  )
  return (
    <li className="onb-h" data-onboard-harness={id} data-state={harness?.state ?? 'absent'}>
      <div className="onb-h-head">
        <span className={ready ? 'chip' : 'chip off'}>
          {harness?.badge ?? id.slice(0, 2).toUpperCase()}
        </span>
        <b>{name}</b>
        <span className="dim">
          {ready
            ? t('onboard.install.ready', { version: harness?.version ?? '' })
            : info?.installed
              ? t('install.installed', { version: info.installed })
              : t('install.notInstalled')}
        </span>
      </div>
      <p className="onb-h-intro">{t(intro)}</p>
      {view ? (
        <InstallRow device={device} harnessId={id} view={view} name={name} compact />
      ) : harness && !ready ? (
        // 设备不能装（旧的设备服务）：照原来的说明说下一步
        <p className="onb-h-next dim">{nextStep(harness, t)}</p>
      ) : null}
      {/* 没装成的那一项回退里已经有官方说明了，这里不再放一个 */}
      {info?.installable && !ready && !failed ? (
        <DocsLink href={info.docsUrl}>{t('install.docs')}</DocsLink>
      ) : null}
    </li>
  )
}

function InstallStep({ device }: { device: DeviceView }) {
  const { channel } = useServices()
  const t = useT()
  const view = useInstall(device)
  const [checking, setChecking] = useState(false)
  // 能装的时候列设备给的全部支持的；不能装的时候只有设备列着的那几个
  const ids = [
    ...new Set([
      ...(view?.versions ?? []).map((entry) => entry.harness),
      ...device.harnesses.map((entry) => entry.id),
    ]),
  ]
  /** 我装好了，重新检测：没起来的都重新探一次，版本也重新问 */
  const recheck = async () => {
    setChecking(true)
    const down = device.harnesses.filter((entry) => entry.state === 'unavailable')
    await Promise.allSettled([
      ...down.map((entry) =>
        channel.command('device.harness.restart', { deviceId: device.id, harness: entry.id }),
      ),
      ...(device.install ? [channel.command('install.versions', { deviceId: device.id })] : []),
    ])
    setChecking(false)
  }
  return (
    <>
      <h2>{t('onboard.install.title')}</h2>
      <p className="onb-lead">{t('onboard.install.lead')}</p>
      <ul className="onb-list">
        {ids.map((id) => (
          <HarnessEntry
            key={id}
            device={device}
            id={id}
            info={view?.versions?.find((entry) => entry.harness === id)}
            view={view}
          />
        ))}
      </ul>
      <p className="onb-note">{t('onboard.install.login')}</p>
      <div className="onb-acts">
        <button
          type="button"
          className="btn"
          data-act="onboard-recheck"
          disabled={checking}
          onClick={() => void recheck()}
        >
          {t(checking ? 'install.rechecking' : 'onboard.install.recheck')}
        </button>
        <button
          type="button"
          className="btn ghost"
          data-act="onboard-later"
          onClick={finishOnboarding}
        >
          {t('onboard.later')}
        </button>
      </div>
    </>
  )
}

function AssistStep() {
  const t = useT()
  return (
    <>
      <h2>{t('onboard.assist.title')}</h2>
      <p className="onb-lead">{t('onboard.assist.lead')}</p>
      <ul className="onb-examples">
        {EXAMPLES.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
      <div className="onb-acts">
        <button
          type="button"
          className="btn primary"
          data-act="onboard-assistant"
          onClick={() => {
            finishOnboarding()
            requestAssistant()
          }}
        >
          {t('onboard.assist.open')}
        </button>
        <button
          type="button"
          className="btn ghost"
          data-act="onboard-later"
          onClick={finishOnboarding}
        >
          {t('onboard.later')}
        </button>
      </div>
    </>
  )
}

/** 盖在主区域上的引导。不该出的时候什么都不画 */
export function Onboarding() {
  const t = useT()
  const flags = useOnboardingState()
  const local = useKey<DeviceView>(keys.device('local'))
  const step = onboardingStep(
    flags,
    local
      ? {
          online: local.connection === 'online',
          listed: local.harnesses.length > 0,
          ready: local.harnesses.filter((entry) => entry.state === 'ready').length,
        }
      : null,
  )
  if (!step || !local) return null
  return (
    <div className="onb" data-onboarding={step} role="dialog" aria-label={t('onboard.title')}>
      <div className="onb-card">
        <header className="onb-head">
          <span className="onb-steps">
            <span aria-current={step === 'install' ? 'step' : undefined}>
              {t('onboard.step', { n: 1 })}
            </span>
            <span aria-current={step === 'assist' ? 'step' : undefined}>
              {t('onboard.step', { n: 2 })}
            </span>
          </span>
          <button
            type="button"
            className="ibtn"
            data-act="onboard-close"
            title={t('onboard.close')}
            aria-label={t('onboard.close')}
            onClick={finishOnboarding}
          >
            <Close />
          </button>
        </header>
        {step === 'install' ? <InstallStep device={local} /> : <AssistStep />}
      </div>
    </div>
  )
}
