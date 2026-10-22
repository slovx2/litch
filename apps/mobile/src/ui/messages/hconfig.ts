// 手机端自己的文案：harness 详情设置（15 号设计，决 317）。键加前缀 "hcm."，中英文各一份，键必须一致。
// 入口、各个标签、配置项、登录的每一步、MCP 与指令文件、模型清单的句子大多直接用桌面界面的 hc.*（packages/ui/src/i18n/
// zh-CN-hconfig.ts）；这里只放手机上做法不一样的：MCP 和指令文件只能看、要回调转发的登录只能在桌面端做、
// 没有弹出的提示条（结果就地说一句）。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'hcm.readonly.mcp': '手机上仅可查看。添加、修改、开关和授权请在桌面端 Litch 中操作。',
  'hcm.readonly.instructions': '手机上仅可查看。编辑和统一模式请在桌面端 Litch 中操作。',
  'hcm.mcp.on': '启用',
  'hcm.mcp.off': '未启用',
  'hcm.instr.link': '此文件是指向 {target} 的软链接（统一模式下各 harness 共用一份）。',
  'hcm.instr.empty': '（空）',
  'hcm.instr.missing': '设备上尚无此文件。',
  'hcm.callback.desktop':
    '此登录方式授权后需回调到设备的 {port} 端口，手机无法转发。请在桌面端 Litch 中完成，或改用其他登录方式。',
  'hcm.callback.paste':
    '授权后浏览器会回调到设备的 {port} 端口，手机无法打开该页面。请将浏览器地址栏中的地址或页面上的授权码粘贴到下方。',
  'hcm.copied': '已复制',
  'hcm.pick': '请选择',
  'hcm.pick.title': '选择 {name}',
  'hcm.pick.custom': '也可填写列表中没有的值。',
  'hcm.custom.title': '新建自定义 provider',
  'hcm.models.tap': '点击条目可编辑、删除或调整顺序。',
} satisfies Record<string, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'hcm.readonly.mcp':
    'View only on the phone. Add, edit, switch and authorize in Litch on the desktop.',
  'hcm.readonly.instructions':
    'View only on the phone. Edit and use unified mode in Litch on the desktop.',
  'hcm.mcp.on': 'Enabled',
  'hcm.mcp.off': 'Disabled',
  'hcm.instr.link': 'Symlink to {target} (in unified mode all harnesses share one file).',
  'hcm.instr.empty': '(empty)',
  'hcm.instr.missing': 'This file doesn’t exist on the device yet.',
  'hcm.callback.desktop':
    'This sign-in calls back to port {port} on the device after you authorize, which the phone can’t forward. Finish it in Litch on the desktop, or choose another sign-in method.',
  'hcm.callback.paste':
    'After you authorize, the browser calls back to port {port} on the device, which the phone can’t open. Paste the address from the browser’s address bar, or the code on the page, below.',
  'hcm.copied': 'Copied',
  'hcm.pick': 'Choose one',
  'hcm.pick.title': 'Choose {name}',
  'hcm.pick.custom': 'You can also enter one not listed.',
  'hcm.custom.title': 'New custom provider',
  'hcm.models.tap': 'Tap an entry to edit, remove or reorder it.',
}
