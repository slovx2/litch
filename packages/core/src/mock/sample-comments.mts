// 模拟核心里演示“选中回答加评论”用的文字。
// 话里带“评论”（英文 comment）时回一段能选字的回答：过程里一段说明、一条命令，最终回答里有段落、行内代码（含文件路径）、代码块和表格；
// 还有一段行内代码长到要折行的、一张窄屏放不下要横着滑的宽表；
// 消息带着评论时逐条回应，用 [N] 标出对应哪一条，末尾故意多写一个超出条数的编号（界面应照原文显示）。
import type { CommentExtra } from '../projection/comments.mjs'
import type { SampleLang } from './sample-text.mjs'

/** 话里带这些字样、又没带评论时，回那段能选字的回答 */
export const ASKS_COMMENTABLE = /评论|comment/i

interface CommentSample {
  note: string
  command: string
  output: string
  answer: string
  /** 逐条回应的开头 */
  lead(n: number): string
  /** 回应一条：n 编号、quote 引用的开头、note 用户写的评论（可能是空的） */
  one(n: number, quote: string, note: string): string
  tail(over: number): string
}

const zh: CommentSample = {
  note: '先看一眼现在的重试逻辑是怎么写的，再决定改哪里。',
  command: 'grep -n "retry" src/net/client.ts',
  output: '12:  const retry = 3\n40:  for (let at = 0; at < retry; at++) {\n',
  answer: [
    '重试现在固定三次（`src/net/client.ts` 第 12 行的 `retry`）、每次立刻重来，网络抖一下就会把三次全用掉。建议改成指数退避：',
    '',
    '```ts',
    'const delay = (attempt: number) => Math.min(30_000, 500 * 2 ** attempt)',
    '```',
    '',
    '| 第几次 | 等多久 |',
    '| --- | --- |',
    '| 1 | 0.5 秒 |',
    '| 2 | 1 秒 |',
    '| 3 | 2 秒 |',
    '',
    '另外，超时的请求（`ETIMEDOUT`）不该重试：服务端可能已经处理过了，再发一次会重复下单。后台任务是`t3`。',
    '',
    '恢复要改服务器文件并重启容器，需要你同意，具体步骤在 `infra/docs/SERVER_CONTENT_RESTORE.md`。我已经在这里改正了“没用”那句，并补上了重试的核对结果。',
    '',
    '| 接口 | 现在的重试 | 建议的重试 | 超时 | 幂等 | 备注 |',
    '| --- | --- | --- | --- | --- | --- |',
    '| `POST /orders` | 立刻重试三次 | 不重试 | 10 秒 | 否 | 重复下单的风险最大 |',
    '| `GET /orders/:id` | 立刻重试三次 | 指数退避 | 5 秒 | 是 | 可以放心重试 |',
  ].join('\n'),
  lead: (n) => `收到 ${n} 条评论，逐条回应：`,
  one: (n, quote, note) =>
    `[${n}] 关于「${quote}」：${note ? `你说“${note}”，` : ''}这一处我再展开说明一下，改动会放在同一个提交里。`,
  tail: (over) => `以上就是全部，没有第 [${over}] 条。`,
}

const en: CommentSample = {
  note: 'First a look at how the retry logic is written today, then decide what to change.',
  command: 'grep -n "retry" src/net/client.ts',
  output: '12:  const retry = 3\n40:  for (let at = 0; at < retry; at++) {\n',
  answer: [
    'Retries are fixed at three (`retry` on line 12 of `src/net/client.ts`), each one immediate, so a brief network blip burns all three. I suggest exponential backoff:',
    '',
    '```ts',
    'const delay = (attempt: number) => Math.min(30_000, 500 * 2 ** attempt)',
    '```',
    '',
    '| Attempt | Wait |',
    '| --- | --- |',
    '| 1 | 0.5 s |',
    '| 2 | 1 s |',
    '| 3 | 2 s |',
    '',
    'Also, timed-out requests should not be retried: the server may already have handled them, and a second try could place the order twice.',
    '',
    'Restoring means editing server files and restarting the container, so it needs your approval; the steps are in `infra/docs/SERVER_CONTENT_RESTORE.md`. I have already fixed the “useless” sentence there and added the retry check results.',
    '',
    '| Endpoint | Retries now | Suggested retries | Timeout | Idempotent | Notes |',
    '| --- | --- | --- | --- | --- | --- |',
    '| `POST /orders` | three, immediately | none | 10 s | no | highest risk of a duplicate order |',
    '| `GET /orders/:id` | three, immediately | exponential backoff | 5 s | yes | safe to retry |',
  ].join('\n'),
  lead: (n) => `Got ${n} ${n === 1 ? 'comment' : 'comments'}; one by one:`,
  one: (n, quote, note) =>
    `[${n}] On “${quote}”: ${note ? `you said “${note}”. ` : ''}Here is more detail on that part; the change goes into the same commit.`,
  tail: (over) => `That is all of them; there is no [${over}].`,
}

const SAMPLES: Record<SampleLang, CommentSample> = { 'zh-CN': zh, en }

export const commentSample = (lang: SampleLang): CommentSample => SAMPLES[lang]

/** 逐条回应几条评论 */
export function commentsReply(lang: SampleLang, comments: CommentExtra[]): string {
  const sample = SAMPLES[lang]
  const head = (quote: string) => {
    const flat = quote.replace(/\s+/g, ' ').trim()
    return flat.length > 20 ? `${flat.slice(0, 20)}…` : flat
  }
  return [
    sample.lead(comments.length),
    ...comments.map((comment, at) => sample.one(at + 1, head(comment.quote), comment.note)),
    sample.tail(comments.length + 1),
  ].join('\n\n')
}
