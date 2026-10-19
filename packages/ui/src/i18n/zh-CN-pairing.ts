// 扫码绑定手机的中文文案：出码对话框、设备详情里“手机”一节、侧栏设备菜单的那一项。
// 并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-pairing.ts。
import type { Entry } from './types.ts'

export const zhPairing = {
  'pairing.use': '在手机上使用…',
  'pairing.title': '在手机上使用 {name}',
  'pairing.intro':
    '用 Litch 手机端“添加设备”里的“扫码添加”扫这张码。手机会生成它自己的钥匙，这台电脑的钥匙不离开电脑。',
  'pairing.shared': '别在共享屏幕时打开：拍到这张码的人都能来登记（虽然还要你在这里点允许）。',
  'pairing.starting': '正在设备上准备一次性钥匙，并用它试登一次…',
  'pairing.address': '给手机用的地址',
  'pairing.address.note': '手机按这里连。只改给手机的这一份，不动这台设备在电脑上的连接配置。',
  'pairing.field.name': '别名',
  'pairing.field.host': '主机名或 IP',
  'pairing.field.port': '端口',
  'pairing.field.user': '用户',
  'pairing.bad.name': '别名不能是空的，最长 64 个字',
  'pairing.bad.host': '主机名不能是空的，不能有空格、不能以减号开头，用户名单独填',
  'pairing.bad.port': '端口是 1 到 65535 之间的整数',
  'pairing.bad.user': '用户名不能是空的，不能有空格、不能以减号开头',
  'pairing.original': '原配置：{address}',
  'pairing.restore': '恢复原配置',
  'pairing.expires': '{time} 后自动换一张新码',
  'pairing.refreshing': '正在换一张新码…',
  'pairing.copy': '复制配对文本',
  'pairing.copied': '配对文本已复制，在手机的扫码页上可以直接粘贴。',
  'pairing.copyFailed': '复制没成：{reason}',
  'pairing.qr': '配对二维码',
  'pairing.state.waiting': '等手机扫码…',
  'pairing.state.requested': '手机“{name}”请求绑定',
  'pairing.code': '确认码',
  'pairing.code.note':
    '手机上也显示了确认码，两边一样再点允许。不一样就拒绝：可能是别人扫了这张码。',
  'pairing.allow': '允许',
  'pairing.reject': '拒绝',
  'pairing.state.done': '已绑定“{name}”。手机会接着用它自己的钥匙连上来。',
  'pairing.state.rejected': '已拒绝这次登记，这张码作废了。',
  'pairing.state.cancelled': '这张码已经作废了。',
  'pairing.state.expired': '这张码过期了。',
  'pairing.again': '换一张新码',
  'pairing.done': '完成',
  'pairing.close': '关闭',
  'pairing.failed': '没做成：{reason}',
  'pairing.fail.title': '出不了码',
  'pairing.fail.keysFile':
    '这台设备上的钥匙文件（~/.ssh/authorized_keys）改不了：可能是符号链接、只读，或者由别的工具管着。请在手机上手动添加这台设备。',
  'pairing.fail.noHostKey':
    '读不到这台设备的主机钥匙（/etc/ssh/ssh_host_*_key.pub 都没有），手机没法确认连到的就是它。',
  'pairing.fail.hostKeyMismatch':
    '这台电脑连到的和这台设备自报的主机钥匙不一样，多半是中间隔着端口转发或跳板机。为了安全，不出码。',
  'pairing.fail.selfTest':
    '用一次性钥匙登不进这台设备：sshd 可能不认 authorized_keys、只放行部分用户，或者要求双因素。请在手机上手动添加这台设备。',
  'pairing.fail.sshOff': '这台电脑没有开 SSH 服务，手机连不进来。',
  'pairing.fail.sshOff.macos':
    '在“系统设置 → 通用 → 共享”里打开“远程登录”，并确认当前用户在允许的名单里，然后点重试。',
  'pairing.fail.sshOff.windows':
    '在“设置 → 系统 → 可选功能”里装上“OpenSSH 服务器”并启动它，然后点重试。管理员账号暂时只能手动添加。',
  'pairing.fail.sshOff.linux': '装上并启动 sshd（比如 openssh-server），然后点重试。',
  'pairing.fail.unsupported':
    '这台设备上的服务版本不支持扫码绑定手机。升级设备上的适配器之后就能用。',
  'pairing.fail.offline': '设备没有连上。连上之后再试。',
  'pairing.fail.said': 'ssh 的原话',
  'pairing.retry': '重试',
  'phones.title': '手机',
  'phones.count': '{count} 部',
  'phones.none': '没有',
  'phones.empty': '还没有手机绑定这台设备。',
  'phones.loading': '正在取…',
  'phones.added': '绑定于 {date}',
  'phones.addedUnknown': '绑定日期不详',
  'phones.revoke': '撤销',
  'phones.revoke.ask': '撤掉“{name}”的钥匙？之后这部手机就连不上这台设备了。',
  'phones.revoked': '已撤掉“{name}”的钥匙。',
  'phones.failed': '没做成：{reason}',
  'phones.upgrade':
    '这台设备上的服务版本不支持扫码绑定手机。升级设备上的适配器之后，这里就能出码、管理绑定的手机。',
  'phones.windowsAdmin':
    'Windows 上的管理员账号暂时不能扫码绑定手机：OpenSSH 对管理员账号只认 administrators_authorized_keys，改它要管理员权限。可以手动把手机的公钥加进那个文件。',
  'phones.offline': '设备没连上，连上之后才看得到绑定了哪些手机。',
} satisfies Record<string, Entry>
