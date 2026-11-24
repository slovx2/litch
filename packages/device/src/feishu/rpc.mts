// litch/feishu/* 方法：校验声明、管理员权限和参数形状，再交给 DeviceFeishuService。
import {
  FEISHU_EXTENSION,
  FEISHU_PUBLIC_READS,
  type FeishuMethod,
  type FeishuRequests,
  FEISHU_METHOD as M,
} from '../../../protocol/src/feishu.mjs'
import { isFeishuMethod, isFeishuMethodParams } from '../../../protocol/src/feishu-validation.mjs'
import { ProtocolError } from '../../../shared/src/protocol-contract.mjs'
import { DeviceError } from '../wire.mjs'
import type { DeviceFeishuService } from './service.mjs'

export class DeviceFeishuRpc {
  private readonly service: DeviceFeishuService
  constructor(service: DeviceFeishuService) {
    this.service = service
  }

  async call(
    method: string,
    raw: unknown,
    access: { declared: boolean; admin: boolean },
  ): Promise<unknown> {
    if (!access.declared)
      throw new DeviceError('extensionRequired', `${method} requires ${FEISHU_EXTENSION}`, {
        method,
        required: [FEISHU_EXTENSION],
      })
    if (!isFeishuMethod(method)) throw new ProtocolError(-32601, 'Unknown Feishu method')
    if (!access.admin && !FEISHU_PUBLIC_READS.has(method))
      throw new DeviceError('deviceAdminRequired', 'This operation requires a device administrator')
    const args = <K extends FeishuMethod>(type: K): FeishuRequests[K]['params'] => {
      const params = raw === undefined ? {} : raw
      if (!isFeishuMethodParams(type, params))
        throw new ProtocolError(-32602, 'Invalid Feishu request parameters')
      return params
    }
    const service = this.service
    switch (method) {
      case M.appList:
        args(method)
        return { apps: service.apps(), admin: access.admin }
      case M.appGet:
        return { app: service.app(args(method).appId) }
      case M.appRegisterBegin: {
        const input = args(method)
        return { registration: await service.registerBegin(input.name, input.operationId) }
      }
      case M.appRegisterGet:
        return { registration: service.registerGet(args(method).registrationId) }
      case M.appRegisterCancel:
        return { registration: service.registerCancel(args(method).registrationId) }
      case M.appConfigure: {
        const input = args(method)
        return { app: await service.configure(input.appId, input.appSecret, input.operationId) }
      }
      case M.appRotate: {
        const input = args(method)
        return {
          app: await service.rotate(
            input.appId,
            input.appSecret,
            input.expectedGeneration,
            input.operationId,
          ),
        }
      }
      case M.appUpdate:
        return { app: service.update(args(method)) }
      case M.appRemove: {
        const input = args(method)
        service.remove(input.appId, input.expectedRevision)
        return {}
      }
      case M.appCheck:
        return { app: await service.check(args(method).appId) }
      case M.appUpgrade: {
        const input = args(method)
        return { app: await service.upgrade(input.appId, input.operationId) }
      }
      case M.chatList: {
        const input = args(method)
        service.app(input.appId)
        return await service.chats.list(input.appId, input.refresh === true)
      }
      case M.chatGet: {
        const input = args(method)
        return { chat: service.chats.get(input.appId, input.chatId) }
      }
      case M.chatMembers: {
        const input = args(method)
        return await service.chats.memberList(input.appId, input.chatId, input.refresh === true)
      }
      case M.chatAccess:
        return { chat: await service.chats.access(args(method)) }
      case M.chatUpdate:
        return { chat: await service.chats.update(args(method)) }
      case M.chatUnaccess: {
        const input = args(method)
        return {
          chat: service.chats.unaccess(
            input.appId,
            input.chatId,
            input.expectedRevision,
            input.deleteRecords,
          ),
        }
      }
      case M.chatBackfill: {
        const input = args(method)
        service.records.backfill(input.appId, input.chatId, input.start, input.end)
        return { chat: service.chats.get(input.appId, input.chatId) }
      }
      case M.inboxList: {
        const input = args(method)
        return service.inboxPage(
          input.managerId,
          input.statuses ?? ['queued', 'notified', 'processed'],
          input.limit ?? 50,
          input.before,
        )
      }
      case M.inboxGet: {
        const entry = service.inbox.entry(args(method).inboxId) ?? fail('feishu_inbox_not_found')
        return { entry, message: service.inboxMessage(entry) }
      }
    }
  }
}

const fail = (reason: string): never => {
  throw new ProtocolError(-32602, reason)
}
