import type { ReactNode } from 'react'
import {
  CHAT_WIDTHS,
  DENSITIES,
  LANGS,
  SKINS,
  type Skin,
  setAppearance,
  THEMES,
  useAppearance,
  useT,
  ZOOMS,
} from '../app/appearance.ts'
import { useServices } from '../app/services.tsx'
import type { Lang, MessageKey } from '../i18n/index.ts'

const SKIN_NOTES: Record<Skin, MessageKey> = {
  retro: 'settings.skin.retro.note',
  human: 'settings.skin.human.note',
  standard: 'settings.skin.standard.note',
}

/** 语言的名字用它自己的字写，不跟着界面的语言变：找不着北的时候也认得出自己那一种 */
export const LANG_NAMES: Record<Lang, string> = { 'zh-CN': '中文', en: 'English' }

/**
 * 一种皮肤的预览。不是截图：这一小块上把那种皮肤的变量整套重新声明了一遍（皮肤样式文件里的 data-skin-preview），
 * 里面的东西只用变量，所以画出来就是那种皮肤；明暗跟着现在的走
 */
function SkinPreview({ skin }: { skin: Skin }) {
  const t = useT()
  return (
    <span className="skin-pv" data-skin-preview={skin} aria-hidden="true">
      <span className="pv-side">
        <i />
        <i className="on" />
        <i />
        <i />
      </span>
      <span className="pv-main">
        <span className="pv-said">{t('settings.preview.said')}</span>
        <span className="pv-reply">
          {t('settings.preview.reply')} <code>1.2s</code>
        </span>
        <span className="pv-box">
          <span>{t('settings.preview.box')}</span>
          <b />
        </span>
      </span>
    </span>
  )
}

/** 几个里选一个的一排按钮。选中的那个 aria-pressed 是 true */
export function Choice<T extends string | number>({
  name,
  value,
  options,
  label,
  disabled,
  onPick,
}: {
  /** 这一排管的是哪一项（验收按它找） */
  name: string
  value: T
  options: readonly T[]
  label(option: T): string
  disabled?: boolean
  onPick(option: T): void
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: 沿用别处那排按钮的写法（.seg），用 fieldset 会带出浏览器自己的边框和排版
    <div className="seg" role="group" data-choice={name}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          data-value={option}
          aria-pressed={option === value}
          disabled={disabled}
          onClick={() => onPick(option)}
        >
          {label(option)}
        </button>
      ))}
    </div>
  )
}

export function Row({
  title,
  note,
  children,
}: {
  title: string
  /** 只有选了会有不明显后果、或者控件不能用要说明原因时才给 */
  note?: string | undefined
  children: ReactNode
}) {
  return (
    <div className="set-row">
      <span className="set-label">{title}</span>
      {children}
      {note ? <span className="set-note">{note}</span> : null}
    </div>
  )
}

/** 外观：皮肤（带预览）、明暗、密度、对话区宽度、界面缩放。点了当场生效 */
export function LookSection() {
  const look = useAppearance()
  const { shell } = useServices()
  const t = useT()
  // 缩放是桌面外壳做的；在普通浏览器里没有外壳，用浏览器自己的缩放
  const canZoom = shell === 'electron'
  return (
    <>
      <section className="set-block">
        <h3>{t('look.skin')}</h3>
        <div className="skins" role="radiogroup" aria-label={t('look.skin')}>
          {SKINS.map((skin) => (
            // biome-ignore lint/a11y/useSemanticElements: 一张卡片里有预览和说明，原生的单选框放不下这些
            <button
              key={skin}
              type="button"
              role="radio"
              className="skin-card"
              data-skin-card={skin}
              aria-checked={skin === look.skin}
              onClick={() => setAppearance({ skin })}
            >
              <SkinPreview skin={skin} />
              <span className="skin-meta">
                <b>
                  {t(`skin.${skin}`)}
                  {skin === look.skin ? (
                    <span className="skin-on">{t('settings.look.skin.inUse')}</span>
                  ) : null}
                </b>
                <span>{t(SKIN_NOTES[skin])}</span>
              </span>
            </button>
          ))}
        </div>
      </section>
      <section className="set-block">
        <div className="set-rows">
          <Row title={t('look.theme')}>
            <Choice
              name="theme"
              value={look.theme}
              options={THEMES}
              label={(theme) => t(`theme.${theme}`)}
              onPick={(theme) => setAppearance({ theme })}
            />
          </Row>
          <Row title={t('look.density')}>
            <Choice
              name="density"
              value={look.density}
              options={DENSITIES}
              label={(density) => t(`density.${density}`)}
              onPick={(density) => setAppearance({ density })}
            />
          </Row>
          <Row title={t('look.chatWidth')}>
            <Choice
              name="chatWidth"
              value={look.chatWidth}
              options={CHAT_WIDTHS}
              label={(width) => t(`chatWidth.${width}`)}
              onPick={(chatWidth) => setAppearance({ chatWidth })}
            />
          </Row>
          <Row title={t('look.zoom')} note={canZoom ? undefined : t('settings.look.zoom.browser')}>
            <Choice
              name="zoom"
              value={look.zoom}
              options={ZOOMS}
              label={(zoom) => `${Math.round(zoom * 100)}%`}
              disabled={!canZoom}
              onPick={(zoom) => setAppearance({ zoom })}
            />
          </Row>
        </div>
      </section>
    </>
  )
}

/** 语言：只有中文和英文两种，没有“跟随系统”——第一次启动时已经按系统语言替用户选好了 */
export function LangSection() {
  const look = useAppearance()
  const t = useT()
  return (
    <section className="set-block">
      <div className="set-rows">
        <Row title={t('look.lang')}>
          <Choice
            name="lang"
            value={look.lang}
            options={LANGS}
            label={(lang) => LANG_NAMES[lang]}
            onPick={(lang) => setAppearance({ lang })}
          />
        </Row>
      </div>
    </section>
  )
}
