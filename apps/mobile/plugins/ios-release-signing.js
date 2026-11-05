// 只给应用的 Release 配置指定分发身份，不能把描述文件参数传给 Pods 目标。
const { withXcodeProject } = require('expo/config-plugins')

module.exports = function iosReleaseSigning(config) {
  const profile = process.env.LITCH_IOS_PROFILE_UUID
  if (!profile) return config
  const team = process.env.LITCH_IOS_TEAM_ID
  const identity = process.env.LITCH_IOS_CERT_SHA1
  if (!/^[A-Z0-9]{10}$/.test(team ?? '') || !/^[A-F0-9]{40}$/i.test(identity ?? ''))
    throw new Error('iOS 分发签名缺少团队或证书指纹')
  if (!/^[A-F0-9-]{36}$/i.test(profile) || config.ios.bundleIdentifier !== 'dev.litch.app')
    throw new Error('iOS 分发描述文件或正式包名无效')
  return withXcodeProject(config, (result) => {
    const project = result.modResults
    const targets = Object.values(project.pbxNativeTargetSection()).filter(
      (target) => target.productType === '"com.apple.product-type.application"',
    )
    if (targets.length !== 1) throw new Error('必须恰好有一个 iOS 应用目标')
    const configs = project.pbxXCConfigurationList()[targets[0].buildConfigurationList]
    let changed = false
    for (const item of configs.buildConfigurations) {
      const build = project.pbxXCBuildConfigurationSection()[item.value]
      if (build.name !== 'Release') continue
      Object.assign(build.buildSettings, {
        CODE_SIGN_STYLE: 'Manual',
        DEVELOPMENT_TEAM: team,
        CODE_SIGN_IDENTITY: identity,
        PROVISIONING_PROFILE_SPECIFIER: `"${profile}"`,
      })
      changed = true
    }
    if (!changed) throw new Error('缺少应用 Release 配置')
    return result
  })
}
