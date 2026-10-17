// @react-navigation/native 的替身：只有 src/shell/dev-links.ts 用到的那几样。导航不真走，记下来给测试看。
export const navigated = []

export function createNavigationContainerRef() {
  return {
    ready: true,
    back: false,
    isReady() {
      return this.ready
    },
    navigate(name, params) {
      navigated.push({ name, params })
    },
    canGoBack() {
      return this.back
    },
    dispatch(action) {
      navigated.push({ action })
    },
  }
}

export const StackActions = { popToTop: () => ({ type: 'POP_TO_TOP' }) }
