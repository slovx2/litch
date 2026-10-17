// 应用的根：读设置、定主题和语言、装核心，然后交给页面栈。核心没装好之前只画一块和页面同色的底（不闪）。
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  type Theme as NavTheme,
} from '@react-navigation/native'
import { StatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Linking, StyleSheet, Text, useColorScheme, View } from 'react-native'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Navigator } from './nav/Navigator'
import { type Booted, boot } from './shell/boot'
import { handleDevLink, navigationRef } from './shell/dev-links'
import { loadPrefs, type Prefs, type Services, ServicesProvider, savePrefs } from './shell/services'
import { I18nContext, systemLang, translator } from './ui/i18n'
import { Button } from './ui/kit/controls'
import { makeTheme, ThemeContext } from './ui/theme'

function useBooted(prefs: Prefs, lang: 'zh-CN' | 'en') {
  const [booted, setBooted] = useState<Booted | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // 语言只影响模拟核心的示例数据，换语言不重装核心；attempt 变了就是用户点了“重试”
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上
  useEffect(() => {
    let cancelled = false
    let current: Booted | null = null
    setBooted(null)
    setError(null)
    boot(prefs.boot, lang).then(
      (next) => {
        if (cancelled) next.stop()
        else {
          current = next
          setBooted(next)
        }
      },
      (failure: Error) => {
        if (!cancelled) setError(failure.message)
      },
    )
    return () => {
      cancelled = true
      current?.stop()
    }
  }, [prefs.boot, attempt])
  return { booted, error, retry: () => setAttempt((n) => n + 1) }
}

export default function App() {
  const [prefs, setPrefsState] = useState(loadPrefs)
  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((current) => {
      const next = { ...current, ...patch }
      savePrefs(next)
      return next
    })
  }, [])
  const scheme = useColorScheme()
  const isDark = prefs.appearance === 'system' ? scheme === 'dark' : prefs.appearance === 'dark'
  const theme = useMemo(() => makeTheme(isDark), [isDark])
  const lang = prefs.lang === 'system' ? systemLang() : prefs.lang
  const t = useMemo(() => translator(lang), [lang])
  const { booted, error, retry } = useBooted(prefs, lang)

  const navTheme = useMemo<NavTheme>(() => {
    const base = isDark ? DarkTheme : DefaultTheme
    return {
      ...base,
      colors: { ...base.colors, background: theme.c.win, card: theme.c.panel, text: theme.c.ink },
    }
  }, [isDark, theme])

  // 测试用的链接：要用到最新的 services，放在 ref 里给监听器读
  const services = useRef<Services | null>(null)
  // 启动应用的那个链接只处理一次：换了装法这里会重新挂一遍，再读一次就又换回去了
  const initialHandled = useRef(false)
  useEffect(() => {
    // 现在做不了的（核心还在装、还没有设备）每 250 毫秒再交一次，最多 15 秒；后来的链接顶掉还在等的
    let retry: ReturnType<typeof setTimeout> | undefined
    const handle = (url: string | null, tries = 0) => {
      if (!url) return
      clearTimeout(retry)
      const mode = handleDevLink(url, services.current)
      if (mode === 'later') {
        if (tries < 60) retry = setTimeout(() => handle(url, tries + 1), 250)
        return
      }
      if (mode && mode !== prefs.boot) setPrefs({ boot: mode })
    }
    const subscription = Linking.addEventListener('url', (event) => handle(event.url))
    if (!initialHandled.current) {
      initialHandled.current = true
      void Linking.getInitialURL().then((url) => handle(url))
    }
    return () => {
      clearTimeout(retry)
      subscription.remove()
    }
  }, [prefs.boot, setPrefs])

  let body: React.ReactNode
  if (!booted) {
    body = (
      <View style={[styles.center, { backgroundColor: theme.c.win }]}>
        {error ? (
          <>
            <Text style={[styles.wait, { color: theme.c.err }]}>
              {t('app.bootFailed', { error })}
            </Text>
            <Button label={t('app.retry')} onPress={retry} />
          </>
        ) : null}
      </View>
    )
  } else {
    body = (
      <ServicesProvider
        booted={booted}
        prefs={prefs}
        setPrefs={setPrefs}
        onReady={(value) => (services.current = value)}
      >
        <NavigationContainer ref={navigationRef} theme={navTheme}>
          <Navigator />
        </NavigationContainer>
      </ServicesProvider>
    )
  }
  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <ThemeContext.Provider value={theme}>
          <I18nContext.Provider value={t}>
            <StatusBar style={isDark ? 'light' : 'dark'} />
            {body}
          </I18nContext.Provider>
        </ThemeContext.Provider>
      </KeyboardProvider>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  wait: { fontSize: 14, textAlign: 'center' },
})
