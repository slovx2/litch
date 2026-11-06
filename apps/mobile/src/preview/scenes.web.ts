// 界面预览的场景：每个场景是从首页出发的几步，走正式的路由和测试链接（src/shell/dev-links.ts），
// 数据全来自模拟核心（packages/core/src/mock/）。每次打开场景都重新载入，模拟数据跟着重置。
// 示例数据里的标识（设备 local、build、nas、gpu，会话 s2、b1 等）见 packages/core/src/mock/sample-data.mts；
// “新建会话说一句”的场景靠模拟核心认的触发词（同目录 mock-*.mts 开头的正则）。
import type { RootStackParamList, RouteName } from '../nav/routes'

export type SceneStep =
  | { [R in RouteName]: { nav: R; params: RootStackParamList[R] } }[RouteName]
  | { link: string }

export interface Scene {
  id: string
  group: string
  name: string
  note: string
  steps: SceneStep[]
}

const nav = <R extends RouteName>(route: R, params: RootStackParamList[R]): SceneStep =>
  ({ nav: route, params }) as SceneStep
const link = (url: string): SceneStep => ({ link: url })
const sessions = (deviceId: string) => nav('Sessions', { deviceId })
const open = (deviceId: string, sessionId: string) =>
  link(`litch://open?device=${deviceId}&session=${sessionId}`)
/** 在本机新建一个会话、说这一句：模拟核心按触发词演一个回合 */
const say = (prompt: string) =>
  link(`litch://new?device=local&prompt=${encodeURIComponent(prompt)}`)

export const SCENES: Scene[] = [
  {
    id: 'pair-ts-login',
    group: '设备',
    name: '扫码 · Tailscale 未登录',
    note: '粘贴配对文本后提示登录或直接连接；模拟登录完成后自动继续配对，不连接真实网络',
    steps: [nav('PairDevice', undefined)],
  },
  {
    id: 'pair-ts-account',
    group: '设备',
    name: '扫码 · Tailscale 已登录',
    note: '显示当前网络 personal.example，确认账号或更换为 engineering.example 后自动继续配对',
    steps: [nav('PairDevice', undefined)],
  },
  {
    id: 'managers',
    group: '经理',
    name: '经理目录',
    note: '首页经理入口进入：按设备分组，先进行中、后已结束',
    steps: [nav('Managers', undefined)],
  },
  {
    id: 'manager-chat',
    group: '经理',
    name: '经理工作台 · 对话',
    note: '显式打开对话；页签“控制台 · 对话 · 工作线 · 概览”，正文里的 #D-n 点了拉起半屏议题卡',
    steps: [nav('ManagerConsole', { deviceId: 'local', managerId: 'm1', tab: 'chat' })],
  },
  {
    id: 'manager-lines',
    group: '经理',
    name: '经理工作台 · 工作线',
    note: '等人、出错在前，状态 · 分支 +领先数，没验 N；已合并收在“已结束”',
    steps: [nav('ManagerConsole', { deviceId: 'local', managerId: 'm1', tab: 'lines' })],
  },
  {
    id: 'manager-line-origin',
    group: '经理',
    name: '工作线回经理',
    note: '直接打开一条工作线：副标题前半段“↰ 经理名”，点了推一个落在工作线页签的经理页',
    steps: [open('local', 'manager-k1')],
  },
  {
    id: 'manager-overview',
    group: '经理',
    name: '经理概览',
    note: '现状、几个数、请你做、受阻事项、最近动态，末尾“经理事项 N”',
    steps: [nav('ManagerConsole', { deviceId: 'local', managerId: 'm1', tab: 'overview' })],
  },
  {
    id: 'manager-console',
    group: '经理',
    name: '控制台与议题',
    note: '四类议题、排序、已答决策分块、原帖操作、讨论与双向关联，复用正式页面',
    steps: [nav('ManagerConsole', { deviceId: 'local', managerId: 'm1' })],
  },
  {
    id: 'manager-old-device',
    group: '经理',
    name: '设备服务较旧',
    note: '本机在跑旧版设备服务：页顶写明哪些不可用、去设备详情升级，忽略、追问、交付禁用并写原因，答复照常',
    steps: [
      say('服务旧而忙'),
      nav('ManagerConsole', { deviceId: 'local', managerId: 'm1', tab: 'console' }),
    ],
  },
  {
    id: 'cjk-emphasis',
    group: '对话',
    name: '中文强调定界符',
    note: '加粗、斜体、删除线及代码与链接的共同用例',
    steps: [],
  },
  {
    id: 'collapsed-turn',
    group: '对话',
    name: '回合过程收起',
    note: '后台续做、回合中途补充、分段过程、长回答与唯一的完成行',
    steps: [],
  },
  {
    id: 'manager-events',
    group: '会话',
    name: '经理事件',
    note: '四种经理事件与未知类型兜底；仅展开正文，无看板操作',
    steps: [],
  },
  {
    id: 'wake-off',
    group: '会话',
    name: '子会话不唤醒',
    note: '关闭自动唤醒的子会话在列表中显示弱提示',
    steps: [link('litch://spawn?device=local&parent=s2&title=后台调研'), sessions('local')],
  },
  {
    id: 'stall-recovery',
    group: '会话',
    name: '唤醒后无进展',
    note: '继续等待、中断并继续；只由用户操作',
    steps: [say('恢复观察')],
  },
  {
    id: 'system-cards',
    group: '会话',
    name: '系统卡片',
    note: '定时任务、简报、交接、带长 Markdown 回报的“在这里做”、别的会话发来的话、重启后继续；点开看展开样子',
    steps: [say('看看系统消息')],
  },
  {
    id: 'home',
    group: '设备',
    name: '首页',
    note: '设备列表、定时任务入口、离线设备的原因',
    steps: [],
  },
  {
    id: 'home-recent',
    group: '设备',
    name: '首页 · 最近',
    note: '两台设备上各有主动操作（派子会话）后的「最近」组，线色区分设备',
    steps: [
      link('litch://spawn?device=local&parent=s2&title=调研'),
      link('litch://spawn?device=build&parent=b2&title=复测'),
      link('litch://spawn?device=local&parent=s4&title=整理'),
    ],
  },
  {
    id: 'home-recent-more',
    group: '设备',
    name: '首页 · 最近 · 显示更多',
    note: '七个主对话有过主动操作，默认显示 5 条，其余在“显示更多”里',
    steps: ['s1', 's2', 's3', 's4', 's5']
      .map((parent) => link(`litch://spawn?device=local&parent=${parent}&title=跟进`))
      .concat(
        ['b1', 'b2'].map((parent) =>
          link(`litch://spawn?device=build&parent=${parent}&title=复测`),
        ),
      ),
  },
  {
    id: 'home-recent-managers',
    group: '设备',
    name: '首页 · 最近经理',
    note: '工作线操作归入经理主项，点击经理打开与经理目录相同的工作台',
    steps: [
      link('litch://spawn?device=local&parent=manager-k1&title=经理工作线跟进'),
      link('litch://spawn?device=build&parent=m2&title=远程经理跟进'),
    ],
  },
  {
    id: 'manager-session-link',
    group: '经理',
    name: '会话链接打开经理',
    note: '开发深链只给会话 ID，经公共入口进入经理工作台；返回回到首页',
    steps: [open('local', 'm1')],
  },
  {
    id: 'add-device',
    group: '设备',
    name: '添加设备',
    note: '主机、端口、用户、密钥',
    steps: [nav('AddDevice', undefined)],
  },
  {
    id: 'pair',
    group: '设备',
    name: '扫码添加',
    note: '扫码或粘贴配对文本（预览里没有相机）',
    steps: [nav('PairDevice', undefined)],
  },
  {
    id: 'device',
    group: '设备',
    name: '设备详情',
    note: '连接信息、harness 的启用与设置',
    steps: [nav('DeviceDetail', { deviceId: 'local' })],
  },
  {
    id: 'device-offline',
    group: '设备',
    name: '设备详情 · 离线',
    note: '连不上的设备',
    steps: [nav('DeviceDetail', { deviceId: 'gpu' })],
  },
  {
    id: 'hconfig',
    group: '设备',
    name: 'harness 详情设置',
    note: 'Claude Code 的配置、账号、MCP',
    steps: [link('litch://hconfig?device=local&harness=claude')],
  },
  {
    id: 'hconfig-codex',
    group: '设备',
    name: 'harness 详情设置 · Codex',
    note: '模型清单在“模型”页',
    steps: [link('litch://hconfig?device=build&harness=codex')],
  },
  {
    id: 'settings',
    group: '设备',
    name: '应用设置',
    note: '语言、明暗、任务卡、更新、关于',
    steps: [nav('Settings', undefined)],
  },

  {
    id: 'sessions',
    group: '会话',
    name: '会话列表',
    note: '置顶、分区、项目、工作区、无项目',
    steps: [sessions('local')],
  },
  {
    id: 'sessions-build',
    group: '会话',
    name: '会话列表 · 等人与出错',
    note: '等回答、出错的会话',
    steps: [sessions('build')],
  },
  {
    id: 'sessions-offline',
    group: '会话',
    name: '会话列表 · 离线设备',
    note: '设备连不上时的横条',
    steps: [sessions('gpu')],
  },
  {
    id: 'new-session',
    group: '会话',
    name: '新建会话',
    note: 'harness、项目、模型和权限',
    steps: [sessions('local'), nav('NewSession', { deviceId: 'local' })],
  },

  {
    id: 'approval',
    group: '对话',
    name: '等审批',
    note: '命令和 MCP 工具两张审批排着',
    steps: [sessions('local'), open('local', 's2')],
  },
  {
    id: 'sign-in-approval',
    group: '对话',
    name: '批准电脑上的登录',
    note: '代理请求登录的卡片：打码的账号、批准前过指纹（模拟核心里每台设备第一个不在等人答的会话上一张）',
    steps: [sessions('local'), open('local', 'p1')],
  },
  {
    id: 'chrome-instance',
    group: '对话',
    name: 'Chrome 实例审批',
    note: '代理要列这台电脑上一个 Chrome 实例的标签页',
    steps: [say('用 Chrome')],
  },
  {
    id: 'chrome-site',
    group: '对话',
    name: 'Chrome 网站审批',
    note: '代理要在 Chrome 里打开没去过的网站',
    steps: [say('用 Chrome 打开网站')],
  },
  {
    id: 'chrome-sign-in',
    group: '对话',
    name: 'Chrome 登录',
    note: '代理请人在 Chrome 里登录，登录完点“已完成登录”',
    steps: [say('用 Chrome 登录')],
  },
  {
    id: 'pending-questions',
    group: '对话',
    name: '跨回合待答问题',
    note: '问题的时长、回报数和忽略操作',
    steps: [say('收尾后回报')],
  },
  {
    id: 'question',
    group: '对话',
    name: '提问与表单',
    note: '三道题的提问，答完是一张 MCP 表单',
    steps: [sessions('build'), open('build', 'b1')],
  },
  {
    id: 'running',
    group: '对话',
    name: '回合进行中',
    note: '正在工作、过程区',
    steps: [sessions('local'), open('local', 's1')],
  },
  {
    id: 'error',
    group: '对话',
    name: '出错的会话',
    note: '回合失败',
    steps: [sessions('build'), open('build', 'b4')],
  },
  {
    id: 'goal',
    group: '对话',
    name: '持续目标',
    note: 'Codex 会话：输入框打 / 选 /goal',
    steps: [sessions('build'), open('build', 'b6')],
  },
  {
    id: 'unread',
    group: '对话',
    name: '读完的回答',
    note: 'Pi 会话的完整回合',
    steps: [sessions('local'), open('local', 's3')],
  },
  {
    id: 'proposals',
    group: '对话',
    name: '建议任务卡片',
    note: '三张提案卡、顶上的建议任务条',
    steps: [say('提个子会话')],
  },
  {
    id: 'wrapup',
    group: '对话',
    name: '收尾建议',
    note: '回答下面的问题和按钮',
    steps: [say('收尾建议')],
  },
  {
    id: 'background',
    group: '对话',
    name: '后台任务',
    note: '输入框上方一行、过程摘要末尾',
    steps: [say('后台任务')],
  },
  {
    id: 'agents',
    group: '对话',
    name: '子代理',
    note: '子代理一行和它的状态',
    steps: [say('用子代理')],
  },
  {
    id: 'ask-inline',
    group: '对话',
    name: '提问卡片',
    note: '回合里问几道题',
    steps: [say('提问')],
  },
  { id: 'todos', group: '对话', name: '待办', note: '回合里的待办清单', steps: [say('待办')] },
  {
    id: 'edits',
    group: '对话',
    name: '改文件',
    note: '改了哪些文件和一小段差异',
    steps: [say('改文件')],
  },
  {
    id: 'mermaid',
    group: '对话',
    name: '图表',
    note: 'Mermaid 卡片，第二张有语法错',
    steps: [say('画图')],
  },
  {
    id: 'mermaid-many',
    group: '对话',
    name: '多张图',
    note: '一长段回答里七张 Mermaid：滚动、进屏才画',
    steps: [say('画几张图')],
  },
  {
    id: 'markdown',
    group: '对话',
    name: 'Markdown 样例',
    note: '各种写法：列表互相嵌套、多位数序号、任务列表、引用、表格、代码、分隔线、图片、长行折行（渲染回归，安卓上另在模拟器里看）',
    steps: [say('markdown 样例')],
  },
  {
    id: 'retry',
    group: '对话',
    name: '重试中',
    note: '模型请求在重试：状态行写第几次和原因',
    steps: [say('重试请求')],
  },
  {
    id: 'report',
    group: '对话',
    name: '长报告',
    note: '标题、列表、表格、代码',
    steps: [say('长报告')],
  },
  { id: 'comments', group: '对话', name: '评论', note: '选中回答文字加评论', steps: [say('评论')] },
  {
    id: 'peer',
    group: '对话',
    name: '会话间消息',
    note: '来自别的会话的消息',
    steps: [say('别的会话')],
  },
  {
    id: 'child-requests',
    group: '对话',
    name: '子会话待处理',
    note: '子会话停下要审批，在父会话里代答',
    steps: [say('子会话待审批')],
  },
  {
    id: 'delegated',
    group: '对话',
    name: '代答记录',
    note: '别的会话替这个会话答过的请求',
    steps: [say('代答记录')],
  },
  {
    id: 'system-cards',
    group: '对话',
    name: '系统消息',
    note: '定时任务、子会话的启动指令、在这里做画成的卡片',
    steps: [say('系统消息')],
  },
  {
    id: 'browser',
    group: '对话',
    name: '内置浏览器',
    note: '代理用浏览器的步骤',
    steps: [say('用浏览器')],
  },

  {
    id: 'terminal',
    group: '工具',
    name: '终端',
    note: 'xterm 和底下的按键条',
    steps: [sessions('local'), link('litch://terminal?device=local')],
  },
  {
    id: 'diff',
    group: '工具',
    name: '未提交的改动',
    note: '文件列表和逐个文件的差异',
    steps: [sessions('local'), link('litch://diff?device=local')],
  },
  {
    id: 'files',
    group: '工具',
    name: '文件',
    note: '目录和文件内容',
    steps: [sessions('local'), nav('Files', { deviceId: 'local', root: '~/work/litch' })],
  },
  {
    id: 'file-links',
    group: '工具',
    name: '对话文件链接',
    note: '标准链接、行号、目录展开和失败详情，使用模拟核心',
    steps: [say('看文件')],
  },
  {
    id: 'outside-previews',
    group: '工具',
    name: '根外图片与 PDF',
    note: '对话绝对链接 → 核心临时根 → 手机受限预览，全程模拟设备',
    steps: [say('根外预览')],
  },

  {
    id: 'tasks',
    group: '定时任务',
    name: '任务列表',
    note: '按设备分组，名字、日程、下一次',
    steps: [nav('Tasks', {})],
  },
  {
    id: 'task',
    group: '定时任务',
    name: '任务详情',
    note: '立即运行、暂停、运行记录',
    steps: [nav('Tasks', {}), nav('TaskDetail', { deviceId: 'local', taskId: 'task-standup' })],
  },
  {
    id: 'task-new',
    group: '定时任务',
    name: '新建任务',
    note: '日程、目标、要说的话',
    steps: [nav('Tasks', {}), nav('TaskEdit', { deviceId: 'local' })],
  },
]

export const sceneById = (id: string | null): Scene | undefined =>
  SCENES.find((scene) => scene.id === id)
