import { keys } from '@litch/core'
import { useCallback, useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Close, Plus } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { AddDevice } from './AddDevice.tsx'
import { DeviceDetail } from './DeviceDetail.tsx'
import { DeviceRow } from './DeviceRow.tsx'

/**
 * 设备：这台电脑和加进来的远程机器，一台一行。这一页只管“有哪些、各自怎么样”和添加；
 * 一台设备的细节和能对它做的事（线色、改名、改连接、移除、重新连接、管理）都在点进去的详情里
 */
export function DevicesPage({ onClose }: { onClose(): void }) {
  const deviceIds = useKey<string[]>(keys.devices) ?? []
  const t = useT()
  const [adding, setAdding] = useState(false)
  /** 点开了哪台设备的详情。null：在列表上 */
  const [detail, setDetail] = useState<string | null>(null)
  /** 刚从哪台设备的详情里退回来：焦点落回它那一行 */
  const [left, setLeft] = useState<string | null>(null)
  const back = useCallback(() => {
    setLeft(detail)
    setDetail(null)
  }, [detail])
  // 开着详情的那台设备没了（被移除）：这一次就画列表，不等详情自己发现再退回来，
  // 否则中间有一帧什么都没有
  const gone = detail !== null && !deviceIds.includes(detail)
  useEffect(() => {
    if (gone) setDetail(null)
  }, [gone])
  const inDetail = detail !== null && !gone

  // Esc 回到对话。开着对话框的时候 Esc 归对话框；开着详情的时候 Esc 归详情（回到这张列表）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || adding || inDetail) return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, adding, inDetail])

  if (inDetail) return <DeviceDetail deviceId={detail} onBack={back} onClose={onClose} />

  return (
    <div className="arch-page devp">
      <header className="arch-head">
        <div>
          <h1>{t('devices.title')}</h1>
        </div>
        <button type="button" className="btn devp-add" onClick={() => setAdding(true)}>
          <Plus />
          {t('sidebar.addDevice')}
        </button>
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
        <div className="devp-wrap">
          <ul className="devp-list">
            {deviceIds.map((deviceId) => (
              <DeviceRow
                key={deviceId}
                deviceId={deviceId}
                focus={deviceId === left}
                onOpen={() => setDetail(deviceId)}
              />
            ))}
          </ul>
        </div>
      </div>
      {adding ? <AddDevice edit={null} onClose={() => setAdding(false)} /> : null}
    </div>
  )
}
