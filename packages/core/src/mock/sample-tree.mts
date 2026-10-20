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

/** 收尾（wrap_up）里的一条建议。refused：设备进程没收下它的原因（照设备进程的英文原话） */
export interface TreeSuggestion extends TreeProposal {
  refused?: string
}

export interface TreeAgent {
  nickname: string
  role: string
  /** 一句话描述（子线程的名字，真的 Claude 入口放的是 Agent 工具的 description） */
  description: string
  prompt: string
  reply: string
  /** 能不能在它里面直接输入（canAcceptDirectInput） */
  canInput: boolean
  /**
   * 怎么结束：completed 回一句话就完成；failed 一开始就失败（error 是失败的原话）；
   * stopped 一直在跑，别的都回来之后父会话停掉它（用户也可以在子代理页上停）
   */
  outcome: 'completed' | 'failed' | 'stopped'
  error?: string
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
  /** 说“收尾建议”时回答完调收尾带的三条建议（第三条被拒），和回答 */
  wrapUp: [TreeSuggestion, TreeSuggestion, TreeSuggestion]
  wrapReply: string
  /** 说“忘了收尾”时没调收尾的回答，和设备进程提醒之后模型补的那一条建议 */
  forgetReply: string
  remindSuggestion: TreeSuggestion
  /** 说“用子代理”时引擎自己派出的三个子代理（完成、停掉、失败各一个），和父会话等它们回来之后说的 */
  agents: [TreeAgent, TreeAgent, TreeAgent]
  agentsReply: string
  /** 子代理调用的提示 */
  agentsPrompt: string
  /**
   * 说“新任务”时模型出的 offer 卡（只带标题）：选了新会话，模型补的简报和子会话的回话、父会话的回话；
   * 选了在这里做，模型在这里的回答
   */
  offer: TreeChild
  offerStartedReply: string
  offerHereReply: string
  /**
   * 说“交接”时：父会话手上做到一半的任务（标题、剩下的计划、分叉会话的回话），和父会话交出去之后
   * 回答新消息的那段话
   */
  handOff: TreeChild
  handOffReply: string
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
    wrapUp: [
      {
        title: '给解析器补模糊测试',
        prompt:
          '在 packages/protocol 下给 parseSessionEvent 加一组模糊测试：随机截断、乱插标签、超长 JSON，各跑一千次，确认不抛错、坏的整条当正文；只加测试，不改实现，跑通后报用例数。',
        reply: '模糊测试加好了：三组各一千次，没有抛错，坏的都当正文了。',
      },
      {
        title: '在 Pi 上对一遍文案',
        prompt:
          '把界面包 i18n 下 zh-CN-proposals.ts 和 en-proposals.ts 逐键对一遍：键要一一对应、占位符一致、英文不超过中文两倍长；列出对不上的键，只列不改。',
        reply: '对完了：键都对得上，有 2 条英文偏长，列在回答里了。',
        harness: 'pi',
        cwd: '~/code/litch/packages/ui',
      },
      {
        title: '看看',
        prompt: '看看日志。',
        reply: '',
        refused:
          'The prompt is too short for a fresh session (at least 80; a CJK character counts as 2).',
      },
    ],
    wrapReply:
      '改动做完了，测试都过了。还有两件能单独做的事，我放在下面的建议任务里了，你点“开始”就起。',
    forgetReply: '好，按你说的改完了，构建和测试都过了。',
    remindSuggestion: {
      title: '更新产品手册',
      prompt:
        '把这次加的“完成后唤醒主会话”写进 skills/litch-manual 的建议任务一节：在哪改、改了有什么用、默认是什么；中英文各一段，只改手册。',
      reply: '手册更新好了：建议任务一节加了一段，中英文都写了。',
    },
    agents: [
      {
        nickname: 'Hubble',
        role: 'explorer',
        description: '走一遍仓库的目录结构',
        prompt:
          '把仓库的目录结构走一遍，说说每个包是干什么的。只读，不要改文件；每个包一两句话，给出入口文件的路径。',
        reply: '走完了：packages 下面是协议、核心、界面和各个引擎的入口，apps 下面是桌面和移动端。',
        canInput: true,
        outcome: 'completed',
      },
      {
        nickname: 'Gauss',
        role: 'worker',
        description: '找出 core 里重复的工具函数',
        prompt: '找出 core 里重复的工具函数，列出每一处的路径和行号，说明哪一份该留下。',
        reply: '',
        canInput: false,
        outcome: 'stopped',
      },
      {
        nickname: 'Noether',
        role: 'explorer',
        description: '对照 OpenCode 的 task 子会话',
        prompt:
          '只读调研 OpenCode 的 task 工具：子会话怎么建、父子关系存在哪、界面上怎么显示状态。',
        reply: '',
        canInput: false,
        outcome: 'failed',
        error: 'PreToolUse:Agent hook error: 原生工具意图未能确认落盘或回合已取消，禁止执行。',
      },
    ],
    agentsReply:
      '子代理都停下了：Hubble 看完了目录结构；Gauss 跑得太久，我停掉了它；Noether 没能启动，原因在它的页上。',
    agentsPrompt: '分头看看仓库的结构和重复代码',
    offer: {
      title: '给设置页加导出按钮',
      prompt:
        '在设置页的“诊断”一节加一个“导出”按钮，把当前设置导出成 JSON 文件。相关文件：packages/ui/src/settings/ 下的诊断那一节。做完的标准：点按钮能存下文件，内容和设置页显示的一致，中英文文案都有。',
      reply: '导出按钮加好了：在诊断一节最下面，存下的 JSON 和设置页显示的一致，中英文文案都补了。',
    },
    offerStartedReply: '已经单开了一个会话去做设置页的导出按钮，做完它会回报到这里。',
    offerHereReply: '好，就在这里做。先看一下设置页诊断那一节的结构，再加导出按钮。',
    handOff: {
      title: '整理会话列表的排序',
      prompt:
        '剩下的：1. 把 sidebar/sort.ts 里按时间排序的那一段换成稳定排序；2. 补上置顶的会话排在最前的单测；3. 跑 client:test:ui。做完的标准：排序单测全过，置顶不受更新时间影响。',
      reply: '会话列表的排序整理完了：换成了稳定排序，置顶的单测补上了，client:test:ui 全过。',
    },
    handOffReply:
      '手上整理排序的活交给了一个分叉会话接着做。你问的那个问题：日志在设置页的“诊断”里能导出。',
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
    wrapUp: [
      {
        title: 'Fuzz the event parser',
        prompt:
          'In packages/protocol add fuzz tests for parseSessionEvent: random truncation, stray tags, oversized JSON, a thousand runs each. Confirm it never throws and broken input stays plain text. Tests only, no implementation changes; report the case count.',
        reply:
          'Fuzz tests added: three groups of a thousand runs, no throws, broken input stays text.',
      },
      {
        title: 'Check the copy on Pi',
        prompt:
          'Compare zh-CN-proposals.ts and en-proposals.ts under the UI package i18n key by key: same keys, same placeholders, English no longer than twice the Chinese. List the mismatches; change nothing.',
        reply: 'Compared: all keys match; two English strings run long, listed in my answer.',
        harness: 'pi',
        cwd: '~/code/litch/packages/ui',
      },
      {
        title: 'Look',
        prompt: 'Look at the logs.',
        reply: '',
        refused:
          'The prompt is too short for a fresh session (at least 80; a CJK character counts as 2).',
      },
    ],
    wrapReply:
      'The change is done and the tests pass. Two pieces can run on their own; they are in the suggested tasks below, press Start to run one.',
    forgetReply: 'Done as you asked; the build and the tests pass.',
    remindSuggestion: {
      title: 'Update the product manual',
      prompt:
        'Describe the new "wake the main session when done" option in the suggested-tasks section of skills/litch-manual: where to change it, what it does, the default. One paragraph in each language; manual only.',
      reply: 'Manual updated: one paragraph in the suggested-tasks section, in both languages.',
    },
    agents: [
      {
        nickname: 'Hubble',
        role: 'explorer',
        description: 'Walk the repository layout',
        prompt:
          'Walk the repository layout and say what each package does. Read only, change nothing; a sentence or two per package with its entry file.',
        reply:
          'Done: packages holds the protocol, the core, the UI and each engine entry; apps holds desktop and mobile.',
        canInput: true,
        outcome: 'completed',
      },
      {
        nickname: 'Gauss',
        role: 'worker',
        description: 'Find duplicated helpers in core',
        prompt:
          'Find duplicated helpers in core: list each one with its path and line, and say which copy should stay.',
        reply: '',
        canInput: false,
        outcome: 'stopped',
      },
      {
        nickname: 'Noether',
        role: 'explorer',
        description: "Compare OpenCode's task sub-sessions",
        prompt:
          "Research OpenCode's task tool, read only: how sub-sessions are created, where the parent link is stored, how the UI shows their state.",
        reply: '',
        canInput: false,
        outcome: 'failed',
        error:
          'PreToolUse:Agent hook error: the native tool intent could not be confirmed on disk, or the turn was cancelled.',
      },
    ],
    agentsReply:
      'The sub-agents have stopped: Hubble mapped the layout; Gauss ran too long, so I stopped it; Noether failed to start, the reason is on its page.',
    agentsPrompt: 'Split up: look at the repository layout and at duplicated code',
    offer: {
      title: 'Add an export button to settings',
      prompt:
        'Add an "Export" button to the Diagnostics section of the settings page that saves the current settings as a JSON file. Files: the Diagnostics section under packages/ui/src/settings/. Done when the button saves a file matching what the settings page shows, with both Chinese and English labels.',
      reply:
        'The export button is in: at the bottom of Diagnostics, the saved JSON matches the settings page, and both languages have labels.',
    },
    offerStartedReply:
      'I started a separate session for the settings export button; it will report back here when done.',
    offerHereReply:
      'OK, doing it here. First a look at the Diagnostics section of the settings page, then the export button.',
    handOff: {
      title: 'Tidy up session list sorting',
      prompt:
        'Left to do: 1. replace the time sort in sidebar/sort.ts with a stable sort; 2. add a unit test that pinned sessions come first; 3. run client:test:ui. Done when the sorting tests pass and pinning ignores update time.',
      reply:
        'Session list sorting is done: stable sort, the pinned-first test added, client:test:ui passes.',
    },
    handOffReply:
      'I handed the sorting work to a forked session to finish. As for your question: logs can be exported from Diagnostics in settings.',
  },
}
