import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import {
  focusCommentInput,
  onCommentFocus,
  requestCommentFocus,
} from '../src/composer/comment-focus.ts'

function model() {
  const drafts = new Map()
  const module = { exports: {} }
  runInNewContext(
    transformSync(
      readFileSync(new URL('../src/transcript/comments/model.ts', import.meta.url), 'utf8'),
      { loader: 'ts', format: 'cjs' },
    ).code,
    {
      module,
      require(name) {
        if (name === '@litch/core') return { MAX_COMMENTS: 10 }
        if (name === 'react') return {}
        if (name.endsWith('/comment-focus.ts')) return { requestCommentFocus }
        if (name.endsWith('/drafts.ts'))
          return {
            editDraftComments: (key, edit) => drafts.set(key, edit(drafts.get(key) ?? [])),
          }
        throw Error(name)
      },
    },
  )
  return { ...module.exports, drafts }
}

for (const result of ['success', 'reject', 'throw']) {
  test(`直接发送 ${result}：完成后复用会话焦点请求，失败回填先于下一帧聚焦`, async () => {
    const m = model()
    const key = 'nebula:direct'
    const comment = {
      id: 'c1',
      itemId: 'a1',
      quote: '星云引用',
      note: '核对结论',
      start: 0,
      end: 4,
      raw: '星云引用',
    }
    const error = new Error('隔离发送失败')
    const frames = []
    const seen = []
    let otherFocused = false
    const input = {
      value: '已有草稿🌟',
      focus: () => seen.push({ comments: m.drafts.get(key)?.length ?? 0 }),
      setSelectionRange: (start, end) => seen.push([start, end]),
    }
    const off = onCommentFocus(key, () => frames.push(() => focusCommentInput(input)))
    const offOther = onCommentFocus('nebula:other', () => {
      otherFocused = true
    })
    let request
    const channel = {
      command: (name, params) => {
        request = { name, params }
        if (result === 'throw') throw error
        return result === 'reject' ? Promise.reject(error) : Promise.resolve('sent')
      },
    }
    try {
      let caught
      const sent = await m
        .sendComment(channel, 'nebula', 'direct', comment, true)
        .catch((reason) => {
          caught = reason
          m.addComment(key, comment)
        })
      assert.equal(caught, result === 'success' ? undefined : error)
      assert.equal(sent, result === 'success' ? 'sent' : undefined)
      assert.equal(otherFocused, false)
      assert.equal(frames.length, 1)
      assert.equal(seen.length, 0, '焦点等到浮层关闭、回填完成后的下一帧')
      frames[0]()
      assert.deepEqual(seen, [
        { comments: result === 'success' ? 0 : 1 },
        [input.value.length, input.value.length],
      ])
      assert.equal(input.value, '已有草稿🌟')
      assert.equal(request.name, 'session.send')
      assert.equal(request.params.text, '')
      assert.equal(request.params.now, true)
      assert.equal(request.params.extras[0].note, comment.note)
    } finally {
      off()
      offOther()
    }
  })
}
