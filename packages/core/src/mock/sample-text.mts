// 示例数据里的文字，中文和英文各一份。结构（哪台设备、哪个会话、哪些条目）在 sample-data.mts 里，两种语言共用。
// 内容全是编出来的。

export type SampleLang = 'zh-CN' | 'en'

export interface SampleText {
  /** 不可用的那个 harness，设备服务对原因的原话 */
  harnessReason: string
  /** 别的客户端里建的那个自定义分区叫什么 */
  sectionLater: string
  /** 演“别处整理了侧栏”时，别处新建的那个工作区叫什么 */
  elsewhereWorkspace: string
  /** 会话标题，键是会话的标识 */
  titles: Record<string, string>
  streamHead: string
  streamRest: string
  history: [question: string, answer: string][]
  firstAsk: string
  firstAnswer: string
  secondAsk: string
  secondThought: string
  placeholder: string
  diskFull: string
  /** 等审批的那个会话 */
  approvalAsk: string
  approvalNote: string
  approvalReason: string
  /** 等回答的那个会话 */
  questionAsk: string
  questionNote: string
  /** 一次问三道：单选、自己写、单选。最后一道是单选，选完就交卷 */
  questions: SampleQuestion[]
  /** 话里带“问一句”时问的那一道单选题 */
  singleQuestion: SampleQuestion
  /** 模拟核心收到回答之后带在回话前面的那一句，后面一题一行；跳过的题写成什么 */
  answersHeard: string
  answerSkipped: string
  /** 排在那次审批后面的：一个 MCP 工具调用的审批 */
  toolAsk: { reason: string; title: string; note: string; ticket: string }
  /** 排在那次提问后面的：MCP 服务要填的一张表 */
  form: {
    message: string
    region: string
    regions: [string, string]
    replicas: string
    notify: string
    notifyNote: string
    migrate: string
    checks: string
    checkNames: [string, string, string]
  }
  /** 在模拟核心里发消息得到的回答 */
  mockReply: string
  /** 发的话里带“跑一会儿”时，那条命令结束后一次给全的输出 */
  runOutput: string
  /** 对话里“配置：…”跑完 litch config 之后的回答：成了、没成 */
  configDone: string
  configFailed: string
  /**
   * 发的话里带“看文件”时的回答：里面有几种写法的文件路径（行内代码、带行号、链接、正文里的），
   * 也有几样不该认成文件的。给界面试“对话里的路径可以点开”用
   */
  filesReply: string
  /** 发的话里带“画图”时的回答：一张 mermaid 图，后面跟一张有语法错、画不出来的 */
  diagramReply: string
  /** 发的话里带“改文件”时，改完之后说的一句 */
  editReply: string
  /** 拒绝审批时附了说明：对面听到之后说的一句。{note} 换成那句说明 */
  declineHeard: string
  /** 新建会话的第一句话里带“建不成”时，对面不肯建的原话 */
  createRefused: string
  /** 模拟的待办：一开始列的几步、列的时候附的说明、做到一半加的一步和那时的说明 */
  todo: { steps: string[]; note: string; added: string; revised: string }
}

export interface SampleQuestion {
  header: string
  question: string
  /** null：没有选项，自己写 */
  options: { label: string; description: string }[] | null
}

const zh: SampleText = {
  harnessReason: '在 PATH 和常见的安装位置里都没有找到 codex',
  sectionLater: '稍后看',
  elsewhereWorkspace: '别处建的',
  titles: {
    p1: '发版前的检查清单',
    p2: '文档站的待办汇总',
    k1: '读一遍 launchd 的日志轮转',
    b6: '核对构建机上的 codex 配置',
    s1: '把运行时与 SSH 入口的启动拆开',
    s2: '聚合面：会话列表合并与复合游标',
    s3: 'Pi 入口过早上报最终回答',
    s4: '设备进程的转发开销基准',
    s5: '握手里的扩展声明放哪个字段',
    s6: '远程设备安装指引',
    s7: '能力矩阵页改成从声明生成',
    s8: '首页文案',
    s9: '查一下 launchd 的 KeepAlive 语义',
    d1: '导航栏按使用场景重排',
    d2: '给每个命令补一个最短示例',
    d3: '排障页：按报错原文能搜到',
    d4: '升级说明里的不兼容改动',
    d5: '把截图换成当前版本的',
    d6: '英文版缺的三页',
    d7: '术语表：入口、运行时、设备',
    d8: '站内搜索的中文分词',
    d9: '文档站的构建换到 Node 24',
    a1: '评估把入口换成 Rust 的工作量',
    a2: '清掉握手里不用的旧字段',
    b1: 'Linux 安装包：systemd 用户服务',
    b2: '跑一遍官方桌面端请求回放',
    b3: '差异面板的大文件降级',
    b4: '轮换构建机的磁盘',
    b5: '缓存目录配额',
    n1: '整理快照保留策略',
    g1: '评测脚本并行化',
    g2: '数据集校验和不一致',
  },
  streamHead: '启动顺序已经拆开了。',
  streamRest: [
    '现在入口监听失败只会把**这一个入口**标成不可用，并把原因记下来；运行时照常工作。',
    '',
    '改动有三处：',
    '',
    '1. `serveRuntime` 拆成 `startRuntime` 和 `startSSHEntry` 两步，后一步失败不再返回错误。',
    '2. 入口的状态里多了一个失败原因，`status` 命令会把它打出来。',
    '3. `doctor` 里的端口检查从报错改成了告警。',
    '',
    '我补了一个端口被占时的测试：',
    '',
    '```go',
    'func TestEntryFailureKeepsRuntime(t *testing.T) {',
    '\tbusy := occupy(t, 7332)',
    '\tdefer busy.Close()',
    '\tstate := start(t, "--harness", "pi")',
    '\tassertEntryFailed(t, state, "ssh")',
    '}',
    '```',
    '',
    '先占住 7332，再启动服务，确认 Pi 的运行时仍然可以经套接字连上，状态里能看到这个入口失败的原因。',
    '',
    '还有两点要你定：',
    '',
    '- 入口失败以后要不要**自动重试**。我倾向于不重试，端口被占通常要人来处理。',
    '- 失败原因要不要也写进日志文件。现在只在状态里有，重启后就看不到了。',
    '',
    '接下来我把 `doctor` 的输出格式也顺一下，让“告警”和“错误”在终端里一眼能分开。',
  ].join('\n'),
  history: [
    [
      '设备服务的状态目录放哪？',
      '默认在用户主目录下的 `.codex-harness-adapter`，每个 harness 一个子目录。套接字、锁文件、日志都在里面，只有属主能访问。',
    ],
    [
      '套接字路径有长度限制吗？',
      '有。macOS 上大约是 104 个字节，超了会直接创建失败。\n\n现在的做法是路径超过 100 就报错，并提示换一个短一点的状态目录。',
    ],
    [
      '异常退出后残留的套接字文件怎么办？',
      '启动时先拿状态锁。拿到锁说明没有别的实例在跑，这时把残留的套接字文件删掉再监听；拿不到锁就说明已经有实例了，直接退出。',
    ],
    [
      '入口和运行时是什么关系？',
      '运行时是真正跑 harness 的那个进程，只监听套接字。\n\n入口是给官方桌面端用的 SSH 服务，它把连进来的会话转接到运行时的套接字上。一个运行时可以没有入口，但入口离不开运行时。',
    ],
    [
      '那为什么入口失败会连累运行时？',
      '因为启动函数是顺着写下来的：起运行时、开入口、任何一步出错就整体返回。入口监听失败时，延迟执行的清理把运行时也停了。',
    ],
    [
      '有没有现成的测试能覆盖这种情况？',
      '没有。现有的测试都假设端口是空的。\n\n要加一个先把端口占住再启动的测试，断言运行时还在、入口被标成失败。',
    ],
    [
      '端口被占的错误信息够清楚吗？',
      '不太够，现在只有系统给的 `address already in use`。应该带上是哪个入口、哪个端口，以及怎么换端口。',
    ],
    [
      '先把这些整理成一个改动清单。',
      '整理如下：\n\n- 启动拆成两步，入口失败不影响运行时\n- 入口状态带失败原因\n- 端口检查改成告警\n- 补一个端口被占的测试\n- 错误信息写清楚入口和端口',
    ],
  ],
  firstAsk:
    '设备服务现在只要有一个 SSH 端口开不成，整个 harness 就起不来。先看看是哪里连在一起的。',
  firstAnswer:
    '连在一起的地方在 serveRuntime：它先起运行时，再开 SSH 入口，入口监听失败时直接返回错误，运行时也跟着停。',
  secondAsk: '把启动拆成两步，入口失败只记在这个入口上。改完跑一下现有测试。',
  secondThought: '拆成 startRuntime 和 startSSHEntry 两步，失败记在入口上。',
  placeholder: '这是模拟核心给的占位回答。接上真实的设备之后，这里显示这个会话的历史。',
  diskFull: '构建机的磁盘满了，命令没能执行。',
  approvalAsk: '把复合游标那组测试跑一遍，过了就提交。',
  approvalNote: '先跑复合游标的测试。测试要装一个新加的开发依赖，得联网。',
  approvalReason: '这条命令要访问网络下载依赖，超出了当前的权限预设。',
  questionAsk: '给 Linux 的安装包配一个 systemd 服务，装完就能用。',
  questionNote: '动手之前有三处要你定一下。',
  questions: [
    {
      header: '服务范围',
      question: '服务装在哪一级？',
      options: [
        { label: '用户级（推荐）', description: 'systemctl --user，不需要 root，随登录启动' },
        { label: '系统级', description: '开机就启动，需要 root 和一个专用的用户' },
      ],
    },
    { header: '服务名', question: '服务叫什么名字？', options: null },
    {
      header: '日志',
      question: '日志写到哪里？',
      options: [
        { label: 'journald（推荐）', description: '用 journalctl --user 查看，自动轮转' },
        { label: '状态目录下的文件', description: '和 macOS 上的做法一致，要自己轮转' },
      ],
    },
  ],
  singleQuestion: {
    header: '时机',
    question: '现在就动手改吗？',
    options: [
      { label: '现在就改', description: '改完跑一遍现有的测试' },
      { label: '先出方案', description: '只写计划，不动文件' },
    ],
  },
  answersHeard: '收到你的回答：',
  answerSkipped: '（跳过）',
  toolAsk: {
    reason: '允许 tracker 这个 MCP 服务运行“新建工单”吗？',
    title: '新建工单',
    note: '在团队的工单系统里建一张工单',
    ticket: '复合游标在翻到最后一页时多返回一条',
  },
  form: {
    message: '部署到预发环境之前，确认几项设置。',
    region: '区域',
    regions: ['香港', '美西'],
    replicas: '实例数',
    notify: '完成后通知谁',
    notifyNote: '填邮箱，留空就不发',
    migrate: '先跑数据库迁移',
    checks: '发布前跑哪些检查',
    checkNames: ['冒烟测试', '端到端测试', '性能基准'],
  },
  runOutput: '共 42 项测试，全部通过\n',
  configDone: '照你说的改好了，上面是 litch config 的输出。',
  configFailed: '这一步没做成，原因在上面 litch config 的输出里。',
  mockReply: [
    '这是模拟核心的回答：你发的这条消息已经收到了。',
    '',
    '这里没有连任何设备，所以不会真的去读文件或者执行命令。接上真实的设备之后，回答由那边的引擎给出，这里看到的发送、排队、打断都是同一套路径。',
  ].join('\n'),
  filesReply: [
    '这次改动涉及这几处：',
    '',
    '- 入口在 `cmd/codex-harness-adapter/serve.go:131`，监听失败只标这一个入口。',
    '- 用法见 [使用说明](docs/guide.md#L12) 和 `README.md`。',
    '- 文件模块在 packages/core/src/device/files.mts:40，界面的入口是 `packages/ui/src/app/App.tsx`。',
    '- 长的那个是 `fixtures/long.ts:4200`。',
    '',
    '下面这几样不是工作区里的文件：`console.log`、`../outside/secret.txt`、读/写，还有 https://example.com/a/b.ts 这个网址。',
  ].join('\n'),
  diagramReply: [
    '会话树现在的数据流是这样的，虚线是子会话停下后回到父会话的那一路：',
    '',
    '```mermaid',
    'flowchart LR',
    '  P[父会话] -->|litch_sessions.start| D[设备进程]',
    '  D -->|派出| C[子会话]',
    '  D --> S[(会话存储：父子关系)]',
    '  C -.->|回报 / 唤醒| P',
    '```',
    '',
    '下面这张写错了，画不出来：',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[开始] --> --> B',
    '```',
  ].join('\n'),
  editReply: '改好了：在记录里添了一行，另外新写了一份草稿。差异面板里看得到这两处。',
  declineHeard: '这条命令不跑了。你的说明我看到了：{note}',
  createRefused: '模拟的设备不肯建这个会话（话里带了“建不成”）',
  todo: {
    steps: [
      '读一遍现在的启动流程，找出入口失败时是在哪一步把整个服务带倒的',
      '把启动拆成“运行时”和“入口”两步',
      '入口失败只记在这个入口上',
      '跑一遍现有的测试',
    ],
    note: '先把要做的事列出来，一步一步来。',
    added: '给入口失败补一条测试',
    revised: '现有的测试里没有覆盖入口失败的，多加一步。',
  },
}

const en: SampleText = {
  harnessReason: 'codex was not found on PATH or in the usual install locations',
  sectionLater: 'Later',
  elsewhereWorkspace: 'Made elsewhere',
  titles: {
    p1: 'Pre-release checklist',
    p2: 'Docs site to-do roundup',
    k1: 'Read up on launchd log rotation',
    b6: 'Check the codex config on the build box',
    s1: 'Split runtime startup from the SSH entry',
    s2: 'Aggregate view: merged session list and composite cursor',
    s3: 'Pi entry reports the final answer too early',
    s4: 'Benchmark the device process forwarding overhead',
    s5: 'Which handshake field carries the extension manifest',
    s6: 'Remote device install guide',
    s7: 'Generate the capability matrix page from manifests',
    s8: 'Homepage copy',
    s9: 'Look into launchd KeepAlive semantics',
    d1: 'Reorder the navigation by use case',
    d2: 'Add a minimal example for every command',
    d3: 'Troubleshooting: searchable by error text',
    d4: 'Breaking changes in the upgrade notes',
    d5: 'Replace screenshots with current ones',
    d6: 'Three pages missing from the English docs',
    d7: 'Glossary: entry, runtime, device',
    d8: 'Chinese tokenization for site search',
    d9: 'Move the docs build to Node 24',
    a1: 'Estimate the cost of rewriting the entry in Rust',
    a2: 'Remove unused legacy handshake fields',
    b1: 'Linux package: systemd user service',
    b2: 'Replay the official desktop request trace',
    b3: 'Large-file fallback in the diff panel',
    b4: 'Rotate the build machine disks',
    b5: 'Cache directory quota',
    n1: 'Tidy up the snapshot retention policy',
    g1: 'Parallelize the eval scripts',
    g2: 'Dataset checksum mismatch',
  },
  streamHead: 'Startup is now split in two.',
  streamRest: [
    // 开头的空格是有意的：它接在 streamHead 那一句后面
    ' If the entry fails to listen, only **that one entry** is marked unavailable and the reason is recorded; the runtime keeps working.',
    '',
    'Three changes:',
    '',
    '1. `serveRuntime` is split into `startRuntime` and `startSSHEntry`; a failure in the second step no longer returns an error.',
    '2. The entry state now carries a failure reason, and the `status` command prints it.',
    '3. The port check in `doctor` is downgraded from an error to a warning.',
    '',
    'I added a test for the port-in-use case:',
    '',
    '```go',
    'func TestEntryFailureKeepsRuntime(t *testing.T) {',
    '\tbusy := occupy(t, 7332)',
    '\tdefer busy.Close()',
    '\tstate := start(t, "--harness", "pi")',
    '\tassertEntryFailed(t, state, "ssh")',
    '}',
    '```',
    '',
    'It occupies 7332 first, then starts the service and checks that the Pi runtime is still reachable over its socket and that the state shows why this entry failed.',
    '',
    'Two things for you to decide:',
    '',
    '- Whether a failed entry should **retry automatically**. I lean towards no: a busy port usually needs a human.',
    '- Whether the failure reason should also go to the log file. Right now it only lives in the state and is gone after a restart.',
    '',
    'Next I’ll tidy up the `doctor` output so warnings and errors are easy to tell apart in a terminal.',
  ].join('\n'),
  history: [
    [
      'Where does the device service keep its state directory?',
      'By default in `.codex-harness-adapter` under the home directory, one subdirectory per harness. The socket, lock file and logs all live there and only the owner can access them.',
    ],
    [
      'Is there a length limit on the socket path?',
      'Yes. On macOS it is about 104 bytes, and going over makes creation fail outright.\n\nThe current behaviour is to error out above 100 and suggest a shorter state directory.',
    ],
    [
      'What about a socket file left behind after a crash?',
      'Startup takes the state lock first. Holding the lock means no other instance is running, so the stale socket file is removed before listening; failing to get the lock means an instance already exists, so we exit.',
    ],
    [
      'How do the entry and the runtime relate?',
      'The runtime is the process that actually runs the harness and it only listens on a socket.\n\nThe entry is the SSH service for the official desktop app; it bridges incoming sessions to the runtime socket. A runtime can live without an entry, but not the other way round.',
    ],
    [
      'Then why does an entry failure take the runtime down?',
      'Because the startup function is written top to bottom: start the runtime, open the entry, return as a whole on any error. When the entry fails to listen, the deferred cleanup stops the runtime too.',
    ],
    [
      'Is there an existing test that covers this?',
      'No. The existing tests all assume the port is free.\n\nWe need one that occupies the port first and then asserts the runtime is alive and the entry is marked failed.',
    ],
    [
      'Is the port-in-use error message clear enough?',
      'Not really; it is just the system’s `address already in use`. It should say which entry, which port, and how to pick another port.',
    ],
    [
      'Put all of this into a change list first.',
      'Here it is:\n\n- Split startup in two so an entry failure does not affect the runtime\n- Entry state carries a failure reason\n- Port check becomes a warning\n- Add a port-in-use test\n- Error message names the entry and the port',
    ],
  ],
  firstAsk:
    'Right now a single SSH port that fails to open keeps the whole harness from starting. Find out where the two are tied together.',
  firstAnswer:
    'They are tied together in serveRuntime: it starts the runtime, then opens the SSH entry, and returns the error as soon as the entry fails to listen, which stops the runtime as well.',
  secondAsk:
    'Split startup into two steps and record an entry failure on that entry only. Run the existing tests when you are done.',
  secondThought: 'Split into startRuntime and startSSHEntry, and record the failure on the entry.',
  placeholder:
    'This is a placeholder answer from the mock core. Once a real device is connected, the history of this session shows up here.',
  diskFull: 'The build machine’s disk is full, so the command could not run.',
  approvalAsk: 'Run the composite cursor tests and commit if they pass.',
  approvalNote:
    'Running the composite cursor tests first. They need a newly added dev dependency, which means going online.',
  approvalReason:
    'This command needs network access to download dependencies, which the current permission preset does not allow.',
  questionAsk: 'Give the Linux package a systemd service so it works right after install.',
  questionNote: 'Three things for you to decide before I start.',
  questions: [
    {
      header: 'Scope',
      question: 'At which level should the service be installed?',
      options: [
        { label: 'User (recommended)', description: 'systemctl --user, no root, starts at login' },
        { label: 'System', description: 'Starts at boot, needs root and a dedicated user' },
      ],
    },
    { header: 'Service name', question: 'What should the service be called?', options: null },
    {
      header: 'Logs',
      question: 'Where should the logs go?',
      options: [
        {
          label: 'journald (recommended)',
          description: 'Read with journalctl --user, rotated for you',
        },
        {
          label: 'A file in the state directory',
          description: 'Same as on macOS, rotation is up to you',
        },
      ],
    },
  ],
  singleQuestion: {
    header: 'Timing',
    question: 'Start making changes now?',
    options: [
      { label: 'Change it now', description: 'Run the existing tests afterwards' },
      { label: 'Plan first', description: 'Write a plan, touch no files' },
    ],
  },
  answersHeard: 'Got your answers:',
  answerSkipped: '(skipped)',
  toolAsk: {
    reason: 'Allow the tracker MCP server to run “Create ticket”?',
    title: 'Create ticket',
    note: 'Creates a ticket in the team tracker',
    ticket: 'Composite cursor returns one extra row on the last page',
  },
  form: {
    message: 'Confirm a few settings before deploying to staging.',
    region: 'Region',
    regions: ['Hong Kong', 'US West'],
    replicas: 'Instances',
    notify: 'Who to notify when done',
    notifyNote: 'An email address; leave empty to skip',
    migrate: 'Run database migrations first',
    checks: 'Checks to run before release',
    checkNames: ['Smoke tests', 'End-to-end tests', 'Performance baseline'],
  },
  runOutput: '42 tests, all passed\n',
  configDone: 'Done. The litch config output is above.',
  configFailed: 'That did not go through; the litch config output above says why.',
  mockReply: [
    'This is the mock core answering: your message has arrived.',
    '',
    'No device is connected here, so nothing reads files or runs commands. Once a real device is connected the answer comes from its engine; sending, queueing and interrupting take the same path you see here.',
  ].join('\n'),
  filesReply: [
    'This change touches a few places:',
    '',
    '- The entry is at `cmd/codex-harness-adapter/serve.go:131`; a failed listen only marks that entry.',
    '- Usage is in [the guide](docs/guide.md#L12) and `README.md`.',
    '- The files module is at packages/core/src/device/files.mts:40, and the interface starts in `packages/ui/src/app/App.tsx`.',
    '- The long one is `fixtures/long.ts:4200`.',
    '',
    'These are not files in the workspace: `console.log`, https://example.com/a/b.ts, `../outside/secret.txt`, read/write.',
  ].join('\n'),
  diagramReply: [
    "Here is how the session tree's data flows today. The dashed line is the path back to the parent once a child stops:",
    '',
    '```mermaid',
    'flowchart LR',
    '  P[Parent session] -->|litch_sessions.start| D[Device process]',
    '  D -->|spawns| C[Child session]',
    '  D --> S[(Session store: parent links)]',
    '  C -.->|report / wake| P',
    '```',
    '',
    "This one has a mistake and can't be drawn:",
    '',
    '```mermaid',
    'flowchart LR',
    '  A[Start] --> --> B',
    '```',
  ].join('\n'),
  editReply:
    'Done: one line added to the log, and a new draft written. Both show up in the diff panel.',
  declineHeard: 'I will not run that command. I saw your note: {note}',
  createRefused: 'The simulated device refused to start this session (the message said so)',
  todo: {
    steps: [
      'Read the current startup flow and find where a failing entry takes the whole service down',
      'Split startup into a runtime step and an entry step',
      'Record an entry failure on that entry only',
      'Run the existing tests',
    ],
    note: 'Listing what needs doing first, then taking it one step at a time.',
    added: 'Add a test for a failing entry',
    revised: 'None of the existing tests cover a failing entry, so one more step.',
  },
}

export const SAMPLE_TEXT: Record<SampleLang, SampleText> = { 'zh-CN': zh, en }
