// 会话中途换供应商（照桌面端 SessionComposer）：开始一轮时记下当时的型号，下一轮要用的型号前缀和它不同就在
// 输入框上面提示一行。判断用桌面那一份（packages/ui/src/composer/provider-switch.ts）。
import type { ComposeOptions } from '@litch/core'
import { useEffect, useState } from 'react'
import { StyleSheet, Text } from 'react-native'
import { switchedProvider } from '../../../../../packages/ui/src/composer/provider-switch.ts'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'

export function ProviderSwitch({
  sessionId,
  harness,
  model,
  running,
  options,
}: {
  sessionId: string
  harness: string | undefined
  /** 下一轮要用的型号（会话设置里的） */
  model: string | null
  running: boolean
  options: ComposeOptions | null
}) {
  const t = useT()
  const { c } = useTheme()
  const [ranWith, setRanWith] = useState<{ sessionId: string; model: string | null } | null>(null)
  useEffect(() => {
    if (model && ranWith?.sessionId !== sessionId) setRanWith({ sessionId, model })
  }, [sessionId, model, ranWith?.sessionId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在开始一轮的那一下记，跑着的时候换了型号算下一轮的
  useEffect(() => {
    if (running) setRanWith({ sessionId, model })
  }, [running, sessionId])
  const name =
    ranWith?.sessionId === sessionId
      ? switchedProvider(ranWith.model, model, options?.models ?? [])
      : null
  if (!name) return null
  return (
    <Text testID="composer:provider-switch" style={[styles.line, { color: c.ink2 }]}>
      {t(harness === 'claude-code' ? 'composer.providerSwitch.claude' : 'composer.providerSwitch', {
        name,
      })}
    </Text>
  )
}

const styles = StyleSheet.create({
  line: { fontSize: 12, lineHeight: 17, paddingHorizontal: 4 },
})
