// 测试子进程不能继承派出本会话的真实设备地址、工具路由和身份。
// 夹具专用开关保留；夹具自身的目标与钥匙在清理后再显式设置。
export function fixtureEnvironment(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name]) => !name.startsWith('LITCH_') || name.startsWith('LITCH_FIXTURE_'),
    ),
  )
}
