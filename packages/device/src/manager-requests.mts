// “请你做”只由用户交付或回复；经理可维护内容及取消，所有写入留修订和历史。
import type {
  ManagerRequest,
  ManagerRequestFailure,
  ManagerRequestId,
  ManagerSubmittedRequest,
} from '../../protocol/src/manager.mjs'
import { type BoardObject, type ManagerStore, managerNow } from './manager-store.mjs'
import { fields, invalid, text } from './manager-validate.mjs'

export const isRequest = (object: BoardObject): object is ManagerRequest =>
  object.id.startsWith('R-')
function save(
  store: ManagerStore,
  managerId: string,
  before: ManagerRequest | null,
  after: ManagerRequest,
  by: import('../../protocol/src/manager.mjs').ManagerActor,
  why: string,
) {
  text(after.title, 'title')
  if (after.buttonLabel !== null) text(after.buttonLabel, 'buttonLabel')
  store.saveObject(managerId, after)
  store.record(managerId, after.id, by, before, after, why)
  return { object: after }
}
export function requestTool(
  store: ManagerStore,
  managerId: string,
  tool: string,
  args: Record<string, unknown>,
  actor: import('../../protocol/src/manager.mjs').ManagerActor = 'manager',
) {
  if (args.kind !== 'request') invalid('kind must match the R-n request.')
  const at = managerNow()
  if (tool === 'add') {
    const request = fields(args.request)
    const object = {
      title: '',
      description: '',
      buttonLabel: null,
      basis: [],
      links: [],
      ...request,
      id: store.nextId(managerId, 'R') as ManagerRequestId,
      revision: 1,
      status: 'open',
      response: null,
      cancelled: null,
      createdAt: at,
      updatedAt: at,
    } as ManagerRequest
    return {
      id: object.id,
      ...save(store, managerId, null, object, 'manager', text(args.why, 'why')),
    }
  }
  const before = store.object(managerId, String(args.id))
  if (!before || !isRequest(before)) invalid('Unknown request.')
  if (before.revision !== args.revision)
    invalid('The request changed; read get and supply its current revision.')
  if (tool !== 'update' && tool !== 'close') invalid('Requests support only get, update and close.')
  const patch =
    tool === 'update'
      ? fields(args.patch)
      : { status: 'cancelled', cancelled: { reason: text(args.reason, 'reason'), at } }
  if (!Object.keys(patch).length) invalid('patch must not be empty.')
  return save(
    store,
    managerId,
    before,
    { ...before, ...patch, revision: before.revision + 1, updatedAt: at },
    actor,
    text(tool === 'close' ? args.reason : args.why, 'why'),
  )
}

export function submitRequests(
  store: ManagerStore,
  managerId: string,
  given: unknown,
): { acceptedRequests: ManagerRequest[]; rejectedRequests: ManagerRequestFailure[] } {
  if (!Array.isArray(given)) invalid('requests must be an array.')
  const entries = given.map((value) => fields(value) as unknown as ManagerSubmittedRequest)
  const result: ReturnType<typeof submitRequests> = { acceptedRequests: [], rejectedRequests: [] }
  for (const entry of entries) {
    if (typeof entry.requestId !== 'string' || !/^R-[1-9]\d*$/.test(entry.requestId))
      invalid('Invalid requestId.')
    const object = store.object(managerId, entry.requestId)
    const request = object && isRequest(object) ? object : null
    const code = !request
      ? 'unknownRequest'
      : request.status === 'cancelled'
        ? 'requestCancelled'
        : request.revision !== entry.revision
          ? 'requestConflict'
          : !Number.isSafeInteger(entry.revision) ||
              typeof entry.delivered !== 'boolean' ||
              typeof entry.text !== 'string' ||
              (!entry.delivered && !entry.text.trim()) ||
              entries.filter((one) => one.requestId === entry.requestId).length !== 1
            ? 'invalidRequest'
            : null
    if (code || !request) {
      result.rejectedRequests.push({
        requestId: entry.requestId,
        code: code ?? 'unknownRequest',
        message:
          'The request changed, was cancelled, or the reply is invalid. Review it before submitting.',
        request,
      })
      continue
    }
    const at = managerNow()
    const after: ManagerRequest = {
      ...request,
      revision: request.revision + 1,
      status: entry.delivered ? 'delivered' : 'replied',
      response: { delivered: entry.delivered, text: entry.text, at },
      updatedAt: at,
    }
    result.acceptedRequests.push(
      save(
        store,
        managerId,
        request,
        after,
        'user',
        entry.delivered ? 'User delivered the request' : 'User replied to the request',
      ).object,
    )
  }
  return result
}
