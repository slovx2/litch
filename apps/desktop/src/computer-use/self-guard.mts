// Litch 自身审批的存储和手机验签留在可信桌面宿主。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ComputerSelfGuard as SharedSelfGuard } from '../../../../third_party/litch-automation/packages/computer-use/src/self-guard.mjs'
import { approvalDesktopId, phoneAnswerLanded, verifyPhoneAnswer } from '../approvals/verify.mjs'

export class ComputerSelfGuard extends SharedSelfGuard {
  constructor(file?: string, now = Date.now) {
    super({
      productName: 'Litch',
      now,
      remote: {
        desktopId: approvalDesktopId,
        verify: verifyPhoneAnswer,
        landed: phoneAnswerLanded,
      },
      ...(file
        ? {
            storage: {
              read: () =>
                (JSON.parse(readFileSync(file, 'utf8')) as { expiresAt: number | null }).expiresAt,
              write: (expiresAt: number | null) => {
                mkdirSync(dirname(file), { recursive: true })
                writeFileSync(`${file}.tmp`, JSON.stringify({ expiresAt }), { mode: 0o600 })
                renameSync(`${file}.tmp`, file)
              },
            },
          }
        : {}),
    })
  }
}
