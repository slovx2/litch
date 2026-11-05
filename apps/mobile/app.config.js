// 验收包与用户正式安装并存；深链也隔离，避免测试操作落到正式应用。
module.exports = ({ config }) => {
  const e2e = process.env.EXPO_PUBLIC_LITCH_E2E
  if (e2e !== undefined && e2e !== '0' && e2e !== '1')
    throw new Error('EXPO_PUBLIC_LITCH_E2E 只能是 0 或 1')
  if (e2e === '1' && (process.env.LITCH_IOS_BUILD_NUMBER || process.env.LITCH_ANDROID_KEYSTORE))
    throw new Error('分发构建不能开启 E2E 开发入口')
  config = { ...config, extra: { ...config.extra, litchE2E: e2e === '1' } }
  // 发布构建号显式传入，重传同一版本时由发布负责人递增。
  const buildNumber = process.env.LITCH_IOS_BUILD_NUMBER
  if (buildNumber && !/^[1-9]\d{0,3}(?:\.\d{1,2}){0,2}$/.test(buildNumber)) {
    throw new Error('LITCH_IOS_BUILD_NUMBER 必须是 Apple 构建号，例如 1.0.1')
  }
  if (buildNumber) config = { ...config, ios: { ...config.ios, buildNumber } }
  return process.env.LITCH_MOBILE_DEV === '1'
    ? {
        ...config,
        name: 'Litch Dev',
        scheme: 'litch-dev',
        android: { ...config.android, package: 'dev.litch.app.dev' },
        ios: { ...config.ios, bundleIdentifier: 'dev.litch.app.dev' },
      }
    : config
}
