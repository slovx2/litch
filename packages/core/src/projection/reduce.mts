// 把一条会话增量落到会话视图上。原地修改视图。
// 核心靠它维护“现在这个会话长什么样”，后来的订阅者拿到的快照才包含之前的增量；模拟核心也用它。
// 界面那一侧按键存放，落增量的逻辑在 replica 里，两边的语义必须一致。
//
// 增量是值：它带来的对象一律拷一份再放进视图，视图和增量之间不共用任何对象。
// 同一条增量还要交给订阅的一方，在通道里最多排一帧才发出去；要是视图里放的就是它带来的那个条目，
// 后面的“追加文本”就地一改，排着队的“添加条目”就跟着带上了这段字，到界面再追加一遍，同一段字出现两遍。
import type { SessionOp } from '../channel/protocol.mjs'
import type { SessionView } from '../model.mjs'
import { appendOutput, appendSkipping } from '../text/output-cap.mjs'
import { copyValue } from '../value.mjs'

export function reduceSession(view: SessionView, op: SessionOp): void {
  switch (op.op) {
    case 'turn.add': {
      const index = view.turns.findIndex((turn) => turn.id === op.turn.id)
      const turn = copyValue(op.turn)
      if (index < 0) view.turns.push(turn)
      else view.turns[index] = turn
      return
    }
    case 'turn.remove': {
      const index = view.turns.findIndex((turn) => turn.id === op.turnId)
      if (index < 0) return
      for (const itemId of view.turns[index]?.itemIds ?? []) delete view.items[itemId]
      view.turns.splice(index, 1)
      return
    }
    case 'turn.status': {
      const turn = view.turns.find((entry) => entry.id === op.turnId)
      if (!turn) return
      turn.status = op.status
      turn.durationMs = op.durationMs
      if (op.error !== undefined) turn.error = op.error
      return
    }
    case 'item.add': {
      view.items[op.item.id] = copyValue(op.item)
      const turn = view.turns.find((entry) => entry.id === op.turnId)
      if (turn && !turn.itemIds.includes(op.item.id)) turn.itemIds.push(op.item.id)
      return
    }
    case 'item.appendText': {
      const item = view.items[op.itemId]
      if (!item) return
      if (op.field === 'output') {
        // 命令的输出有上限，接的规矩和界面的副本是同一个函数（text/output-cap.mts）
        if (item.kind === 'command') Object.assign(item, appendOutput(item, op.text))
      } else if (
        item.kind === 'agentMessage' ||
        item.kind === 'reasoning' ||
        item.kind === 'plan'
      ) {
        item.text += op.text
      }
      return
    }
    case 'item.appendOutput': {
      // 通道上只留了头尾的一大段（channel/server.mts）：接出来和整段接的一样
      const item = view.items[op.itemId]
      if (item?.kind === 'command') Object.assign(item, appendSkipping(item, op))
      return
    }
    case 'item.remove': {
      delete view.items[op.itemId]
      const turn = view.turns.find((entry) => entry.id === op.turnId)
      if (turn) turn.itemIds = turn.itemIds.filter((id) => id !== op.itemId)
      return
    }
    case 'item.status': {
      const item = view.items[op.itemId]
      // 有些条目没有状态（用户消息、计划、一行说明）
      if (item && 'status' in item) item.status = op.status
      return
    }
    case 'request.add':
      if (!view.requests.some((request) => request.id === op.request.id))
        view.requests.push(copyValue(op.request))
      return
    case 'request.remove':
      view.requests = view.requests.filter((request) => request.id !== op.requestId)
      return
    case 'queue.set':
      view.queued = copyValue(op.queued)
      return
    case 'session.state':
      view.live = op.live
      view.note = copyValue(op.note)
      return
    case 'session.settings':
      view.settings = copyValue(op.settings)
      return
    case 'session.usage':
      view.usage = copyValue(op.usage)
      return
    case 'session.can':
      view.can = copyValue(op.can)
      return
    case 'session.proposals':
      view.proposals = copyValue(op.proposals)
      return
    case 'session.agents':
      view.agents = copyValue(op.agents)
      return
  }
}
