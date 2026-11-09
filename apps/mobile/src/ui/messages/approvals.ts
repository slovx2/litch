// 手机远程批准文案；不包含代理登录或代填入口。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'approval.siteDesktop': '请在执行浏览器操作的 Litch 桌面端打开此会话，处理网站审批。',
  'approval.device': '会话所在设备',
  'approval.decline': '拒绝',
  'approval.unlock': '批准电脑上的操作',
  'approval.unlock.cancel': '取消',
  'approval.fail.noLock': '这部手机没有设锁屏，也没录指纹或面容，不能批准。设好后再试',
  'approval.fail.unlock': '没有通过验证',
  'approval.fail.noPhone': '这台设备没有用这部手机自己的钥匙连接，不能批准。扫码重新绑定后再试',
  'approval.fail.send': '没送出去：{reason}',
  'approval.sent': '已送出，等电脑确认',
  'approval.settings': '远程批准',
  'approval.settings.fingerprint': '批准钥匙指纹',
  'approval.settings.none': '还没有批准钥匙。扫码绑定或第一次批准时会自动生成',
  'approval.settings.make': '现在生成',
  'approval.settings.note':
    '批准 Litch 自身访问前需通过指纹、面容或锁屏验证；电脑上显示相同的批准钥匙指纹。',
} satisfies Record<`approval.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'approval.siteDesktop':
    'Open this conversation in the Litch desktop running the browser to approve website access.',
  'approval.device': 'Session device',
  'approval.decline': 'Decline',
  'approval.unlock': 'Approve access on your computer',
  'approval.unlock.cancel': 'Cancel',
  'approval.fail.noLock':
    'This phone has no screen lock, fingerprint or face set up, so it can’t approve. Set one up and try again',
  'approval.fail.unlock': 'Verification didn’t pass',
  'approval.fail.noPhone':
    'This device isn’t connected with this phone’s own key, so it can’t approve. Pair again by scanning the code',
  'approval.fail.send': 'Couldn’t send: {reason}',
  'approval.sent': 'Sent; waiting for the computer',
  'approval.settings': 'Remote approvals',
  'approval.settings.fingerprint': 'Approval key fingerprint',
  'approval.settings.none':
    'No approval key yet. One is made when you pair by scanning or approve for the first time',
  'approval.settings.make': 'Make one now',
  'approval.settings.note':
    'Approving access to Litch requires fingerprint, face or screen-lock verification. The desktop shows the same approval-key fingerprint.',
}
