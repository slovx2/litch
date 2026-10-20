// 手机端自己的文案：harness 详情设置（15 号设计，决 317）。键加前缀 "hcm."，中英文各一份，键必须一致。
// 入口、各个标签、配置项、登录的每一步、MCP 与指令文件、模型清单的句子大多直接用桌面界面的 hc.*（packages/ui/src/i18n/
// zh-CN-hconfig.ts）；这里只放手机上做法不一样的：MCP 和指令文件只能看、要回调转发的登录只能在桌面端做、
// 没有弹出的提示条（结果就地说一句）。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'hcm.readonly.mcp': '手机上只能看。增删改、开关和授权请在桌面端的 Litch 里做。',
  'hcm.readonly.instructions': '手机上只能看。编辑和统一模式请在桌面端的 Litch 里做。',
  'hcm.mcp.on': '启用',
  'hcm.mcp.off': '没启用',
  'hcm.instr.link': '这是指向 {target} 的软链（统一模式下各个 harness 共用一份）。',
  'hcm.instr.empty': '（空的）',
  'hcm.instr.missing': '设备上还没有这个文件。',
  'hcm.callback.desktop':
    '这种登录授权完要回调到设备上的 {port} 端口，手机转不过去。请在桌面端的 Litch 里完成，或者换一种登录方式。',
  'hcm.callback.paste':
    '授权完浏览器会回调到设备的 {port} 端口，手机上打不开那一页；把浏览器地址栏里的地址或者页面上的授权码粘贴到下面。',
  'hcm.copied': '已复制',
  'hcm.pick': '选一个',
  'hcm.pick.title': '选 {name}',
  'hcm.pick.custom': '也可以直接填清单里没有的。',
  'hcm.custom.title': '新的自定义 provider',
  'hcm.models.tap': '点一项可以改、删或者挪位置。',
} satisfies Record<string, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'hcm.readonly.mcp':
    'View only on the phone. Add, edit, switch on or off and authorize in Litch on the desktop.',
  'hcm.readonly.instructions':
    'View only on the phone. Edit and unified mode are in Litch on the desktop.',
  'hcm.mcp.on': 'Enabled',
  'hcm.mcp.off': 'Disabled',
  'hcm.instr.link':
    'This is a symlink to {target} (in unified mode every harness shares one file).',
  'hcm.instr.empty': '(empty)',
  'hcm.instr.missing': 'This file does not exist on the device yet.',
  'hcm.callback.desktop':
    'After you authorize, this sign-in calls back to port {port} on the device, which the phone cannot forward. Finish it in Litch on the desktop, or pick another way to sign in.',
  'hcm.callback.paste':
    'After you authorize, the browser calls back to port {port} on the device, which the phone cannot reach. Paste the address from the browser bar, or the code on the page, below.',
  'hcm.copied': 'Copied',
  'hcm.pick': 'Pick one',
  'hcm.pick.title': 'Pick {name}',
  'hcm.pick.custom': 'You can also type one that is not listed.',
  'hcm.custom.title': 'New custom provider',
  'hcm.models.tap': 'Tap an entry to edit, remove or move it.',
}
