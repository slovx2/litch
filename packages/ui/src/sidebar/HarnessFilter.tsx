// 侧栏顶上的筛选：只看某几个 harness 的会话。
// 平时是“新对话”右边一个小按钮，点开挑，可以挑好几个；挑了以后下面多一行说正在只看谁，点那一行就取消。
// 连着的设备里一共只有一个 harness 的时候没什么可挑，按钮不出现。
// 挑的是哪几个记在界面本地（state.ts）；树里怎么跟着筛在 Sidebar.tsx。
import { type DeviceView, keys } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { Check, Close, Icon } from '../app/icons.tsx'
import { usePopover } from '../app/popover.ts'
import { useKey, useKeys } from '../app/services.tsx'
import { describeHarness, harnessChoices, toggleHarness } from './filter.ts'
import { setSidebarHarnesses, useSidebarHarnesses } from './state.ts'

const NO_DEVICES: readonly string[] = []

export function HarnessFilter() {
  const t = useT()
  const picked = useSidebarHarnesses()
  const deviceIds = useKey<string[]>(keys.devices) ?? NO_DEVICES
  const devices = useKeys<DeviceView>(deviceIds.map(keys.device))
  const { open, setOpen, close, root, trigger, pop, onKeyDown } = usePopover()
  const choices = harnessChoices(devices)
  // 没什么可挑的就不出。正筛着的时候不能不出：得有地方看见、有地方取消
  if (choices.length < 2 && picked.length === 0) return null
  const current = picked.map((id) => describeHarness(devices, id))
  // 挑着的有的现在不在能挑的里面（它所在的设备断了）：也列出来，不然列表里看不出挑的是谁
  const options = [
    ...choices,
    ...current.filter((entry) => !choices.some((choice) => choice.id === entry.id)),
  ]
  const names = current.map((entry) => entry.name).join(t('sidebar.filter.join'))
  return (
    <>
      <div className="sb-filter" ref={root}>
        <button
          ref={trigger}
          type="button"
          className={current.length > 0 ? 'ibtn on' : 'ibtn'}
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
            <div
              role="listbox"
              aria-label={t('sidebar.filter')}
              aria-multiselectable="true"
              className="pick-list"
            >
              <div className="pick-title">{t('sidebar.filter')}</div>
              {/* 都看：一点就清掉、收起 */}
              <button
                type="button"
                role="option"
                aria-selected={picked.length === 0}
                className="pick-opt"
                data-harness=""
                onClick={() => {
                  close(true)
                  setSidebarHarnesses([])
                }}
              >
                <b>
                  <span className="pick-mark">{picked.length === 0 ? <Check /> : null}</span>
                  {t('sidebar.filter.all')}
                </b>
              </button>
              {/* 各个 harness：点一下挑上或去掉，浮层不收，好接着挑 */}
              {options.map((choice) => {
                const on = picked.includes(choice.id)
                return (
                  <button
                    key={choice.id}
                    type="button"
                    role="option"
                    aria-selected={on}
                    className="pick-opt"
                    data-harness={choice.id}
                    onClick={() => setSidebarHarnesses(toggleHarness(picked, choice.id, choices))}
                  >
                    <b>
                      <span className="pick-mark">{on ? <Check /> : null}</span>
                      <span className="chip">{choice.badge}</span>
                      {choice.name}
                    </b>
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>
      {current.length > 0 ? (
        // 整行是一个按钮：点一下就回到都看
        <button
          type="button"
          className="sb-filter-on"
          title={t('sidebar.filter.clear')}
          data-harness={picked.join(',')}
          onClick={() => setSidebarHarnesses([])}
        >
          {current.map((entry) => (
            <span key={entry.id} className="chip">
              {entry.badge}
            </span>
          ))}
          <span className="ell grow">{t('sidebar.filter.on', { name: names })}</span>
          <Close />
        </button>
      ) : null}
    </>
  )
}
