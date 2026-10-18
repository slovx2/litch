// expo prebuild 时改安卓工程的两处（android/ 是生成的，不进仓库，改动只能放在这里）：
// 1. 版本号：versionCode 由 app.json 的 version 算出来（主 × 1000000 + 次 × 1000 + 修订，0.9.0 是 9000），
//    安卓只认 versionCode 变大才能覆盖安装，不用每次另外记着改。
// 2. release 包的签名：给了下面四个环境变量就用这把发版钥匙签；没给（本机调试、流水线里的端到端）照旧用调试钥匙。
//    LITCH_ANDROID_KEYSTORE           钥匙库文件的绝对路径（PKCS12）
//    LITCH_ANDROID_KEYSTORE_PASSWORD  钥匙库的密码
//    LITCH_ANDROID_KEY_ALIAS          钥匙的别名
//    LITCH_ANDROID_KEY_PASSWORD       钥匙的密码（PKCS12 里和钥匙库的密码是同一个）
// 钥匙库和密码怎么来、存在哪见 CONTRIBUTING.md 的“发版”一节。
const { withAppBuildGradle } = require('expo/config-plugins')

const versionCodeOf = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '')
  if (!match) throw new Error(`app.json 的 version 要是 主.次.修订：${version}`)
  const [major, minor, patch] = match.slice(1).map(Number)
  if (minor > 999 || patch > 999) throw new Error(`版本号的次、修订要小于 1000：${version}`)
  return major * 1_000_000 + minor * 1000 + patch
}

const SIGNING = `
        release {
            def keystore = System.getenv('LITCH_ANDROID_KEYSTORE')
            if (keystore) {
                storeFile file(keystore)
                storePassword System.getenv('LITCH_ANDROID_KEYSTORE_PASSWORD')
                keyAlias System.getenv('LITCH_ANDROID_KEY_ALIAS')
                keyPassword System.getenv('LITCH_ANDROID_KEY_PASSWORD')
            }
        }`

module.exports = function releaseSigning(config) {
  config.android = { ...config.android, versionCode: versionCodeOf(config.version) }
  return withAppBuildGradle(config, (gradle) => {
    let text = gradle.modResults.contents
    const debugBlock = /(signingConfigs \{\n\s+debug \{[^}]*\})/
    if (!debugBlock.test(text))
      throw new Error('build.gradle 里没找到 signingConfigs.debug，Expo 的模板变了')
    text = text.replace(debugBlock, `$1${SIGNING}`)
    // release 构建类型里那一行 signingConfig signingConfigs.debug（模板的注释紧跟在 release { 后面）
    const releaseUse = /(release \{[^{}]*?)signingConfig signingConfigs\.debug/
    if (!releaseUse.test(text))
      throw new Error('build.gradle 的 release 构建类型里没找到 signingConfig，Expo 的模板变了')
    text = text.replace(
      releaseUse,
      "$1signingConfig System.getenv('LITCH_ANDROID_KEYSTORE') ? signingConfigs.release : signingConfigs.debug",
    )
    gradle.modResults.contents = text
    return gradle
  })
}
