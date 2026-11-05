export const zhCN = {
  'tailscale.title': 'Tailscale',
  'tailscale.switch': '通过 Tailscale 连接',
  'tailscale.mode.auto': '自动',
  'tailscale.mode.always': '总是',
  'tailscale.mode.never': '从不',
  'tailscale.mode.hint':
    '自动：已登录时，tailnet 地址与匹配的节点名称走内置 Tailscale；其他地址走系统网络。',
  'tailscale.route.tailscale': '经内置 Tailscale',
  'tailscale.route.system': '经系统网络',
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
  'tailscale.checking': '正在读取节点状态…',
  'tailscale.preparing': '正在获取登录地址，将自动打开浏览器…',
  'tailscale.waiting': '请在浏览器完成登录，返回后会自动确认状态。',
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
  'tailscale.error.switch': '这是 Tailscale 网络地址。登录内置 Tailscale 后可自动连接。',
  'tailscale.error.address': '未找到 tailnet 节点。请填写 MagicDNS 名或 Tailscale IP。',
  'tailscale.error.storage': '无法读取或保存加密状态。请清除 Tailscale 状态后重新登录。',
  'tailscale.error.control':
    '请输入有效的 HTTPS 控制服务器地址，不得含凭据、查询或片段。更换服务器前请清除状态。',
  'tailscale.error.start': 'Tailscale 启动失败。请检查网络后重试。',
  'tailscale.error.paused': '后台连接已暂停，请回到前台重试。',
  'tailscale.error.approval':
    '需要在 Tailscale 管理台批准此设备。请管理员按本页节点名找到设备并批准，再返回刷新。',
  'tailscale.error.connecting': 'Tailscale 节点正在恢复连接，请稍候，将自动重试。',
  'tailscale.error.connect':
    '无法通过 Tailscale 连接 SSH。请检查目标设备在线、SSH 端口及 tailnet 访问规则；若使用其他 VPN，请确认它允许 Tailscale 的 HTTPS 和 UDP 流量。',
  'tailscale.error.timeout':
    '30 秒内未取得登录地址。请检查网络及当前 VPN 是否允许访问 Tailscale，然后点击登录重试。',
  'tailscale.error.other': 'Tailscale 操作失败，请检查网络后重试。',
} as const

export const en: Record<keyof typeof zhCN, string> = {
  'tailscale.title': 'Tailscale',
  'tailscale.switch': 'Connect through Tailscale',
  'tailscale.mode.auto': 'Automatic',
  'tailscale.mode.always': 'Always',
  'tailscale.mode.never': 'Never',
  'tailscale.mode.hint':
    'Automatic uses embedded Tailscale for tailnet addresses and matching node names when signed in. Other addresses use the system network.',
  'tailscale.route.tailscale': 'Via embedded Tailscale',
  'tailscale.route.system': 'Via system network',
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
  'tailscale.checking': 'Reading node status…',
  'tailscale.preparing': 'Getting a sign-in link. Your browser will open automatically…',
  'tailscale.waiting': 'Finish signing in in your browser. Status updates when you return.',
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
  'tailscale.error.switch':
    'This address belongs to a Tailscale network. Sign in to embedded Tailscale to connect automatically.',
  'tailscale.error.address': 'Tailnet node not found. Enter a MagicDNS name or Tailscale IP.',
  'tailscale.error.storage':
    'Cannot read or save encrypted state. Clear Tailscale state and sign in again.',
  'tailscale.error.control':
    'Enter a valid HTTPS control URL without credentials, query, or fragment. Clear state before changing servers.',
  'tailscale.error.start': 'Could not start Tailscale. Check your network and retry.',
  'tailscale.error.paused':
    'Connections are paused in the background. Return to the app and retry.',
  'tailscale.error.approval':
    'This device needs approval in the Tailscale admin console. Ask an administrator to approve the node shown here, then refresh.',
  'tailscale.error.connecting':
    'Tailscale is reconnecting. The connection will retry automatically.',
  'tailscale.error.connect':
    'Cannot reach SSH through Tailscale. Check the target device, SSH port and tailnet access rules. If another VPN is active, check that it allows Tailscale HTTPS and UDP traffic.',
  'tailscale.error.timeout':
    'No sign-in link arrived within 30 seconds. Check your network and whether your VPN allows Tailscale, then try signing in again.',
  'tailscale.error.other': 'Tailscale operation failed. Check your network and retry.',
}
