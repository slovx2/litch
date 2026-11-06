export const zhChrome = {
  'chrome.tab': '允许控制这个 Chrome 标签页？',
  'chrome.tabAllow': '允许控制',
  'chrome.trustDone': '已信任 Chrome 中的所有网站。可在“设置 → Chrome”中关闭或设置黑名单',
  'chrome.instance': '允许使用这个 Chrome',
  'chrome.instanceLabel': '实例',
  'chrome.instanceNote':
    '允许代理列出此 Chrome 实例的标签标题和网址。访问页面内容遵循 Chrome 站点权限设置，用户标签仍需单独认领。',
  'chrome.title': 'Chrome',
  'chrome.note': '在这台电脑的 Chrome 中操作已登录的网站。站点权限单独设置。',
  'chrome.permissionsNote':
    '总开关打开后，本机和下方勾选设备的会话可使用这台电脑上已连接的 Chrome，包括已登录的用户标签；无需另批实例或标签。页面访问由下方网站权限控制，登录仍需单独确认。',
  'chrome.stopped': '用户已停止 Chrome 控制，请点击 Chrome 工具栏中的 Litch 扩展重新打开。',
  'chrome.enable': '允许代理使用 Chrome',
  'chrome.unsupported': '此平台不支持。',
  'chrome.browsers.darwin': '支持 Google Chrome 正式版。',
  'chrome.browsers.win32': '支持 Google Chrome 正式版；Edge 等其他浏览器暂不支持。',
  'chrome.browsers.linux': '支持 Google Chrome；已装 Chromium 的同时登记 Chromium。',
  'chrome.checking': '正在检查扩展连接…',
  'chrome.unprepared': '尚未设置 Chrome 连接',
  'chrome.disconnected': '等待扩展连接',
  'chrome.waitingHelp':
    '保持 Chrome 开启。若已安装扩展，请在扩展页确认 Litch Browser 已启用；连接后此处自动更新。',
  'chrome.extensionOutdated': '扩展版本过旧，与此版本的 Litch 不兼容。请在扩展页重新加载。',
  'chrome.extensionOutdatedStore':
    '扩展版本过旧，与此版本的 Litch 不兼容。请在扩展页点“更新”，或等待 Chrome 自动更新。',
  'chrome.litchOutdated': '扩展版本较新，请升级 Litch。',
  'chrome.reloadAvailable': '扩展目录中已有 {version} 版，在扩展页重新加载即可更新。',
  'chrome.connected': '扩展已连接',
  'chrome.prepare': '准备扩展',
  'chrome.extensions': '打开扩展页',
  'chrome.store': '在 Chrome 应用商店中打开',
  'chrome.storeHeading': '安装 Litch Browser',
  'chrome.storeInstallAction': '从 Chrome 应用商店安装',
  'chrome.storeInstall':
    '打开商店后，在 Chrome 中添加 Litch Browser。安装完成后自动连接，无需刷新此页。',
  'chrome.unpacked': '备选：手动安装',
  'chrome.manualPrepare': '无法使用应用商店时，可准备本地扩展并通过开发者模式加载。',
  'chrome.directory': '打开扩展目录',
  'chrome.stop': '停止全部 Chrome 操作',
  'chrome.install':
    '在 Chrome 扩展页开启“开发者模式”，选择“加载已解压的扩展程序”，选取以下目录。更新 Litch 后请重新加载扩展。',
  'chrome.version': '扩展目录中的版本 {version}',
  'chrome.remote': '允许使用 Chrome 的远程设备',
  'chrome.remoteNote':
    '这是 Chrome 总开关的设备范围：只允许勾选的远程设备使用这台电脑的 Chrome，不再弹实例或标签卡。网站权限与本机会话相同。',
  'chrome.signIn': '在 Chrome 中登录',
  'chrome.signInNote':
    '请在 Chrome 中完成登录。等待期间，代理无法读取或操作此标签。完成后重新载入页面并交还控制。',
  'chrome.signInDone': '登录已完成',
  'chrome.approve': '允许访问 Chrome 网站',
} as const
