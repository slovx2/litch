// 侧栏顶上的筛选：只看某个 harness 的会话。
// 平时是“新对话”右边一个小按钮，点开挑；挑了以后下面多一行说正在只看谁，点那一行就取消。
// 连着的设备里一共只有一个 harness 的时候没什么可挑，按钮不出现。
// 挑的是哪个记在界面本地（state.ts）；树里怎么跟着筛在 Sidebar.tsx。
import { type DeviceView, keys } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { Close, Icon } from '../app/icons.tsx'
import { usePopover } from '../app/popover.ts'
import { useKey, useKeys } from '../app/services.tsx'
import { describeHarness, harnessChoices } from './filter.ts'
import { setSidebarHarness, useSidebarHarness } from './state.ts'

const NO_DEVICES: readonly string[] = []

export function HarnessFilter() {
  const t = useT()
  const only = useSidebarHarness()
  const deviceIds = useKey<string[]>(keys.devices) ?? NO_DEVICES
  const devices = useKeys<DeviceView>(deviceIds.map(keys.device))
  const { open, setOpen, close, root, trigger, pop, onKeyDown } = usePopover()
  const choices = harnessChoices(devices)
  // 没什么可挑的就不出。正筛着的时候不能不出：得有地方看见、有地方取消
  if (choices.length < 2 && only === null) return null
  const current = only === null ? null : describeHarness(devices, only)
  // 正筛着的那个现在不在能挑的里面（它所在的设备断了）：也列出来，不然列表里看不出挑的是谁
  const options =
    current && !choices.some((choice) => choice.id === current.id) ? [...choices, current] : choices
  const pick = (harness: string | null) => {
    close(true)
    setSidebarHarness(harness)
  }
  return (
    <>
      <div className="sb-filter" ref={root}>
        <button
          ref={trigger}
          type="button"
          className={current ? 'ibtn on' : 'ibtn'}
          title={t('sidebar.filter')}
          aria-label={t('sidebar.filter')}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon name="filter" />
        </button>
        {open ? (
          // biome-ignore lint/a11y/noStaticElementInteractions: 键盘事件是从里面的按钮冒上来的
          <div className="pick-pop down" ref={pop} onKeyDown={onKeyDown}>
            <div role="listbox" aria-label={t('sidebar.filter')} className="pick-list">
              <div className="pick-title">{t('sidebar.filter')}</div>
              <button
                type="button"
                role="option"
                aria-selected={only === null}
                className="pick-opt"
                data-harness=""
                onClick={() => pick(null)}
              >
                <b>{t('sidebar.filter.all')}</b>
              </button>
              {options.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  role="option"
                  aria-selected={only === choice.id}
                  className="pick-opt"
                  data-harness={choice.id}
                  onClick={() => pick(choice.id)}
                >
                  <b>
                    <span className="chip">{choice.badge}</span>
                    {choice.name}
                  </b>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {current ? (
        // 整行是一个按钮：点一下就回到都看
        <button
          type="button"
          className="sb-filter-on"
          title={t('sidebar.filter.clear')}
          data-harness={current.id}
          onClick={() => setSidebarHarness(null)}
        >
          <span className="chip">{current.badge}</span>
          <span className="ell grow">{t('sidebar.filter.on', { name: current.name })}</span>
          <Close />
        </button>
      ) : null}
    </>
  )
}
