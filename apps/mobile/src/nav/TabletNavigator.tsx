// 所有路由留在同一棵组件树；窗口变化只改容器尺寸，不重建导航栈或输入框。
import {
  createNavigatorFactory,
  type ParamListBase,
  type StackActionHelpers,
  type StackNavigationState,
  StackRouter,
  type StackRouterOptions,
  useNavigationBuilder,
} from '@react-navigation/native'
import type {
  NativeStackNavigationEventMap,
  NativeStackNavigationOptions,
  NativeStackNavigatorProps,
} from '@react-navigation/native-stack'
import { useRef, useState } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useT } from '../ui/i18n'
import { Empty } from '../ui/kit/controls'
import { useTheme } from '../ui/theme'
import { PaneContext } from './pane'
import {
  navigationRoute,
  orderTabletRoutes,
  type Pane,
  TABLET_SPLIT,
  tabletLayout,
} from './tablet-layout'

export function TabletNavigator(props: NativeStackNavigatorProps) {
  const { width: windowWidth } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  // 系统窗口指标可能先于原生容器更新；分栏只服从实际分配到的宽度。
  const [width, setWidth] = useState(windowWidth - insets.left - insets.right)
  const split = useRef(false)
  split.current = width >= TABLET_SPLIT
  const { state, descriptors, render } = useNavigationBuilder<
    StackNavigationState<ParamListBase>,
    StackRouterOptions,
    StackActionHelpers<ParamListBase>,
    NativeStackNavigationOptions,
    NativeStackNavigationEventMap
  >(StackRouter, {
    ...props,
    UNSTABLE_router: (router) => ({
      getStateForAction(state, action, options) {
        const next = router.getStateForAction(state, action, options)
        if (
          !next ||
          next.stale !== false ||
          !split.current ||
          !['NAVIGATE', 'PUSH'].includes(action.type)
        )
          return next
        if (!navigationRoute(next.routes[next.index]?.name ?? '')) return next
        const routes = orderTabletRoutes(next.routes)
        return { ...next, routes, index: routes.length - 1 }
      },
    }),
  })
  const { c } = useTheme()
  const t = useT()
  const layout = tabletLayout(width, state.routes, state.index)
  return render(
    <View
      testID={layout.split ? 'tablet:split' : 'tablet:single'}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[
        styles.root,
        { backgroundColor: c.win, marginLeft: insets.left, marginRight: insets.right },
      ]}
    >
      {layout.split && !layout.panes.content ? (
        <View style={[styles.empty, { left: layout.sidebar }]}>
          <Empty title={t('app.selectSession')} />
        </View>
      ) : null}
      {state.routes.map((route) => {
        const pane = (Object.keys(layout.panes) as Pane[]).find(
          (key) => layout.panes[key] === route.key,
        )
        const visible = pane !== undefined
        const left = pane === 'navigation' ? 0 : layout.sidebar
        return (
          <PaneContext.Provider
            key={route.key}
            value={{
              pane: pane ?? 'content',
              split: layout.split,
              visible,
              width:
                pane === 'navigation'
                  ? layout.sidebar
                  : pane === 'tool'
                    ? layout.tool
                    : width - layout.sidebar - layout.tool,
              back: () =>
                descriptors[route.key]?.navigation.dispatch({
                  type: 'GO_BACK',
                  source: route.key,
                  target: state.key,
                }),
            }}
          >
            <View
              testID={visible ? `tablet:${pane}` : undefined}
              pointerEvents={visible ? 'auto' : 'none'}
              accessibilityElementsHidden={!visible}
              importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
              style={[
                styles.page,
                { backgroundColor: c.win, borderColor: c.line1 },
                pane === 'navigation'
                  ? { left: 0, width: layout.sidebar, borderRightWidth: 1 }
                  : pane === 'tool'
                    ? { right: 0, width: layout.tool, borderLeftWidth: 1 }
                    : { left, right: layout.tool },
                !visible ? styles.hidden : null,
              ]}
            >
              {descriptors[route.key]?.render()}
            </View>
          </PaneContext.Provider>
        )
      })}
    </View>,
  )
}

export const tabletStack = createNavigatorFactory(TabletNavigator)()
const styles = StyleSheet.create({
  root: { flex: 1 },
  page: { position: 'absolute', top: 0, bottom: 0 },
  empty: { position: 'absolute', top: 0, bottom: 0, right: 0, justifyContent: 'center' },
  hidden: { display: 'none' },
})
