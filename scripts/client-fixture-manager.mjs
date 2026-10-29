// 经理夹具：行首“经理：<操作> <JSON 参数>”调用 litch_manager，结果加 MANAGER_HEARD 原样回显。
// summary、get、add、update、verify、close、answer、status 的说明前缀来自 client-tools-manager.mts。
// manager-open、manager-answers、manager-end 事件只回固定文字，不调工具；答复附本次决策编号。
// manager-rules 尚未进入 session-tree.mts 的契约，合入后在这里补充。

export const MANAGER_HEARD = '经理结果：'
export const MANAGER_OPENED = '经理已就绪，等待开始。'
export const MANAGER_ANSWERS_HEARD = '收到答复：'
export const MANAGER_ENDED = '经理已结束，未完成事项与决策保留在只读看板。'

export const MANAGER_SPACE = {
  namespace: 'litch_manager',
  marks: {
    summary: 'Read current situation, open decisions, unfinished items and running lines.',
    get: 'Read one decision or item with full fields and change history.',
    add: 'Add a decision or item; returns its id and object.',
    update: 'Patch supplied fields and record why.',
    verify: 'Record that you checked the basis and it is still valid.',
    close: 'Close an open decision as expired/withdrawn, or finish/defer an item.',
    answer: 'Record an answer the user already gave in conversation, as user-conversation.',
    status: 'Replace the current situation with a short account of material progress;',
  },
}

/** 只识别整条事件，避免引用或事件后面的用户指令被当作事件回合吞掉。 */
export function managerEventReply(said) {
  const event = said
    .trim()
    .match(
      /^<litch-session-event kind="(manager-open|manager-answers|manager-end)">([\s\S]*?)<\/litch-session-event>$/,
    )
  if (!event) return null
  if (event[1] === 'manager-open') return { text: MANAGER_OPENED }
  if (event[1] === 'manager-end') return { text: MANAGER_ENDED }
  // 编号来自协议渲染的答复列表，不扫描背景文字或 JSON 里引用的旧决策。
  const ids = [...event[2].matchAll(/^- (D-\d+) /gm)].map((match) => match[1])
  return { text: `${MANAGER_ANSWERS_HEARD}${ids.join('、')}` }
}
