import type { ClientToolNamespaceSpec } from './client-tools.mjs'
import { RELATION_INPUTS } from './client-tools-manager-posts.mjs'

const string = { type: 'string' }
const id = { ...string, description: 'Issue id in this manager: X-n, D-n, R-n, P-n or S-proposal.' }
const revision = { type: 'integer', minimum: 1 }
const follow = { type: 'string', enum: ['on', 'off'] }
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
export const MANAGER_ISSUE_TOOLS: ClientToolNamespaceSpec['tools'] = [
  {
    type: 'function',
    name: 'issue_create',
    description:
      'Create an ordinary issue for discussion and long-term follow-up. The author is manager; link its source. Does not create a decision or request.',
    inputSchema: object(
      { title: string, body: string, followUp: follow, idempotencyKey: string, ...RELATION_INPUTS },
      ['title', 'body'],
    ),
  },
  {
    type: 'function',
    name: 'issue_get',
    description:
      'Read an issue including id, comments, questions, relations and timeline. Temporary question sessions can only read their current issue.',
    inputSchema: object({ id }, ['id']),
  },
  {
    type: 'function',
    name: 'issue_comment',
    description:
      'Append a manager comment after reading issue_get; to edit your own comment, include commentId and commentRevision. Comments do not answer decisions or deliver user requests. Reuse idempotencyKey when retrying.',
    inputSchema: object(
      {
        id,
        revision,
        body: string,
        why: string,
        idempotencyKey: string,
        replyTo: string,
        commentId: string,
        commentRevision: revision,
      },
      ['id', 'revision', 'body', 'why'],
    ),
  },
  {
    type: 'function',
    name: 'issue_update',
    description:
      'Update an ordinary issue with the current revision and a reason. Special types retain their quick actions and post_reply.',
    inputSchema: object(
      {
        id,
        revision,
        why: string,
        patch: object(
          {
            title: string,
            body: string,
            status: {
              type: 'string',
              enum: ['open', 'in_progress', 'blocked', 'resolved', 'closed'],
            },
            followUp: follow,
            ...RELATION_INPUTS,
          },
          [],
        ),
      },
      ['id', 'revision', 'patch', 'why'],
    ),
  },
  {
    type: 'function',
    name: 'issue_follow',
    description:
      'Pause or resume issue follow-up with an audited reason. Paused comments remain saved, but do not wake the manager; resuming does not replay old comments.',
    inputSchema: object({ id, revision, state: follow, why: string }, [
      'id',
      'revision',
      'state',
      'why',
    ]),
  },
]
