// 访问范围“禁止常用敏感位置”的内置名单（08 号设计 3.3，决 248）。以 ~ 开头的是主目录下的。
// 设置页显示它，切到“自定义”时从它抄一份起步。改名单就改这里，随版本更新。
export const SENSITIVE_PRESETS: readonly string[] = [
  '~/.ssh',
  '~/.gnupg',
  '~/Library/Keychains',
  // 浏览器的资料（Cookie、保存的密码）
  '~/Library/Application Support/Google/Chrome',
  '~/Library/Application Support/Firefox',
  '~/Library/Application Support/Microsoft Edge',
  '~/Library/Application Support/BraveSoftware',
  '~/Library/Application Support/Arc',
  '~/Library/Safari',
  '~/Library/Cookies',
  // Litch 自己的设置和状态
  '~/Library/Application Support/Litch',
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
