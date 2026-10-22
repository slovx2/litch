import { Fragment } from 'react'
import { useT } from '../app/appearance.ts'
import { currentPlatform } from '../app/platform.ts'
import type { MessageKey } from '../i18n/index.ts'
import {
  canonical,
  capsOf,
  combosOn,
  SHORTCUT_GROUPS,
  SHORTCUTS,
  type ShortcutGroup,
} from './shortcuts.ts'

/** 组名之外还要交代生效范围的组：只有范围不明显的才写 */
const GROUP_NOTES: Partial<Record<ShortcutGroup, MessageKey>> = {
  request: 'keys.group.request.note',
}

/**
 * 快捷键：现在能用的键的一览表，只能看，不能改。照 shortcuts.ts 那份清单画，按这台电脑的系统写 Cmd 或 Ctrl；
 * 这种系统上没有的键不列。行上带着几样给验收对账用的标记（是哪一条、菜单里的哪一项、键位写成能比的样子）
 */
export function ShortcutsSection() {
  const t = useT()
  const platform = currentPlatform()
  return (
    <>
      {SHORTCUT_GROUPS.map((group) => {
        const rows = SHORTCUTS.filter(
          (shortcut) => shortcut.group === group && combosOn(shortcut, platform).length > 0,
        )
        if (rows.length === 0) return null
        const note = GROUP_NOTES[group]
        return (
          <section key={group} className="set-block" data-keys-group={group}>
            <h3>
              {t(`keys.group.${group}`)}
              {note ? <span>{t(note)}</span> : null}
            </h3>
            <div className="set-rows">
              {rows.map((shortcut) => {
                const combos = combosOn(shortcut, platform)
                return (
                  <div
                    key={shortcut.id}
                    className="set-row key-row"
                    data-shortcut={shortcut.id}
                    data-menu={'menu' in shortcut ? shortcut.menu : undefined}
                    data-combos={combos.map((combo) => canonical(combo, platform)).join(' ')}
                  >
                    <span className="key-what">{t(`keys.${shortcut.id}`)}</span>
                    <span className="key-caps">
                      {combos.map((combo, index) => (
                        <Fragment key={combo}>
                          {index > 0 ? <span className="key-or">/</span> : null}
                          <span className="key-combo">
                            {capsOf(combo, platform).map((cap) => (
                              <kbd key={cap} className="kbd">
                                {cap}
                              </kbd>
                            ))}
                          </span>
                        </Fragment>
                      ))}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </>
  )
}
