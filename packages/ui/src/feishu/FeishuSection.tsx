// 设备详情里“飞书”一节：每个应用一行（头像、机器人名、分配的经理、连接状态点），点一行进应用详情；
// 标题行的 + 打开添加向导。设备服务不支持（没有 litchFeishu）不出这一节。
import type { DeviceView } from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Forward, Icon } from '../app/icons.tsx'
import { useDeviceManagers } from '../external/data.ts'
import { Dot } from '../external/parts.tsx'
import { AddApp } from './AddApp.tsx'
import { useFeishuDevice } from './data.ts'
import { connectionReason, type FeishuApp, STATE_TONE, shownState } from './model.ts'

/** 机器人头像：桌面渲染进程不加载外部图片，画名字首字 */
export function BotAvatar({ app }: { app: Pick<FeishuApp, 'name' | 'appId'> }) {
  return (
    <span className="ext-avatar" aria-hidden="true">
      {[...(app.name || app.appId)][0]?.toUpperCase()}
    </span>
  )
}

/** 一个应用的连接状态：一个点，文字放悬停提示；失败带原因 */
export function StateDot({ app }: { app: FeishuApp }) {
  const t = useT()
  const state = shownState(app)
  const reason = connectionReason(app)
  const label = t(`feishu.state.${state}`) + (reason ? ` · ${t(`feishu.conn.${reason}`)}` : '')
  return <Dot tone={STATE_TONE[state]} label={label} />
}

export function FeishuSection({
  device,
  onOpen,
}: {
  device: DeviceView
  onOpen(appId: string): void
}) {
  const t = useT()
  const supported = device.feishu === true
  const view = useFeishuDevice(device.id, supported)
  const managers = useDeviceManagers(device.id)
  const [adding, setAdding] = useState(false)
  if (!supported) return null
  const online = device.connection === 'online'
  const apps = view?.apps.value ?? null
  const error = view?.apps.error ?? null
  const managerName = (id: string | null) =>
    id ? (managers.find((one) => one.id === id)?.name ?? id) : t('feishu.unassigned')
  return (
    <section className="mng-sec" data-sec="feishu">
      <div className="mng-sec-head">
        <h2>{t('feishu.title')}</h2>
        {!online ? <span className="mng-sum ell">{t('feishu.offline')}</span> : null}
        <span className="grow" />
        <button
          type="button"
          className="ibtn"
          data-act="feishu-add"
          title={t('feishu.add')}
          aria-label={t('feishu.add')}
          disabled={!online}
          onClick={() => setAdding(true)}
        >
          <Icon name="plus" small />
        </button>
      </div>
      {error ? (
        <div className="devp-note err" role="alert">
          {error.text ? t.text(error.text) : error.message}
        </div>
      ) : null}
      {apps === null ? (
        error ? null : (
          <div className="ext-empty">{t('feishu.loading')}</div>
        )
      ) : apps.length === 0 ? (
        <div className="ext-empty">{t('feishu.none')}</div>
      ) : (
        <ul className="ext-list">
          {apps.map((app) => {
            const reason = connectionReason(app)
            const state = shownState(app)
            return (
              <li key={app.appId}>
                <button
                  type="button"
                  className="ext-row fs-app-row"
                  data-feishu-app={app.appId}
                  title={t('feishu.openApp')}
                  onClick={() => onOpen(app.appId)}
                >
                  <BotAvatar app={app} />
                  <b className="ext-row-name ell">{app.name || app.appId}</b>
                  <span className="ext-row-meta ell">{managerName(app.managerId)}</span>
                  <span className="grow" />
                  <span className="ext-row-meta ell" data-tone={STATE_TONE[state]}>
                    {t(`feishu.state.${state}`)}
                    {reason ? ` · ${t(`feishu.conn.${reason}`)}` : ''}
                  </span>
                  <StateDot app={app} />
                  <Forward />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {adding && online ? (
        <AddApp
          deviceId={device.id}
          onClose={() => setAdding(false)}
          onAdded={(appId) => {
            setAdding(false)
            onOpen(appId)
          }}
        />
      ) : null}
    </section>
  )
}
