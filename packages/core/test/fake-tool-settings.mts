import { TOOL_COLUMNS, toolSettingKey } from '../../protocol/src/client-tools-settings.mjs'
import { fakeSettings, spec } from './fake-settings.mjs'

/** 工具设置使用设备配置接口，模拟服务端对未显式设置 harness 的继承计算。 */
export function fakeToolSettings(harnesses: string[]) {
  const fake = fakeSettings()
  fake.settings.schema.settings.push(spec('tools.machine', 'boolean'))
  fake.settings.snapshot.values['tools.machine'] = false
  for (const harness of [null, ...harnesses])
    for (const column of TOOL_COLUMNS) {
      const key = toolSettingKey(column, harness)
      fake.settings.schema.settings.push(spec(key, 'boolean', { default: column === 'browser' }))
      fake.settings.snapshot.values[key] = column === 'browser'
    }
  const inherit = () => {
    for (const column of TOOL_COLUMNS)
      for (const harness of harnesses) {
        const key = toolSettingKey(column, harness)
        if (!fake.settings.snapshot.explicit.includes(key))
          fake.settings.snapshot.values[key] =
            fake.settings.snapshot.values[toolSettingKey(column)]!
      }
  }
  const write = fake.handlers['litch/device/settings/write']!
  fake.handlers['litch/device/settings/write'] = (params) => {
    const result = write(params)
    inherit()
    return result
  }
  return fake
}
