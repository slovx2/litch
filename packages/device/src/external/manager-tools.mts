// 工具仅由设备的经理调用入口注册；参数不接受经理、线程或调用者身份。
import type { ClientToolFunctionSpec } from '../../../protocol/src/client-tools.mjs'
import { EXTERNAL_METHOD } from '../../../protocol/src/external-sources.mjs'
import { isExternalMethodParams } from '../../../protocol/src/external-validation.mjs'
import type { ExternalStore } from '../external-store.mjs'
import type { ManagerBoardWriter } from '../manager-board.mjs'
import { fields, invalid, keys } from '../manager-validate.mjs'
import type { ExternalManagerTurn, ExternalMandateService } from './mandate.mjs'
import type { ExternalLinkRequest, ExternalLinkService } from './mandate-link.mjs'

const str = { type: 'string', minLength: 1, maxLength: 256 }
const id = { type: 'string', pattern: '^[1-9][0-9]*$' }
const issueId = { type: 'string', pattern: '^X-[1-9][0-9]*$' }
const revision = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
const inboxStates = ['received', 'blocked', 'pending_triage', 'processed', 'notified']
const disposition = {
  intakeId: str,
  expectedRevision: revision,
  idempotencyKey: { ...str, maxLength: 128 },
}
const reply = { type: 'string', minLength: 1, maxLength: 65536 }
const required = ['intakeId', 'expectedRevision', 'idempotencyKey']
const spec = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ClientToolFunctionSpec => ({
  type: 'function',
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
})

export const MANAGER_EXTERNAL_TOOLS = [
  spec('external_inbox_list', 'List structured external inbox entries assigned to this manager.', {
    beforeSeq: revision,
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    sourceId: str,
    repoId: id,
    reason: str,
    status: { enum: inboxStates },
  }),
  spec(
    'external_inbox_get',
    'Read one event, intake or reminder group by its device-provided key. Supply exactly one identifier.',
    {
      eventKey: str,
      intakeId: str,
      groupId: str,
    },
  ),
  spec(
    'external_accept',
    'Verify an assigned intake and create an ordinary issue with an internal title and description. For a terminal binding, relatedIssueId links a new internal issue without changing the existing GitHub binding.',
    {
      ...disposition,
      title: str,
      body: { type: 'string', maxLength: 65536 },
      relatedIssueId: issueId,
      reply,
    },
    [...required, 'title', 'body'],
  ),
  spec(
    'external_merge',
    'Verify an assigned intake and add it to an existing issue of this manager. Supply the current issue revision.',
    {
      ...disposition,
      issueId,
      expectedIssueRevision: revision,
      reply,
    },
    [...required, 'issueId', 'expectedIssueRevision'],
  ),
  spec(
    'external_ignore',
    'Verify and dismiss an assigned intake. The reason stays on this device. A separate optional reply is checked against the source policy.',
    {
      ...disposition,
      reason: str,
      reply,
    },
    [...required, 'reason'],
  ),
  spec(
    'external_link',
    'Verify and link an unbound issue or PR in an enabled repository to an existing issue of this manager. This does not create a mandate or authorize a GitHub write.',
    {
      sourceId: str,
      repoId: id,
      number: id,
      kind: { enum: ['issue', 'pull_request'] },
      issueId,
      expectedIssueRevision: revision,
    },
    ['sourceId', 'repoId', 'number', 'kind', 'issueId', 'expectedIssueRevision'],
  ),
] as const

export const EXTERNAL_ANSWER_FIELDS = {
  ownerEventKey: {
    ...str,
    description:
      'Device event key of a verified GitHub owner comment or submitted review that answers this decision.',
  },
  expectedDecisionRevision: {
    ...revision,
    description: 'Current decision revision; required with ownerEventKey.',
  },
}
export function isExternalManagerCall(tool: string, input: unknown): boolean {
  return (
    MANAGER_EXTERNAL_TOOLS.some((entry) => entry.name === tool) ||
    (tool === 'answer' &&
      !!input &&
      typeof input === 'object' &&
      ('ownerEventKey' in input || 'expectedDecisionRevision' in input))
  )
}

const valid = (value: unknown, re: RegExp): value is string =>
  typeof value === 'string' && re.test(value)
function isLinkRequest(
  input: Record<string, unknown>,
): input is ExternalLinkRequest & Record<string, unknown> {
  return (
    valid(input.sourceId, /^.{1,256}$/) &&
    valid(input.repoId, /^[1-9][0-9]*$/) &&
    valid(input.number, /^[1-9][0-9]*$/) &&
    valid(input.issueId, /^X-[1-9][0-9]*$/) &&
    (input.kind === 'issue' || input.kind === 'pull_request') &&
    Number.isSafeInteger(input.expectedIssueRevision) &&
    Number(input.expectedIssueRevision) > 0
  )
}

export class ExternalManagerTools {
  private readonly store: ExternalStore
  private readonly mandates: ExternalMandateService
  private readonly board: ManagerBoardWriter
  private readonly links: ExternalLinkService
  constructor(
    store: ExternalStore,
    mandates: ExternalMandateService,
    board: ManagerBoardWriter,
    links: ExternalLinkService,
  ) {
    this.store = store
    this.mandates = mandates
    this.board = board
    this.links = links
  }

  async call(turn: ExternalManagerTurn, tool: string, given: unknown): Promise<unknown> {
    const input = fields(given)
    const manager = this.mandates.requireManager(turn)
    if (tool === 'external_inbox_list') {
      keys(input, ['beforeSeq', 'limit', 'sourceId', 'repoId', 'reason', 'status'])
      if (!isExternalMethodParams(EXTERNAL_METHOD.inboxList, input))
        invalid('Invalid inbox filters.')
      return this.store.inbox({ ...input, managerId: manager.id })
    }
    if (tool === 'external_inbox_get') {
      if (Object.hasOwn(input, 'groupId')) {
        keys(input, ['groupId'])
        if (!valid(input.groupId, /^.{1,256}$/)) invalid('Invalid reminder group ID.')
        const group = this.store.queue.deliveryGroup(input.groupId)
        if (!group || group.managerId !== manager.id) invalid('Unknown reminder group.')
        return {
          groupId: group.groupId,
          events: group.eventKeys.flatMap((key) => this.event(key, manager.id)),
          intake: null,
        }
      }
      if (!isExternalMethodParams(EXTERNAL_METHOD.inboxGet, input))
        invalid('Provide one event or intake ID.')
      if ('eventKey' in input) {
        const [event] = this.event(input.eventKey, manager.id)
        if (!event) invalid('Unknown external event.')
        const intake = event.intakeId ? this.store.intake(event.intakeId) : null
        return { events: [event], intake: intake?.managerId === manager.id ? intake : null }
      }
      const intake = this.store.intake(input.intakeId)
      if (!intake || intake.managerId !== manager.id) invalid('Unknown intake.')
      return { intake, events: intake.eventKeys.flatMap((key) => this.event(key, manager.id)) }
    }
    if (tool === 'answer') {
      const { ownerEventKey, expectedDecisionRevision, ...answer } = input
      if (
        !valid(ownerEventKey, /^.{1,256}$/) ||
        !Number.isSafeInteger(expectedDecisionRevision) ||
        Number(expectedDecisionRevision) < 1
      )
        invalid('Provide ownerEventKey and the current expectedDecisionRevision.')
      return this.mandates.ownerAnswer(turn, ownerEventKey, (source) =>
        this.board.answerFromExternal(
          manager.id,
          answer,
          Number(expectedDecisionRevision),
          source,
          turn.turnId,
        ),
      )
    }
    if (tool === 'external_link') {
      keys(input, ['sourceId', 'repoId', 'number', 'kind', 'issueId', 'expectedIssueRevision'])
      if (!isLinkRequest(input)) invalid('Invalid external link target or issue revision.')
      return this.links.link(turn, input)
    }
    if (tool !== 'external_accept' && tool !== 'external_merge' && tool !== 'external_ignore')
      invalid('Unknown external manager operation.')
    const action =
      tool === 'external_accept' ? 'accept' : tool === 'external_merge' ? 'merge' : 'ignore'
    if (Object.hasOwn(input, 'action')) invalid('Supply only the arguments of this tool.')
    const request = { ...input, action }
    if (
      !isExternalMethodParams(EXTERNAL_METHOD.inboxTriage, request) ||
      request.action === 'reassign'
    )
      invalid('Invalid external intake disposition.')
    return this.mandates.decide(turn, request)
  }

  private event(key: string, managerId: string) {
    const event = this.store.inboxEvent(key)
    return event?.managerId === managerId ? [event] : []
  }
}
