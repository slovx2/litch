// 验收包与用户正式安装并存；深链也隔离，避免测试操作落到正式应用。
module.exports = ({ config }) =>
  process.env.LITCH_MOBILE_DEV === '1'
    ? {
        ...config,
        name: 'Litch Dev',
        scheme: 'litch-dev',
        android: { ...config.android, package: 'dev.litch.app.dev' },
      }
    : config
