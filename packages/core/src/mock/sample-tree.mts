// 会话树示例里的文字，中文和英文各一份。演法在 mock-tree.mts。内容全是编出来的。
import type { SampleLang } from './sample-text.mjs'

export interface TreeChild {
  title: string
  prompt: string
  /** 子会话回的话（它这一回合最后的回答，回报取它的开头） */
  reply: string
}

/** 提案的示例：比子会话多几样，凑齐卡片上要显示的东西 */
export interface TreeProposal extends TreeChild {
  /** 子会话的 harness、目录。不给是跟父会话一样 */
  harness?: string
  cwd?: string
  /** 目标 harness 收不到父会话那么严时子会话会是的那一档（卡片上写明） */
  widerSandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** 很快过期（演过期） */
  short?: boolean
}

export interface TreeAgent {
  nickname: string
  role: string
  prompt: string
  reply: string
  /** 能不能在它里面直接输入（canAcceptDirectInput） */
  canInput: boolean
}

export interface TreeText {
  /** 子会话第一段话的开头：由哪个会话派出、做完怎么回报。{parent} 是父会话的标题 */
  briefHead: string
  /** 说“派子会话”时派出的两个，和父会话自己的回话 */
  children: [TreeChild, TreeChild]
  spawnReply: string
  /** 两个子会话都停下之后，设备进程替父会话开的那个回合里父会话说的 */
  wakeReply: string
  /** 说“提个子会话”时提的三个提案（第二个很快过期，第三个在 Pi 上、沙箱收不紧），和父会话的回话 */
  proposals: [TreeProposal, TreeProposal, TreeProposal]
  proposeReply: string
  /** 说“撤回提案”时模型撤回最近一个还等着的提案，和它的回话；没有可撤回的时候的回话 */
  withdrawReply: string
  withdrawNone: string
  /** 说“用子代理”时引擎自己派出的两个子代理，和父会话等它们回来之后说的 */
  agents: [TreeAgent, TreeAgent]
  agentsReply: string
  /** 子代理调用的提示 */
  agentsPrompt: string
}

export const TREE_TEXT: Record<SampleLang, TreeText> = {
  'zh-CN': {
    briefHead:
      '这个会话是由「{parent}」派出的子会话。做完之后把结论写在最后一条回答里，父会话会收到它的开头。',
    children: [
      {
        title: '查依赖版本',
        prompt: '看一下界面包的依赖有没有该升的稳定版，只看，不改。',
        reply: '依赖都看过了：react 19.3.0、vite 7.1.2 已经是最新的稳定版，没有要升的。',
      },
      {
        title: '补解析器的测试',
        prompt: '给 parseSessionEvent 补几条边界用例：标签不完整、JSON 坏了、后面没有正文。',
        reply: '测试补好了：加了 12 条用例，覆盖标签不完整、JSON 坏了、没有正文三种，全部通过。',
      },
    ],
    spawnReply:
      '好，我派了两个子会话分头去做：一个查依赖版本，一个补解析器的测试。它们做完会叫我。',
    wakeReply: '两个子会话都做完了：依赖不用升；解析器的测试补了 12 条，都过了。',
    proposals: [
      {
        title: '整理 CHANGELOG',
        prompt: '把这次的改动整理进 CHANGELOG 的“未发布”一节，中英文各一份。',
        reply: 'CHANGELOG 整理好了：未发布一节加了 5 条，中英文都写了。',
      },
      {
        title: '顺手清理旧分支',
        prompt: '列出已经合进 main 的本地分支，等我确认再删。',
        reply: '列出来了：3 个分支已经合进 main，等你确认。',
        short: true,
      },
      {
        title: '在 Pi 上跑一遍基准',
        prompt:
          '在 packages/core 下跑 npm run bench:router，每组 5 轮取中位，把流式通知的端到端延迟和 thread/list 往返的中位数与上次记录对比，写成一张小表；只量不改代码。',
        reply: '基准跑完了：流式通知多 0.03 毫秒，thread/list 往返多 0.05 毫秒，和上次差不多。',
        harness: 'pi',
        cwd: '~/code/litch/packages/core',
        widerSandbox: 'danger-full-access',
      },
    ],
    proposeReply:
      '这几件事适合另开子会话去做，我各提了一个，你点“开始”就起，也可以改了再开始；第二个只是顺手的事，一会儿就过期。',
    withdrawReply: '那张卡片用不着了，我撤回了。',
    withdrawNone: '现在没有等着的提案可撤回。',
    agents: [
      {
        nickname: 'Hubble',
        role: 'explorer',
        prompt: '把仓库的目录结构走一遍，说说每个包是干什么的。',
        reply: '走完了：packages 下面是协议、核心、界面和各个引擎的入口，apps 下面是桌面和移动端。',
        canInput: true,
      },
      {
        nickname: 'Gauss',
        role: 'worker',
        prompt: '找出 core 里重复的工具函数。',
        reply: '找到 3 处重复：路径拼接两处、时间换算一处，已经列在回答里。',
        canInput: false,
      },
    ],
    agentsReply: '两个子代理都回来了：Hubble 看完了目录结构，Gauss 把重复的代码列出来了。',
    agentsPrompt: '分头看看仓库的结构和重复代码',
  },
  en: {
    briefHead:
      'This is a sub-session started from "{parent}". When you are done, put the conclusion in your last answer; the parent session receives its beginning.',
    children: [
      {
        title: 'Check dependency versions',
        prompt:
          'See whether any UI package dependency has a newer stable release. Look only, change nothing.',
        reply:
          'Checked them all: react 19.3.0 and vite 7.1.2 are already the latest stable releases. Nothing to upgrade.',
      },
      {
        title: 'Add parser tests',
        prompt:
          'Add edge cases for parseSessionEvent: an unfinished tag, broken JSON, no text after it.',
        reply:
          'Tests added: 12 new cases covering an unfinished tag, broken JSON and no text after it. All pass.',
      },
    ],
    spawnReply:
      'Done: I started two sub-sessions, one to check dependency versions and one to add parser tests. They will wake me when they finish.',
    wakeReply:
      'Both sub-sessions are done: no dependency needs an upgrade, and the parser got 12 new tests that all pass.',
    proposals: [
      {
        title: 'Tidy the CHANGELOG',
        prompt:
          'Put this round of changes into the Unreleased section of the CHANGELOG, in both languages.',
        reply: 'CHANGELOG updated: 5 entries under Unreleased, in both languages.',
      },
      {
        title: 'Clean up old branches',
        prompt: 'List the local branches already merged into main and wait for me before deleting.',
        reply: 'Listed: 3 branches are merged into main, waiting for your go-ahead.',
        short: true,
      },
      {
        title: 'Run the benchmark on Pi',
        prompt:
          'In packages/core run npm run bench:router, five rounds per group, take the median, and compare the streaming end-to-end latency and the thread/list round trip with the last recorded numbers in a small table. Measure only, change no code.',
        reply:
          'Benchmark done: streaming adds 0.03 ms and the thread/list round trip 0.05 ms, about the same as last time.',
        harness: 'pi',
        cwd: '~/code/litch/packages/core',
        widerSandbox: 'danger-full-access',
      },
    ],
    proposeReply:
      'These fit better in their own sub-sessions. I proposed one for each; press Start to run one, or change it first. The second is a small extra and expires soon.',
    withdrawReply: 'That card is no longer needed, so I withdrew it.',
    withdrawNone: 'There is no waiting suggestion to withdraw.',
    agents: [
      {
        nickname: 'Hubble',
        role: 'explorer',
        prompt: 'Walk the repository layout and say what each package does.',
        reply:
          'Done: packages holds the protocol, the core, the UI and each engine entry; apps holds desktop and mobile.',
        canInput: true,
      },
      {
        nickname: 'Gauss',
        role: 'worker',
        prompt: 'Find duplicated helpers in core.',
        reply: 'Found 3 duplicates: two path joins and one time conversion, listed in my answer.',
        canInput: false,
      },
    ],
    agentsReply:
      'Both sub-agents are back: Hubble mapped the layout and Gauss listed the duplicated code.',
    agentsPrompt: 'Split up: look at the repository layout and at duplicated code',
  },
}
