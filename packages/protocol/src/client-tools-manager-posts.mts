// 通用帖子工具只增不改；patch 的对象级权限由设备校验。
import type { ClientToolNamespaceSpec } from './client-tools.mjs'

const text = { type: 'string' }
const markdown = { ...text, description: 'Markdown supported; use it for lists and emphasis.' }
const id = {
  ...text,
  description: 'D-n decision, R-n For you, P-n report, or S-<proposal id> suggestion.',
}
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
export const RELATION_TARGET = object(
  {
    kind: { enum: ['issue', 'item', 'thread', 'file', 'branch', 'commit', 'url'] },
    target: text,
    label: text,
  },
  ['kind', 'target'],
)
export const RELATION_INPUTS = {
  source: {
    type: 'array',
    items: RELATION_TARGET,
    description:
      'Sources this object derives from. Link the originating issue, manager item or workline whenever work is derived from a report or user question.',
  },
  related: {
    type: 'array',
    items: RELATION_TARGET,
    description: 'Other related issues, manager items, worklines or repository evidence.',
  },
}
export const MANAGER_POST_TOOLS: ClientToolNamespaceSpec['tools'] = [
  {
    type: 'function',
    name: 'report',
    description:
      'Publish a longer update, release summary or limitations as a report in the manager Console, instead of a long chat message. Returns P-n and revision. Markdown supported; use it for lists and emphasis.',
    inputSchema: object({ title: text, body: markdown, why: markdown, ...RELATION_INPUTS }, [
      'title',
      'body',
      'why',
    ]),
  },
  {
    type: 'function',
    name: 'relate',
    description:
      'Attach source/related links to an existing issue or manager item. Source means this object derives from that target. References must belong to this manager. Markdown supported in why; explain the relationship.',
    inputSchema: object({ id, ...RELATION_INPUTS, why: markdown }, ['id', 'why']),
  },
  {
    type: 'function',
    name: 'post_get',
    description:
      'Read a decision, For you request, report or suggestion as a post, with discussion and original-post edit history. Use summary to discover ids.',
    inputSchema: object({ id }, ['id']),
  },
  {
    type: 'function',
    name: 'post_reply',
    description:
      'Respond on a post by updating its original content (patch), appending a reply (text), or both. Supply current revision and why. questionId targets one pending question; omit to resolve all pending manager questions. Markdown supported for body, text, why and option descriptions; use it for lists and emphasis. A question is not authorization. Cannot answer decisions or deliver requests for the user.',
    inputSchema: object(
      {
        id,
        revision: { type: 'integer', minimum: 1 },
        questionId: text,
        text: markdown,
        why: markdown,
        patch: object({
          title: text,
          body: markdown,
          buttonLabel: { type: ['string', 'null'] },
          recommend: { type: ['string', 'null'] },
          options: {
            type: 'array',
            items: object({ id: text, label: text, description: markdown }, [
              'id',
              'label',
              'description',
            ]),
          },
        }),
      },
      ['id', 'revision', 'why'],
    ),
  },
]
