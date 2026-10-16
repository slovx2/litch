// Codex 客户端内置的“置顶”分组。桌面以该 ID 查询 thread/list 的置顶分组，
// 引擎必须用同一 ID 记录置顶，并只对真正置顶的会话返回该分组。
export const PINNED_SECTION_ID = '01984de2-8f74-7c91-a3b2-5c5e937cf318'
export const PINNED_SECTION = { id: PINNED_SECTION_ID, name: 'Pinned', appearance: null }
