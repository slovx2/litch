export const zhChrome = {
  'chrome.title': 'Chrome',
  'chrome.note': '在这台 Mac 的 Chrome 中操作已登录的网站。每个来源单独审批。',
  'chrome.enable': '允许代理使用 Chrome',
  'chrome.unsupported': '目前仅支持 macOS。',
  'chrome.unprepared': '尚未准备扩展',
  'chrome.disconnected': '扩展未连接；加载或重新加载扩展后自动连接。',
  'chrome.mismatch': '扩展版本不一致，请在扩展页重新加载。',
  'chrome.connected': '扩展已连接',
  'chrome.prepare': '准备扩展',
  'chrome.extensions': '打开扩展页',
  'chrome.directory': '打开扩展目录',
  'chrome.stop': '停止全部 Chrome 操作',
  'chrome.install':
    '在 Chrome 扩展页开启“开发者模式”，选择“加载已解压的扩展程序”，选取以下目录。更新 Litch 后请重新加载扩展。',
  'chrome.version': '所需版本 {version}',
  'chrome.remote': '远程设备',
  'chrome.remoteNote': '选中的设备可请求操作这台 Mac 的 Chrome，仍需逐来源批准。',
  'chrome.signIn': '在 Chrome 中登录',
  'chrome.signInNote':
    '请在 Chrome 中完成登录。等待期间，代理无法读取或操作此标签。完成后重新载入页面并交还控制。',
  'chrome.signInDone': '登录已完成',
  'chrome.approve': '允许访问 Chrome 网站',
} as const
