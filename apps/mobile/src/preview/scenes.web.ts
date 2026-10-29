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
    id: 'home',
    group: '设备',
    name: '首页',
    note: '设备列表、定时任务入口、离线设备的原因',
    steps: [],
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
