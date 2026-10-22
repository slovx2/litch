// 模拟核心里“长报告”那一出（话里带“长报告”，英文 long report）：过程里一段思考、一段说明、五条命令、一次 MCP 读文件，
// 最终回答很长，有标题、段落、两张表和列表。用来看回合结束后在过程区和长回答之间点开、收起时视口稳不稳。
import type { ThreadItem } from '../../../protocol/src/index.mjs'
import type { SampleLang } from './sample-text.mjs'

/** 话里带这些字样时演这一出 */
export const ASKS_REPORT = /长报告|long report/i

interface ReportSample {
  /** 开头的一段思考：头一行显示在过程里，点开看全文 */
  thought: string
  note: string
  commands: { command: string; output: string }[]
  read: string
  answer: string
}

const COMMANDS = [
  {
    command: 'git log --oneline | head -40 && git log --oneline | wc -l',
    output: 'a1b2c3d 补上断线后的重连\n9f8e7d6 地图缓存改成按区域存\n…\n53\n',
  },
  { command: 'wc -l docs/COVERAGE.md', output: '412 docs/COVERAGE.md\n' },
  {
    command: "grep -nE '^\\| *(K|X)[0-9]+' docs/CORE.md | head -30",
    output: '18:| K01 | 会话与角色 |\n19:| K02 | 人物成长 |\n20:| K03 | 世界与地图 |\n',
  },
  { command: 'ls -la .local/probes', output: 'total 24\n-rw-r--r--  1 dev  staff  1840 run.log\n' },
  { command: 'tail -c 300 .local/probes/run.log', output: 'step 1180 ok\nstep 1181 ok\n' },
]

/** 表格的一行：编号、领域、已验证、缺口 */
const row = (cells: string[]) => `| ${cells.join(' | ')} |`

const zhRows = [
  ['K01', '会话与角色', '登录、角色列表、建角、进场、正常退出与重登', '断线自动重连'],
  ['K02', '人物成长', '单点加点、自动加点、回复药', '技能非战斗使用'],
  ['K03', '世界与地图', '单步、校验步、四向寻路、换图、地图缓存', '未知地块的处理'],
  ['K04', '移动与转向', '八方向转向、跨图移动', '传送点'],
  ['K05', '对话与窗口', '多级菜单、分页、按钮', '文本输入、服务端取消'],
  ['K06', '背包与装备', '空槽移动、穿脱', '堆叠与拆分'],
  ['K07', '交易', '发起、取消', '双方确认'],
  ['K08', '队伍', '组队、离队', '队长转移'],
  ['K09', '战斗', '遇敌、攻击、逃跑、换宠、捕捉、结算', '道具、倒地失败'],
  ['K10', '宠物', '出战、休息、改名', '技能学习'],
]

const enRows = [
  [
    'K01',
    'Session & characters',
    'Login, character list, creation, entry, logout and relogin',
    'Auto-reconnect',
  ],
  ['K02', 'Growth', 'Single and auto stat points, potions', 'Out-of-combat skills'],
  [
    'K03',
    'World & maps',
    'Steps, checked steps, pathfinding, map switch, map cache',
    'Unknown tiles',
  ],
  ['K04', 'Movement', 'Eight-way turns, cross-map moves', 'Teleport points'],
  ['K05', 'Dialogs & windows', 'Nested menus, paging, buttons', 'Text input, server cancel'],
  ['K06', 'Inventory', 'Moving to empty slots, equip and unequip', 'Stacking and splitting'],
  ['K07', 'Trade', 'Start, cancel', 'Two-sided confirm'],
  ['K08', 'Party', 'Join, leave', 'Leader handover'],
  ['K09', 'Combat', 'Encounters, attack, flee, swap pets, capture, settlement', 'Items, knockout'],
  ['K10', 'Pets', 'Deploy, rest, rename', 'Skill learning'],
]

const zh: ReportSample = {
  thought: [
    '要总结进展，先弄清范围和现状。',
    '提交记录说明做了什么，覆盖文档说明还差什么，探针日志说明最近一次跑到哪里。',
    '三样对上之后再按领域列表，缺口单独一列。',
  ].join('\n'),
  note: '先看提交记录和覆盖文档，再看探针最近一次跑到哪里。',
  commands: COMMANDS,
  read: 'docs/HANDOFF.md',
  answer: [
    '## 进展总结',
    '',
    '### 一句话现状',
    '',
    '分层已经定下：协议、状态和动作在一层，脚本和策略在另一层，两层之间是常驻的子进程通信。目前有 53 个提交，单项能力大多已经在真实环境验过，但按约定的完整范围，还没有哪一组标记为完成。眼下的主线是“有限练级、等级目标、保护退出”这一串。',
    '',
    '### 已验证的能力',
    '',
    row(['编号', '领域', '已验证', '主要缺口']),
    row(['---', '---', '---', '---']),
    ...zhRows.map(row),
    '',
    '### 下一步',
    '',
    '1. 把断线重连补上，这是挂机的前提。',
    '2. 战斗里的道具和倒地失败要有明确的结局。',
    '3. 练级脚本加上等级目标和退出保护。',
    '4. 覆盖文档按编号逐组标记完成状态。',
    '',
    '### 风险',
    '',
    row(['风险', '影响', '对策']),
    row(['---', '---', '---']),
    row(['服务端更新协议', '动作失效', '每次登录先比对版本']),
    row(['长时间挂机内存上涨', '进程被杀', '每小时自检一次']),
    row(['地图缓存过期', '寻路走错', '换图时校验']),
    row(['账号被限制', '无法登录', '节流、随机间隔']),
    '',
    '以上是现状。要先做哪一块，告诉我就开始。',
  ].join('\n'),
}

const en: ReportSample = {
  thought: [
    'To summarize progress, first pin down the scope and the current state.',
    'The commit log says what was done, the coverage doc what is missing, the probe log where the last run got to.',
    'Once the three agree, list by area with the gaps in their own column.',
  ].join('\n'),
  note: 'First the commit log and the coverage doc, then where the probe got to last time.',
  commands: COMMANDS,
  read: 'docs/HANDOFF.md',
  answer: [
    '## Progress summary',
    '',
    '### Where it stands',
    '',
    'The layering is settled: protocol, state and actions in one layer, scripts and strategy in the other, talking over a long-lived child process. There are 53 commits, and most single capabilities have been verified against the real environment, but no group is marked done against the agreed scope yet. The current focus is the bounded-leveling, level-target and safe-exit chain.',
    '',
    '### Verified capabilities',
    '',
    row(['ID', 'Area', 'Verified', 'Main gaps']),
    row(['---', '---', '---', '---']),
    ...enRows.map(row),
    '',
    '### Next',
    '',
    '1. Add reconnect after a dropped connection; idle runs depend on it.',
    '2. Give combat items and knockouts a defined outcome.',
    '3. Add a level target and safe exit to the leveling script.',
    '4. Mark each group in the coverage doc as done or not.',
    '',
    '### Risks',
    '',
    row(['Risk', 'Impact', 'Mitigation']),
    row(['---', '---', '---']),
    row(['Server protocol update', 'Actions break', 'Compare versions at login']),
    row(['Memory growth on long runs', 'Process killed', 'Hourly self-check']),
    row(['Stale map cache', 'Wrong paths', 'Validate on map switch']),
    row(['Account restricted', 'Cannot log in', 'Throttle with random gaps']),
    '',
    'That is the current state. Tell me which part to start with.',
  ].join('\n'),
}

const SAMPLES: Record<SampleLang, ReportSample> = { 'zh-CN': zh, en }

export const reportSample = (lang: SampleLang): ReportSample => SAMPLES[lang]

/** 那次读文件：一次 MCP 调用，写成协议里的形状，交给真的投影 */
export function readCall(id: string, path: string): ThreadItem {
  return {
    type: 'mcpToolCall',
    id,
    server: 'claude-code',
    tool: 'Read',
    status: 'completed',
    arguments: { file_path: path },
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: true,
    result: {
      content: [{ type: 'text', text: '# Handoff\n\nLayering, coverage and the current focus.\n' }],
      structuredContent: null,
      _meta: null,
    },
    error: null,
    durationMs: 44,
  }
}
