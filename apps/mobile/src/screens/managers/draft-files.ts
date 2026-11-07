// 手机上的经理草稿文件，按“设备、经理、议题”的同一个键存：选项、补充说明或回复、追问，以及草稿开始写时的版本。
// 纯逻辑，不引用 React（订阅用的钩子在 use-draft-files.ts）。写入时通知订阅者：底部提交条和卡头标记随写随算；批量提交或清除后另有一个“清过”的版本号，已经展开的卡据此重读文件。
import { type JsonFile, jsonFile } from '../../shell/json-file'

const listeners = new Set<() => void>()
let version = 0
let cleared = 0
export const subscribeDrafts = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const publish = () => {
  version++
  for (const listener of listeners) listener()
}
function watched<T>(name: string): JsonFile<T> {
  const file = jsonFile<T>(name)
  return {
    read: () => file.read(),
    write(value) {
      file.write(value)
      publish()
    },
    remove() {
      file.remove()
      publish()
    },
  }
}

export const choiceFile = watched<Record<string, string>>('manager-choices.json')
export const replyFile = watched<Record<string, string>>('manager-replies.json')
export const questionFile = watched<Record<string, string>>('manager-questions.json')
/** 草稿开始写时议题的版本：议题在别处答复、关闭、忽略或取消后据此判断草稿已结束（core 的 *DraftState） */
export const baseFile = watched<Record<string, number>>('manager-draft-revisions.json')
/** 用户主动修改已有答复时的版本，普通遗留草稿不能借同版状态冒充修改。 */
export const editFile = watched<Record<string, number>>('manager-answer-edits.json')

/** 任一草稿文件写过就变 */
export const draftVersion = () => version
/** 批量提交或清除草稿之后变：卡片丢掉手里的旧草稿，重读文件 */
export const draftsCleared = () => cleared

/** 删掉一组键上的指定草稿；某个键什么都不剩时连版本记录一起删 */
export function clearDrafts(
  keys: Iterable<string>,
  parts: { choice?: boolean; reply?: boolean; question?: boolean },
) {
  const choices = { ...choiceFile.read() }
  const replies = { ...replyFile.read() }
  const questions = { ...questionFile.read() }
  const bases = { ...baseFile.read() }
  const edits = { ...editFile.read() }
  for (const key of keys) {
    if (parts.choice || parts.reply) delete edits[key]
    if (parts.choice) delete choices[key]
    if (parts.reply) delete replies[key]
    if (parts.question) delete questions[key]
    if (!choices[key] && !replies[key]?.trim() && !questions[key]?.trim()) delete bases[key]
  }
  cleared++
  choiceFile.write(choices)
  replyFile.write(replies)
  questionFile.write(questions)
  baseFile.write(bases)
  editFile.write(edits)
}
