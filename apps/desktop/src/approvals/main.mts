// 主进程里的手机批准钥匙：装上验签（verify.mts 的 verifyPhoneAnswer 由内置浏览器的登录卡片调），
// 收工具进程报来的“扫码时核对过”“撤销了”，给设置页列出和删掉，第一次记下、对不上时告诉界面出提示。
// 钥匙文件是 <用户数据>/trusted-phones.json，只有主进程读写。
import { join } from 'node:path'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  APPROVAL_KEYS,
  APPROVALS_CHANGED,
  APPROVALS_FORGET,
  APPROVALS_LIST,
  APPROVALS_NOTICE,
  type ApprovalKeysMessage,
  type TrustedPhoneEntry,
} from './ipc.mjs'
import { TrustedPhones } from './store.mjs'
import { installPhoneApprovals, PhoneApprovals, pairingKeyMatches } from './verify.mjs'

export interface ApprovalsMainOptions {
  dataDir: string
  ipcMain: IpcMain
  /** 只接受界面自己的主框架发来的 */
  fromUi(event: IpcMainInvokeEvent): boolean
  windows(): BrowserWindow[]
  log(line: string): void
}

export interface ApprovalsMain {
  /** 工具进程发来的一条。是批准钥匙的消息就处理掉并回 true */
  message(message: unknown): boolean
}

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

export function startApprovalsMain(options: ApprovalsMainOptions): ApprovalsMain {
  const send = (channel: string, payload?: unknown) => {
    for (const window of options.windows())
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
  const approvals = new PhoneApprovals({
    store: new TrustedPhones(join(options.dataDir, 'trusted-phones.json'), options.log),
    notice: (notice) => send(APPROVALS_NOTICE, notice),
    changed: () => send(APPROVALS_CHANGED),
    log: options.log,
  })
  installPhoneApprovals(approvals)

  const list = (): TrustedPhoneEntry[] =>
    approvals.phones().map((phone) => ({
      phoneId: phone.phoneId,
      name: phone.name,
      fingerprint: phone.fingerprint,
      source: phone.source,
      deviceId: phone.deviceId,
      addedAt: phone.addedAt,
      lastApprovedAt: phone.lastApprovedAt,
      conflict: phone.conflict,
    }))
  options.ipcMain.handle(APPROVALS_LIST, (event) => (options.fromUi(event) ? list() : []))
  options.ipcMain.handle(APPROVALS_FORGET, (event, phoneId: unknown) =>
    options.fromUi(event) && typeof phoneId === 'string' ? approvals.forget(phoneId) : false,
  )

  return {
    message(raw) {
      const message = raw as Partial<ApprovalKeysMessage> | null
      if (message?.type !== APPROVAL_KEYS) return false
      if (message.op === 'forget' && isText(message.phoneId, 64)) approvals.forget(message.phoneId)
      if (
        message.op === 'trust' &&
        isText(message.phoneId, 64) &&
        typeof message.name === 'string' &&
        isText(message.approvalKey, 64) &&
        isText(message.deviceId, 200)
      ) {
        const checked = pairingKeyMatches({
          pairId: String(message.pairId ?? ''),
          phoneId: message.phoneId,
          publicKey: String(message.publicKey ?? ''),
          approvalKey: message.approvalKey,
          code: String(message.code ?? ''),
        })
        if (!checked) {
          options.log(`手机 ${message.phoneId} 的批准公钥和确认码对不上，没有记下`)
          return true
        }
        approvals.trustFromPairing({
          phoneId: message.phoneId,
          name: message.name.slice(0, 64),
          approvalKey: message.approvalKey,
          deviceId: message.deviceId,
        })
      }
      return true
    },
  }
}
