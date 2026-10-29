// 字号检查与迁移共用的范围。共享样式按所在组件继承 --fs；外壳、弹层在区域边界重置为 1。
// 不把差异、文件、终端、信息栏等独立工具纳入检查。
export const textFiles = [
  'tree.css',
  'transcript.css',
  'transcript-prose.css',
  'dock.css',
  'compose.css',
  'ask.css',
  'comments.css',
  'goal.css',
  'text-size.css',
]
export const sharedFiles = [
  'base.css',
  'shell.css',
  'background.css',
  'skins/retro.css',
  'skins/human.css',
  'skins/standard.css',
]

export function followsText(file, selector) {
  if (textFiles.includes(file)) return true
  if (file === 'base.css') return /\.(chip|st|pill|caret-ic|ic)\b/.test(selector)
  if (file === 'shell.css')
    return /\.(dev-(?:none|row|note)|ws-row|filter-hid|row-err|sec-label|ss-[\w-]+)\b/.test(
      selector,
    )
  if (file === 'background.css') return /\.(bgbar|pulse)\b/.test(selector)
  if (file.startsWith('skins/'))
    return /\.(md|umsg|think|code|cmp-[\w-]+|pick-btn|sug-opt|mode-btn|req-[\w-]+|pending-[\w-]+|pill|st|mention|ss-[\w-]+|ws-row|dev-row|sec-label|tree-[\w-]+|agent-[\w-]+)\b/.test(
      selector,
    )
  return false
}

/** CSS 的最内层规则；先去注释（保留行号），媒体块里的组件规则也会逐条检查。 */
export function textRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim(),
    body: match[2],
    at: match.index + match[0].indexOf('{') + 1,
  }))
}

/** calc/round 里的像素不是裸值；font 简写的字号和斜线后行高一起检查。 */
export function bareTextPixels(body) {
  return [...body.matchAll(/(?:^|;)\s*(font-size|font|line-height)\s*:\s*([^;]+)/g)].flatMap(
    (match) => {
      let value = match[2]
      if (/\b\d+(?:\.\d+)?px\b/.test(value) && !value.includes('var(--fs)'))
        return [`${match[1]}: ${value.trim()}`]
      if (match[1] === 'line-height' && /px\b/.test(value) && !value.includes('round('))
        return [`${match[1]}: ${value.trim()}`]
      const leading = match[1] === 'font' ? value.split('/')[1] : undefined
      if (leading && /px\b/.test(leading) && !leading.includes('round('))
        return [`${match[1]}: ${value.trim()}`]
      // 由内向外剥函数，避免 calc(12px * var(--fs)) 里的 px 被算成裸值。
      while (/[-\w]+\([^()]*\)/.test(value)) value = value.replace(/[-\w]+\([^()]*\)/g, '')
      return /\b\d+(?:\.\d+)?px\b/.test(value) ? [`${match[1]}: ${match[2].trim()}`] : []
    },
  )
}
