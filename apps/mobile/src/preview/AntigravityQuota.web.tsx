// 预览专用：正式用量页订阅模拟核心的 Antigravity 模型组额度；不读取真实账号。
import { useEffect, useState } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { UsageSheet } from '../detail/usage/UsageSheet'
import { type Booted, boot } from '../shell/boot'
import { loadPrefs, ServicesProvider } from '../shell/services'
import { I18nContext, translator } from '../ui/i18n'
import { makeTheme, SKINS, type Skin, ThemeContext } from '../ui/theme'

const noop = () => {}
export function AntigravityQuotaPreview({ params }: { params: URLSearchParams }) {
  const initialSkin = params.get('skin') as Skin
  const [look, setLook] = useState({
    skin: SKINS.includes(initialSkin) ? initialSkin : 'standard',
    theme: params.get('appearance') ?? 'light',
    lang: params.get('lang') ?? 'zh-CN',
  })
  const [booted, setBooted] = useState<Booted | null>(null)
  useEffect(() => {
    let stopped = false
    let core: Booted | null = null
    void boot('mock', 'zh-CN').then((value) => {
      core = value
      if (stopped) value.stop()
      else setBooted(value)
    })
    return () => {
      stopped = true
      core?.stop()
    }
  }, [])
  Object.assign(window, {
    __litchLook: {
      set: (patch: Partial<typeof look>) => setLook((current) => ({ ...current, ...patch })),
    },
  })
  if (!booted) return null
  return (
    <SafeAreaProvider>
      <I18nContext.Provider value={translator(look.lang === 'en' ? 'en' : 'zh-CN')}>
        <ServicesProvider booted={booted} prefs={loadPrefs()} setPrefs={noop}>
          <ThemeContext.Provider value={makeTheme(look.skin, look.theme === 'dark')}>
            <UsageSheet
              visible
              deviceId="local"
              harness="agy"
              usage={null}
              compact={null}
              onClose={noop}
            />
          </ThemeContext.Provider>
        </ServicesProvider>
      </I18nContext.Provider>
    </SafeAreaProvider>
  )
}
