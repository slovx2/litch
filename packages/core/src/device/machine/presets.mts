// 访问范围“禁止常用敏感位置”的内置名单。以 ~ 开头的是主目录下的。
// 设置页显示它，切到“自定义”时从它抄一份起步。改名单就改这里，随版本更新。
export const SENSITIVE_PRESETS: readonly string[] = [
  '~/.ssh',
  '~/.gnupg',
  '~/Library/Keychains',
  // 邮件、信息、通讯录、日历（V2 实测：经本机设备服务起的命令读得到，不弹授权框）
  '~/Library/Mail',
  '~/Library/Messages',
  '~/Library/Application Support/AddressBook',
  '~/Library/Calendars',
  // 浏览器的资料（Cookie、保存的密码）
  '~/Library/Application Support/Google/Chrome',
  '~/Library/Application Support/Firefox',
  '~/Library/Application Support/Microsoft Edge',
  '~/Library/Application Support/BraveSoftware',
  '~/Library/Application Support/Arc',
  '~/Library/Safari',
  '~/Library/Cookies',
  // Litch 自己的设置和状态：桌面端的用户数据，以及设备服务的状态目录（设置里有各 harness 的环境变量和密钥，
  // 改了它就能改本机 harness 的启动方式）
  '~/Library/Application Support/Litch',
  '~/.codex-harness-adapter',
  // 各 harness 和常用命令行的登录凭据
  '~/.codex/auth.json',
  '~/.claude/.credentials.json',
  '~/.config/gh',
  '~/.aws',
  '~/.docker/config.json',
  '~/.kube/config',
  '~/.netrc',
  '~/.npmrc',
]
