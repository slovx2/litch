# Projects and sessions

侧栏运行标识会随已打开会话的实时回合更新，选中或清除未读不会隐藏运行、等待和后台任务标识。
回合结束后若仍有后台任务，继续显示后台任务标识。
从经理建议卡开始的工作线遵循同样的规则；回合中收到追加消息不表示回合结束，运行标识保持到回合完成。
切换到其他会话后，原会话的侧栏状态仍持续更新。

Sidebar activity follows live turns in open conversations. Selecting a row or clearing unread
does not hide running, waiting or background-task indicators. Background activity remains visible
after the foreground turn ends.
Worklines started from manager suggestions follow the same rules. Additional messages during
a turn do not end it; the running indicator stays until the turn finishes.
Switching to another conversation does not stop sidebar status updates for the previous one.

## 手机输入与键盘

评论和消息编辑弹窗在键盘上方滚动；添加评论只保存在草稿中，不请求 AI 数据同意。编辑消息发送等操作若需同意，会在当前弹窗上方展示，取消同意后保留编辑内容。

Comment and message-edit dialogs scroll above the keyboard. Adding a comment only updates the draft and does not request AI data consent. Actions such as sending an edited message show any required consent above the current dialog; cancelling consent keeps the edited text.

提问卡片与审批说明在键盘弹出后自动滚到完整输入框。空间不足时，按钮随卡片内容滚动，多行文字在输入框内滚动。滚动收起键盘的操作不变。

Question cards and approval notes scroll the full focused field into view above the keyboard. When space is limited, buttons scroll with the card and multiline text scrolls inside its field. Scrolling to dismiss the keyboard works as before.

手机上的看板、设置和长表单会将正在编辑的输入框滚到键盘上方；标题和页签保持原位。添加设备、定时任务与建议任务编辑页的主操作固定在键盘上方，评论、改名和消息编辑弹窗也可直接提交。多行内容超过输入框高度后可在框内滚动。

iOS 可点键盘上方的“完成”收起数字、多行及其他键盘，也可向下拖动表单收起；Android 可滚动表单或使用系统返回键收起。键盘打开时点击表单按钮会直接执行。经理代答后的“重新作答”在独立输入弹窗中编辑。

On mobile, boards, settings and long forms scroll the focused field above the keyboard while keeping page titles and tabs in place. Device, task and proposal forms keep their primary action above the keyboard. Comment, rename and message-edit dialogs can be submitted without hiding the keyboard. Long multiline content scrolls inside its field.

On iOS, tap Done above the keyboard, including numeric and multiline keyboards, or drag the form down to dismiss it. On Android, scroll the form or use the system Back action. Form buttons act on the first tap while the keyboard is open. Overriding a manager's answer opens a separate input dialog.

## 问题与答复记录

答复问题后，原问题卡会更新为已回答。若答复与问题卡在同一回合紧挨着，答案只显示在卡片里；隔了回合、过程或其他消息时，答复也会在发送的位置显示为“题目 → 回答”，与跨会话消息分别保留。

桌面可点击答复中的题目引用跳回已读取的原问题卡；原卡未读取时只显示引用。手机保留题目引用。重新打开会话仍按同样的规则显示，桌面搜索也能找到独立显示的答复。

## 对话文件链接

明确 Markdown 链接与反引号中的路径使用相同的行号规则：`:12`、`:12:3`、`#L12`、`#L12C3`（只定位起始行）。支持 Windows 盘符和反斜杠、带空格的文件名与 PDF、图片文件名。Markdown 地址中的空格请用 `%20` 编码，或把整个地址放在尖括号里。相对路径保留会话工作目录和项目根的候选地址。

点击链接只读取会话所属设备上的文件；同设备项目根外的绝对路径也可打开，不跨设备查找。相对路径依次检查会话 cwd 和项目各根；多个候选内容不同或不能确认相同时，先选择路径。`~` 使用会话设备报告的主目录，旧服务没有报告时提示改用绝对路径。旧服务提供标准文件接口即可读取；没有受限预览能力时图片、PDF 等仍提示升级。

根外文件的文件树从其父目录开始，不改项目配置。预览保留设备端真实路径和字节预算核对，文档引用不能逃出这个目录；符号链接跨越所选根时预览会被拒绝。

手机和桌面的标准 Markdown 文件链接、反引号路径和正文路径使用同一套解析与候选选择。内部跳转保留备选、行号和文档锚点；手机源码页按行号定位，标题锚点的显示取决于文件预览支持。

目录可以用明确链接（如 `[文档](docs/)`）或带末尾斜杠的路径引用。点击后在两端文件树中展开到目标目录并定位，其他分支收起；目录内容按需读取。

打不开时会区分路径未识别、不存在、设备离线、没有读取权限、设备不支持访问以及主目录未知。`file://`、编辑器 URI 和 UNC 本轮不支持，点击会给出说明。链接详情列出原始地址、规范化路径、已尝试候选，可复制路径；成功打开的文件也可查看这些详情。格式不支持预览与路径不存在分别显示。

新建会话会收到统一的文件链接写法提示，要求使用会话设备上的已存在绝对路径、标准 Markdown 和 `#L行号`。适配器复用已有呈现说明；原生 Codex 仅注入文件格式这一段，沿既有开发者指令机制在恢复、分叉和压缩后保留，不额外叠加通用呈现风格，也不新增工具命名空间。已有适配器会话的工具定义不会被追溯改写。

## 搜索

支持分页的设备打开会话时先读取最近十个回合；向上滚动时继续读取更早的消息。桌面右上角的小按钮可以手动读取或重试，查找栏打开时隐藏；手机向上翻页时继续读取。旧设备仍读取完整历史。

桌面标题栏的文字查找图标“在对话中查找”打开查找栏（浮在对话区右上角，不占整行；顶上的内容会让出位置，不被它挡住）；macOS 用 `Cmd+F`，Windows/Linux 用 `Ctrl+F`。`Enter` 下一处、`Shift+Enter` 上一处，`Esc` 关闭。同一窗口只打开一个查找栏：在另一处打开会自动关闭前一个并恢复其折叠与阅读状态。窄窗口经理页处于看板时，查找会先切到对话。
搜索当前已读取的用户消息、助手回答和过程说明、可见思考摘要、代码块、计划、提问与评论卡片文字。
索引构建或查询失败时显示失败提示，可关闭查找后重新打开重试。
命中尚未显示的早期回合会先显示目标附近内容；收起的过程、思考和卡片会临时展开，再定位高亮，关闭搜索后恢复原折叠选择，并停留在最后命中所在位置；焦点返回打开前的控件。
命令、工具参数和输出、子代理活动、编辑工具的文件差异不参与搜索，也没有“包含工具”开关。
输入查询后会逐页补齐该会话尚未读取的历史，期间显示“正在搜索”；清空查询或关闭搜索停止继续补页，已经读取的内容保留。搜索范围是设备向客户端提供的历史，不代表引擎的全部原生记录。首次选择离当前视口最近的命中；每次最多列出视口附近 500 处，仍按对话顺序上下跳转。达到上限请缩小查询。支持中文、大小写和全角字母归一化。

侧栏顶部的放大镜“搜索会话”（侧栏收起时在标题栏的新对话旁）或 `Cmd/Ctrl+Shift+F` 按标题搜索所有设备，默认包含归档；原生子代理和临时会话不参与搜索。
可按设备筛选，结果显示设备、项目名、harness、相对时间与归档标签，完整路径在悬停提示中。离线设备只搜缓存标题，会话列表未完整读取时在结果下方提示结果可能不全，可点标题旁的 ↻（悬停提示“重新读取会话列表”）重试；读取中按钮禁用，失败单独提示。
空查询先显示最近会话；方向键选择结果，Enter 打开并聚焦目标会话输入框；Esc 取消才返回原控件。结果以标题/时间/归档和设备/项目/harness两行显示；没有项目归属的会话显示“无项目”。点击活动会话打开对话，点击归档会话进入只读历史。每台设备最多显示 100 项，超过时请输入更完整的标题。
全局标题搜索不检索消息正文；手机搜索界面尚未提供。

## @ 引用会话

桌面和手机输入 `@` 可搜索同一设备上未归档的普通对话、子会话、经理和工作线。候选显示类型，也支持按“经理”“工作线”等类型文字搜索；空查询仍按最近更新排序。当前会话、已经引用的会话和隐藏的原生子会话不列出。普通侧栏的经理树过滤不影响这些候选。

On desktop and phone, `@` searches unarchived conversations, sub-sessions, managers and work lines on the same device. Each result shows its type, which is also searchable. Empty searches keep the recent-update order. The current session, already mentioned sessions and hidden native sub-sessions are excluded.

选中后，输入框里的引用显示为会话标签（图标加标题），排队消息、编辑已发消息和对话中的用户消息也显示为同样的标签，点击打开该会话。标签整体删除：光标不会停在标签内部，紧挨标签按退格或删除会删掉整个标签。桌面端可以撤销恢复；复制含标签的文字后，粘贴到同一设备的输入框仍是标签；悬停显示全称，读屏读作“会话：标题”。草稿关闭或重开应用后标签仍在。发给模型的内容不变：正文写作 `＠[标题]`，末尾附会话列表。

手机上长按已发送消息里的会话引用，会打开该消息的操作菜单；短按仍打开被引用的会话。

On the phone, long-pressing a session mention in a sent message opens the message actions; tapping still opens the referenced session.

After you pick one, the composer shows the mention as a session chip (icon and title). Queued messages, the edit box for a sent message and sent user messages show the same chip; clicking it opens the session. A chip is deleted as a whole: the caret never lands inside it, Backspace or Delete next to it removes the chip. On desktop, undo brings it back and copied text keeps its chips when pasted into a composer on the same device; hovering shows the full title and screen readers read "Session: title". Chips survive closing the draft and restarting the app. What the model receives is unchanged: `＠[title]` in the text plus the session list at the end.

## 侧栏「未读 / 最近」

桌面「对话」视图在各设备前显示「未读」「最近」，两组可独立收起。
点击会话时只高亮实际点击的那一行；同一会话在其他投影和对话树中的副本不高亮。上下方向键与读屏当前项跟随这一行。
对话与经理是两棵导航树，右侧只显示最后点开的会话。切树不换会话、不关闭侧面板或看板，也不取消正在等待身份确认的打开；再点另一个会话才替换上次选择。两棵树各自记住行来源，切回同一会话时不会把最近或未读中的选中行移到设备树。
Chat and Managers are navigation trees. The content follows the last conversation you opened. Switching trees keeps the conversation, panels and pending open request. Selecting another conversation replaces the previous request. Each tree preserves the selected row's source.
刷新列表、排序或新增副本不会转移选择；选中的投影项移除后，选择回到同一会话的对话树行。
Only the clicked row is selected, including for keyboard navigation and screen readers. Other copies stay unselected.
List updates preserve the selected location; removing that projection item selects the same conversation in the tree.
未读沿用本机的新结果标记：未查看的对话从运行转为停止时标记，打开后清除；随侧栏缓存保存，重启保留。
桌面和手机收起项目时，未读数按展开后的实际会话树汇总。跨项目的子会话计入它显示所在的父会话项目；父项被筛掉、子项单列时，计回子项所在项目。被筛掉、已归档及普通列表不显示的经理工作线不计入。未读后代所需的父链不会被子树折叠或“显示更多”藏住；打开未读子会话清除它自己的标记，打开父会话不会代清子会话。
On desktop and phone, collapsed project unread counts follow the visible conversation tree. A nested child counts toward the parent's displayed project; if filtering leaves the child standalone, it counts toward its own project. Filtered, archived and manager workline rows absent from the ordinary list do not count. Unread descendants remain reachable through folded or paginated ancestors. Open the unread child to clear its mark; opening the parent does not clear its children.
从未读组打开后，当前主项保留在原位置并恢复已读样式，切到其他主会话或离开对话后才移出，避免连续点击打开下一项。未读计数只计算仍未读的主项，最近组不显示总数。
这条规则也适用于子会话：父会话已打开、子会话完成后才进入未读时，读完子会话仍保留整棵树和展开状态；在同棵树内切换不移出。切到其他树、新建对话、设置页或经理模式后释放暂留；清未读不会移除「最近」中的主项。
Opening a child keeps its whole tree in the Unread group, at the same position and with its expansion unchanged, even when the child finishes after the parent was opened. Read rows use the normal style. The tree stays while you browse within it and leaves when you switch trees or leave the conversation. Marking it read does not remove it from Recent.
这不是逐条消息的已读计数，客户端离线期间结束的回合不保证标记；不同电脑和手机的已读状态不互相同步。

最近的空状态提示为“查看满 5 秒或有过操作的对话会出现在这里”（Conversations you view for 5 seconds or interact with appear here）。
最近按本机最后一次查看或操作倒序排列。打开、切换或查看会话，须在当前可见窗口连续停留满 5 秒才更新，时间记录为满 5 秒的时刻；同一段连续停留只记一次。
切走会话、离开对话页、窗口失去前台、最小化或隐藏会清零计时，返回后重新计满 5 秒。打开立即清除未读，不用等待，也不会仅因清未读而进入最近。
发送、插话、回答、批准或拒绝、停止、恢复、提交编辑等成功操作立即更新，不受查看时长限制；
模型输出、定时任务、后台唤醒、子会话自动回报不更新。首次使用从新的查看和操作开始记录，不读取所有历史回填。
最近覆盖连接的各台设备，但不跨客户端同步；离线设备保留缓存条目，归档、删除的会话不列入。
经理也进入最近和未读。工作线及其后代归入所属经理，不单独列为主项；桌面默认收在“› N 个子会话”下，可展开。
桌面上经理主项的记号列多一个细框（人文外观是圆圈），状态记号照常画在框里，读屏念“经理”；和侧栏经理一节的经理行同一画法。
经理和普通对话一样：前台连续查看满 5 秒、或成功发送、答复、追问等操作进入最近；新结果沿用未读标记。读取、标记已读、失败或未受理的操作不计入最近。
从最近、未读、搜索、通知或会话链接打开经理，均进入与经理目录相同的工作台（含看板）；桌面保留当前导航树，最近或未读中的直接点击保留该行选中。手机也打开完整工作台，返回一次回到来源页，不经过经理目录。工作线和普通子会话仍打开普通对话。身份尚未确认时等待目录或摘要，不先展示普通对话。经理树仍不显示这两组。
Managers also appear in Recent and Unread. Their worklines are grouped beneath the manager and collapsed by default on desktop.
Viewing a manager for five continuous foreground seconds or completing an explicit action records a recent interaction. Reading, marking read, failed and rejected actions do not.
Opening a manager from Recent, Unread, search, a notification or a session link opens the same workbench and board as the Managers directory. Desktop keeps the current navigation tree and the clicked Recent or Unread row. On phone, Back returns directly to the source page without visiting the Managers directory. Worklines and ordinary children keep their conversation view. Opening waits for session identity when needed. The projection groups remain hidden in the Managers tree.

手机首页在定时任务入口之后依次显示「置顶」「本机分组」「最近」「未读」，然后是各台设备。「最近」规则与桌面相同：应用在前台、会话页正显示该会话时连续停留满 5 秒才记录；
切到后台、锁屏、下拉通知中心或离开会话页（回到列表、打开终端、文件、子代理页等）都会清零。在手机上发送、批准、停止等操作立即记录。
手机只记录本机的查看和操作，与电脑上的「最近」各自独立。每行以设备色线区分设备，登记了多台设备时第二行写设备名（离线时带“离线”），与置顶区、本机分组同一种行；
普通子会话和经理工作线缩进显示在主项下面，不占主项分页名额，点击直接打开对应对话。行尾小箭头展开或收起，照桌面投影默认收起，开合独立记在手机上。
收起时行尾动态点表示后代有未读、等待处理、运行或后台任务，读屏给出数量，包含更深层的后代。设备会话列表使用同样的提示，并让未读和待处理的后代及其父链在折叠时仍显示。
On phone, Recent shows ordinary children and manager worklines below their parent. The compact arrow toggles children, collapsed by default, and remembers the state locally. Children do not count toward pagination. A dot on a folded parent indicates activity anywhere in its descendant tree, with its count available to screen readers. The device conversation list uses the same indicator and keeps unread and waiting descendants, together with their ancestors, visible when folded.
点组头收起或展开；组头「⋯」可切换按项目聚合，并选择默认显示 5 / 10 / 20 条，
「显示更多」每次增加 10 条，设置记在手机上。「未读」组没有未读对话时不显示，收起、聚合和条数与「最近」分开记。

子会话符合条件时列出其主会话，展开主会话可查看整个子树，子会话不单独列出；父会话不在活动目录时不列出孤立子项。
两组默认各显示 5 个主会话，「显示更多」每次增加 10 个，不限总数。组头菜单可分别选择按项目聚合、默认显示 5 / 10 / 20 条，设置在本机记住。
默认不按项目聚合；聚合后项目按组内最新项排序、项目内按时间排序。当前显示的投影包含多台设备时，项目头显示“项目名 · 设备名”；只有一台设备时项目头不重复显示设备名。平铺时每行行首有设备色块；登记了多台设备时每行都显示淡色设备名（本机也显示，离线时带“离线”）。
设备色线与原树一致；新添加设备自动选色优先蓝、紫、灰，已有设备的颜色保持原样。文字名称提供设备区分，不依赖颜色。组头菜单以勾选标明项目聚合状态和默认条数。
最近组的时间是最后查看或操作的时间；未读组是主会话及子会话中最新未读结果的时间。悬停时间可查看口径和完整日期。
项目的新建对话、重命名、颜色、置顶、移动与删除操作与原设备树相同。投影组不受设备树的 harness 筛选影响；原设备树仍保留全部原有条目。
会话菜单打开后，滚动侧栏使该行移动时菜单收起；打开前已经完成的滚动不会关闭新菜单。

## 输入历史与清空草稿

桌面和手机的未发送图片随草稿保存在各自应用的数据目录，退出后重新打开会还原。
发送、移除图片或清空草稿会同步清理存储。图片草稿总上限为 128 MiB（含 base64 编码），
超限或磁盘写入失败会明确提示；当前窗口的图片仍可发送，其他草稿不会被自动删除。

Unsent images are saved in the desktop or phone app’s own data directory and restored on restart.
Sending, removing images or clearing a draft removes their stored copies. Image drafts have a total
128 MiB limit including base64 encoding. A warning explains failed saves; images remain available
in the current window and other drafts are never automatically evicted.

桌面输入框在光标位于开头时用上、下方向键回忆本机输入框实际提交的原文；排队、停止或发送失败后仍可找回，新建会话首句也会记录。每会话保留最近 100 条（相同原文只留最近一次），本机最多保留 200 个会话的记录，重开应用仍可回忆。
会话通信、经理事件、子会话回报、定时任务、后台通知和自动续跑指令不进入输入历史；技能、附件、评论与会话引用的协议展开也不写入。其他桌面、手机、CLI 及升级前的历史不会回填到上键记录中；手机输入框目前没有上键翻历史入口。
仅 macOS：`Ctrl+C` 清空整份草稿（文字、图片、提及、技能、评论及差异批注），`Cmd+Z` 可撤销清空；不打断回合，输入法组字中不处理。Windows/Linux 的 `Ctrl+C` 保持原生复制行为。

发送前可点输入框中的图片缩略图查看大图，适用于粘贴、拖放和选择的图片。桌面按 Esc、点图片外部或关闭按钮返回，焦点回到输入框，草稿和光标位置保留；右上角的移除按钮只移除附件。手机也可点草稿缩略图查看，关闭后返回输入框。已发送消息中的图片仍可点开查看。

## 过程开合

桌面对话展开或收起过程、步骤组和命令时，保持被点击行的位置；滚到顶部收起时也保持该位置。

桌面的用户消息超过 20 行时显示「展开全部」，展开后显示全文并可「收起」。切换会话保留展开状态；编辑取消、正文更新或窗口宽度变化后仍可展开。用户消息按原文显示，保留空行、编号和 Markdown 标记。手机用户消息直接显示全文。

桌面和手机的运行中回合始终展开最后一段过程，新说明和工具步骤按顺序显示在上下文压缩分隔线之后。
中途插入消息之前的过程，须本段最终回答与工具均已结束才自动收起；最后一段等回合真正结束后按原规则收起。
上下文压缩不会结束过程段。手动展开过过程或仍有运行中的子代理时，不自动收起。

## 复制消息

桌面端悬停或聚焦消息可见“复制消息”按钮。最终回答的复制图标与完成状态、用时、时间共用一行；
输出中及同回合较早回答的图标悬浮在回答右下角，不另占空行。没有工作提示时也不预留空的状态行。
手机端不再在消息下方放复制按钮：长按用户消息选“复制消息”，
长按回答或点回合状态行的 ⋯ 选“复制回答”；别的会话发来的消息和系统消息展开后有一个小的复制图标。
复制成功显示“已复制”，失败会给出重试提示。离线和输出中也可复制当前已收到的全文。
一条回答以消息条目为界：多段过程说明与最终回答分别复制，不合并整个回合；
手机端把长回答分块显示时仍复制该条完整 Markdown，代码围栏和链接原样保留。
用户消息复制正文、附件名称（无名称时用附件类型）、评论编号与完整引用和备注；
会话提及复制显示标题，不复制内部评论指令、会话元数据或图片数据。
折叠的长消息仍复制全文；系统和协作消息展开后的按钮复制其可见原文。

## 访问权限

新建对话按“执行设备 + 实际目录 + harness”保存访问权限。下次在同一范围新建时预填该档位；换 harness 使用它自己的记录，没有记录就使用它的默认档。未选择项目或目录时，每台设备的每个 harness 独立保存一份“无项目”记录。桌面与手机共用设备上的同一份记录，不跨目录、设备或 harness 沿用。

是否确认听引擎声明：Pi、通用 ACP 等声明免确认的默认完全访问可直接使用，不写入虚假的确认；声明需要确认的完全访问，在该范围确认一次后不再弹，降低默认权限不抹掉此前确认。能力变更导致保存的档位不再受支持时，预填回引擎默认档并提示，不阻断发送；若默认档本身需要确认，仍须确认。旧跨 harness 的权限记录作废，其他设备数据保留。保存失败或设备服务不支持记忆权限时，显示不阻断操作的提示，仍按界面所选档位新建对话。需要确认的完全访问仍需确认；确认无法保存时只对本次新建有效，下次需再次确认。

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
another group to change their order, or use Move up / Move down in its menu; the order is remembered
on this computer only. Sessions can be dragged onto Pinned or a group's title, or back onto their own
project. The phone app shows the same groups but has no dragging. Arranging the
sidebar (groups, pins, order) is not available through the command; tell the user how to do it in the
sidebar.

### Pinned and local groups

Pinned sits at the top of the sidebar and merges the pinned sessions and projects of every device into
one flat list. Each row starts with a small bar in the device's wire color and shows the device name
(and "offline" when it is). Recent and Unread rows use the same marker; when grouped by project, the
project row carries it too. The device name appears once more than one device is set up. In Recent and
Unread an offline device shows a dashed bar instead of the word "offline", so the title keeps its room;
the device name's tooltip and screen readers still say "offline". Pinning still lives on each device (pin and unpin need the device online and
able to organize); only the order is local: drag rows, or use Move up / Move down, and the order is kept
on this computer or phone only. A pinned session appears only in Pinned, not again under its device,
in Recent, Unread or a local group. Pinning still takes a session out of its device group, as before.

Local groups are folders that live only in this app (desktop and phone each keep their own; nothing is
synced or sent to devices) and can mix sessions from any device. Create one from a session's menu
(Add to local group → New local group…) or the **+** on the Local groups header; rename, reorder and
delete it from its menu (deleting removes only the group). Add sessions by dragging them onto a group
or from the session menu, reorder by dragging or Move up / Move down, and remove with "Remove from …".
This works while a device is offline. Sessions in a local group still appear under their device. A
member that is pinned is counted as "N more in Pinned" and returns to its place when unpinned. Members
that can't be shown stay as a placeholder you can remove: not loaded yet, archived, deleted, not in the
list, or device removed. The file is `sidebar-organizer.json` in the app data folder (a `.bak` keeps the
previous version); if it is damaged or from a newer Litch, local groups are read-only and the file is
left untouched.

置顶区在侧栏最上方，合并所有设备的置顶对话和项目，每行有设备色块和设备名；置顶资格仍存在各设备上，先后只在本机排序。
「最近」「未读」的行用同一个设备标记（按项目聚合时项目行也带）；登记了多台设备时才写设备名。设备离线时色块画成虚线，行上不写“离线”，以免挤占标题；悬停设备名和读屏仍会说明“离线”。
本机分组只保存在此客户端（桌面、手机各一份，不同步），可混装各设备的对话，设备离线时也能整理；组里的对话照常显示在原设备下，已置顶的只在置顶区显示。
手机不拖放：长按对话可「加入本机分组」、移出或上移、下移；首页本机分组一组一行，点进组详情，长按组或在组详情右上角「⋯」改名、调顺序、删除。平板上组详情在左栏，右栏保留当前对话。

On phone there is no dragging: long-press a session to add it to a local group, remove it, or move it up
or down. Each local group is one row on the home screen; tap it to open the group, and long-press it (or
use **⋯** in the group) to rename, reorder or delete. On tablets the group opens in the left pane and the
current conversation stays on the right.

## Sessions

会话可以在后台任务运行期间切换；离开大对话或关闭其后台任务面板，不需要等待任务结束。
切换只释放当前界面的会话订阅，不会停止设备上的 Agent 或后台任务。

### 侧栏中的子会话

桌面侧栏将子会话缩进显示在父会话下方，以实线连接。收起父会话后，仍显示当前选中、
待处理和未读的子会话（未读会话仍受 harness 筛选影响）。其余子会话在竖线内汇总为
“N 个子会话”；已有子会话显示时，汇总为“还有 N 个子会话”，只计算尚未显示的数量。
点击汇总行展开。筛选或显示开关隐藏的子会话不计入该数量；全部已显示时没有汇总行。
手机端仍使用父会话行上的箭头和数量展开、收起，没有单独的数量汇总行。

### Opening from outside the sidebar

With **Automatically locate conversation** enabled (sidebar More menu, on by default), opening a session from a notification, task card, link, manager workline or pending activity reveals
its device, project/group and parent chain and highlights the row. It scrolls only if the row is out
of view. Clicking a row already in the tree does not reveal or scroll it again. A hidden sidebar stays
hidden and locates the row when reopened. A single-group view returns to the full list.
Filters and display switches are preserved; when the target cannot be shown, its nearest visible
ancestor is revealed. Archived previews do not select a sidebar row.
With this option off, opening a conversation still selects its existing row but does not expand
groups or scroll the tree. Back/Forward navigation and notifications follow the same option.

Chat and Managers only switch the sidebar tree. They share the same current session or page;
switching trees leaves the content, panels and pending session opening unchanged. External entries
also keep the current tree. Managers always open their full workbench, regardless of entry.
Back/Forward changes the content without switching trees. Archived or deleted sessions are not restored.
Managers and the global suggestion list: see [Managers and suggested tasks](managers-and-suggestions.md).

直接点击侧栏“未读”“最近”中的经理时，进入经理工作台；工作线仍在原视图打开普通对话。
普通设备树不重复列出经理及其工作线。手机最近中的经理使用与经理目录相同的工作台和默认页签，
返回一次回到原入口；查看对话时按工作台的规则清除会话未读。

### Pending questions and answers

Answer pending wrap-up and asynchronous questions **above the composer**, on desktop and phone.
They survive sub-session reports, schedules, messages and background wakes. Several old and new
questions can coexist; duplicates are shown once. Answering one settles only that question. A message
you type in the main composer settles earlier pending questions together. Automated plan confirmation
follows the same distinction. Automated turns do not count as your answer.

The transcript shows a question only after it is answered, ignored or closed, combining its record
and answers in one card. In partially answered groups only settled questions appear there; the rest
remain above the composer. Answered groups fold to a count and summary; expand to read answers and
other options. In pending questions, clicking an option sends that answer immediately on desktop
and phone. The Send button is only for a custom answer. Desktop answer fields use Enter to confirm and Shift+Enter for a newline; IME Enter
only confirms composition. On the phone Return adds a newline and the card's button submits.

The pending section can collapse while retaining its count. Cards show their age and later
sub-session report count. Replies follow the configured send mode (immediate or queued); cancelling a
queued answer restores the question. **Ignore**, when supported by the device, hides a question
without sending a message or answering it, and syncs across clients/reconnects. Ignored questions
remain visible to the agent in wake/reminder context; obsolete questions should be explicitly
withdrawn through wrap_up. Ignore state is not inherited when a session forks.

Blocking approvals and questions remain in their request cards until answered, withdrawn or their
owning turn ends. The parent also shows direct children's blocking requests above its composer;
expanding one opens the original request card. The model can read a current request id and explicitly
respond when authorized (its descendants, or a user-input turn). Ordinary messages never answer a
request. Secrets, MCP forms and requests owned only by another executor still require the user in the
original flow. Delegated answers leave an audit record in the child conversation.

### Folded turns and mid-turn input

Long desktop conversations load their history progressively so the sidebar stays responsive.
When returning to an earlier reading position, the transcript briefly shows a loading message
while restoring it. You can select another conversation during that time.
切回长会话时，即使阅读位置落在部分露出的回合结尾、前面的长正文尚未排版，首个显示帧也保持离开前的位置。
Scrolling while earlier turns are being filled in keeps your reading position; code blocks and
other inner scroll areas retain their own scrolling.

In the compact transcript, a finished turn with a final answer folds its activity into a full-width
row: elapsed time, supporting counts of commentary/steps/subagents, and any failure, refusal or still
running background work. Click the row to expand. Stopped turns and turns without a final answer stay
open. Every message explicitly marked as a final answer stays outside the folded activity, including
a conclusion followed by a short reply to a message received in the same turn. The detailed view
keeps its usual behavior.

Native subagents appear as compact rows with a description, status and elapsed time when available
on desktop and phone. Click a row to open the subagent's conversation. Codex activity markers and
the structured subagent calls used by Claude Code, Pi, DSH and OpenCode share this presentation;
repeated activity markers update the same row within a turn. Generic ACP tool reports without a
subagent identity remain tool steps.

A user message delivered during a turn appears as a regular message bubble. It stays in
that turn and divides its activity into independently expandable segments on desktop and phone.
Segment time appears only when every entry has timestamps. The turn's source appears once at its
start, and completion/total time once at its end. With no mid-turn input there is one activity row.
System events (reports, schedules, messages and manager updates) fold to their source and summary;
expand to read the body. Their open state is remembered per session. Expanded, a sub-session report
shows the sub-session's title and status on one line with the report underneath at the card's full
width. Reports, manager updates, messages from other sessions and unfolded suggested-task briefs are
rendered as Markdown; file links in them open in the file viewer as in answers. Tags such as "Run
manually" or "Sender skips approvals" sit on the card's title line. Desktop and phone alike.

Ordinary sessions are managed in the UI or with session tools; manager configuration has its own commands. What the user can do in the UI, so you can
explain it:

- **Start**: New session (Mod+N) → pick device, project, harness, model, reasoning effort, permissions
  (Read only / In project / Full access, or the harness's own presets) and optionally turn on the
  Plan mode switch → send the
  first message. `scripts/litch open new` brings the user to this page.
  新建页开启的计划模式用于新会话的第一条消息。进入会话时按该会话的能力显示对话参数；会话未单独声明能力时沿用 harness 的能力。
  新建页进入会话时连续保留已收到的正文与提问卡，不因页面交接短暂清空；首个计划问题可直接作答。
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
  Pressing Enter again while the previous message is still being sent is accepted too (desktop and
  phone): it goes in order, queued or into the running turn per the setting. On the new-conversation
  page the next message waits until the conversation has been created; anything still in the composer
  then (text, images, chips) moves into the new conversation's composer unsent, and the
  new-conversation page starts empty next time.
  发送刚开始、设备尚未返回回合号时也能停止：先暂停待发，回合号到达后停止该回合。此时提交的立即插话先保留在待发中，停止后不再自动插入。
  正常完成后按顺序发送排队消息；上一回合迟到的空闲通知不会阻塞后续队列。
  停止或回合失败后，本客户端尚未发送的消息暂停，不会自动开启下一回合。桌面和手机输入框上方一行头
  “⏸ N 条待发 · 全部发送”，下面每条一行，行尾是图标按钮：发送（↑）、编辑回输入框（✎）、移除（✕），
  有悬停提示和读屏名称；桌面悬停或聚焦时出现，手机常显。待发的“发送”和输入框的发送键是同一个箭头。
  排队中的消息同样每条一行，行尾是立即插入（拐进去的回车箭头 ⏎，与发送区分；桌面、手机相同）、编辑、移除，
  手机不另占标题行，第一条前写“◷ N”。输入框有内容时发送键旁出现小开关“含 N 条待发”（默认开）：开着连同待发
  一起发，保持各条消息的顺序与附件归属；关着只发这条，待发的留着。手机的发送、停止是圆形图标键（↑、■）。
  插话状态在气泡左边用一个小记号表示，不占一行：桌面是图标（钟、暂停、圈 i），悬停提示和读屏名称是整句说明；
  手机是小记号，点一下在对话区底部显示整句说明。排队、停止待发、状态待确认分别表示。手机用户消息的发送时刻也在气泡左边。
  正常已发送消息不显示状态记号，读屏名称仍包含状态。“已发送”只表示运行时已接纳，
  不保证模型已经执行。只有明确取消的未消费输入进入待发；状态待确认的消息不会自动重发，核实后可编辑再发。
  Delivery status is a small mark at the left of the bubble on desktop and phone, taking no extra line: an icon on desktop
  with the full explanation as tooltip and accessible name, and a small mark on the phone that shows the explanation when
  tapped. Queued, stopped pending, and unconfirmed messages remain distinct.
  Sent messages have no visible status; their accessible name still includes it. Sent means accepted by the runtime, not necessarily acted on by the model.
  待发原文和附件保存在当前客户端，重启后保持暂停并尽量按 Claude 历史对账；尚不在设备间同步。
  明确取消的插话在本机可靠保存为待发后，从对话中移到托盘；重新发送只显示新尝试，失败仍回到原待发记录。
  切换会话、重读历史和重启后也按输入标识对账，不按相同文字删除消息；没有本机恢复记录的历史消息保留原文。
  托盘单条发送、全部发送都不会提交输入框里的草稿；主发送键仍默认连同待发一起发，编辑待发仍追加到现有草稿后。
  On desktop and phone, a confirmed cancelled input moves from the transcript to the pending tray after its recovery copy
  is saved locally. Resending shows only the new attempt; a failed resend returns to the same pending entry. Reopening
  or restarting uses input IDs, never matching text, to keep that projection. History without a local recovery record stays visible.
  Sending one or all pending entries leaves the composer draft untouched. The main Send button still includes pending
  entries by default, and editing a pending entry still appends it to an existing draft.

  编辑时若现有草稿容纳不下附件，消息仍留在待发列表。此阶段仅 Claude 提供交付状态，其他 harness 只统一停止后暂停队列。
  若界面误以为回合仍在运行、引擎明确拒绝插话，客户端会重新核对回合状态；确认已正常结束后，原消息作为新回合发送一次。
  无法确认状态时，消息和附件保留为暂停待发，可在状态恢复后点击“发送”。停止后的核对若超时或被新通知打断，下次发送会重新核对；Claude Code 等引擎报告回合不一致时也会核对，不会一直等待旧回合结束。用户在核对期间点停止，仍须明确恢复发送。
- Child sessions show their harness in the sidebar/list, cards and details. A successful user message
  during an automated turn makes that turn user-driven.
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
  In Claude Code, background notifications that continue after manual compaction run in a separate
  normal turn with the session’s own permissions; they do not inherit compaction’s temporary
  read-only restrictions.
- **Side panel**: Files (tree, search, read-only viewer, add a file to the conversation), Diff (all /
  staged / unstaged, stage, unstage, discard, comment on lines; comments go with the next message),
  Browser, Suggested tasks, Background tasks, Goal, Side chat.
  从回答里的文件改动点“在差异里看”可定位该文件；连续打开不同文件时，会分别确认各自的最新改动。
- **文件自动刷新**：桌面和手机打开文件页时，展开目录中的新增、删除和重命名自动更新，保留展开和选中状态。当前预览随文件改写重新读取；删除或重命名后原路径显示不存在。收起目录、关闭面板或离开手机文件页时停止相关监听；重新打开或重连后重新读取。批量变化会合并；设备不支持 `fs/watch` 时仍可手动刷新。
- **在文件管理器中打开本机文件**：本机文件不显示另存操作。文件树的右键菜单、源码和渲染预览的标题栏与右键菜单、附件卡片提供此入口；对话中的文件链接打开预览后也可使用。macOS 显示“在 Finder 中打开”，Windows 和 Linux 显示“在文件管理器中打开”。文件会打开所在目录并选中，目录则打开自身；文件已删除或无法访问时会明确提示。远程会话中标为本机的附件仍按本机文件处理。
- **远程文件另存到本地电脑**：远程设备的文件树右键菜单、当前预览的右键菜单及标题栏、附件卡片均可选择“另存到本地…”。系统保存对话框的目标属于运行客户端的这台电脑，默认使用原文件名，重名确认由系统处理。传输显示进度并可取消；完成后可打开文件或显示所在文件夹。只支持单个普通文件，需要设备服务提供 `fileDownload`；不支持时提示升级，不回退整文件读取。大文件按 256 KiB 分块读取和落盘；来源变化会停止，完成前不覆盖目标。手机尚无系统导出入口。
- **Images in replies (desktop and phone)**: `![description](path-or-url)` displays a thumbnail.
  Relative paths use the conversation's working directory; absolute paths may point anywhere on
  its device. Paths containing `..` and network shares are rejected. The device probes content before
  reading the image, so a renamed non-image does not become a preview. Click to enlarge: desktop
  supports zoom, drag, previous/next, copy, save and Show in file browser; phone supports pinch and drag.
  HTTP/HTTPS images are lazily downloaded by the conversation's device, without cookies or Referer,
  using public-IP-only DNS-pinned connections. Private addresses and unsafe redirects are rejected.
  Old devices and failed external downloads remain links; the viewing app never downloads directly.
  Static PNG/JPEG/GIF/WebP and safe SVG are supported, with 8 MiB/image and 1 MiB/SVG limits. Corrupt,
  animated or oversized images become file cards. Plain links, code and HTML do not embed media.
  Audio/video embedding and tool-image history recovery are not part of this first image release.
- **File previews (desktop)**: the Files tab opens tree/search results and file links read-only.
  Markdown renders by default (Source is available; line-number links open source). Static images
  and SVG can zoom. PDF supports pages, scroll, zoom and text selection. CSV/TSV shows strings, never
  evaluates formulas, and offers source for cropped fields. Static HTML disables scripts, forms,
  navigation and external resources. Short MP3/WAV/MP4/WebM media has manual playback; codec support
  depends on the system. DOCX approximates document layout; XLSX shows sheets and saved formula
  results without recalculation, with basic number/date formats, merges and limited frozen panes.
  Unsupported formats include DOC, XLS, PPT and PPTX. Previews do not reproduce every Office feature.
  Project-relative images/links stay inside the project root; remote images, active SVG, PDF actions,
  macros and encrypted Office files are not opened. Size/complexity limits show a reason (PDF:
  20 MiB/200 pages; Office: 10 MiB compressed/40 MiB expanded; media: 16 MiB). Large table previews
  are cropped with a notice. Use the original application for editing or full fidelity. Preview
  fonts do not follow Conversation text size. A device without preview support offers its ordinary
  source/type view.
- **手机文件预览**：PNG、JPG/JPEG、静态 GIF/WebP 支持双指缩放、拖动平移和双击复原。
  图片上限 8 MiB、2000 万像素、单边 16384 像素；动画图片暂不预览。SVG 显示源码。
  PDF 使用离线渲染器逐页查看，也可缩放和平移；上限 20 MiB、200 页，每次仅保留一页画布。
  加密、损坏、超限或处理超时的文件会显示原因，并提示在桌面查看；设备服务没有预览能力时提示升级。
  Office、音视频、压缩包等格式暂不在手机预览。预览页与不支持格式的提示均可复制设备上的文件路径。
  PDF 不执行文档脚本、动作或外链，渲染器不从网络加载资源。
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
  a breathing line above the composer says how many are running, counting running subagents too (on
  the phone a small pill with the mark and the count); clicking it opens the Background tasks tab. That tab lists background commands and the harness's own
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
  wake the session; when you stop one, the model is told on its next turn that you stopped it. 原生 Codex 在新建 Litch 会话中默认提供 `litch_background.watch/read/cancel`：模型用原生命令执行有限任务，再登记需要结果后继续的 session_id；登记成功后可以结束回合，任务完成后设备自动投递结果并继续。常驻开发服务器和无限监听不登记，不因退出自动续跑。等待一次消息、邮件或构建完成后退出的有限命令，若结果仍用于当前任务，必须登记 `watch`，即使名称叫 watcher 或 listener。后台任务页会提示当前 Codex 版本不支持或会话未安装工具；请升级到 0.163.0 及以上后新建会话。命令权限和沙箱仍由 Codex 管理。Gemini CLI and Qwen Code get no Litch
  background commands. Litch's background commands run on the device the session runs on, as the
  model's own commands do; their output goes to a log file the model can read. They keep running when
  every client disconnects, and stop when the harness's runtime restarts (a settings change, a service
  restart or upgrade) or the session is deleted. A sub-session reports to its parent when its turn ends and says how many
  background tasks are still running, then reports again when they finish (after the turn that
  continues, or right away for unregistered Codex terminals and when the tasks were stopped). If you stopped them, that report
  says so and does not wake the parent. A scheduled run ends with its turn too; when the background
  work finishes later, the run's summary and count are updated and it shows as unread again.
  原生 Codex 登记的任务在后台页显示自动继续状态。停止回合会暂停自动继续，命令本身不会额外被杀；输入框中的待发消息不会因此自动发送，用户明确发送后才能解除暂停。取消登记只撤销自动继续，停止命令使用后台页的停止按钮。客户端全部断开时，设备仍可收到结果并继续；设备服务或 Codex 重启不自动续跑，已保存结果仍可读取。自动续跑没有次数上限，可能持续产生模型费用；重复完成只投递一次，交付未确认时不自动重试。官方客户端同时打开同一线程会看到标准回合和工具输出；绕过设备的并发写入不能获得设备侧的原子仲裁保证。
  To stop a task without the Stop button, ask the model or stop the turn. With Pi's "Ask before acting" on, starting a background command is asked about like
  any other command; in OpenCode's read-only permission mode the model cannot start one, and outside
  the project folder it asks first (except with full access). On the phone, the same line (or
  "Background tasks" in the session's menu) opens a simpler page with the same list, where a subagent
  opens its own page and running commands can be stopped; the folded steps and the
  line at the start of a continuing turn look the same as on the desktop.
- **Messages Litch sends for you** show as cards, not as your own message: a scheduled task's run
  ("Scheduled task · <name>", tagged "Run manually" for Run now), a sub-session's first message ("Sub-session
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
- **CJK emphasis**: in replies and Markdown file previews, bold, italic and strikethrough render even
  when the markers touch Chinese punctuation (for example `**“文件”**的`); code and link text stay
  as written. Desktop and phone use the same rules.
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
  Litch are named after their first text message is accepted, independently of the main turn
  (switch and conditions in `harnesses.md`). Interrupting the turn does not cancel naming. A name
  the user sets by hand is never replaced.
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

Native Codex **0.163.0 or later** adds `litch_background.watch/read/cancel` to new Litch sessions. Finite commands that exit after one message or email, or after a build finishes, must register with `watch` when their result is needed for the current task, even if called watchers or listeners. Persistent services and indefinite listeners remain unregistered. Registration permits ending the turn; completion triggers continuation. The Background tasks page explains an unsupported runtime or a session without the tool; upgrade and start a new session as needed.

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
parent in the sidebar, their results come back to the parent, and the parent can be
woken to continue.

- **By hand**: session menu → Start a sub-session… → harness, model, project, context ("Start fresh",
  or carry over the parent's context, which needs the parent's harness), title, task, background
  (only for a fresh start, optional: what the sub-session cannot see of this conversation), and
  "Wake the main session when done". If the chosen harness cannot give the same sandbox as the parent,
  the dialog warns that the sub-session will be looser.
- **By the model**: in sessions of every harness (Codex, Claude Code, Pi, DSH, OpenCode, Gemini CLI,
  Qwen Code, ACP) the model has `litch_sessions` tools: list and read sessions on the device, start
  sub-sessions, send to and interrupt its own sub-sessions, wait for them, and archive or restore
  sessions. `list` now excludes archived sessions by default, including with `scope: "mine"`;
  use `archived: "only"` to find sessions to restore, or `"include"` to list both. Every record
  includes `archived: boolean`; existing arguments remain valid. In a turn you started it may send to or interrupt any session. Once two sessions have
  exchanged a message in any way (a message the model sent, an interruption, a session you mentioned
  with `@` in the other, a sub-session's brief and reports, a Claude Code inbox message), both may
  message each other at any time after that, also after archiving and restoring either (interrupting
  still needs a turn you started, unless it is its own sub-session). It archives a session only after you agree in a message you typed (when its sub-sessions
  have all finished it may suggest archiving them), never one that is still working or pinned; it can
  restore its own sub-sessions any time. Without authorization to start sub-sessions (including earlier authorization still in effect), the model proposes a task card instead. To use another
  harness or model it first looks up what the device offers (`litch_sessions.options`: each harness's
  models as in the model menu, Claude Code's with their provider, reasoning efforts, defaults); a
  harness or model the device does not have is refused with the choices instead of starting a session
  that fails on its first turn.
- **Suggested tasks**: the model proposes work with an outcome of its own that you may want to
  follow separately, including independent steps of an agreed plan. Parts of the current task,
  unfinished work and verification stay in the conversation. Most turns need no card. A next step
  continuing a diagnosis is one question with reply buttons; answering sends your response to this
  session. Wrap-up suggestions appear below the final answer when the turn ends; mid-turn proposals
  appear where raised. Card actions, inheritance, retention and the session/global lists are in
  `managers-and-suggestions.md`. Repeated Start returns the original child, not another session;
  an already settled card reports its actual state.
- **Where a sub-session works** (devices that support worktrees): when the parent session is in a
  worktree Litch created (or shares one), a new sub-session gets its own new worktree and branch,
  starting from the last commit of the parent's branch (the parent's uncommitted changes are not
  carried over); otherwise it shares the parent's folder. The model can say which it wants; cards,
  the "New session" choice of an offer card and the Start a sub-session dialog have a "New worktree"
  checkbox, preset this way, and what is checked there wins. "Do it here" always stays in the current
  session and folder. A handed-off task gets a worktree only on harnesses that can fork into another
  folder (Codex, Claude Code); elsewhere it shares the folder. On the phone the cards, the offer card
  and "Edit and start" have the same "New worktree" switch.
  At most three unsolicited suggestions and four total cards can be raised per turn. To start one,
  click its card or tell the model which one. The model withdraws stale proposals. Wrap-up precedes
  the final answer and may carry no suggestions. A missed wrap-up can trigger one reminder turn.
  Settings for task cards, wrap-up and reminders are documented once in `device-settings.md`;
  these do not remove authorization for explicitly requested sub-sessions. Cards live on the device
  and can be created while no desktop or phone is connected.
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
  not consume the 4-card allowance shared by proposals, offers and wrap-up suggestions. The whole tree allows 24 running or starting sessions including the root,
  with maximum depth 4 (root is 0).
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
  回报摘录最多 2000 字符，超过时附“已截断 / Truncated”及 `litch_sessions.read` 全文提示。
  模型按需 `read` 时，最近回合回答最多 32000 字符，较早回合最多 4000 字符，超限使用相同截断标记；界面全文读取不受这个摘要上限影响。
  多条回报一起交给模型时，摘录与错误（正文及 JSON 两份）共享 24000 字符预算，必要时进一步缩短并标明截断。
  桌面回报卡、事件条和待交付回报中，回报标题行末尾的小图标（展开全文 / 收起全文）按需读取原回合的完整回答；手机在标题行末尾用小箭头展开或收起。
  后续新回合不会替换历史回报的全文。设备离线、回答被删除或回滚时保留摘录并提示错误，可重试或打开子会话查看。
  If a sub-session finishes several turns while the parent is busy, only its latest report is handed over.
  Users can also stop automatic reports entirely; see [Stop or resume reporting](#stop-or-resume-reporting) below.
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
later. Managers and their worklines are exempt: delegation, reports and automatic wakes continue
when this switch is off. Individual report and wake settings, user stops and failures still apply.

A running client tool does not mean the session needs user input. Browser sign-in approvals explicitly shared by the desktop appear in the parent’s pending section; complete them through the original approval flow. Other approvals held only by a client may require opening that sub-session on that client.


### Stop or resume reporting

Right-click a child session on desktop, or long-press it on the phone, then choose **Stop reporting to
parent** or **Resume reporting to parent**. Manager worklines have the same menu. It requires an online
device supporting the feature; a stopped row shows **Reports off**. The setting is stored on that
device and survives reconnects/restarts.

Stopping reports keeps the child in the tree and leaves its own running/waiting status visible. It
suppresses future automatic completion, failure, interruption, pending-request and background reports,
removes undelivered reports and prevents their wakes. Already delivered reports remain. Other
children still report and wake normally. Resuming does not replay old results; a currently pending
request is reported once after the usual 10-second waiting threshold. Waking also obeys the separate
wake_parent switch. Models can read report_parent through list/read but cannot change this user
control; set_wake only controls waking. There is no litch config command for it.

## 自动定位对话（桌面）

对话树顶部“更多”里的“自动定位对话”（Automatically locate conversation）默认打开，设置保存在这台电脑。
打开时，前进、后退、通知、搜索或其他入口切换对话，都会展开设备、组、项目和父会话，滚到对应行并选中。
关闭时只切换对话，不新增侧栏选中，也不自动展开或滚动；通知打开也遵守这个开关。直接点击侧栏行始终选中该行。
External navigation selects the tree row when automatic location is enabled. When disabled, it adds no sidebar selection; direct row clicks still select that row.
侧栏整体收起时不会自动弹开；开启自动定位后，重新显示侧栏会完成定位。

## 发送普通文件

桌面可通过选择文件、拖放或粘贴添加文件；手机在输入框“＋”中选择“添加文件”。输入区与发送后的消息均显示文件卡，包含文件名和类型或大小，长名称截断。点卡片在文件面板预览；不支持的格式仍可从桌面文件面板另存。图片沿用图片附件规则。

- 会话在本机：发送文件路径，不复制内容。
- 会话在远程设备且已开启“操作本机”：发送控制端电脑上的路径，模型通过 `litch_machine` 读取。
- 其余情况（包括手机）：先经协议上传到会话设备，再发送设备上的路径。单文件上限 16 MB；空文件可上传。无法访问的文件夹不递归上传。

上传从选定文件时开始，完成前不能发送。文件存放在会话设备主目录的 `.litch/attachments/<独立编号>/` 下，不同附件不覆盖同名文件；上传失败会尝试清除本次目录。设备服务启动时清理一次，之后每 24 小时清理修改时间超过 30 天的附件编号目录。会话仍打开、回合或后台任务仍在运行时保留；重新引用、打开附件会刷新目录修改时间。无法确认会话状态时暂不清理。清理不跟随软链，不触及附件根目录之外的路径。已自动清理的附件在桌面和手机显示“已清理”，不能再打开；历史中的文件名保留。上传副本不包含后续对源文件的修改。

手机可打开会话设备上的附件；属于控制端电脑的附件需要回到该电脑打开。新发送的文件卡信息保存在消息文本中，重新读取原生历史仍能恢复；既有历史中的裸路径不作猜测转换。
