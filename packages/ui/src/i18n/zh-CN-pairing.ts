// 扫码绑定手机的中文文案：出码对话框、设备详情里“手机”一节、侧栏设备菜单的那一项。
// 并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-pairing.ts。
import type { Entry } from './types.ts'

export const zhPairing = {
  'pairing.fail.entryUnsupported':
    '此端口的 SSH 服务无法完成手机绑定：未接受一次性钥匙或未执行强制命令，可能不读取设备的 ~/.ssh/authorized_keys，或受认证策略限制。请改用系统 OpenSSH 的端口；必要时为 sshd 配置独立端口。出码前可在此对话框修改地址和端口。',
  'pairing.fail.network':
    '无法连接手机使用的 SSH 入口，或服务响应超时。请检查地址、端口、网络和防火墙；出码前可在此对话框修改地址。',
  'pairing.hostKey.title': '确认主机密钥',
  'pairing.hostKey.mismatch': '入口主机密钥与设备自报或本机记录不一致。',
  'pairing.hostKey.unknown': '本机没有此入口的已知主机密钥记录。',
  'pairing.hostKey.unverified': '未能直接读取手机连接入口的主机密钥。',
  'pairing.hostKey.risk':
    '代理、跳板机或端口转发可能造成差异，也可能意味着手机将连接到其他机器。请核对地址和指纹后再继续。',
  'pairing.hostKey.reported': '设备自报的密钥',
  'pairing.hostKey.known': '本机已知的入口密钥',
  'pairing.hostKey.entrance': '本次读取的入口密钥',
  'pairing.hostKey.selected': '本次二维码和登录检查使用的密钥',
  'pairing.hostKey.none': '未取得',
  'pairing.hostKey.once':
    '确认仅用于本次出码，不保存为信任设置。换码或地址、密钥变化后需要重新确认。',
  'pairing.hostKey.cancel': '取消',
  'pairing.hostKey.confirm': '确认并生成二维码',
  'pairing.use': '在手机上使用…',
  'pairing.title': '在手机上使用 {name}',
  'pairing.intro':
    '在 Litch 手机端“添加设备”中选择“扫码添加”，扫描此二维码。手机会生成自己的密钥，本机钥匙不会离开本机。',
  'pairing.shared': '请勿在共享屏幕时打开：拍到此二维码的人都可以申请绑定（仍需在此处允许）。',
  'pairing.starting': '正在设备上准备一次性密钥并验证登录…',
  'pairing.address': '手机连接地址',
  'pairing.address.note': '仅修改给手机使用的地址，不影响本机与此设备的连接配置。',
  'pairing.field.name': '别名',
  'pairing.field.host': '主机名或 IP',
  'pairing.field.port': '端口',
  'pairing.field.user': '用户',
  'pairing.bad.name': '别名不能为空，最长 64 个字',
  'pairing.bad.host': '主机名不能为空、不能包含空格或以减号开头；用户名请单独填写',
  'pairing.bad.port': '端口须为 1 到 65535 之间的整数',
  'pairing.bad.user': '用户名不能为空、不能包含空格或以减号开头',
  'pairing.original': '原配置：{address}',
  'pairing.restore': '恢复原配置',
  'pairing.host.pick': 'Tailscale',
  'pairing.host.choose': '换成这台设备在 Tailscale 里的 IP、全名或短名',
  'pairing.host.ip': 'IP',
  'pairing.host.long': '全名',
  'pairing.host.short': '短名',
  'pairing.expires': '{time} 后自动刷新二维码',
  'pairing.refreshing': '正在生成新二维码…',
  'pairing.copy': '复制配对文本',
  'pairing.copied': '配对文本已复制，可在手机的扫码页直接粘贴。',
  'pairing.copyFailed': '复制失败：{reason}',
  'pairing.qr': '配对二维码',
  'pairing.state.waiting': '等待手机扫码…',
  'pairing.state.waitingTailscale':
    '等待手机连接。此地址可能是 Tailscale；扫码后未出现确认时，请在手机上登录或核对 Tailscale 账号。',
  'pairing.state.requested': '手机“{name}”请求绑定',
  'pairing.code': '确认码',
  'pairing.code.note':
    '手机上也会显示确认码，两边一致时再点允许。如果不一致，请拒绝：可能有他人扫描了此二维码。',
  'pairing.allow': '允许',
  'pairing.reject': '拒绝',
  'pairing.state.done': '已绑定“{name}”。手机将使用自己的密钥连接。',
  'pairing.state.rejected': '已拒绝绑定，此二维码已失效。',
  'pairing.state.cancelled': '此二维码已失效。',
  'pairing.state.expired': '此二维码已过期。',
  'pairing.again': '生成新二维码',
  'pairing.done': '完成',
  'pairing.close': '关闭',
  'pairing.failed': '操作失败：{reason}',
  'pairing.fail.title': '无法生成二维码',
  'pairing.fail.keysFile':
    '无法修改此设备上的密钥文件（~/.ssh/authorized_keys）：可能是符号链接、只读或由其他工具管理。请在手机上手动添加此设备。',
  'pairing.fail.noHostKey':
    '无法读取此设备的主机密钥（/etc/ssh/ssh_host_*_key.pub 均不存在），手机无法验证连接的是否为此设备。',
  'pairing.fail.hostKeyMismatch':
    '本机连接到的主机钥匙与设备报告的不一致，可能中间经过了端口转发或跳板机。出于安全考虑，不生成二维码。',
  'pairing.fail.selfTest':
    '设备未完成配对自检。请检查 SSH 输出及设备上的适配器命令是否可执行，然后重试。',
  'pairing.fail.sshOff': '本机未开启 SSH 服务，手机无法连接。',
  'pairing.fail.sshOff.macos':
    '在“系统设置 → 通用 → 共享”中打开“远程登录”，确认当前用户在允许列表中，然后点重试。',
  'pairing.fail.sshOff.windows':
    '在“设置 → 系统 → 可选功能”中安装并启动“OpenSSH 服务器”，然后点重试。管理员账号暂时只能手动添加。',
  'pairing.fail.sshOff.linux': '安装并启动 sshd（例如 openssh-server），然后点重试。',
  'pairing.fail.unsupported': '此设备上的服务版本不支持扫码绑定手机，请升级设备上的适配器。',
  'pairing.fail.offline': '设备未连接，连接后再试。',
  'pairing.fail.said': 'ssh 输出',
  'pairing.retry': '重试',
  'pairing.fail.tailscale':
    '用于检查的地址由 Tailscale SSH 接管：它不读取 authorized_keys，一次性密钥的强制命令不生效。可改用 Tailscale 方式生成二维码。',
  'pairing.fail.enrollTest':
    '出码前的检查没通过：本机用临时密钥经 Tailscale SSH 登录此地址并执行登记命令失败。看下面的原话；Tailscale ACL 不放行本机时，手机通常也登不进去。',
  'pairing.useTailscale': '改用 Tailscale 方式',
  'pairing.fail.verify':
    'Tailscale 要求在浏览器中完成一次验证（ACL 的 check 模式）。打开验证页面完成验证后点重试。',
  'pairing.fail.verify.open': '打开验证页面',
  'pairing.tailscale.note':
    '此地址由 Tailscale SSH 接管：手机需先安装并登录 Tailscale，能否登录由 Tailscale ACL 决定。tailnet 中被 ACL 允许的设备无需密钥即可以 {user} 登录，在 Litch 中撤销无法阻止它们。',
  'pairing.tailscale.phone': '本机能登录不代表手机能登录：ACL 可以按设备设置。',
  'pairing.tailscale.unchecked': '本机无法连接此地址，未做生成前的检查。',
  'phones.tailscale':
    '此设备使用 Tailscale SSH，撤销只删除密钥。要阻止某台手机，请在 Tailscale 管理后台修改 ACL 或移除该设备。',
  'phones.revoke.askTailscale':
    '撤销“{name}”的密钥？此设备使用 Tailscale SSH，撤销只删除密钥，该手机仍可经 Tailscale 登录；要阻止它，请在 Tailscale 管理后台修改 ACL 或移除该设备。',
  'phones.title': '手机',
  'phones.count': '{count} 部',
  'phones.none': '无',
  'phones.empty': '暂无手机绑定此设备。',
  'phones.loading': '正在加载…',
  'phones.added': '绑定于 {date}',
  'phones.addedUnknown': '绑定日期未知',
  'phones.revoke': '撤销',
  'phones.revoke.ask': '撤销“{name}”的密钥？之后该手机将无法连接此设备。',
  'phones.revoked': '已撤销“{name}”的密钥。',
  'phones.failed': '操作失败：{reason}',
  'phones.upgrade':
    '此设备上的服务版本不支持扫码绑定手机。升级设备上的适配器后，可在此生成二维码和管理已绑定的手机。',
  'phones.windowsAdmin':
    'Windows 管理员账号暂不支持扫码绑定手机：OpenSSH 对管理员账号只读取 administrators_authorized_keys，修改它需要管理员权限。可手动将手机的公钥添加到该文件。',
  'phones.offline': '设备未连接，连接后显示已绑定的手机。',
} satisfies Record<string, Entry>
