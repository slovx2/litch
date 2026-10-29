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

// CSS 本身不能推断无祖先限定的类在 JSX 中的挂载位置。混合文件明确登记归属；
// 新增有字号的选择器若不属于任何已知区域，检查失败，不能静默漏掉。
const following = {
  'base.css': /^(chip|st|pill|caret-ic|ic)$/,
  'shell.css': /^(dev-(none|row|note)|ws-row|filter-hid|filter-off|row-err|sec-label|ss-[\w-]+)$/,
  'background.css': /^(bgbar|bgmark|pulse|turn-origin|st)$/,
  skins:
    /^(md|umsg|think|code|cmp-[\w-]+|pick-btn|sug-opt|mode-btn|req-[\w-]+|pending-[\w-]+|pill|st|mention|ss-[\w-]+|ws-row|dev-row|sec-label|tree-[\w-]+|agent-[\w-]+)$/,
}
const fixed = {
  'base.css': /^(harness-off-label)$/,
  'shell.css':
    /^(crumb|sb-btn|sb-btn-ic|sb-look-row|sb-look-more|sb-filter-on|sb-link|info-card|info-head|toast)$/,
  'background.css': /^(bg-group|bg-row|bg-stop|bg-empty|bg-task-head|bg-task-none)$/,
  skins: /^(peek|peek-foot|pick-opt)$/,
}
const regionRoots = new Set([
  'sb-scroll',
  'tr',
  'dock',
  'tr-tail',
  'new-compose',
  'cmp',
  'tree-card',
  'prop-card',
  'agent-row',
  'sev',
  'ask',
  'req-frame',
  'pending-asks',
  'child-reqs',
])

/** 返回 follow / fixed / unknown；逗号分组逐个判断，未知分支不能被另一分支掩盖。 */
export function textScope(file, selector) {
  if (textFiles.includes(file)) return 'follow'
  const key = file.startsWith('skins/') ? 'skins' : file
  const scopes = selector.split(',').map((part) => {
    // 去掉属性字符串，避免把属性值里的点号当类名；完整提取类名，ic 不会匹配 ic-other。
    const plain = part.replace(/\[[^\]]*\]/g, '')
    const classes = [...plain.matchAll(/\.([\w-]+)/g)].map((match) => match[1])
    if (classes.some((name) => fixed[key]?.test(name))) return 'fixed'
    if (classes.some((name) => regionRoots.has(name) || following[key]?.test(name))) return 'follow'
    if (
      (key === 'skins' && !classes.length) ||
      (file === 'base.css' && /^(body|button)$/.test(part.trim()))
    )
      return 'fixed'
    return 'unknown'
  })
  if (scopes.includes('unknown')) return 'unknown'
  return scopes.includes('follow') ? 'follow' : 'fixed'
}

export function followsText(file, selector) {
  return textScope(file, selector) === 'follow'
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
