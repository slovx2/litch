// 写消息时用得到的示例：各个 harness 上的技能、计划模式下出的那份计划。内容全是编出来的，两种语言各一份。
// 各 harness 故意不一样，在界面上看得出取的是哪一份：
// - Claude Code：仓库里带的、用户自己的、系统带的都有，够多，看得出过滤和滚动；
// - Pi、Codex：各有两三项；
// - dsh：一项都没有——看“没有技能”怎么交代。（真的 dsh 是有技能的，这里空着只是为了留一种“没有”的情形。）
import type { QuestionView, SkillOption } from '../model.mjs'
import type { SampleLang } from './sample-text.mjs'

type Row = [name: string, scope: SkillOption['scope'], zh: string, en: string]

const SKILLS: Record<string, Row[]> = {
  claude: [
    [
      'code-review',
      'repo',
      '把眼前的改动审一遍，挑出问题',
      'Review the current changes and list problems',
    ],
    [
      'release-notes',
      'repo',
      '照提交记录写一份发布说明',
      'Write release notes from the commit log',
    ],
    ['flaky-test', 'user', '排查时过时不过的测试', 'Track down a test that only sometimes fails'],
    ['write-tests', 'user', '给指定的模块补测试', 'Add tests for the module you name'],
    ['changelog', 'user', '整理这一版的变更记录', 'Put together the changelog for this version'],
    ['pdf', 'system', '读写 PDF 文件', 'Read and write PDF files'],
  ],
  pi: [
    [
      'commit',
      'user',
      '整理暂存区，写提交说明',
      'Tidy the staging area and write a commit message',
    ],
    ['summarize', 'user', '把一段长文总结成要点', 'Boil a long text down to its points'],
  ],
  codex: [
    ['refactor', 'repo', '照仓库的约定重构一个模块', "Refactor a module by the repository's rules"],
    ['plan-review', 'user', '把一份计划挑一遍毛病', 'Pick a plan apart for weak spots'],
    ['imagegen', 'system', '生成和修改图片', 'Generate and edit images'],
  ],
  dsh: [],
}

/** 用户自己的、系统带的技能放在哪。仓库里的跟着工作目录走 */
const HOMES: Record<string, string> = {
  claude: '/home/dev/.claude/skills',
  pi: '/home/dev/.pi/agent/skills',
  codex: '/home/dev/.codex/skills',
}

export function sampleSkills(harness: string, lang: SampleLang, cwd: string | null): SkillOption[] {
  const home = HOMES[harness] ?? '/home/dev/skills'
  return (SKILLS[harness] ?? []).flatMap(([name, scope, zh, en]) => {
    // 仓库里的技能要有工作目录才看得到
    if (scope === 'repo' && !cwd) return []
    const root = scope === 'repo' ? `${cwd}/.agents/skills` : home
    return [
      { name, title: name, note: lang === 'en' ? en : zh, path: `${root}/${name}/SKILL.md`, scope },
    ]
  })
}

/** 技能没取到时对面的原话 */
export const SKILLS_FAILED: Record<SampleLang, string> = {
  'zh-CN': '技能目录读不出来：/var/cache/ci/.agents/skills 没有读的权限',
  en: 'Could not read the skills directory: no permission to read /var/cache/ci/.agents/skills',
}

/** 那个目录再取一次时，对面扫到了却没列出来的一项和它的原话 */
export const SKILLS_SKIPPED: Record<SampleLang, { path: string; message: string }> = {
  'zh-CN': {
    path: '/var/cache/ci/.agents/skills/prune-cache/SKILL.md',
    message: '开头的元数据里没有 description',
  },
  en: {
    path: '/var/cache/ci/.agents/skills/prune-cache/SKILL.md',
    message: 'The front matter has no description',
  },
}

/**
 * 计划模式下的一个回合出的东西。和真的一样，适配器的两个引擎出完计划自己接着问：
 * Claude Code 是引擎出的一道题（标识、选项和它的一样），Pi 是计划插件的那张菜单（插件的原话，只有英文）；
 * Codex 说一句就结束，由界面来问。
 */
export interface SamplePlan {
  plan: string
  /** 出完计划之后说的那一句 */
  done: string
  question: QuestionView
}

/**
 * Pi 的计划插件在计划写好之后问的那一句，和真实入口一样：插件只给题目（几行英文）、没有标签，
 * 选项只有字没有说明，是入口拿掉“Start fresh and implement”之后的五项。
 * 选第一项是就地实施；别的模拟里都当留在计划模式（真实入口上导出、留着以后用、丢掉退出会关掉计划模式）
 */
export const PI_PLAN_QUESTION: QuestionView = {
  id: 'q1',
  header: '',
  question: [
    'Proposed plan ready. What next?',
    'Implement here keeps this planning conversation.',
    'Plan reinjection: Off; use conversation history only.',
  ].join('\n'),
  options: [
    'Implement here',
    'Export plan…',
    'Save for later',
    'Stay in Plan mode',
    'Discard plan and exit',
  ].map((label) => ({ label, description: '' })),
  allowOther: false,
  secret: false,
}

export const PLAN_QUESTION_ID = 'execute_plan'

const PLANS: Record<SampleLang, SamplePlan> = {
  'zh-CN': {
    plan: [
      '## 给首页加一个状态条',
      '',
      '1. 在 `web/status.ts` 里加一个取状态的函数，十秒取一次',
      '2. 首页顶上加一条：正常是绿的，出事了是红的，写着是哪一项',
      '3. 补两条测试：取不到的时候、状态变了的时候',
      '',
      '不动构建脚本，也不加新的依赖。',
    ].join('\n'),
    done: '计划写好了，在上面。要改哪里直接说。',
    question: {
      id: PLAN_QUESTION_ID,
      header: '执行计划',
      question: '计划已完成，是否退出计划模式并按当前权限执行？',
      options: [
        { label: '执行计划', description: '退出计划模式，继续执行已确认的计划。' },
        { label: '继续规划', description: '保持计划模式，不执行修改。' },
      ],
      allowOther: true,
      secret: false,
    },
  },
  en: {
    plan: [
      '## Add a status bar to the home page',
      '',
      '1. Add a status fetcher in `web/status.ts`, polling every ten seconds',
      '2. Put a bar at the top of the home page: green when fine, red with the failing item when not',
      '3. Add two tests: when the fetch fails, and when the status changes',
      '',
      'No build script changes and no new dependencies.',
    ].join('\n'),
    done: 'The plan is above. Tell me what to change.',
    question: {
      id: PLAN_QUESTION_ID,
      header: 'Run the plan',
      question: 'The plan is ready. Leave plan mode and carry it out with the current permissions?',
      options: [
        { label: 'Run the plan', description: 'Leave plan mode and carry out the confirmed plan.' },
        { label: 'Keep planning', description: 'Stay in plan mode and change nothing.' },
      ],
      allowOther: true,
      secret: false,
    },
  },
}

export const samplePlan = (lang: SampleLang): SamplePlan => PLANS[lang]
