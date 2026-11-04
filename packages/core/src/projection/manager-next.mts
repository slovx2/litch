// 提交条上的“下一个”找哪一个决策：桌面与手机共用。

/**
 * 当前列表里排在 current 后面、还待定、没有本机草稿的第一个决策；current 不在列表里时从头找。
 * 已写了草稿的跳过：那条已经答过（只差提交），往下是还没答的；草稿失效待确认的不跳，要回去看。
 */
export function nextOpenDecision<Id extends string>(
  entries: readonly { id: Id; status: string }[],
  current: string | null,
  drafted: (id: Id) => boolean,
): Id | null {
  const start = current === null ? 0 : entries.findIndex((entry) => entry.id === current) + 1
  return (
    entries.slice(start).find((entry) => entry.status === 'open' && !drafted(entry.id))?.id ?? null
  )
}
