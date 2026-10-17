// 终端页的外框：竖屏是通用的标题栏；横屏时屏幕矮，键盘一弹起来通用标题栏（52 高）占掉的地方够终端放好几行，
// 换成矮的那一条（Screen 的 compact）。
import type { ReactNode } from 'react'
import { useWindowDimensions } from 'react-native'
import { type HeaderAction, Screen } from '../../../ui/kit/Screen'

export function Frame({
  title,
  subtitle,
  wire,
  actions,
  children,
}: {
  title: string
  subtitle?: string
  wire?: string
  actions: HeaderAction[]
  children: ReactNode
}) {
  const { width, height } = useWindowDimensions()
  return (
    <Screen
      title={title}
      subtitle={subtitle}
      wire={wire}
      actions={actions}
      compact={width > height}
      testID="terminal"
    >
      {children}
    </Screen>
  )
}
