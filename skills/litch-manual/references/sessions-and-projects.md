# Projects and sessions

## Projects

A project is a folder on one device. Sessions of every harness in that folder are listed under it, and
the side panel (files, diff) and terminals follow the project.

- `scripts/litch projects list <device>` lists the device's projects with their paths (arguments of
  the project actions: `scripts/litch projects --help`).
- `scripts/litch projects add <device> <path>` adds a folder as a project. The path is on that device
  (absolute, or `~/…`); the folder must exist there.
- `scripts/litch projects remove <device> <project>` removes the project from the sidebar. The folder
  and the sessions in it are not deleted; the sessions show under "No project" or wherever their working
  folder fits.

In the UI: Add project… on the device's menu, the **+** on the built-in Projects group, or in the
new-session project picker. In the dialog, type the folder, pick one used by sessions not in a project,
or press Choose…: on this computer it opens the system folder dialog, on a remote device (and in the
phone app) it browses the device's folders in place (Up, tap a folder to go in; hidden folders are not
listed); rename, color, pin, move to a group (or back to Projects), reorder and delete
from the project's menu. Groups (sidebar folders) are made from the device menu (New group…). Projects
that are not pinned or in a group are listed under the built-in Projects group (it can't be renamed or
deleted). In the sidebar, drag a project onto a group's title row to put it at the end of that group
(the row lights up), or between two projects to place it there (a line shows where it lands); dragging
it onto Projects takes it out of its group. Drag a group's title row (or Projects') above or below
another group to change their order, or use Move up / Move down in its menu; Pinned stays on top and
the order is remembered on this computer only. Sessions can be dragged onto Pinned or a group's title, or
back onto their own project. The phone app shows the same groups but has no dragging. Arranging the
sidebar (groups, pins, order) is not available through the command; tell the user how to do it in the
sidebar.

## Sessions

### 从其他入口打开会话

桌面端从通知、任务卡、会话链接、经理工作线或待处理入口打开会话时，侧栏自动展开所在设备、项目分组和各级父会话，并高亮当前行。只有目标不在可见区域时才滚动定位；直接点击树内会话行不会触发自动展开或滚动。侧栏收起时保持收起，重新打开后再定位。单独查看某组时，从其他入口打开会话会返回完整列表。

定位不修改“更多”里的显示开关或 harness 筛选。当前会话仍遵守已有的临时显示规则；目标确实不能显示时，定位到最近可见的祖先。归档预览不选中侧栏里的会话。

### 经理（桌面端）

侧栏顶部切换“对话 / 经理”。经理是专门管理其他会话的会话，看板保存在所选设备上；经理及其子会话只列在经理栏。切到经理时先打开全部经理页，列表按设备分组，已结束的经理放在下方。

“新建经理”打开独立表单：填写设备、项目或工作目录，并选择 harness、模型与强度。“经理设定”为可选的自定义提示词，可填写角色设定、行为规范等；名称可留空，由经理命名。任务分配默认使用经理的 harness、共用工作目录、由经理验收后合并，最大并行工作线数为四；“代码修改使用独立工作树”默认不勾选。决策未答复时持续等待；桌面通知开关目前仅保存偏好，尚未接入通知发送。

行为规则由设备根据当前任务分配与等待策略自动生成，不在界面展示或编辑；修改设置后重拼提示词时使用最新值。“经理设定”保留用户原文，放在提示词最后，可留空；任务分配和界面语言变化不会覆盖它。“首个任务”留空时仅制定计划，待用户确认后开始；开场使用用户设定或对话的语言。

经理页左侧是普通对话，右侧是概览、决策、事项和工作线。窄窗口使用“对话 / 看板”切换。工作线可打开子会话；子会话顶端的“返回经理”返回经理页。经理在对话中提到决策时，可以同时说明选项和推荐；用户在看板上提交答复，也可以在对话中明确答复。

经理页标题栏的“设置”可修改名称、经理设定、任务分配（子会话 harness、模型与强度、工作树、合并方式、并发上限）和桌面通知。设备、工作目录和经理自己的 harness、模型与强度只供查看。经理设定与任务分配分别保存，修改任务分配或通知选项不会覆盖用户设定。保存失败会显示原因并保留表单；取消不保存。经理设定内容变化后，对话会出现“已更新经理设定”事件卡。结束中和已结束的经理不提供设置入口。

决策可以选推荐或其他选项，也可以直接写答复。答复先保存在当前桌面端本地，不跨客户端同步，不自动提交。底部“提交给经理”将答复写入设备看板，并触发经理处理；部分失败时只清除成功项，失败草稿保留。决策版本变化后，需要核对最新内容并确认当前版本。“清除草稿”仅清除本地未提交内容。已关闭决策可重新打开。事项中的决策编号可以点击，切到决策页并定位对应卡片；已答或已关闭的决策会自动切到相应分组。

决策的依据记录其关联文件、提交、分支或会话；缺少依据仍可创建，设备会提示经理补齐。依据按看板记录显示，第一版不自动检测过时，也不显示“仍然有效”和“推迟”按钮。结束经理前会提示看板将只读、未完成事项保留。确认后先进入“结束中”，仍列在进行中组，对话和看板不可写；收尾回合完成、失败或被打断后转为“已结束”。经理设定更新会在对话中显示“已更新经理设定”事件。已结束经理的“查看总结”当前为占位，不提供接手。

经理自己开的工作线（包括线派出的子会话）完成、改动已落地或作废后，由经理直接归档，不再询问用户；结束经理时也按此处理。归档后可恢复。运行中或置顶的会话仍不会归档。归档其他会话仍须用户明确同意；看板答复开启的经理回合可以执行，回报唤醒、提醒等事件回合不视为用户同意。

新界面创建和保存设置时发送空范围，仅将“经理设定”原文写入自定义规则字段；旧版设备仍要求非空范围，需升级设备后使用新表单。

### 停止或恢复回报主对话

经理栏里的工作线也提供相同的停报菜单与标记，切换“对话 / 经理”不会重置设置。Manager worklines use the same reporting menu and indicator; switching sidebar tabs keeps the setting.

桌面端在侧栏子会话行右键，手机端长按会话行，选择“停止回报主对话”或“恢复回报主对话”。停止回报的子会话行显示“已停报”标记。默认回报；只有支持此功能的执行设备才显示菜单，离线时禁用并说明原因。

停止后，子会话仍挂在父会话下，自身的运行和等待用户状态照常显示。完成、失败、中断、待答请求和后台任务结束都不再自动回报父会话，也不触发唤醒；该子会话尚未投递的回报会移出队列，已送达的不撤回。静默子会话不会挡住其他子会话唤醒父会话。

恢复只接收今后的新事件，不补发停报期间的历史结果；如果仍有已等待满 10 秒的待答请求，补报一次当前请求；未满 10 秒的继续等待原来的提醒计时。是否唤醒仍遵守独立的 `wake_parent` 开关及原有条件。设置保存在执行设备上，重连或重启后保留。模型的 `list`、`read` 可读 `report_parent`，没有修改此开关的模型工具；`set_wake` 只控制唤醒。

On desktop, right-click a child session in the sidebar; on mobile, long-press its row. Choose **Stop reporting to parent** or **Resume reporting to parent**. Rows show **Reports off** while reporting is stopped. Reporting starts enabled. The menu requires device support and is disabled with a reason while offline.

Stopping reports keeps the child in its tree and leaves its own running or waiting status visible. It suppresses automatic completion, failure, interruption, pending-request and background-task reports, removes its undelivered reports, and prevents those reports from waking the parent. Delivered reports remain. Other children can still wake the parent. Resuming does not replay old results; it reports a currently pending request once after the usual 10-second waiting threshold, then future events. Waking still follows `wake_parent` and the existing rules. This device-side preference survives reconnects and restarts. Models can read `report_parent` through `list` and `read`, but cannot change it; `set_wake` only controls waking.

手机上的经理开始、看板答复、收尾和经理设定更新显示为系统事件行，可展开正文；答复摘要显示决策编号。手机不提供经理页或看板操作。未知事件显示“会话事件”，展开保留种类与正文。On mobile, manager events are expandable system rows; board-answer summaries include decision IDs. They provide no manager-page navigation or board actions. Unknown kinds use “Session event” and retain the kind and body when expanded.

### 问题结果与输入

已答问题默认收成一行，显示已答题数和答案摘要；展开后，每题的选择或自由文字统一显示在“回答”区域，其他选项默认折叠。系统消息（子会话回报、定时任务、会话间消息、在这里做等）也默认显示一行来源与摘要，点击展开全文；开合状态按会话保留。桌面问题输入框支持 Shift+Enter 换行、Enter 确认；输入法组字时的 Enter 只确认候选。手机多行输入用回车换行，使用卡片按钮提交。
子会话在桌面侧栏、手机列表、任务卡和会话详情中显示 harness 标识。
用户在自动唤醒的回合中插话成功后，该回合也按用户回合处理；后来的自动消息不会覆盖这个来源。

用户已经要求派出子会话，或批准的计划已经包含子会话时，模型可在后续唤醒、提醒、定时任务等任意回合通过 `start(initiation: "user_asked")` 直接启动；任务卡关闭也可用。仅批准目标不等于批准拆会话，新的限制或撤销优先。每个父会话每回合直接启动最多 16 个，同时运行或启动的直接子会话最多 8 个；整棵树同时运行或启动最多 24 个会话（含根），嵌套最多 4 层（根为第 0 层）。并发创建预占名额，只有会话尚未创建时失败才退还；已创建但首回合未确认启动的仍计入额度，并占运行名额，直到开始、归档或删除。重连或重启不重置同回合额度，归档成功时清理该会话的直接启动记录。进程在启动结果未确认时退出，已预占的回合额度保守保留。
直接启动不占提案卡名额；提案、offer 与收尾建议合计每回合最多 4 张，撤回仍计数，提醒回合与来源回合合计。目标 harness 需要放宽沙箱时仍须用户确认。50 次自动唤醒上限不变。

主会话可用 `litch_sessions.set_wake(thread_id, wake)` 关闭或重新打开直接子会话的自动唤醒；`start` 的 `wake_parent` 默认开启。主会话也可以覆盖用户此前在界面上选择的唤醒设置。关闭后回报仍入队、显示，也仍可插入正在运行的主会话；重新开启会检查已有回报，但不会绕过用户停止、失败、定时回合和唤醒次数等限制。`list`、`read` 会返回当前开关，桌面会话详情顶部的来历一行写“完成后不唤醒父会话”，手机会话行显示“不唤醒”。

### 子会话待答与代答

父会话输入框上方显示直接子会话的阻塞请求。展开某条会订阅原子会话，使用同一张请求卡作答；仍可打开子会话处理。密码、登录、手机签名或仅原执行设备能处理的请求遵循原有限制。
模型通过 `litch_sessions.read` 查看当前请求 ID、类型与内容，通过显式 `respond(thread_id, request_id, answer)` 代答。只能代答自己的子孙会话，或在包含用户输入的回合里代答；有过消息联系本身不授予代答权限。
普通消息、回报和自发回合都不是答案。过期、目标不匹配、无权限、秘密字段会返回结构化错误。命令、文件及权限审批和阻塞提问支持代答；MCP 表单与原执行端专属请求由用户处理。异步提问与收尾问题仍用各会话自己的待答区。
代答以设备生成的审计记录保存在子会话中，显示“由主会话代答”或具体来源会话；重开历史仍可查看最近 100 条记录。未声明会话树扩展的客户端不接收这些字段。

### 待答问题

桌面和手机的输入框上方会保留收尾问题与异步提问。子会话回报、定时任务、会话间消息和后台唤醒不会清掉它们。
收尾问题在所属回合结束后计入未答集合，随后的唤醒和收尾提醒会附上这些问题。
新旧问题可以同时回答，相同的待答问题只显示一次。点击回复按钮或在题目下填写回答后，只有对应的问题收起；异步卡中尚未回答的其他题目继续保留。
待答题只在输入框上方的交互卡显示；回答、忽略或关闭后，对话流再显示这道题的记录，已有的答案合并在同一张卡中。多题部分作答时，对话流只显示已处理的题，剩余题目继续在待答区作答。
用户直接在会话输入框发话则视为回答此前的待答问题，一起收起。自动的计划确认也遵循这一区分：自发回合不清除，用户发话后收起。
待答区可以折叠，折叠后仍显示问题数量。回答会按当前发送方式插话或排队；撤销排队中的答复会恢复问题。
待答卡按刚刚、分钟、小时、天显示提出时间，并显示之后收到的子会话回报数。设备支持时显示“忽略”。点“忽略”仅隐藏当前问题，不向代理发送消息，也不算回答或撤回；忽略状态在桌面、手机和重连后同步。代理在唤醒或收尾提醒时仍会看到未答题及“用户已忽略”标记，不应重复催问；过时的题应撤回。

模型可以在 `litch_sessions.wrap_up` 的 `withdraw_questions` 中列出已经不需要回答的旧题目原文，明确撤回这些问题。
审批、AskUserQuestion 和阻塞式 request_user_input 仍在请求卡片中回答；只有对应的请求被答复、撤回或其所属回合结束时收起，其他回合不会清掉它们。

Sessions are not created or edited through `litch config`. What the user can do in the UI, so you can
explain it:

- **Start**: New session (Mod+N) → pick device, project, harness, model, reasoning effort, permissions
  (Read only / In project / Full access, or the harness's own presets) and optionally turn on the
  Plan mode switch → send the
  first message. `scripts/litch open new` brings the user to this page.
- **Worktrees**: on the New session page, when the project folder is in a git repository on a device
  that supports worktrees, "Where" offers Local (the project folder) or New worktree. A new worktree is
  created by the device service with its own branch (named from the first line of the message), so the
  session's changes stay out of the project folder; "From" picks what to branch from: the default
  branch, the current local state (current commit plus uncommitted changes and new files), or any
  local or remote branch. The choice is remembered per device and project. Such a session shows a
  branch mark in the sidebar and a Worktree card in the info rail (branch, base, path; Terminal, Copy
  path, and Restore when the folder was removed). The terminal panel follows the session: in such a
  session it switches to a terminal opened in the worktree (opening one if needed; the card's
  Terminal does the same), and new terminals open there; other sessions of the project switch back to
  one at the project root. The session's menu has "Delete worktree": it deletes the folder and keeps
  the session and branch (uncommitted changes saved as a snapshot, brought back when the session is
  opened again). Ignored files copied when the worktree was made (`.worktreeinclude`, local harness
  settings) are copied again when it is restored. Device settings → Worktrees lists every worktree on
  the device: Remove deletes the folder and keeps the branch (uncommitted changes saved as a snapshot,
  or discarded), Restore brings a removed one back with its snapshot, Remove with branch deletes both
  for good. The Worktree card also has "Merge <base>": it merges new commits from the branch the
  worktree started from (nothing is pushed; commit the worktree's changes first; on conflicts it stops
  and lists the files to resolve in the terminal or by the model). In such a session the Diff tab's
  "All" compares against where the worktree started (its latest common commit with the base branch),
  so committed changes show too ("Since <commit>"); those can't be discarded there. Archiving the
  session removes a clean worktree (the branch stays), keeps one with uncommitted changes (see
  `worktrees.keptDays`), or hands it to a session still sharing it (a sub-session or fork working in
  that folder); reopening or unarchiving the session, or a sharing session, brings the folder back
  (changes made on the branch since then are kept; a clash is left as conflicts to resolve). Deleting
  the session hands the worktree to a session still sharing it, otherwise deletes the folder without
  a snapshot (the confirmation says so).
  Where worktrees go, how branches are named and automatic cleanup: `device-settings.md`.
  The phone app has the same "Where" and "Start from" choices on its New session page; a session in a
  worktree shows its branch in the session list and under the title, and the conversation menu's
  **Worktree** sheet shows branch, base and path with Terminal, Merge <base>, Copy path, and Restore
  when the folder was removed.
- **While a turn runs**: with Settings → Conversation → Sending during a turn set to Send now (the
  default) a message goes straight into the running turn and the button reads Send; set to Queue, or
  when the harness can't take messages mid-turn (or can't take images mid-turn and the message has
  some), it waits in the queue above the composer until the turn ends and the button reads Queue
  (the composer's placeholder says which). Codex, Claude Code, Pi, DSH and OpenCode take images
  mid-turn; ACP agents (Gemini, Qwen and the generic ACP entry) take no messages mid-turn. "Send now"
  on a queued message puts it into the running turn. With nothing typed the button is Stop, which interrupts the turn.
- Answered question cards and system messages default to one-line summaries; expand them to read the details. Expansion is remembered within the session. Answers use a labeled answer area for both selected options and free text; other options are collapsed. Desktop question fields use Shift+Enter for a newline and Enter to confirm, respecting IME composition. Mobile multiline fields use Return for a newline and the card buttons to submit. Child sessions show their harness in the sidebar/list, cards, and details. A successful user interruption during an automated turn makes that turn user-driven.
- **Approvals and questions** appear as cards above the composer: commands, file changes, extra
  permissions, MCP tools (Allow once / Allow for this session / Always allow / Decline / Decline and
  stop, or decline with a note for the model); multi-question forms; plan confirmation (Run the plan /
  Ask for changes / Not now).
- **Per message**: Fork a new conversation from here; Edit (the message turns into an editor in place,
  a dialog on the phone; nothing changes until Send, Esc or Cancel restores it. Send removes that
  message and everything after it, then sends the edited text as a new turn; files are only restored
  where the harness supports it, the note under the editor says which. Comments, mentioned sessions and
  inline images are resent; device-disk images, audio, files and skills are not, the editor lists
  them). On a message sent while the turn was running, both cut at that message and keep the earlier
  part of the turn; harnesses that can't cut inside a turn (only Claude Code can) don't offer them
  there. On the phone, long-press the message.
- **Composer**: `/` for commands and skills, `@` to mention a file, attach images, files and folders
  (dragged or pasted; files and folders are mentioned by path, never uploaded). Remote devices take the
  contents of text files only; other files and folders on this computer go by their path here only when
  the device has "Operate this computer" on, so the agent reads them with `litch_machine`. Context meter. In an existing session, clicking the meter shows context
  usage and a Compact context button (dimmed with the reason underneath while a turn runs or when the
  harness can't compact). When the harness is signed in with a subscription (Claude Code with an
  Anthropic subscription, Codex with ChatGPT) it also lists the plan limits: the 5-hour and weekly
  limits, per-model weekly limits when there are any, how much of each is used and when it resets. API
  keys and third-party providers have no plan limits, and those rows are not shown.
  Compaction shows in the conversation as a divider: “Compacting context” while it runs, “Context
  compacted” when done (manual and automatic alike), “Compaction didn’t finish” when it was cut short.
- **Side panel**: Files (tree, search, read-only viewer, add a file to the conversation), Diff (all /
  staged / unstaged, stage, unstage, discard, comment on lines; comments go with the next message),
  Browser, Suggested tasks, Background tasks, Goal, Side chat.
- **文件预览（桌面）**：文件树、搜索结果和对话文件链接共用“文件”页。Markdown 默认渲染，可切源码；带行号的链接先显示源码。支持 PNG、JPEG、静态 GIF/WebP 和静态 SVG，图片可缩放；这些文件仍然只读。
  Markdown 相对链接和图片以文件所在目录为基准，只允许项目根内资源；外链图片不自动下载，原始 HTML 只显示文字。动画、主动 SVG 内容、超出字节/像素预算的图片会显示原因。
  文档正文和 Mermaid 图表保持固定字号，不跟随“对话文字”设置。
  预览要求设备声明 `filePreview`；设备服务和自有单 harness 入口提供它。直连原生 Codex 没有这项能力时保留原来的源码/类型查看，不自动另用 shell 取文件。手机文件查看不变。
  直连 Claude Code、OpenCode 或 ACP 入口时，超限和根目录外的预览也会返回具体原因；读取被拒绝后不会返回文件内容。
  PDF 支持只读翻页、滚动、缩放和选择文字，上限 20 MiB / 200 页；只绘制可见页及相邻页。损坏、需要密码、超限或处理超时的文件显示原因；不执行 PDF 脚本，不打开表单、附件和外链，不提供打印、签名或编辑。字体、CMap 和解码资源随应用提供，PDF 不上传转换服务；未嵌入字体和特殊色彩配置可能与专业阅读器有差异。
  页码未修改时移开焦点会保留当前滚动位置；只有更换页码才跳到对应页。
  Markdown 渲染上限 512 KiB、源码 2 MiB、位图 8 MiB、SVG 1 MiB；Markdown 自动附图最多 16 张、累计 16 MiB，刷新重读文件。CSV/TSV 可预览数据表格：文件上限 2 MiB，显示前 10,000 行、100 列，字段均为字符串，不执行公式；TSV 只按制表符分列，引号原样显示；长字段截断显示，完整内容可切换源码查看。UTF-8 之外的编码需先转换。
  静态 HTML 上限 1 MiB，在隔离框架内显示，脚本、表单、导航、外部 CSS/字体和网络资源禁用；仅加载最多 16 张项目根内图片，内联原始字节累计 16 MiB、像素累计 4,000 万；重复引用同一图片也逐次计入。保留部分静态布局样式，不保证网页完整效果；超深或超大 DOM 拒绝预览。
  MP3、PCM WAV、H.264/AAC MP4、VP9/Opus WebM 短媒体按 16 MiB 整读，不自动播放，关闭即停止并释放。实际编码支持取决于系统；损坏或不支持的编码显示提示，不进行转码、远程流式读取或字幕加载。以上媒体样例已在 macOS Electron 验证，其他系统可能不同。
  PDF 与 Office 由独立预览模块提供；手机文件查看仍不改变。
- **Office previews (desktop)**: `.docx` is a read-only, approximate layout with paragraphs, tables,
  images, headers and footers. External resources, embedded objects, altChunk HTML and embedded fonts
  are not loaded. Macros and encrypted documents are unsupported. The preview cannot access the app.
  `.xlsx` shows sheets and cell text in a virtual grid, including saved formula results; it never
  recalculates formulas. A formula without a saved result is shown as text. Links are plain text.
  Numbers and dates are right-aligned. Frozen panes saved in the file stay pinned (up to 10 rows
  and 3 columns; anything beyond scrolls). Column widths are not reproduced.
  Merged cells, dates, and common decimal/percentage formats are supported; charts, pivot tables,
  printing layouts, and complex custom number formats are not reproduced. Long numeric strings
  remain strings; numeric cells retain the precision saved by Excel.
  Both formats are limited to 10 MiB compressed and 40 MiB expanded, with additional XML/image
  complexity limits. XLSX accepts at most 100,000 cells in total, 100 sheets, 1,000 merge ranges,
  and 8 MiB of displayed cell text; files beyond these safety limits are rejected with an explanation.
  Within those limits, a sheet exceeding 10,000 rows or 200 columns is cropped to its first 10,000 rows
  and 200 columns, with a notice above the grid. Cells outside that view still count toward the workbook's
  100,000-cell safety budget. Named ranges,
  validation rules and print settings are omitted before parsing. Closing,
  switching or refreshing the file terminates its parser and releases its preview. `.doc`, `.xls`,
  `.ppt` and `.pptx` remain unsupported; phone file viewing is unchanged.
- **Side chat**: a temporary fork of the current session for asking something on the side. It starts
  with the session's context up to the last finished turn (if a turn is running it stops before it, and
  the main turn keeps going), lives in the side panel's Side chat tab, never shows in the sidebar, and
  is gone when closed (closing one you talked in asks first) or when the app restarts, and may be gone
  after the device was disconnected for a while; New side chat starts over from the main session's latest. Two ways in: the Side chat tab
  (Start side chat), or select text in a reply and choose Side chat (the text goes into the side chat's
  composer as a quote, not sent; with a side chat open the button reads Send to side chat). Selecting
  text in a side chat reply offers Add to main chat instead, which quotes it into the main composer.
  One side chat per session. It uses the main session's model and permissions (changeable in the side
  chat) and the same folder, so it can change files if asked; the model is told to only answer and not
  to continue the main task. Only Claude Code, Pi and Codex sessions have it: OpenCode and generic ACP
  temporary sessions carry no history, and DSH can't fork.
- **Background tasks**: work still running after a turn ends (a background command, a Claude Code
  Monitor, a dsh background job, a long-running Codex command, or a background command Litch gives Pi,
  OpenCode and ACP sessions through its `litch_shell` tools (on by default; each harness's "Background
  commands" setting turns it off). The session counts as idle, not stuck:
  a breathing line above the composer says how many are running, counting running subagents too;
  clicking it opens the Background tasks tab. That tab lists background commands and the harness's own
  subagents together (running first, then finished ones; type icon, name, elapsed time and status).
  Sub-sessions are not background tasks: they sit under their parent in the sidebar, and you stop one
  from its own page. Click a subagent to open its page below the list, a command to see its output.
  Running commands and monitors have a Stop button on harnesses that can stop them (not dsh, whose
  background jobs can only be listed), and so do subagents of harnesses that can stop one on its own
  (Claude Code; stopping one leaves the turn and the other subagents running). The folded
  turn says "N running in the background", and the sidebar row shows a slowly breathing hollow mark
  instead of the spinner. Claude Code, dsh and Litch's background commands (Pi, OpenCode, ACP)
  continue on their own when a task finishes by itself; that turn starts with "Background task
  finished, continuing" instead of a message from the user. A task you or the model stopped does not
  wake the session; when you stop one, the model is told on its next turn that you stopped it. Codex does not continue on its own. Gemini CLI and Qwen Code get no Litch
  background commands. Litch's background commands run on the device the session runs on, as the
  model's own commands do; their output goes to a log file the model can read. They keep running when
  every client disconnects, and stop when the harness's runtime restarts (a settings change, a service
  restart or upgrade) or the session is deleted. A sub-session reports to its parent when its turn ends and says how many
  background tasks are still running, then reports again when they finish (after the turn that
  continues, or right away for Codex and when the tasks were stopped). If you stopped them, that report
  says so and does not wake the parent. A scheduled run ends with its turn too; when the background
  work finishes later, the run's summary and count are updated and it shows as unread again.
  To stop a task without the Stop button, ask the model or stop the turn. With Pi's "Ask before acting" on, starting a background command is asked about like
  any other command; in OpenCode's read-only permission mode the model cannot start one, and outside
  the project folder it asks first (except with full access). On the phone, the same line (or
  "Background tasks" in the session's menu) opens a simpler page with the same list, where a subagent
  opens its own page and running commands can be stopped; the folded steps and the
  line at the start of a continuing turn look the same as on the desktop.
- **Messages Litch sends for you** show as cards, not as your own message: a scheduled task's run
  ("Scheduled task · <name>", with "Run manually" for Run now), a sub-session's first message ("Sub-session
  brief", "Fork brief" or "Handed-off task", with the session it came from, which opens it), and "Do it
  here" on a suggested-task card ("Task card · Do it here"). The card shows the title and the start of
  the task; Show full text shows exactly what the model received, Show less folds it again. A message
  another session sent with `litch_sessions.send` shows as "Message from …" (as below), folded to one
  line until you expand it. These cards sit on the left at the width of the answers; the right side is
  only for what you typed yourself. Desktop and phone alike.
- **To-dos**: the to-do list a harness keeps (Claude Code, OpenCode, ACP agents, Codex) shows in the
  info rail on the right, with the latest list staying until the next one replaces it; when the rail
  doesn't fit it shows in the conversation instead. On the phone a small "To-do 2/6" button sits above
  the composer next to the background-tasks line while steps remain (or the turn is still running);
  tap it to open the list above the composer and Collapse to put it away. In the conversation the
  phone shows one line per list (progress and the current step); tap it to expand the list in place.
- **Mermaid diagrams**: a `mermaid` code block in a reply is drawn as a diagram once the block is
  complete (while it is still being written, the source shows). The block's header switches between
  Diagram and Source and copies the source; Enlarge opens a viewer (wheel to zoom, drag to pan). If a
  diagram can't be drawn (a syntax error), the source shows with the reason in the header. On the
  phone each diagram is a fixed-height card with the whole diagram scaled down; tap it for full screen
  (pinch to zoom, drag, double-tap to reset, Source and Copy at the top, Back closes it). Diagrams are
  drawn on the desktop or phone itself, without a network connection.
- **Goals** (Codex and Claude Code only; other harnesses show no goal controls): type `/goal` followed
  by what should be achieved and send it. Instead of a normal message this sets the session's goal,
  and the harness keeps working on it turn after turn while the session is idle, until the goal is
  achieved, blocked, hits a usage limit or runs out of its budget. Each turn it starts on its own
  begins with "Goal not met yet, continuing" instead of a message from the user. A line above the
  composer shows the status, the goal and the time or tokens used, with Pause / Resume and Clear;
  clicking it opens the Goal tab in the side panel, where the goal can be edited (Save, or Mod+S;
  saving also resumes it). Sending `/goal` with different text while a goal is unfinished asks before
  replacing it. Stop pauses an active goal before stopping the turn, so it does not start again by
  itself. `/goal` also works on the New session page. Once the goal is achieved it is cleared right
  away: the line above the composer goes, and "Goal reached · <time>" appears under the last answer
  of the turn that achieved it (until a new goal is set). Only text is accepted (no images or files),
  and a token budget can be shown but not set in Litch. The phone follows the same rules: the goal
  line above the composer (status, time, Pause / Resume, Clear — no confirmation), `/goal` from the
  slash list (also on the New session page), the line at the start of a continuing turn and the
  "Goal reached" line; editing in a side tab is desktop only. For Codex, a goal set in another app on
  the same session shows up here too; if goals are turned off in the Codex configuration, the
  controls disappear for that session.
- **Terminal**: per project; "Put away, keep it running on the device" keeps a terminal alive and
  "Terminals on the device" brings it back. Limits are device settings (`device-settings.md`).
- **Session menu**: pin, move to group or project, rename, archive (undo available), delete (permanent),
  schedule a task for this session, start a sub-session, detach a sub-session.
- **Session names**: Claude Code sessions take the title Claude Code writes; Codex sessions started in
  Litch are named by Litch after their first turn (switch and conditions in `harnesses.md`). A name the
  user sets by hand is never replaced.
- **Archived sessions** page: restore, open read-only, delete.
- **Archiving with sub-sessions**: archiving a session (sub-sessions included) also archives its
  sub-sessions that have stopped, and theirs; ones still working (a turn running, waiting for you,
  background tasks) or pinned stay in the list. Restoring a session brings back only that one.
- **Reply style**: sessions that Litch starts (including sub-sessions and scheduled tasks) tell the model
  that replies appear in Litch, which renders Markdown and Mermaid diagrams, and to answer
  conversationally rather than like a terminal. Codex sessions do not get this (Codex keeps its own
  style, as in the official Codex app). The user's own instructions take precedence. It is fixed when
  a session is created: sessions started outside Litch (for example in the official Codex app) and
  sessions created before this version do not have it, and a session Litch created keeps it when
  opened in another app. There is no setting to turn it off.

## Claude Code sessions started elsewhere

The Claude Code harness also lists Claude Code sessions started elsewhere on the machine (Claude desktop
app, `claude` in a terminal). They can be opened and continued in Litch, and back in the other app.

- **Read-only while another process has it open**: when the Claude desktop app or a `claude` in a
  terminal still has the session open, the session is read-only in Litch: the composer is greyed out
  with "Another process has taken over this session, so it is read-only here" (中文「此会话正由另一个
  进程接管，这边只读」), and sending, rewinding and compacting are refused. Two processes writing one
  session would fork its history. What the other side does still shows up in Litch every few seconds,
  and the session becomes writable again by itself once the other side lets go.
- **How to make the desktop app let go**: archive that session in the Claude desktop app, or quit the
  Claude desktop app (it keeps a session's process running after the reply, so a session used there
  recently is usually still held). In a terminal, exit `claude`. A session that was written to in the
  last 10 seconds by something Litch cannot identify also counts as held.
- **Going back**: do not continue the session in the desktop app while Litch is still running a turn
  in it; wait until Litch's turn has finished. The desktop app does not check, so this cannot be
  blocked.
- **Settings**: when Litch picks up the session, it takes the model, reasoning effort, permissions
  (bypass permissions becomes Full access) and Plan from what the other app used last. A setting the
  user changes in Litch stays as set; the others keep following the other app. Titles and approvals
  granted for the session are not shared.
- **Context usage** shows how much the last request used; the window size is only known for models
  Litch has run itself, otherwise only the amount used is shown.

## Session trees (sub-sessions)

A session can start **sub-sessions** on the same device, with any harness. They are nested under the
parent in the sidebar (up to 8 levels), their results come back to the parent, and the parent can be
woken to continue.

- **By hand**: session menu → Start a sub-session… → harness, model, project, context ("Start fresh",
  or carry over the parent's context, which needs the parent's harness), title, task, background
  (only for a fresh start, optional: what the sub-session cannot see of this conversation), and
  "Wake the main session when done". If the chosen harness cannot give the same sandbox as the parent,
  the dialog warns that the sub-session will be looser.
- **By the model**: in sessions of every harness (Codex, Claude Code, Pi, DSH, OpenCode, Gemini CLI,
  Qwen Code, ACP) the model has `litch_sessions` tools: list and read sessions on the device, start
  sub-sessions, send to and interrupt its own sub-sessions, wait for them, and archive or restore
  sessions. In a turn you started it may send to or interrupt any session. Once two sessions have
  exchanged a message in any way (a message the model sent, an interruption, a session you mentioned
  with `@` in the other, a sub-session's brief and reports, a Claude Code inbox message), both may
  message each other at any time after that, also after archiving and restoring either (interrupting
  still needs a turn you started, unless it is its own sub-session). It archives a session only after you agree in a message you typed (when its sub-sessions
  have all finished it may suggest archiving them), never one that is still working or pinned; it can
  restore its own sub-sessions any time. When the user did not ask for
  a sub-session in that turn, it becomes a suggested task instead of starting directly. To use another
  harness or model it first looks up what the device offers (`litch_sessions.options`: each harness's
  models as in the model menu, Claude Code's with their provider, reasoning efforts, defaults); a
  harness or model the device does not have is refused with the choices instead of starting a session
  that fails on its first turn.
- **Suggested tasks**: the model suggests a task of its own as a card instead of only mentioning it:
  work that ends in something of its own (a branch, a pull request) and that you may want to follow
  apart from this conversation, such as something it noticed, the follow-up its answer recommends, or
  independent steps of an agreed plan. Parts of the current task (however large), and anything it left
  unfinished or unverified, stay in the conversation; most turns end with no card. When the next step
  simply continues what the model just found (say, fixing what it diagnosed), it asks one short
  question at the end of the turn with one or two reply buttons instead of making a card; a click
  sends the answer with its question as your message. Questions awaiting a reply appear only above
  the composer. After they are answered, ignored, or closed, the transcript shows their record with
  any answers in the same card. Partially answered groups show only settled questions in the transcript.
  Pending questions stay above the composer until
  answered, explicitly withdrawn, or hidden with Ignore; automated turns do not clear them. Ignore is synced across clients and reconnects without sending a message or answering the question. Cards show their age as just now, minutes, hours, or days, and the number of sub-session updates since they were asked. Wake and wrap-up reminder turns tell the agent which questions remain, including ignored ones; the agent should avoid repeats and withdraw obsolete questions. A message you type in the main composer settles earlier pending questions; a reply inside one question settles only that question. Suggested
  cards from the wrap-up appear below the final answer once the turn has ended;
  cards the model raises mid-turn (independent plan steps) appear where it raised them, as soon as it
  does, and scroll with the conversation. The
  card shows its state (waiting, started, done here, dismissed, withdrawn by the model, expired after
  7 days). Buttons: Start, Do it here (the card is settled and "Do it here: <title>" plus the task is
  sent to the session as your message, after the running turn if one is running), Edit and start
  (change the harness, model, effort, project, folder, fresh or with context, title, task,
  background, permissions), Dismiss. Whatever the card does not set comes from the parent session as
  it is when you start: harness, model, reasoning effort and folder (on another harness, that
  harness's default model and effort). The same holds when the model starts a sub-session or hands
  off a task. A fresh card the model raises always carries a background (the overall goal,
  decisions and constraints so far) next to the task; the sub-session gets it as its own section
  before the task. Expand the brief on the card to read it.
  On the phone, Start, Do it here and Dismiss update the card directly; the desktop need not stay
  connected. Repeating Dismiss succeeds without changing an already dismissed card. Repeating Start
  returns the original child session instead of creating another one. If a different action has
  already settled the card, the error explains its actual state.
- **Where a sub-session works** (devices that support worktrees): when the parent session is in a
  worktree Litch created (or shares one), a new sub-session gets its own new worktree and branch,
  starting from the last commit of the parent's branch (the parent's uncommitted changes are not
  carried over); otherwise it shares the parent's folder. The model can say which it wants; cards,
  the "New session" choice of an offer card and the Start a sub-session dialog have a "New worktree"
  checkbox, preset this way, and what is checked there wins. "Do it here" always stays in the current
  session and folder. A handed-off task gets a worktree only on harnesses that can fork into another
  folder (Codex, Claude Code); elsewhere it shares the folder. On the phone the cards, the offer card
  and "Edit and start" have the same "New worktree" switch.
  The side panel's **Suggested tasks** tab lists every card of the current session, with a badge for
  the waiting ones; clicking one scrolls to it. You can also tell the model "start the second one", and
  it withdraws cards that went stale. At most three cards it raises on its own per turn (independent
  steps of an agreed plan count separately), four in all. When its work is done, the model makes a
  wrap-up call that carries its suggestions (an empty one when there are none) and then writes its full
  final answer as the last message of the turn; the steps before the wrap-up fold into "Worked". If a
  model still writes its answer first and only a short line after the wrap-up, the answer is shown in
  full, not folded. When a turn the user started ends without a wrap-up, Litch starts one short reminder
  turn (a light line "Reminded the model to wrap up"). Device settings: `sessions.wrapUp` (on by default)
  turns the wrap-up off for sessions created afterwards (the model then suggests cards only when it sees
  fit, and nothing is reminded); `sessions.wrapUpReminder` (on by default, no effect while
  `sessions.wrapUp` is off) switches the reminder, at once. **Task cards** can be switched off per
  harness with the device setting `harness.<id>.taskCards` (on by default, for example
  `scripts/litch settings set <device> harness.pi.taskCards=false`): sessions of that harness then get
  no suggested-task cards, no new-session offers, no wrap-up and no reminder, at once and in running
  sessions too; the model still starts sub-sessions when you ask and hands off tasks. Started cards
  show the harness and folder the sub-session actually got. The mobile app shows the same cards and a
  per-session list (the "N suggested tasks waiting for you" bar at the top of a conversation, or the menu).
  Cards and wrap-ups are kept on the device, so a session on a remote device makes them even when no
  desktop or phone is connected; they show up when you open the session later.
- **New task or here**: when the user asks for something unrelated to the current session (after a
  first task has been done in it; the first request is simply what the session is for), the model
  first shows a card with only a title and two buttons, "New session" and "Do it here". New session: the
  model writes the brief and the sub-session starts; if the brief targets a harness that cannot be
  sandboxed as tightly as this session, it does not start and the card turns into an ordinary
  suggested task saying why, for you to review and start. Do it here: the model does it in this session.
  Sending a new message instead of choosing counts as "Do it here". Requests that build on the session
  (corrections, follow-ups, the next iteration, going ahead with what was just suggested) get no card.
- **Hand-off**: when an unrelated message arrives while the model is in the middle of a task, it hands the
  task and its remaining plan to a forked sub-session (a "Handed off to a forked session" card, started
  at once, waking the parent when done) and answers the new message here. The fork starts before the
  current turn, so work done in that turn reaches it only through the remaining plan.
- **Previously authorized sub-sessions**: `start(initiation: "user_asked")` can run in any later turn,
  including wake, reminder and scheduled turns, if you already requested sub-sessions or approved a
  plan that includes them. Approving a goal alone does not authorize separate sessions. Later changes
  or withdrawal of your authorization take precedence. Task cards may be off. Direct starts have a
  separate limit of 16 per parent per turn and 8 direct children running or starting at once; they do
  not consume the 4-card allowance shared by proposals, offers and wrap-up suggestions. Concurrent
  requests reserve slots. The whole tree allows 24 running or starting sessions including the root,
  with maximum depth 4 (root is 0). Only failures before session creation release the turn allowance.
  A created session whose first turn did not start keeps its running slot until it starts, is archived
  or deleted. Reconnecting or restarting does not reset the turn allowance; successful archiving clears it. A reservation whose outcome was unknown at process exit remains counted.
  Wider sandbox access still needs confirmation; the 50-wake limit is unchanged.
- **Reports and waking**: when a sub-session finishes a turn, the start of its last answer is handed to
  the parent ("Reports from sub-sessions"). When the parent is idle and its sub-sessions have stopped,
  the parent is woken to continue (up to 50 times per user message; your next message resets the count). The model can set `wake_parent` when starting a sub-session (default true), then use
  `litch_sessions.set_wake(thread_id, wake)` to disable or re-enable waking for its direct children,
  including overriding the setting previously chosen in the UI.
  Reports still arrive while waking is off; enabling it rechecks eligible queued reports under the
  normal wake rules, without overriding stops, failures, scheduled turns or wake limits.
  `list` and `read` include the current `wake_parent` value. Desktop session details and mobile rows
  show “Wake off”. The spawn dialog and Edit and start also let you choose the initial setting. Waking happens on the
  device, also when no desktop or phone is connected. Background tasks still running in the parent or a
  sub-session after its turn do not hold it back. Turns run by scheduled tasks report but do not wake;
  a scheduled run in the parent itself carries the reports waiting there. After you stop the parent's
  turn (or it fails) the parent is not woken; waiting reports go with your next message.
  A sub-session you stop or archive yourself does not wake the parent either: the report notes it and
  the parent sees it on your next message. The same goes for a turn you start yourself by typing in the
  sub-session (as in Claude's desktop app): its report waits until you next message the parent. A failed or interrupted turn's report carries its error and
  does not wake the parent (as in Claude's desktop app); it goes with your next message, or with a wake
  another sub-session's report brings. Nothing wakes while another sub-session is still running.
  Reports not yet handed over show as soon as they arrive as one small button above the parent's
  composer, next to Background tasks ("Report from …", or "Reports from N sub-sessions"); tap it to
  see them. "Handle now" there hands them over at once: into the running turn, or in a new turn when the
  parent is idle, without waiting for the other sub-sessions. Once handed over they show on the message
  that carried them.
  If a sub-session finishes several turns while the parent is busy, only its latest report is handed over.
  Users can also stop automatic reports entirely; see [Stop or resume reporting](#停止或恢复回报主对话) above.
- **Detach as a standalone session** (session menu or the "Started from …" bar at the top of a
  sub-session) cuts the link.
- **Subagents** started by a harness itself (for example Codex's agents) are not sub-sessions; they show
  in the side panel's Background tasks tab and cannot be messaged directly. In Claude Code sessions, Litch stops
  a subagent that shows no activity for 30 minutes; the turn and the other subagents keep running, and
  the model is told that Litch, not you, stopped it.
- **Messages from other Claude sessions**: Claude Code sessions on the same computer can message each
  other (`ListAgents`, `SendMessage`), including the Claude desktop app's sessions and Claude Code in a
  terminal. A message that reaches a Litch session shows as a "Message from …" card on the left, not as
  your own message, folded to one line until expanded (with "Sender skips approvals" when the sender
  runs tools without asking, and "Open session" or "Open in Claude" when the sender is a Litch session
  or a Claude desktop session); an idle session handles it in a turn of its own,
  a busy one right after its current step. On the sending side the step reads "Message …". This is the
  device setting `harness.claude-code.crossSessionInbox` (on by default), and works only between
  sessions on the same computer. A session keeps the same address while Litch restarts its Claude Code
  process. When another Litch session messages one whose process is not running, Litch starts it
  first and the message opens a turn there; from the Claude desktop app or a terminal, the receiving
  session's process has to be running. Turns a harness opens by itself like this (and turns that go on
  after background work finishes) can still use Litch's session tools (messaging other sessions,
  sub-sessions, task cards, wrap-up) and scheduled tasks when no desktop or phone is connected: the device
  runs those tools itself.

The whole feature can be switched per device with the `sessions.enabled` setting
(`scripts/litch settings set <device> sessions.enabled=false`); remote devices need adapter 0.11.0 or
later.

A running client tool does not mean the session needs user input. Browser sign-in approvals explicitly shared by the desktop appear in the parent’s pending section; complete them through the original approval flow. Other approvals held only by a client may require opening that sub-session on that client.

忽略记录目前不随分叉继承；回退后设备仍保留已失效的来源行，它们不会匹配新提出的问题。
Ignored-question records are not inherited by forks. Reverting a session leaves obsolete source records in storage; they do not match newly asked questions.
