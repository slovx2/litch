// 一台设备上一个 harness 的详情设置（15 号设计）：从设备详情里那个 harness 的标题行进来。
// 四块各占一个标签：配置（按对面声明的分组摆配置项和动作）、账号（provider、登录、API key）、MCP、指令文件；
// 配置里说有模型清单（modelCatalog）的 harness 多一个“模型”标签。
// 内容全按对面的声明画，界面不认识哪一项是干什么的。改过要重启才生效的，顶上一直提示，可以就地重启。
// 开着这一页才订阅（harnessConfig 主题），核心这时才去设备上读。
import type { DeviceView, HarnessConfigTopicView } from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { Confirm } from '../../app/Confirm.tsx'
import { whyNot } from '../../app/errors.ts'
import { Back, Close } from '../../app/icons.tsx'
import { useServices } from '../../app/services.tsx'
import { showToast } from '../../app/toasts.tsx'
import { AccountsTab } from './AccountsTab.tsx'
import { ConfigTab } from './ConfigTab.tsx'
import { InstructionsTab } from './InstructionsTab.tsx'
import { McpTab } from './McpTab.tsx'
import { ModelsTab } from './ModelsTab.tsx'

type Tab = 'config' | 'accounts' | 'models' | 'mcp' | 'instructions'
const TABS: readonly Tab[] = ['config', 'accounts', 'models', 'mcp', 'instructions']

/** 订阅这个 harness 的详情设置。订不上（设备没了）是 'error' */
export function useHarnessConfig(
  deviceId: string,
  harness: string,
): HarnessConfigTopicView | undefined | 'error' {
  const { channel } = useServices()
  const [view, setView] = useState<HarnessConfigTopicView | 'error'>()
  useEffect(() => {
    setView(undefined)
    return channel.subscribe(
      { kind: 'harnessConfig', deviceId, harness },
      {
        snapshot: (data) => setView(data),
        delta: (ops) => {
          const last = ops.at(-1)
          if (last) setView(last.view)
        },
        error: () => setView('error'),
      },
    )
  }, [channel, deviceId, harness])
  return view
}

interface PageProps {
  device: DeviceView
  harnessId: string
  /** 回到设备详情 */
  onBack(): void
  /** 回到对话 */
  onClose(): void
}

export function HarnessSettingsPage({ device, harnessId, onBack, onClose }: PageProps) {
  const t = useT()
  const view = useHarnessConfig(device.id, harnessId)
  const harness = device.harnesses.find((entry) => entry.id === harnessId)
  const name = harness?.name ?? harnessId
  const [tab, setTab] = useState<Tab>('config')

  // Esc 回到设备详情。开着对话框的时候 Esc 归对话框
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('dialog[open]')) return
      event.preventDefault()
      onBack()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onBack])

  const ready = view !== undefined && view !== 'error' && view.supported === true
  const catalog = ready && view.config.data?.modelCatalog === true
  const tabs = TABS.filter((one) => one !== 'models' || catalog)
  // 模型标签没了（重读后说没有了）：回到配置
  const shown: Tab = tabs.includes(tab) ? tab : 'config'
  let body = null
  if (view === undefined) {
    body = (
      <div className="mng-state" data-hc-state="loading">
        {t('manage.loading')}
      </div>
    )
  } else if (view === 'error' || view.supported === null) {
    body = (
      <div className="mng-state" data-hc-state="offline">
        {t('hc.offline')}
      </div>
    )
  } else if (!view.supported) {
    body = (
      <div className="mng-state" data-hc-state="unsupported">
        {t('hc.unsupported', { name })}
      </div>
    )
  }

  return (
    <div className="arch-page devp mng-page hc-page" data-hc={harnessId} data-hc-device={device.id}>
      <header className="arch-head">
        <button
          type="button"
          className="ibtn"
          data-act="hc-back"
          title={t('hc.back')}
          aria-label={t('hc.back')}
          onClick={onBack}
        >
          <Back />
        </button>
        <div className="grow">
          <h1 className="mng-title">
            <span className={harness?.state === 'ready' ? 'chip' : 'chip off'}>
              {harness?.badge ?? harnessId.slice(0, 2).toUpperCase()}
            </span>
            <span className="ell">{t('hc.title', { name })}</span>
            <span className="hc-where dim ell">{t.text(device.name)}</span>
          </h1>
        </div>
        <button
          type="button"
          className="ibtn"
          title={t('devices.close')}
          aria-label={t('devices.close')}
          onClick={onClose}
        >
          <Close />
        </button>
      </header>
      <div className="arch-body">
        <div className="mng-wrap">
          <div className="mng hc">
            {ready ? (
              <>
                {view.restartRequired ? (
                  <RestartBanner device={device} name={name} harnessId={harnessId} />
                ) : null}
                {/* biome-ignore lint/a11y/useSemanticElements: 分段按钮，不用 fieldset */}
                <div className="seg hc-tabs" role="group" aria-label={t('hc.title', { name })}>
                  {tabs.map((one) => (
                    <button
                      key={one}
                      type="button"
                      data-tab={one}
                      aria-pressed={shown === one}
                      onClick={() => setTab(one)}
                    >
                      {t(`hc.tab.${one}`)}
                    </button>
                  ))}
                </div>
                {shown === 'config' ? (
                  <ConfigTab device={device} harnessId={harnessId} slot={view.config} />
                ) : shown === 'accounts' ? (
                  <AccountsTab device={device} harnessId={harnessId} view={view} />
                ) : shown === 'models' ? (
                  <ModelsTab device={device} harnessId={harnessId} name={name} slot={view.models} />
                ) : shown === 'mcp' ? (
                  <McpTab device={device} harnessId={harnessId} view={view} />
                ) : (
                  <InstructionsTab device={device} harnessId={harnessId} slot={view.instructions} />
                )}
              </>
            ) : (
              body
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 改过要重启才生效：一直提示，可以就地重启。有回合在跑时问一声要不要照样重启 */
function RestartBanner({
  device,
  name,
  harnessId,
}: {
  device: DeviceView
  name: string
  harnessId: string
}) {
  const t = useT()
  const { channel } = useServices()
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const restart = async (force: boolean) => {
    setAsking(false)
    setBusy(true)
    try {
      const result = await channel.command('device.harness.restart', {
        deviceId: device.id,
        harness: harnessId,
        ...(force ? { force: true } : {}),
      })
      showToast({
        id: `hc-restart:${device.id}:${harnessId}`,
        tone: result.running ? 'plain' : 'err',
        text: (say) =>
          result.running
            ? say('manage.restart.done', { name })
            : say('manage.restart.down', {
                name,
                reason: result.text ? say.said(result.text) : say('harness.unavailable'),
              }),
        lifeMs: 5000,
      })
    } catch (error) {
      if (!force && (error as { code?: string } | null)?.code === 'busy') {
        setAsking(true)
        return
      }
      showToast({
        id: `hc-restart:${device.id}:${harnessId}`,
        tone: 'err',
        text: (say) => say('manage.restart.failed', { name, reason: whyNot(error, say) }),
        lifeMs: 9000,
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="hc-banner" data-hc-restart role="status">
      <span className="grow">{t('hc.restart.note', { name })}</span>
      <button
        type="button"
        className="btn"
        data-act="hc-restart"
        disabled={busy}
        onClick={() => void restart(false)}
      >
        {t(busy ? 'manage.restarting' : 'hc.restart.now')}
      </button>
      {asking ? (
        <Confirm
          title={t('manage.restart.busy.title', { name })}
          note={t('manage.restart.busy.note')}
          yes={t('manage.restart.busy.yes')}
          no={t('manage.restart.busy.no')}
          onYes={() => void restart(true)}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </div>
  )
}
