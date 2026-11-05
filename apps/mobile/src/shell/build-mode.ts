// Expo 在打包时内联这个变量。Release E2E 显式开启；发布构建固定为 0，不能由深链或本地设置开启。
export const devToolsEnabled = (): boolean => process.env.EXPO_PUBLIC_LITCH_E2E === '1'

export function productionPrefs<T extends { boot?: string }>(saved: T): T {
  return devToolsEnabled() ? saved : { ...saved, boot: 'stored' }
}
