export const zhCN = {
  'tailscale.title': 'Tailscale',
  'tailscale.switch': '通过 Tailscale 连接',
  'tailscale.guide': '可选：配置 Tailscale 网络',
  'tailscale.scope': '仅用于本应用的 SSH 连接，不占用系统 VPN。SSH 密钥与主机指纹校验保持不变。',
  'tailscale.unavailable': '此平台暂不可用。请安装支持内嵌 Tailscale 的应用版本。',
  'tailscale.control': '控制服务器（可选）',
  'tailscale.control.hint':
    '留空使用 Tailscale；Headscale 请填写 HTTPS 地址。更换服务器前须清除状态。',
  'tailscale.login': '登录',
  'tailscale.open': '打开登录页面',
  'tailscale.logout': '退出登录',
  'tailscale.clear': '清除状态',
  'tailscale.refresh': '刷新',
  'tailscale.back': '返回继续添加',
  'tailscale.node': '节点名',
  'tailscale.tailnet': 'Tailnet',
  'tailscale.state.stopped': '未连接',
  'tailscale.state.starting': '连接中',
  'tailscale.state.needsLogin': '未登录',
  'tailscale.state.needsApproval': '等待管理员批准',
  'tailscale.state.connected': '已连接',
  'tailscale.state.suspended': '后台已暂停',
  'tailscale.logout.detail':
    '所有通过内嵌 Tailscale 的连接将断开，登录后可重连。普通 SSH 连接不受影响。',
  'tailscale.clear.detail':
    '断开所有内嵌 Tailscale 连接并删除本机节点身份。再次登录会注册新节点；原节点需在管理台删除。',
  'tailscale.error.login': '请先在 Tailscale 设置中登录，待节点连接后重试。',
  'tailscale.error.address': '未找到 tailnet 节点。请填写 MagicDNS 名或 Tailscale IP。',
  'tailscale.error.storage': '无法读取或保存加密状态。请清除 Tailscale 状态后重新登录。',
  'tailscale.error.control':
    '请输入有效的 HTTPS 控制服务器地址，不得含凭据、查询或片段。更换服务器前请清除状态。',
  'tailscale.error.start': 'Tailscale 启动失败。请检查网络后重试。',
  'tailscale.error.paused': '后台连接已暂停，请回到前台重试。',
  'tailscale.error.other': 'Tailscale 操作失败，请检查网络后重试。',
} as const

export const en: Record<keyof typeof zhCN, string> = {
  'tailscale.title': 'Tailscale',
  'tailscale.switch': 'Connect through Tailscale',
  'tailscale.guide': 'Optional: set up Tailscale',
  'tailscale.scope':
    'For SSH within this app. Uses no system VPN slot. SSH keys and host fingerprint verification still apply.',
  'tailscale.unavailable':
    'Unavailable on this platform. Install an app version with embedded Tailscale support.',
  'tailscale.control': 'Control server (optional)',
  'tailscale.control.hint':
    'Leave empty for Tailscale, or enter your Headscale HTTPS URL. Clear state before changing servers.',
  'tailscale.login': 'Sign in',
  'tailscale.open': 'Open sign-in page',
  'tailscale.logout': 'Sign out',
  'tailscale.clear': 'Clear state',
  'tailscale.refresh': 'Refresh',
  'tailscale.back': 'Back to add device',
  'tailscale.node': 'Node name',
  'tailscale.tailnet': 'Tailnet',
  'tailscale.state.stopped': 'Disconnected',
  'tailscale.state.starting': 'Connecting',
  'tailscale.state.needsLogin': 'Signed out',
  'tailscale.state.needsApproval': 'Awaiting administrator approval',
  'tailscale.state.connected': 'Connected',
  'tailscale.state.suspended': 'Paused in background',
  'tailscale.logout.detail':
    'Disconnect all embedded Tailscale connections. Sign in to reconnect. Direct SSH connections are unaffected.',
  'tailscale.clear.detail':
    'Disconnect embedded Tailscale connections and delete this node’s local identity. Signing in registers a new node; remove the previous node in the admin console.',
  'tailscale.error.login':
    'Sign in in Tailscale settings, wait for the node to connect, then retry.',
  'tailscale.error.address': 'Tailnet node not found. Enter a MagicDNS name or Tailscale IP.',
  'tailscale.error.storage':
    'Cannot read or save encrypted state. Clear Tailscale state and sign in again.',
  'tailscale.error.control':
    'Enter a valid HTTPS control URL without credentials, query, or fragment. Clear state before changing servers.',
  'tailscale.error.start': 'Could not start Tailscale. Check your network and retry.',
  'tailscale.error.paused':
    'Connections are paused in the background. Return to the app and retry.',
  'tailscale.error.other': 'Tailscale operation failed. Check your network and retry.',
}
