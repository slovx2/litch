// 界面预览的首页（打开预览地址看到的就是它）：左边是场景，右边是一块或两块手机屏。
// 手机屏是 iframe，里面是完整的应用（/?app=1&...，见 frame.ts），所以底部弹层、确认框都在屏里，不会跑到外面。
// 选了什么记在地址上（?scene=&look=&lang=&size=），复制地址给别人打开是同一屏。
import { useEffect, useMemo, useState } from 'react'
import { SCENES } from './scenes.web.ts'
import { CSS } from './style.web.ts'

type Look = 'light' | 'dark' | 'both'
type Lang = 'zh-CN' | 'en'

const SIZES = [
  { id: '412', w: 412, h: 915, name: '412 × 915' },
  { id: '360', w: 360, h: 780, name: '360 × 780' },
  { id: '320', w: 320, h: 640, name: '320 × 640' },
] as const

interface State {
  scene: string
  look: Look
  lang: Lang
  size: (typeof SIZES)[number]['id']
}

function readState(): State {
  const params = new URLSearchParams(location.search)
  const look = params.get('look')
  const size = SIZES.find((entry) => entry.id === params.get('size'))
  return {
    scene: SCENES.some((scene) => scene.id === params.get('scene'))
      ? (params.get('scene') as string)
      : 'home',
    look: look === 'light' || look === 'dark' ? look : 'both',
    lang: params.get('lang') === 'en' ? 'en' : 'zh-CN',
    size: size?.id ?? '412',
  }
}

function frameUrl(state: State, appearance: 'light' | 'dark'): string {
  const params = new URLSearchParams({ app: '1', scene: state.scene, appearance, lang: state.lang })
  return `/?${params}`
}

function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly (readonly [T, string])[]
  onChange(next: T): void
}) {
  return (
    <div className="pv-seg-row">
      <span className="pv-label">{label}</span>
      <fieldset className="pv-seg" aria-label={label}>
        {options.map(([id, name]) => (
          <button key={id} type="button" aria-pressed={id === value} onClick={() => onChange(id)}>
            {name}
          </button>
        ))}
      </fieldset>
    </div>
  )
}

export function PreviewIndex() {
  const [state, setState] = useState(readState)
  const [query, setQuery] = useState('')
  // 点同一个场景也要重新载入（数据重置）：屏的 key 带上它
  const [round, setRound] = useState(0)
  const set = (patch: Partial<State>) => {
    setState((current) => ({ ...current, ...patch }))
    setRound((n) => n + 1)
  }
  useEffect(() => {
    const params = new URLSearchParams({ ...state })
    history.replaceState(null, '', `/?${params}`)
  }, [state])

  const groups = useMemo(() => {
    const words = query.trim().toLowerCase()
    const shown = SCENES.filter((scene) =>
      `${scene.group} ${scene.name} ${scene.note}`.toLowerCase().includes(words),
    )
    return [...new Set(shown.map((scene) => scene.group))].map((group) => ({
      group,
      scenes: shown.filter((scene) => scene.group === group),
    }))
  }, [query])

  const size = SIZES.find((entry) => entry.id === state.size) ?? SIZES[0]
  const looks: ('light' | 'dark')[] = state.look === 'both' ? ['light', 'dark'] : [state.look]
  const current = SCENES.find((scene) => scene.id === state.scene)

  return (
    <div className="pv">
      <style>{CSS}</style>
      <aside className="pv-side">
        <header className="pv-head">
          <h1>Litch 移动端 · 界面预览</h1>
          <p>和应用是同一套页面，数据来自模拟核心。每次打开场景都重新载入，数据跟着重置。</p>
        </header>
        <div className="pv-tools">
          <Seg
            label="明暗"
            value={state.look}
            options={[
              ['both', '并排'],
              ['light', '浅色'],
              ['dark', '深色'],
            ]}
            onChange={(look) => set({ look })}
          />
          <Seg
            label="语言"
            value={state.lang}
            options={[
              ['zh-CN', '中文'],
              ['en', 'English'],
            ]}
            onChange={(lang) => set({ lang })}
          />
          <Seg
            label="屏幕"
            value={state.size}
            options={SIZES.map((entry) => [entry.id, entry.name] as const)}
            onChange={(next) => set({ size: next })}
          />
        </div>
        <input
          className="pv-search"
          type="search"
          placeholder="筛选场景"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <nav className="pv-list" aria-label="场景">
          {groups.map(({ group, scenes }) => (
            <section key={group}>
              <h2>{group}</h2>
              {scenes.map((scene) => (
                <button
                  key={scene.id}
                  type="button"
                  aria-current={scene.id === state.scene ? 'true' : undefined}
                  onClick={() => set({ scene: scene.id })}
                >
                  <b>{scene.name}</b>
                  <span>{scene.note}</span>
                </button>
              ))}
            </section>
          ))}
        </nav>
      </aside>
      <main className="pv-main">
        <div className="pv-bar">
          <b>{current?.name}</b>
          <span>{current?.note}</span>
          <button type="button" onClick={() => setRound((n) => n + 1)}>
            重新载入
          </button>
        </div>
        <div className="pv-phones">
          {looks.map((look) => (
            <figure key={look} className="pv-phone">
              <iframe
                key={`${look}-${round}`}
                title={`${current?.name ?? ''} · ${look}`}
                src={frameUrl(state, look)}
                style={{ width: size.w, height: size.h }}
              />
              <figcaption>
                {look === 'light' ? '浅色' : '深色'} ·{' '}
                <a href={frameUrl(state, look)} target="_blank" rel="noreferrer">
                  单独打开
                </a>
              </figcaption>
            </figure>
          ))}
        </div>
      </main>
    </div>
  )
}
