# Changelog

All notable public-facing changes for Codex Harness Adapter are summarized here.
The project is still private in `package.json`; this file tracks release notes
for maintainers preparing the next public release and does not change package
versioning or publishing metadata.

## 0.7.2

- Claude Code 入口列出这台机器上别处（命令行、Claude 桌面端）开的 Claude Code 会话：`~/.claude/projects` 里的、不是程序化调用起的（SDK、`claude -p`，适配器自己跑的也在里面）都在会话列表里，能打开看历史、接着聊（接着同一个原生会话）。历史在第一次打开时照原生记录画进适配器的库，原生记录里又多了内容（命令行里接着说过）再接着画后面的。别处新开的会话半分钟内出现。在这里删掉只是不再列出，原生记录不动。`CHA_CLAUDE_NATIVE_SESSIONS=0` 关掉。此前这个入口只列经它建的会话，Litch 里看不到本机用 Claude Code 聊过的那些。
- Litch：同一个目录同时是几个项目的根时（从 Codex 导入的项目常这样），会话照官方桌面端的规则归：只有这一个目录的项目优先，其次是把它当主目录的，再其次按排的先后。此前归给排在最前面的那个，比如 home 目录下的会话全落进一个把 home 当作第三个目录的项目里，home 项目自己是空的。
- Litch：“工作区”改叫“项目”，和官方桌面端一样；DeepSeek Harness 在界面上简称 DSH。
- Litch：侧栏按 harness 筛选可以多选。
- Litch：添加项目时，本机的设备可以点“选择…”用系统的选文件夹对话框挑目录。
- Litch：模型多的选择器（8 个起）顶上有筛选框，按名字、标识筛，回车选第一个。

## 0.7.1

- Litch 有了安装包，随发布页一起出：macOS（Apple Silicon）的 dmg，用 Developer ID 签名并经苹果公证；Windows（x64）的安装程序，只装给当前用户、不要管理员权限，没有签名，**还没有经过完整的测试**。发布流程改名为 `release.yml`，适配器的包和两种安装包都出好才一起挂到草稿发布页；手动跑时不填标签就是试跑。
- 自带的适配器能给 Windows 暂存了：命令行和 Node 带 `.exe`，Node 取官方的 .zip（校验和照官方签过名的清单登记）；按文件头认 Windows 可执行文件的架构。

## 0.7.0

- 原生 Codex：这台机器上装了 codex 时默认就启用，不用再去设置里打开（设置里没写过启用与否时，看设置里的命令行路径或 PATH 里有没有 codex；没装照实显示“没装”，不算毛病）；在设置里关掉的照旧关着。
- Pi 入口：只走了插件命令、没写一条消息的回合（比如在官方桌面端发 `/plan`，计划插件弹出菜单后跳过）也算会话有了动静，最后更新时间是这个回合结束的时候，和上游一样。此前列会话、读会话（包括 Litch 重启后重新拉列表）拿到的还是上一条消息的时间：Litch 侧栏上这个会话先排在最上面写“2分”，重启 Litch 之后掉下去写“50分”。压缩上下文的回合同样如此。打开会话看一眼照旧不改时间。
- Claude Code 入口：前面带空白（换行、空格）的斜杠命令（比如 `\n/compact`、`  /自定义命令`）不管在第几个回合发都认了。此前只有 Claude Code 进程起来后的头一条消息认（新会话的第一句、重启或恢复后的第一句），之后前面带空白的就不认，原样当成一句话交给模型。后面带空白的一直认。
- Litch：别处先建好、还没发过消息的会话（官方桌面端的新对话页一打开就建好一个）不再出现在侧栏里写成“没有标题的会话”，十来分钟后才没；它开始第一个回合时才出现，标题就是第一句话。
- Litch：在别处建的会话，第一个回合进行中侧栏上就拿第一句话当标题，此前要等回合结束、那边起好名字才有。
- Litch：没打开的会话在别处（官方桌面端、另一台电脑）跑了新回合，侧栏上的时间和排序跟着回合的开始和结束变，此前一直停在上次刷新列表时的样子。
- Litch：会话上的未读记号重启之后还在，此前只记在内存里，重启就全没了。
- 三个入口（Claude Code、Pi、dsh）归档、取消归档会话时照上游先回应答、再发 `thread/archived`、`thread/unarchived`，和原生 codex 一样。此前通知比应答先到客户端。官方桌面端经 SSH 归档这几个入口的会话时总提示归档没成功，这个先后是对照原生 codex 时查到的归档一来一回里的差别之一，改了之后还提不提示要在桌面端上确认。
- 修复官方桌面端经 Pi 入口改会话名之后，Litch 侧栏和会话列表里多出一个重复会话的问题：桌面端改名时分叉一个临时会话（`thread/fork` 带 `ephemeral: true`）起描述，Pi 入口此前不认这个参数，建的是一个普通会话，写了原生会话文件、进了列表。现在照上游，临时分叉和临时新建的会话都只在内存里（不写 Pi 的会话文件），不进列表，通知只给建它的连接；没人订阅、闲下来就卸载，之后按会话号找答“没有这个会话”。临时会话的回合被打断之后也不再丢掉已有的上下文。
- Pi 入口认得出首尾带空白的斜杠命令：官方桌面端发来的 `/plan` 结尾带一个换行，此前被当成一句普通的话交给了模型，计划插件的菜单不弹。现在照 Pi 自己的界面去掉首尾空白再交给 Pi（只对去掉空白后以 `/` 开头的话这样做，别的话原样）。
- Pi 入口新会话的第一句话在回合开始时就有了：第一个回合进行中读会话、列会话，预览就是这句话，和上游一样。此前要等这个回合结束（模型说得久就是好几秒）预览才出现，这期间 Litch 侧栏上这个会话没有标题。
- Pi 入口的会话列表不再列没说过话的空会话，和上游、dsh 入口一样：官方桌面端在新对话页上会先建一个空会话、没用就删，此前 Litch 重连或刷新时它以“没有标题的会话”出现在侧栏上。列已归档的会话时照列；头一句只发了技能或图片的会话照列。
- Claude Code 入口的 `thread/list` 照上游不再列还没说过话（预览为空）的会话：官方桌面端在新对话页上会先建一个空会话、一阵子没用就删，此前 Litch 重连或刷新时它会以“没有标题的会话”出现在侧栏里。第一句话一发出去（回合还在跑）就列出来；看归档的、按父会话查的、指定了某个分区（含置顶）的照列，按标识读照读。
- Claude Code 入口：还没说过话就设了目标的会话，照上游拿目标当预览（只在预览为空时填，之后说的话、改的目标都不顶掉它）。此前这种会话的预览是空的，目标一续跑就变成续跑回合那句内部提示“继续执行当前持续目标……”，客户端列表里显示的就是这句。
- Claude Code 入口的临时会话（客户端起标题、起描述、侧聊用的）照上游用完就没了：最后一个订阅者退订或断开、回合也结束了，过 60 秒（`CHA_CLAUDE_EPHEMERAL_UNLOAD_MS`）卸载，库里的记录和 Claude Code 写下的会话记录一起删掉，之后读它、恢复它都是找不到会话；入口重启时把上次留下的也删掉（包括以前攒下的）。此前这些会话一直留在库里，Claude Code 的会话记录也一直在，`claude --resume` 里多出一堆，起描述的分叉每次还是整段历史的一份拷贝。
- Claude Code 入口：退订分叉出来的会话不再被挂回去。此前这条连接只要还开着源会话，退订分叉之后紧跟着的关闭通知又把它订阅上了，之后分叉里的通知照收，`thread/loaded/list` 里也一直有它（官方桌面端关侧聊、起完描述都是这样退订的）。
- Claude Code 入口不再拒绝官方桌面端改名后起描述用的临时分叉（此前报“Claude 入口不支持 Codex 模型或跨引擎会话”，桌面端就没有描述）：临时分叉带着 Codex 的模型名时沿用源会话的模型。普通分叉带着 Codex 的模型照旧拒绝。
- Claude Code 入口的分叉照上游只看请求带没带 `ephemeral: true`：官方桌面端开侧聊（“旁支对话”）的分叉是临时会话了，应答和 `thread/started` 里写着 `ephemeral: true`，新建通知只给开侧聊的那条连接，不进会话列表。此前分叉一律跟着源会话，侧聊成了普通会话，广播给了别的连接，Litch 侧栏里一直多一行“出个计划 (2)”这样的会话。修好之前已经留下的这种会话是普通会话，要手动删。
- Pi 入口分叉出来的会话（Litch 里悬停消息点分叉、`thread/fork`，以及在 Pi 自己的界面里 `/fork` 出来的）最后活动时间是分叉那一刻，和上游、Claude Code 入口一样：Litch 侧栏上新会话写“现在”、排在最上面。此前沿用的是源会话最后一条消息的时间，分叉出来的会话写着“10 分钟前”、排在源会话下面，入口重启之后也一样。
- dsh 入口里用户在审批里拒绝的命令，条目照上游不再带输出、退出码和时长（和 Claude Code、Pi 入口一样）：此前带着退出码 1、dsh 交给模型的那句拒绝的话，时长还把等审批的那段算了进去，Litch 里这一条显示成红色的“22 秒 已拒绝”，另两家是灰色的“已拒绝”。回放历史也一样。
- 三个入口的 `config/read` 多报一项 `default_permissions`：不带权限设置新建的会话用哪个权限档（Claude 照配置的审批策略和沙箱凑，Pi 是完全放开，dsh 是它给新会话的默认预设）。Pi 入口报的默认强度改成 Pi 建会话时真用的那一档（这个模型单独记的档优先，钳到模型支持的范围），此前报的是全局默认档；dsh 入口报的默认模型和强度改成和建会话时同一个取法，此前强度取的是模型自己的默认，dsh 记着上回选的强度时对不上。
- 官方桌面端（以及移动端）连 Claude Code、Pi 的入口时，计划模式不再要确认两次：这类客户端在回合结束后自己问“要不要执行”，引擎不再在回合里另问一道。交了计划的回合带着计划条目正常结束，计划模式不退出；选执行发来的新回合照常执行，写意见就是计划模式里的普通消息。Litch 握手时声明新的协议扩展 `planConfirmation`，照旧由引擎在回合里问（Claude Code 的“执行计划 / 继续规划”，Pi 计划插件的菜单）。带 `outputSchema` 的回合照旧问。
- 三个入口（Claude Code、Pi、dsh）把会话的新建、状态变化、改名、归档、取消归档、删除等通知发给所有连接，和上游一样，不再只发给订阅着这个会话的连接（Claude Code 入口此前状态变化只在没人订阅时才发给所有连接，新建只发给建它的那条）：Litch 侧栏上没打开的会话（比如在官方桌面端或另一台电脑上跑着的）的状态记号、名字、归档会跟着变，官方桌面端开着几个窗口时也一样。回合和条目的通知照旧只给订阅者；客户端起标题用的临时会话的通知不发给别的连接。
- Claude Code 入口的 `thread/read`、Pi 入口按会话号找不到会话时，同样改答 `thread not found: <会话号>`（此前是“未知会话”“未知 Pi 会话”，官方桌面端同样认不出），错误码不变。
- Claude Code 的入口：官方桌面端里分叉出来的会话，不再每个回合都把整段开发者指令放在用户消息前面交给模型，只在头一个回合放一次；指令变了、带着它的回合被回退了、上下文压缩过了，再放一次。系统提示仍和父会话一样，提示缓存照旧命中。
- 修复 Claude Code 入口一个回合里工具调用越多越卡的问题：工具调用（命令、文件改动等）每开始、结束一次，连同它前后思考和正文条目的开始、完成，适配器此前都把整个回合从库里读出来、解析、再整个写回去，一次的开销随回合里已有的内容涨，整个回合下来是平方级的。实测一个回合三百次调用、每次输出两万字，入口光是存这些就要 14 秒的 CPU（整个入口 24 秒，越到后面每次越贵，最后每次约 80 毫秒）。现在一次增减只把这一个条目记进库（库里新加的一张表 `turn_item_log`），回合被读、被整个写、结束时才合进回合那一行；存的开销降到 2 秒，不再随调用次数涨。客户端收到的通知、读会话、恢复会话、重连拿到的内容和以前一样；进程被强杀之后，已经开始和完成的条目一个不少（下次启动时合进去）。0.6.0 的库照常打开。
- 修复 Claude Code 入口工具调用越多、会话越长越卡的另一处：每次调用工具之前，入口要确认这次调用已经写进 Claude Code 自己的会话记录（确认不了就不让执行，防止重启、恢复时同一个工具被执行两次），此前每确认一次（没写进去时每隔 25 毫秒再看一次）都把整个会话记录读出来、逐行解析，会话记录跨回合累积，越往后每次越贵。现在每份记录只读新增的部分、只解析带工具调用的行；记录被 Claude Code 截短、重写、换掉时认得出来，从头再读。实测一个回合三百次调用、每次输出两万字，入口的 CPU 从 16.8 秒降到 2.6 秒，每次调用的开销不再随调用次数涨。确认的规矩不变：只认已经写进会话记录的调用，子代理的调用照样到它自己的记录里确认；只差一个换行、还没写完的最后一行不再算数。
- 调试日志（状态目录里的 `debug.jsonl`）不再每记一行就同步写一次文件：同一轮事件循环里记的行攒在一起写一次，进程退出时也写，行的先后不变，轮换照旧。流式输出时入口花在写日志上的 CPU 少了一半多（一万条正文的回答每条增量 116 微秒降到 72 微秒）。进程被强杀时可能少最后一轮里记的几行。
- Pi 和 dsh 入口的 `thread/read` 不再把这条连接挂成会话的订阅者，和上游一样只读：此前一条连接读过一个会话（比如官方桌面端找置顶会话在哪台机器上时向每个入口都读一遍），之后就会一直收到这个会话的全部通知。订阅照旧靠 `thread/start`、`thread/resume` 这些。
- Pi 入口照上游发 `thread/closed`：一个会话最后一个订阅者退订或断开、会话释放之后，发给所有连接。此前从不发。dsh 入口没有卸载会话这一步（打开过的会话一直开到 dsh 退出，订阅关系在 dsh 重启后照旧），所以不发。
- Pi 入口：在 Pi 自己的界面里（比如命令行的 `/fork`）分出来的会话，列会话、读会话、恢复会话时报出分叉来源（`forkedFromId`），客户端能在会话最上面写“分叉自 某某”。此前报的是 null：Pi 记的来源是文件路径，入口没换成会话号。来源会话不在这个入口上时照旧是 null。
- Pi 入口改一次会话名只发一条 `thread/name/updated`（上游也是一条）。此前改名的请求自己发一条，Pi 的会话名变了的事件又发一条，客户端收到两条。
- Pi 入口分叉出来的会话（`thread/fork`）和新建的一样发 `thread/started`，在应答之后、发给所有连接，和上游一样：没打开源会话的客户端（比如 Litch 侧栏、另一台电脑上的官方桌面端）也能马上看到多了一个会话。此前不发，要等下一次刷新列表。
- 修复 Pi 入口里一个回合调用很多次工具、每次结果又大时越往后越慢的问题：以前工具调用的开始和结束、消息的开始和结束，每来一个都把整个回合重新写一遍库，回合里已有的结果越多越贵。现在进行中的回合按条目存，一个事件只写它动过的条目，回合结束时再整个写成一行；读会话、恢复会话拿到的内容不变。实测一个回合三百次调用、每次结果两万字，运行时的 CPU 从 125 秒降到 38 秒。库里多了一张表 `turn_items`，0.6.0 的库照常打开。
- Pi 入口在回合执行期间检查原生会话有没有被别的 Pi 实例写过时，不再每次都把整个会话文件读出来、逐条比一遍，只读新追加的那一截，先核对已经读过的部分还在不在（同一个文件、没变短、末尾一段没变），对不上才整份比；别的实例追加条目、文件被截短、换掉、删掉照样认得出来。会话越长、工具结果越大，这一项省得越多：实测一个回合三百次调用、每次结果两万字，运行时的 CPU 从 39 秒降到 19 秒；每次结果两百字、一千次调用从 24 秒降到 14 秒。
- 修复 dsh 入口重启之后，刚说过话的会话偶尔从会话列表里消失的问题：dsh 只在会话建好、回合结束、会话关掉时把“说没说过话”记进它的缓存，而且不等写完，回合刚结束入口就重启（机器忙时更容易）时缓存还是会话建好时那份“没说过话”，入口照着它把会话当成空的、不列出来，客户端就以为没有这个会话。现在缓存里说“没说过话”的会话另照会话记录核对一次。
- dsh 入口收到它没有的会话号时（多半是别的 harness 的：官方桌面端找一个置顶会话在哪台机器上时，拿会话号向每个连着的入口都问一遍）答上游的说法 `thread not found: <会话号>`，错误码不变，也不再往日志里记成 `thread/read 失败（-32602）`。此前答的是 dsh 的原话，桌面端认不出这是“这台机器上没有”，把 dsh 入口当成出了错的机器；桌面端隔一会儿就问一遍，日志里也就隔一会儿记一行。卸载了的临时线程也这样答。
- Litch：被拒绝的命令一律显示灰色的“已拒绝”，不带耗时，退出码不看。原生 codex 重读旧版本记下的会话时，拒绝的命令带着退出码 -1 和 0 的时长，此前显示成红色的“0 毫秒 已拒绝”。
- Litch：工具调用（MCP、动态工具、函数工具）的参数和结果太长时只留开头和末尾，中间单独一行写明省了多少；图片、音频、资源只显示一行说明（种类、格式、大小），不再把内容整段留着。此前结果原样留在核心和界面里：模拟核心里一次回 20 MB 的 MCP 结果，点开那一刻界面卡 1.6 秒，界面进程从 244 MB 涨到 1 GB 多；现在点开不卡（一帧 17 毫秒），界面进程不涨。
- Litch：命令一口气打出大量输出时，核心发给界面的量有了上限：同一帧里接到一条命令输出上的字并起来太长时只发开头和末尾，界面接出来的和以前一模一样。模拟核心里一条一秒打完 24 MB 的命令，通道上发给界面的从 25.8 MB 降到 4.1 MB，一帧最多从 555 KB 降到 160 KB。
- Litch：核心截下来的命令输出头尾不再拖着整段原文。此前读历史、恢复会话时拿到的几十 MB 输出，截下八万个字之后原文仍整段留在核心进程里。
- Litch：原生 codex 的会话没配强度时，输入区底栏的强度显示这个模型默认的那一档（codex 实际用的就是它）。此前 codex 报的强度是空的，底栏只剩“思考强度”四个字。
- Litch：强度选择器里 `ultra`、`persistent` 两档和 Pi 的 `off` 有了名字（中文“极致”“持续”“不思考”，英文 Ultra、Persistent、No reasoning）。此前 codex 0.160 的模型清单里有 `ultra` 这一档，底栏直接显示标识。
- Litch：MCP 工具调用的错误信息太长时也只留开头和末尾，中间一行写明省了多少，和工具结果同一个规矩。此前错误信息原样留在核心和界面里，几 MB 的错误整段画进框里。
- Litch：文件改动的差异太长时只留开头和末尾，都切在行与行之间，中间一行写明省了几行、多大；行号接得上，增删的行数仍按全部算。此前几十 MB 的差异原样留在核心和界面里。
- Litch：新建对话页上没选的模型、强度、权限，显示的是不带设置新建会话时对面真会用的那一项（照上游的取法从对面的配置里算），建会话时也照显示的发。此前显示的是模型清单里标了默认的那个：原生 codex 配置里写了 gpt-5.5，页上却显示清单默认的 gpt-6.1-sol，建出来的会话用的是 gpt-5.5；强度、权限没选时不显示具体哪一档。
- Litch：分叉出来的会话在对话最上面写着“分叉自 某某”，点名字回到原来的会话；关了再打开、重新读历史也在。原来的会话已经不在侧栏里（归档了、删了）时只写一句，不给点。
- Litch：别的客户端起标题之类用的临时会话不再出现在侧栏里（原生 codex 会把这种会话开始的通知发给每条连接）。对面卸载会话的通知（`thread/closed`）不再记成不认识的通知。
- Litch：差异面板里跳到某个文件（从对话里“在差异面板里看”、点文件树）时文件头贴着差异区的顶，不再多滚出上面标签、工具栏和文件树那一截、把文件开头十几行压在文件头底下；往下滚时“当前文件”在下一个文件头过顶时就换，滚回顶也会换回第一个。

## 0.6.0

- 新增设备进程（`packages/device`）：把一台机器上的多个 harness 收在一个入口（聚合面，`<状态目录>/device/device.sock`）后面，一条连接里合并各 harness 的会话列表、按会话归属路由请求、harness 可用与否有变化时发通知。`start` 会自动拉起并看着它，它起不来不影响各入口。聚合面只给声明了 `harness` 扩展的客户端用（握手时在 `capabilities.litchExtensions` 里列出），官方桌面端仍然连各 harness 自己的入口，行为不变。
- 新增设备配置接口（协议扩展 `deviceSettings`，经聚合面调用）：读写适配器的设置、重启某个 harness、运行诊断并拿到结构化的结果、读日志末尾、取给官方桌面端用的 ssh 配置片段。设置存在 `<状态目录>/device/settings.json`：每个 harness 是否启用、命令行路径、环境变量（密钥只写不读回），每个 SSH 入口是否开启和端口。`--ssh`、`--claude-port` 等启动参数成了“设置里没写过时的默认值”；没有设置文件时行为和以前一样，`env` 文件继续生效（优先级：适配器固定变量 > 设置 > 启动进程的环境 > `env` 文件）。需要重启才生效的设置不打断进行中的回合，有回合在跑时标成待重启。
- 聚合面的 `runtime/info` 列出这台机器上全部已知的 harness，没在跑的说明原因：已停用、没装、版本太低、启动失败、已退出。
- 一个 harness 都起不来时（什么都没装，或者全都没通过环境检查），`start` 不再退出，前提是聚合面给得出来：服务留着并打一行告警，客户端连上之后能看到每个 harness 没起来的原因，在设置里填好命令行路径后重试。`device-start` 这时以 0 返回。聚合面给不出来时照旧以“没有可用的适配器入口”退出。
- 常驻服务里，某个 harness 的运行时跑起来之后自己停了（崩了、被杀了）会自动再起：依次等 1 秒、5 秒、15 秒各试一次，这段时间 `runtime/info` 里它是“正在启动”，原因写明是自动重启、第几次；三次都用完还是停，就停在“已退出”并说明试过几次，等人重启。稳稳跑过两分钟、或者人来重启之后，次数重新算。没起来的（没装、版本太低、启动失败）不自动重试。此前运行时自己停了就一直停着，要人去点重启。
- 各引擎的 `runtime/info` 新增结构化的声明（原有字段不变）：`displayName`、`badge`、`extensions`（支持哪些我们自己的协议扩展）、`features`（能否引导、打断、压缩、分叉、回退，有哪几类审批，是否发待办进度和本回合差异，接受哪些输入等，每一位都有测试守着与实际行为一致）、`permissionPresets`（权限预设的标题、说明、风险等级、能否中途切换）。
- 新增协议扩展 `declineWithNote`：握手时声明了它的客户端，在 Claude Code 的命令与文件改动审批里可以答“拒绝并附一句说明”，说明会交给模型。Pi 和 dsh 不支持。没声明的客户端（官方桌面端）收到的审批请求和以前逐字段一致。
- 新增设备级的工作区（协议扩展 `deviceWorkspaces`，经聚合面使用）：聚合面上的 `project/*`、`threadSection/*`、`thread/section/move` 由设备进程处理，工作区、会话归属、自定义分区和置顶存在 `<状态目录>/device/device.sqlite` 里，同一个目录下各 harness 的会话归在同一个工作区。第一次启用时从各引擎现有的项目导入一次（根目录相同的合成一个），只读不改引擎自己的数据；删掉设备库会重新导入出同样的结果。各 harness 自己的入口（官方桌面端连的那些）仍用各引擎自己的项目，两边互不影响。
- 聚合面的 `runtime/info` 把各引擎自报的 `extensions`、`features`、`permissionPresets` 带在每个 harness 上；同一种引擎配了多份时徽标按标识区分；不可用的说明里不再带套接字路径。
- 新增协议扩展 `deviceProcesses`（经聚合面使用）：终端可以属于设备而不是属于连接，连接断开后继续运行，重连后按句柄挂回去并回放末尾的输出；可以列出、挂接、解除、结束、清除。不带扩展参数时 `process/*` 的行为不变。设备进程为此新增四个选项：`--process-buffer-bytes`（每个进程保留多少输出，默认 2 MiB）、`--process-limit`（同时最多几个，默认 32）、`--process-idle-ms`（没人挂接留多久，默认不过期）、`--process-exited-ms`（退出后的记录留多久，默认 10 分钟），设置里对应 `processes.bufferBytes`、`processes.limit`、`processes.idleMs`、`processes.exitedMs`，改了立刻生效，不重启任何东西，也不结束正在运行的终端。
- 聚合面上进程的输出加了按连接的流量控制：连接不读时设备进程不再无限占内存（此前伪终端里一条不停输出的命令 5 秒能涨到 1 GB），进程会被暂停，连接恢复后接着出。伪终端的碎输出在发给属于设备的终端之前先合并。
- 这台机器上装的 Codex 命令行可以作为一个 harness 接进聚合面（设置 `harness.codex.enabled`，默认关；要求 codex >= 0.157.1）：它的会话和别的 harness 的并排列出，能新建、跑回合，审批和提问照常来回。适配器起的是 `codex app-server --listen unix://<状态目录>/codex/runtime.sock`，用的是你自己的 Codex 数据目录，不碰它自己的常驻服务；同一个会话同一时间只能有一个 codex 进程在写，别处正用着的会话在这边恢复会被它拒绝。它没有 SSH 入口。
- 新增 `--ssh=on|off`（默认 `on`）：`off` 时不监听内置的 SSH 入口，也不生成 SSH 用的密钥和入口脚本。
- SSH 入口监听失败（例如端口被占）不再连带停掉引擎：只告警，端口空出来之后入口自己接上。
- 新增子命令 `version`、`device-start`（幂等地拉起常驻服务并等聚合面就绪；退出码 0 是可以连了，3 是这个状态目录上有一份不带聚合面的旧版服务在运行，1 是没起来）、`device-proxy`（把标准输入输出接到聚合面，给经 ssh 连过来的客户端用）。
- 仓库迁到 [slovx2/litch](https://github.com/slovx2/litch)，与桌面客户端 Litch 同仓；命令名、npm 包名、Homebrew 配方名都不变，旧仓库 `slovx2/codex-harness-adapter` 归档。Go 模块路径随之改为 `github.com/slovx2/litch`。
- 命令行输出支持中文和英文，默认跟随系统语言，用 `CHA_LANG=zh-CN` 或 `CHA_LANG=en` 指定，可以写在环境文件里。引擎经协议发到界面里的提示仍只有中文。
- 升级 `ws` 到 8.22.0。
- Pi 入口在等用户回答提问时，会话状态带上“在等用户输入”的标记（`thread/status/changed` 的 `waitingOnUserInput`），答完或取消后改回进行中；`thread/list`、`thread/read` 给出的状态同样带着。此前这段时间一直报普通的进行中，侧栏上看不出它停下来在等人。
- 修复 Pi 入口里“点开看一眼，会话就排到最前面”的问题：会话的最后更新时间改成按最后一条消息算。此前按会话文件的最后一条记录算，而计划模式扩展在会话每次打开、关闭时都会往文件里记一条自己的状态，于是只是在客户端里打开过的会话，更新时间也变成了“刚刚”。
- 修复 Pi 入口流式回答开头那段字在客户端上多出一遍的问题：`item/started` 里的回答条目不再带内容，字只由随后的 `item/agentMessage/delta` 给出，和推理条目、原生 codex 的做法一致。此前条目第一次出现时已经带着头一段字，而这段字紧接着又作为增量再发一遍，按“开始时的内容加上增量”显示的客户端会把开头显示两遍，到 `item/completed` 才改回来。
- 修复 Claude Code 入口提问里与“其他”有关的三个问题：模型自己写的 `Other` 选项选不上；用户自己填的字正好是 `Other` 时模型看到的是“没有回答”；计划确认时自己写的话被丢掉。提问请求改用标准的 `isOther` 表示“选项之外可以自己写”（和原生 codex 一致），不再在每道题末尾补一个 `Other` 选项，选项和答案原样往返；计划确认时只写了话、没选“执行计划”的不算确认，但话会原样交给模型；选了“执行计划”同时又带了话的算确认，话作为执行时的补充并进计划交给模型。
- 写设置（`litch/device/settings/write`）的应答现在等事情定下来才回：要顺手重启的 harness 等到它有了结果，SSH 入口等到它听上或者说明了原因。应答里就是最后的状态；这次写入只发一条 `litch/device/settings/changed`，在应答之前。此前应答和通知里带的是途中的样子（先标成待重启又摘掉、SSH 入口没了又回来）。
- 聚合面 `thread/list` 的 `skippedHarnesses` 现在也列出停用的、没装的 harness，并带原因分类 `kind`（和 `runtime/info` 的 `unavailable.kind` 同值）。
- 设置结构里启用项带显式标记 `role: "enable"`，界面按它认标题行上的开关。
- 带工作区的新建会话迟迟没有应答时，被扣着的 `thread/started` 最多扣 30 秒就放出，不再一直扣着。
- harness 没装时的提示只提它自己的环境变量，并说明可以在设置里填命令行路径；各 harness 的显示名只有一个出处，dsh 那一个统一为 “DeepSeek Harness”（此前引擎自报的是 `dsh`，设置里的标题是 DeepSeek Harness）。
- “没有可用的 harness”的提示改为 `codex-harness-adapter doctor`（从源码运行时是 `npm run doctor`）。
- 新增子命令 `device-stop`：平稳停掉常驻服务并等它退出。带 `--if-idle` 时，有回合在跑、有属于设备的终端在跑、有客户端连着都不停，并说明是哪一种。这之前的服务不认识这条命令，那一次要手工结束。
- 常驻服务报自己是哪一份（版本、根目录、启动时间）：在 `device/service.json`、`device-start` 的就绪行里，以及握手时声明了 `deviceService` 扩展的客户端的 `runtime/info` 里。
- Litch 连本机时，后台在跑的服务比应用自带的旧而且闲着，就换成自带的那一份；忙着的、前台运行的、更新的都不动。
- 不带 `--node` 时默认用适配器旁边随包带的那份 Node（有的话）。
- `install.sh` 升级之后提示用 `device-stop --if-idle` 再 `device-start` 换上新版。
- 修复状态目录的路径里有空格或非 ASCII 字符时（主目录是带空格的全名、中文用户名的机器上默认就是这样）聚合面连不上各引擎的运行时、Litch 连不上聚合面的问题：套接字的路径此前被写进 `ws+unix://` 地址里，空格和中文会被转义成 `%xx`，按转义后的路径去连就是“没有这个文件”。
- 一个会话可以同时被多个客户端（或同一客户端的多个窗口）订阅：每条订阅连接都收到会话的通知；审批、提问、MCP 征询发给全部订阅连接，先答的生效，其余连接收到 `serverRequest/resolved`。此前 Claude Code 入口上后来的连接会顶掉先来的，Pi 和 dsh 的审批与提问只发给一条连接。只有一个客户端连着时行为不变。
- 修复 Claude Code 入口上，回合刚开始的那一小段时间里切换权限档，这一回合的写文件全被当成越界拒掉、也不询问的问题：回合用的沙箱策略此前比审批策略、权限模式读得晚，中间隔着一次取 diff 基线的等待（在真的 git 仓库里更长），切换正好落在里面时两边对不上。
- 修复 `fs/watch` 监视一个还不存在的路径时，路径上的几层目录被一口气建出来，之后目标出现却没有通知的问题：把监视往下挪的当口路径又往前长了，监视就一直停在上一层。
- 新增独立发布包与安装脚本（Linux x64、arm64 和 macOS Apple Silicon）：发布包自带 Node，机器上不用另装 Node 和 Go；`install.sh` 装到用户目录（不要 root），支持升级、退回旧版本和卸载，当前的之外保留最近 4 个版本，不动状态目录，也不替用户重启正在运行的服务。需要 glibc；musl 的系统在安装前给出说明。Homebrew 的安装方式不变。
- 新增：Pi 可以在动手之前先问你。设备设置里 Pi 那一组多了“动手之前先问”（`harness.pi.approvals`，默认关，改了要重启 Pi 的运行时）。打开后，主会话里运行命令、写文件、改文件、调用没有标成只读的 MCP 工具和扩展工具、启动子代理之前先发标准的审批请求；可以允许这一次、这个会话里同类的都允许、拒绝（可以附一句说明）、取消并停下回合。两条限制：子代理里的操作不问；这不是安全边界，Pi 没有沙箱。
- 终端不再需要 python3：macOS 和 Linux 上带终端的命令和进程改由命令行自带的 `pty-bridge` 子命令来起（Windows 上本来就是），`scripts/pty-bridge.py` 已删除。运行时制品里多了 `bin/codex-harness-adapter`，打制品的机器要有 Go。行为上的差别：起不来时的报错文案变成“<命令>: <原因>”；命令不再继承到“忽略 SIGPIPE”；输入堵住时也能立刻结束。
- DeepSeek Harness 入口：和 dsh 之间的连接出问题时（连不上、连接被对面关掉），报错里带上连接层的原因（如 `ECONNREFUSED`、`other side closed`），不再只有一句 `fetch failed`。
- 修复 Claude Code 入口：后台命令结束后 CLI 自行续跑的回合，如果开始那一刻订阅着线程的连接随后退订了，回合内容和确认请求还会接着发给它（它已经不看这个线程，请求等于没人答）。现在这类回合的通知和请求只按线程当时的订阅连接送；一条都没有时请求留着，等有连接订阅再送。
- 修复 Pi 入口上选了技能又写了话发出去时技能没有展开的问题：排在开头的技能和后面的话之间改成隔一个空格（`/skill:名字 后面的话`）。此前用换行连，而 Pi 认技能的名字只认到第一个空格，换行连同后面的字都被算进了名字里，找不到这项技能，整句原样当成一句话发给了模型。只发技能、不带话的和以前一样。
- Pi 入口：回合里计划模式自己变了（计划写好之后，用户在计划插件的那一问里选了就地实施，插件退出了计划模式），回合结束时发一条 `thread/settings/updated` 告诉订阅着的客户端，和 Claude Code 入口在模型退出计划模式时的做法一样。此前只把新状态记在会话上，客户端的计划模式开关还开着，要重新载入会话才对得上。
- 修复 Claude Code 入口上选了技能（或者自己打了斜杠命令）又带图片发出去时技能没有展开的问题：带图片的消息是按内容块发给 CLI 的，CLI 这时只拿最后一块文本去认斜杠命令，而适配器把文本排在了图片前面，整句原样当成一句话发给了模型。现在斜杠命令开头的文本排到图片后面，别的话照旧排在图片前面。不带图片的不受影响：技能和后面的话用换行连，CLI 认得。
- DeepSeek Harness 入口：`skills/list` 列得出技能了。此前这个方法写死返回空清单，桌面端在 dsh 的会话里打 `/` 一项技能也没有。清单问的是 dsh 自己，列出来的就是能用 `/名字` 点名的那些：项目里的 `.dsh/skills/`、`.agents/skills/`（项目根是往上第一个带 `.git` 的目录），用户的 `~/.agents/skills/`，同名时项目的优先；元数据里写了 `user-invocable: false` 的不列。每项带名字、说明、文件位置和来源范围；dsh 没有逐项的开关，`enabled` 恒为真。技能文件增、删或改了说明，问过清单的连接会收到 `skills/changed`（适配器每两秒向 dsh 问一遍比出来的）。选了技能的消息照旧化成单独一行的 `/名字` 交给 dsh，带图片、回合中插话时也展开。两点要知道：适配器给 dsh 用的是自己的状态目录，`~/.dsh/skills/` 里的技能读不到；dsh 的技能清单只能按会话问，适配器为每个问过技能的工作目录在 dsh 里留一个从不发消息的会话（会话号以 `session-skills-` 开头，不出现在线程列表里，dsh 没有删除会话的接口）。
- 三个引擎的入口（Claude Code、Pi、DeepSeek Harness）现在照握手里的 `capabilities.optOutNotificationMethods` 办：客户端列出的通知，这条连接上之后不再发，和原生 codex 一样按方法名精确匹配、按连接各记各的；应答和服务端发起的请求（审批、提问）不受影响。此前只有聚合面处理这份名单，官方桌面端握手时退订的通知里各入口会发的那几种（`warning`、`thread/closed`、`thread/reverted`、`thread/compacted`、`project/changed`、`thread/project/updated`、`command/exec/outputDelta`、`turn/diff/updated`）照发不误。握手时不带这份名单的客户端收到的内容不变。
- 修复 DeepSeek Harness 入口上项目用不了的问题：`project/list`、`project/create` 等一调就回内部错误（`no such table: threads`），带着项目新建会话则是 dsh 那边的会话已经建好了才失败。共用的项目存储此前直接查适配器库里的会话表，而 dsh 的会话在 dsh 自己手里、库里没有这张表；现在由各入口告诉它会话在不在、最近什么时候动过。项目的建、列、读、改、排序、删、导入都能用，项目的最近活动时间按 dsh 现有的会话算（不算归档了的）；`thread/metadata/update` 的 `projectId` 现在真的改会话的归属（空串是拿出来），此前只把会话原样回一遍。Claude Code、Pi 入口和聚合面的项目行为不变。
- 修复 DeepSeek Harness 入口上回合刚开始就打断不生效的问题：`turn/start` 的应答一到就发 `turn/interrupt`（消息刚发出去马上点停止）时，回合照常说完、以 `completed` 结束。回合是适配器先建的，提示词随后才交给 dsh，而 dsh 的取消只停正在跑的回合，取消先到了就什么都没停。现在打断会等提示词交到 dsh 再取消，回合以 `interrupted` 结束；停得够早时这一回合不会向模型发请求，dsh 的会话里也不留下这句话（它在回合的第一步开始时才记用户的话）。
- Claude Code 入口：MCP 工具调用的条目（`mcpToolCall`）现在报的是那个 MCP 服务的名字和不带前缀的工具名（比如 `server: "forms"`、`tool: "ask_form"`），实时的和重读历史的一样。此前服务一律是 `claude-code`，工具是带前缀的全名（`mcp__forms__ask_form`）。Claude Code 自带的工具照旧记在 `claude-code` 名下；这之前存下的历史条目不改。
- Claude Code 入口：用户级配置（`.claude.json`）里的 MCP 服务每个回合只连一份。此前适配器桥接一份，Claude Code 又照自己的配置连一份：stdio 的服务就是多起一个进程，活到回合结束，工具调用从不落到它身上。
- Claude Code 入口：MCP 工具调用的审批改成原生 codex 的形状。请求从 `item/fileChange/requestApproval` 换成 `mcpServer/elicitation/request`：表单为空，`serverName` 是那个 MCP 服务，`_meta` 里带 `codex_approval_kind: "mcp_tool_call"`、`persist: "session"` 和调用的参数（`tool_params`、`tool_params_display`）。客户端答 `accept` 放行这一次，带上 `_meta.persist: "session"` 则这个会话里这个工具不再问（按服务和工具记，不分参数）；`decline` 拒绝这一次；`cancel` 停掉回合。此前这类审批看上去是一次“文件改动”，没有服务名、工具名和参数，“这个会话里都允许”选了也不起作用。Claude Code 自带的工具的审批不变。不认识 `codex_approval_kind` 的客户端会把它当成一张没有栏目的 MCP 表单：提交是放行，拒绝是拒绝。这类审批里没有“拒绝并附说明”。
- Claude Code 入口：握手时退订了 `mcpServer/startupStatus/updated` 的连接（`capabilities.optOutNotificationMethods`），握手之后不再为它把配置里的每个 MCP 服务连一遍。那一遍的产出只有这一种通知，不看它的客户端退订之后，每次连接少起一份。
- 修复 Claude Code 入口：在客户端这边停用的用户级 MCP 服务（`mcp_servers.<名字>.enabled = false`）仍会被 Claude Code 自己连上、工具照样交给模型的问题。
- 修复 DeepSeek Harness 入口上停服务时可能丢掉刚完成的回合的问题：回合刚结束就停适配器（`device-stop`、停后台服务、前台运行时按 Ctrl+C），重新打开会话，那一回合有时是“被打断”，结尾的内容没了。dsh 只认头一个结束信号，收场途中再收到一个就丢下收尾立刻退出，还没落盘的内容就丢了；而主进程停运行时是给整个进程组发信号（dsh 已经收到），适配器收场时又给它发了一个。现在适配器对一个 dsh 至多发一次：先看它是不是已经在收场（它收场的头一件事是断开和适配器的连接），是就只等；dsh 自己先被结束时也不再补发。等它收尾的时限从 3 秒改成 6 秒（适配器自己被要求退出时 4 秒，主进程给运行时的时限是 5 秒），到点才强杀：dsh 平时不到 0.1 秒就收完，系统忙时要几秒，此前会在它还没收完时把它强杀。回合刚完成时照主进程的做法停 30 次，此前每次 dsh 都收到两个信号、有 3 次丢了那一回合，现在每次只收到一个、没有丢的。
- 修复 DeepSeek Harness 入口上回合刚开始就插话时两句话先后颠倒的问题：`turn/start` 的应答一到就发 `turn/steer`（消息刚发出去紧接着又补一句）时，后补的那句成了这个回合的开头，原来那句排到后面另起了一个回合。原因和上一条“回合刚开始就打断不生效”一样：插话先于提示词到了 dsh。现在插话等提示词交到 dsh 再发，并进同一个回合、排在原来那句后面；提示词没交成的回合上插话回“指定回合与活动回合不一致”。
- 修复 DeepSeek Harness 入口上带着不存在的项目新建会话（`thread/start` 的 `projectId`）时，请求被拒绝了、dsh 里却留下一个空会话的问题：现在先核对项目再建会话。
- 修复 DeepSeek Harness 入口上没说过话的会话在适配器重启后出现在线程列表里的问题：会话建好之后很快（一百毫秒之内）就停了适配器时，重启后这个空会话会进 `thread/list`。dsh 给的“空白”标记出自它的缓存，缓存里没有这个会话时它一律报成不空白；现在这种会话另问一次 dsh 再定，没说过话的不列（和原生 codex 一样），说过话的照列。
- DeepSeek Harness 入口：dsh 自己没办成的事不再说成“接口不兼容，请换用验证过的版本或升级适配器”。比如新建会话时工作目录那个位置是个文件、会话建不出来，此前报的是版本不兼容，现在报 dsh 的原话（`session/create: failed to create session …`）。只有方法、参数、返回结构和 dsh 的接口对不上时才提版本。
- 修复 DeepSeek Harness 入口上 dsh 起来了却连不上时（接口对不上的 dsh）每次请求都另起一个 dsh、前面的没人收的问题：没连上的那个现在当场结束，下一个等它退出再起。
- 修复 Pi 入口回答越长越卡的问题：流式输出每来一小段，适配器此前都把整个回合重新写一遍库，一小段的开销随回答已有的长度涨，整个回答下来是平方级的。实测一个一万段、四十万字的回答，运行时光处理这些增量就要 17 秒的 CPU，客户端从发出消息到收完要 18 秒；三万段、一百二十万字的是将近三分钟。运行时只有一个线程，这期间同一个运行时上别的会话也得等。现在增量只记一笔，等有人读这个会话或者回合有了别的动静才写，一小段的开销不再随长度变（上面两种分别降到 0.3 秒和 0.9 秒），思考内容同样。客户端收到的通知、流到一半时读会话或者重连拿到的内容、回合结束后存下的内容都和以前一样；只有进程被强杀时，最后一次写库之后流出来的那一截不在适配器的库里。模型用工具写很长的文件时仍然会越写越慢：那一部分花在 Pi 自己每来一段就把累计的参数重新解析一遍上，适配器这头绕不开。
- 修复 Claude Code 入口回答越长越卡的问题，和上一条是同一类，而且更重：流式输出每来一小段，适配器此前都把整个回合从库里读出来两遍、再整个写回去一遍（思考是读三遍），一小段的开销随回答已有的长度涨，整个回答下来是平方级的。实测一个一万段、四十万字的回答，入口进程光处理这些增量就要 63 秒的 CPU，客户端从发出消息到收完要 68 秒，而模型那头不到半秒就说完了；同样长的一段思考是 92 秒的 CPU、130 秒收完。入口只有一个线程，这期间同一个入口上别的会话也得等。现在增量只记一笔，等这个回合下一次被读或被写（模型开始说下一条消息、来了工具调用、回合结束或被打断、有人读这个会话）才写进去，一小段的开销不再随长度变：上面两种都降到不到 1 秒的 CPU，一秒多收完；三万段、一百二十万字的回答是 2 秒的 CPU。客户端收到的通知、流到一半时读会话或者重连拿到的内容、回合被打断或服务正常停下之后存下的内容都和以前一样；只有进程被强杀时，最后一次写库之后流出来的那一截不在适配器的库里。模型用工具写很长的文件时本来就不受影响（Claude Code 处理流式参数的开销不随长度涨）。
- 修复 Pi 入口上输出很长的命令还在跑的时候，客户端里同一段输出一遍遍重复的问题。命令的输出超过 Pi 保留的量（末尾 2000 行或 50KB）之后，Pi 给适配器的是末尾的一个往后滑的窗口，适配器此前把整个窗口当成“新增的一段”（`item/commandExecution/outputDelta`）发出去，把增量接起来显示的客户端看到的就是窗口一遍遍叠上去，到命令结束才改回来；实测一条慢慢出一万二千行的命令，增量加起来是实际输出的三倍多。现在每条增量只是真正新增的那一段，接起来就是命令的输出；命令一开始的那条空增量也不再发。两份快照之间输出得比窗口还多时（100 毫秒里超过 2000 行或 50KB），中间那些 Pi 没有给，客户端接起来的内容在那里另起一行、直接跳到新的窗口。命令结束时条目里的输出没有变，仍然是 Pi 给的末尾窗口加一句说明（全文在它说的那个文件里）。
- 修复 Pi 入口上回答流到一半时打开或恢复会话，可能有一段字出现两遍的问题。Pi 事件里带的消息会比事件本身超前（平时超前一小段；装了在 `message_update` 里做异步事情的 Pi 扩展时可以超前一大段），适配器此前把超前的内容也记进了回合，这时读会话（`thread/read`、`thread/resume`）拿到的比已经发出去的增量多，客户端接着收增量就把多出来的那一截又显示一遍，到条目完成才改回来。现在回合里的内容总是正好等于已经发出的增量。正文条目的 `item/started` 也不再抢在思考的最后几条增量前面。
- 修复 DeepSeek Harness 入口上新建的会话没有模型的问题：`thread/start`、`thread/resume` 的应答里 `model` 是空串、`reasoningEffort` 是空，客户端的模型和强度选择器在会话里没有选中项。dsh 只在会话发过请求或者选过模型之后才记它用的是哪个，新会话到发请求时用的是 dsh 当时的默认。现在应答和 `thread/settings/updated` 里报的是这个会话实际会用的模型和强度：没选过的是 dsh 的默认（和 `model/list` 里 `isDefault` 的那一项一致，强度是那个模型自己的默认强度），选了、用了之后跟着变，会话对象上的 `modelProvider` 也和它一致。要知道的一点：dsh 的默认不是固定的，在任何会话里选一次模型它都跟着变成那一个，之后没指定模型的新会话用的就是它。只改强度、不带模型的回合（`turn/start` 只带 `effort`）在没选过模型的会话上此前会失败（“模型格式必须为 provider/model”），现在按会话本来会用的模型改强度。
- 修复 DeepSeek Harness 入口上带图的用户消息回显里没有图的问题：`item/completed` 和 `thread/read` 里那条 `userMessage` 的内容只有文字，客户端的气泡里没有缩略图（模型是收到图的）。dsh 的会话记录里图片只有它另存的附件号；现在适配器把客户端发来的输入原样记一份（在适配器自己的库里，按会话和提交标识），实时的回显和重读历史时用户消息的内容就是它：带地址的图片（`image`）还是那个地址，本地文件（`localImage`）还是那个路径，回合中插话带的图也一样。这一份没有的时候（适配器的库丢了，或者升级之前发的消息）照 dsh 的记录来：图片按附件号从 dsh 取回，一律是带地址的图片（dsh 收图时可能缩小、转码过，不一定是原件；本地文件的路径没有了）。
- 修复 DeepSeek Harness 入口上点了技能的那句话成了字的问题：回显和重读历史里是一段“/名字”打头的字，线程列表的预览也是，标题还没生成或者没生成成的会话名字是“/名字 ……”（dsh 的兜底标题，头一句开头的几个词）。现在回显和重读历史里是一项技能加那句话（同上一条，按记下的原样）；预览是用户自己写的字（只点了技能、一个字没写的才是“/名字”）；dsh 的兜底标题不当会话的名字，也不发 `thread/name/updated`，没有名字的会话客户端显示的是预览，dsh 的模型起了标题、用户改了名照旧是名字。交给 dsh 的照旧是“/名字”。适配器的库丢了时技能认不回来，是交给 dsh 的那一句、名字是 dsh 的兜底标题：不照字去猜，那会把用户自己写的“/名字”也当成技能。
- DeepSeek Harness 入口接上向用户提问：模型调 dsh 的提问工具时，此前适配器不应答，模型拿到“没有人应答”的报错，客户端什么也看不到（入口声明的也是不支持）。现在转成 `item/tool/requestUserInput` 问客户端，选的、自己写的、跳过的都交回 dsh 给模型；工具调用是一个动态工具条目，结束时每道题一行答案，重读历史一样。`runtime/info` 里 dsh 的 `userInput` 改为支持。协议的题上没有多选的标记，dsh 的多选题到客户端和单选题一个样子（和 Claude 入口一样）。没有连着的客户端、拿着请求的连接都断了时，模型照旧拿到“没有人应答”、接着往下做；等回答时打断回合，提问随回合收场，不替用户作答。计划模式仍然没有接。
- 修复 DeepSeek Harness 入口的提问在官方桌面端上丢答案的问题：一次提问里既有带选项的题、又有没有选项（自己写）的题时，在官方桌面端选的那一项到不了模型手里，模型看到的是那道题没有回答；后面那道跳过时整批都是空的。原因在桌面端的提问卡片：同一张卡片里从带选项的题翻到没有选项的题，它会清掉前一题的选择。现在这种提问按先后拆成几张卡片（连着的带选项的题一张、连着的没有选项的题一张），挨个问完再一起交给模型；题都带选项、或都没有选项的，照旧一张卡片。另外，模型给的题号重复、为空或者是 `__proto__` 时，此前几道题的答案会串到一起或者丢掉；现在适配器给这几道另起题号，交回模型的还是它自己的题号，逐题对上。
- 修复 Pi 入口带技能的消息回给客户端的是展开后的技能正文的问题：回显的用户消息、读历史（`thread/read`、`thread/resume`）里都是一大段 `<skill name=… location=…>…</skill>` 加上那句话，会话头一句就带技能时预览（侧栏的标题）也是这串。现在三处都是客户端发来的样子（技能是一项 `skill`，话是话，带着客户端给的 `clientId`），预览只算话里的字（和上游一样）；发给 Pi 的仍是 `/skill:名字 话`，模型照样收到技能的正文。依据是适配器自己记下的那一份：带技能的消息，客户端发来的样子记在原生会话里这个回合（或这条插话）的标记条目上，分叉、回退时跟着走；不从 Pi 存下的正文里认，用户自己在话里写一段同样格式的 `<skill …>` 照原样显示。这之前的会话、在 Pi 自己的命令行里用技能说的话没有这份记录，照旧显示展开后的正文。
- 修复 Pi 入口提问（`item/tool/requestUserInput`）的小标题是题目前 12 个字的问题：计划插件那一问的小标题是 `Proposed pla`，题目短时小标题和题目一字不差。`header` 在上游是界面上的短标签，Pi 的扩展提问时只给一个题目、没有单独的标签，现在留空（协议里它是必填的字符串；上游的界面这时用题目，Litch 显示一句通用的话）。
- 修复 Pi 入口上会话太小时手动压缩（`thread/compact/start`）留下一个“出错”回合的问题：Pi 判断没什么可压（`Nothing to compact (session too small)`）、刚压过（`Already compacted`）时不压，此前入口照样开了回合、再把它记成失败，历史里多一个出错的回合。现在 Pi 定了要压才开回合；它不压时不开回合，它的原话作为这个请求的错误（-32600）回给客户端，历史里什么都不留。真的压缩出错（模型请求失败之类）照旧是这个回合失败。
- Pi 入口：计划插件交了计划之后问的那一句不再列“Start fresh and implement”（新开一个会话去实施）。这一项要插件自己开新会话，入口不支持，此前选了只弹一句 `Unable to start a fresh implementation session: 请通过客户端会话入口操作`，计划原样留着；发 `/plan` 打开的菜单里同样拿掉，题目里讲这一项的那行说明（`Start fresh transfers only the approved plan to a new session.`）也一起拿掉。其余五项（就地实施、导出、留着以后用、留在计划模式、丢掉退出）逐项走过，都走得到头。
- 修复 Pi 入口上计划插件不肯进计划模式时回合照默认模式跑下去的问题：在菜单里选了“Save for later”之后，插件在这份计划处理掉之前不让再进计划模式（`A plan is saved for later. Implement or clear it before starting another Plan-mode workflow.`），此前入口只转发这句提示，回合照默认模式跑，模型能改文件。现在要的模式没切过去时这个回合不跑、不请求模型，插件的原话作为回合的错误。存着的计划要发 `/plan` 打开插件的菜单处理（实施或清掉）。
- 修复 Claude Code 入口上用户拒绝的命令显示成执行失败的问题：审批里答了“拒绝”（带不带说明都一样）或“拒绝并停下”之后，命令条目此前是 `status: "failed"`、`exitCode: 1`、输出是给模型看的 `denied by user`，界面上像一条退出码为 1 的失败命令。现在照上游 app-server 记成 `status: "declined"`，没有退出码、输出和时长，在答复的当时就收尾；文件改动同样是 `declined`。实时的 `item/completed` 和 `thread/read` 读回的一样。模型那头不变：照旧收到拒绝，带的说明照旧交给它。协议里没有“已拒绝”状态的条目（MCP 工具调用、Claude Code 自带的其余工具）照旧是失败，原因在 `error` 里，上游也是这样。
- 修复 Claude Code 入口上模型交计划（ExitPlanMode）时出两条工具条目的问题：同一次调用此前既有一条 `mcpToolCall`（`claude-code` 的 `ExitPlanMode`），又有问用户“执行还是继续规划”的那条 `dynamicToolCall`，界面上是两行“调用 ExitPlanMode”，选“继续规划”时前一条还是“失败”。现在和 AskUserQuestion 一样只有提问的那一条，选“继续规划”不是失败。
- 修复 Claude Code 入口上选“继续规划”之后模型接着说的话并进了计划条目的问题：此前计划模式里模型说的一切都进 `plan` 条目，交计划后用户没放行、还在计划模式里，模型的回话就接在计划正文后面，回合里没有单独的回答，`thread/read` 读回来也一样；计划写进计划文件之后再说的话同样会接到文件内容后面。现在计划交出来（写进计划文件，或者调 ExitPlanMode 请用户确认）之后这一回合里说的话是单独的 `agentMessage`，计划条目在问用户之前就收尾，里面只有计划。
- 修复 Claude Code 入口上手动压缩（`thread/compact/start`）的回合里多一条空回答的问题：回合里此前除了 `contextCompaction` 还有一条 `agentMessage`，`item/started`、`item/completed`、`thread/read` 里都是空串，界面上多出一块空的回答。现在回答条目等 CLI 真的说了话才建，手动压缩的回合里只有压缩条目（上游也是）。子代理最后什么也没说（只有空白）时，子线程里同样不再留一条空的回答。
- 修复 Claude Code 入口的命令审批没带目录的问题：`item/commandExecution/requestApproval` 的 `cwd` 此前是空串（Claude Code 的 Bash 工具参数里没有目录），审批卡片上没有“在哪个目录里跑”。现在是这条命令要跑的目录，和同一条 `commandExecution` 条目上的 `cwd` 一样。
- 修复 Claude Code 入口上会话的模型在 `model/list` 里找不到的问题：`CHA_CLAUDE_DEFAULT_MODEL` 写的是 Claude Code 认、但不在它自己模型清单里的写法时（比如完整型号 `claude-sonnet-4-6`，或者文档里举例的 `opus`——2.1.282 的清单里只有 `opus[1m]`），新会话报的是这个模型，`model/list` 里却只有原生清单的那几行，客户端的模型选择器没有选中项，强度选择也没了；`thread/start` 显式带了清单之外的模型也一样。现在 `model/list` 在原生清单之后给配置的默认模型补一行（标成默认），没归档的会话用着的清单之外的模型也各补一行；只是大小写不同的按清单里的写法记。交给 CLI 的模型不变。
- Claude Code 入口的测试不再往本机共用的 `/tmp/claude-<uid>/` 里留东西。Claude Code 的这个临时根不看 `TMPDIR`，后台命令的输出、贴进来的图、文件监视的探针都写在下面，此前跑一遍子代理、后台命令、带图的用例就多出一批目录，测试的临时目录删了它们还在。现在起 CLI 的测试夹具都带 `CLAUDE_CODE_TMPDIR`，指进用例自己的临时目录。适配器平时起的 CLI 不变，仍用 Claude Code 自己的默认位置。
- Litch：命令的输出很长时只留开头和末尾。此前一条狂打日志的命令有多少输出，客户端的核心进程和界面就各留多少，切走再切回来还要把整份重发一遍；实测 24 MB 的输出，核心进程涨到 380 MB 上下，展开着看的界面进程涨到 4 GB 多、每一帧要 1 秒上下。现在每条命令最多留 8 万字上下（开头 1.6 万字，末尾 4.8 万到 6.4 万字），中间省掉的地方单独一行写明省了多少（按字节算），切的地方尽量落在行与行之间；边跑边看、打开历史会话、断线重连之后看到的是同一个样子。同样 24 MB 的输出，展开着看时帧间隔在 10 毫秒上下，核心进程最高 110 MB 上下、界面进程 250 MB 上下（开始前分别是 70 MB 和 210 MB）。只是客户端里省掉，引擎和模型那边的输出不受影响。
- 修复 DeepSeek Harness 入口上等审批、等回答时，客户端侧栏偶尔没有“等你”记号的问题：只在开始等的那一刻发一条带标记的线程状态，别处报的状态（`thread/read`、`thread/list`、`thread/resume` 给的会话对象，回合开始时的通知）都是“在跑、没在等”，客户端等着的时候重读或者重列一次会话，标记就被盖掉了；同时等着两件事时，先等完的那件会把标记整个去掉。现在按正在等的审批和提问现算，各处报的一致，最后一件等完才去掉，和 Pi 入口、上游一样。
- 修复 Litch 里 Claude Code 写的文件点“在差异里看”说“这个文件现在没有没提交的改动”的问题（macOS，工作目录在 `$TMPDIR` 或 `/tmp` 下时）：macOS 上 `/var`、`/tmp`、`/etc` 是指向 `/private/…` 的系统链接，Claude Code 给的是解开链接之后的路径（`/private/var/…`），工作区的根是用户给的写法（`/var/…`），客户端此前只按字面比，就当成了工作区外面的文件。现在设备是 macOS 时这三处的两种写法算同一个目录（设备是 Linux 等别的系统时照旧只比字面），认出来的路径一律换成工作区根的写法：差异里定位文件、本回合差异的路径、对话里能点开的文件路径、文件面板读文件和找文件、文件面板“加入对话”的相对路径、侧栏的工作目录记号、会话归到哪个工作区都按这个规矩。别的符号链接不猜。
- 修复 Claude Code 入口给用户打断的回合带了一句 `interrupted` 当错误的问题：`turn/completed` 和读历史（`thread/read`、`thread/resume` 等）里被打断的回合 `error` 现在是 null，和上游一样（用户打断不是出错）；Pi、DeepSeek Harness 入口本来就是 null。此前 Litch 照着这句画了一个红色的出错框。Litch 也改成照官方桌面端只给失败的回合画回合级的出错框：被打断的回合对面就算带了错误也只在结尾写“已中断”，此前存下来的那些回合重新打开时也不再出框。

## 0.5.1

- 修复 Claude 与 Pi 入口“从旧位置分叉”得到的对话与原对话完全相同的问题：`thread/fork` 现在按 `lastTurnId` / `beforeTurnId`
  截断，分叉里只保留该位置之前的回合，之后发给模型的历史也只含这些回合，源会话不变。此前这两个参数被忽略，总是整份复制，
  而桌面端在这种情况下不会再补发回退。分叉到第一条消息之前得到空会话；两个参数同时给、或所指回合不在会话当前历史里时拒绝。

## 0.5.0

- Claude 的后台命令（`run_in_background` 的 Bash）跨回合存活：回合结束时还有后台命令在跑，Claude 进程就留下，
  后面的回合接着用同一个进程；桌面的后台终端列表、单个停止和全部清理在没有回合进行时也可用，
  命令条目在命令真正结束时才收尾。
- 后台命令自己结束后，Claude 会自行续跑一轮处理结果，界面上显示为一个没有用户消息的新回合；
  这期间发来的消息并入该回合。没有客户端在看这个会话时回合照常执行并保存；遇到需要用户确认的调用，
  回合停在那里一直等，客户端连上并打开这个会话后收到确认请求，答复后继续。
- Claude 入口需要用户确认或回答的请求（命令与文件审批、权限请求、提问、回合里的 MCP 征询）不再因为客户端断开而失效：
  此前回合进行中客户端掉线，已经送达的请求会被当作拒绝，掉线之后才产生的请求则没有人收得到、回合一直卡住；
  现在请求一直留着（不设超时），会话显示为等待批准，客户端重新连上并打开会话后原样送达。
  打断回合、归档会话或适配器退出才会取消；等待期间不受“全部客户端断开后保留多久”的限制。
- 打断回合不再连带停掉后台命令（还在排队的追加指令一并取消）。改工作目录、MCP、工具或指令配置，以及回退、归档、删除会话会结束 Claude 进程并停掉后台命令
  （有提示说明）；改模型、推理强度、计划模式不会。
- 新增 `CHA_CLAUDE_KEEP_ALIVE_SESSIONS`（同时保留后台命令的会话数上限，默认 8，设为 0 则回合结束即停止后台命令）
  与 `CHA_CLAUDE_KEEP_ALIVE_DETACHED_MINUTES`（全部客户端断开后保留多久，默认 30，0 表示一直保留）。
- 修复 Claude 后台命令变成孤儿进程的问题：此前回合结束、适配器退出或崩溃时，后台命令会脱离管理继续运行。
  现在 Claude 进程无论怎样结束，它名下的后台命令都会被清理。
- Claude 回合结束更快：此前被强制结束的 Claude 进程会留下配置文件锁，之后每个回合收尾要多等一秒左右。
- Pi 入口不再自带 Pi 本体，改为加载用户安装的 Pi（`PATH` 中的 `pi` 或 `PI_CLI`），只要求版本不低于 0.99.1；
  升级 Pi 后重启适配器即可生效。Pi 需用 npm 安装，独立二进制不含可加载的运行时。
- 计划模式、子代理和界面组件插件继续随适配器分发；Homebrew 安装中 Pi 部分的依赖从约 295 MB 降到约 14 MB。
- 找不到 Pi、Pi 不是 npm 安装、版本过低或接口与适配器不兼容时，`doctor` 和启动检测给出对应的处理提示，其他入口不受影响。
- 新增实验性的 DeepSeek Harness 入口（`--harness dsh`，默认端口 7333）：使用用户安装的 `dsh`（`PATH` 或 `CHA_DSH_CLI`，
  不低于 0.2.0-rc.2），支持线程列表、发消息、逐字流式输出、提权审批、中断和历史回放；密钥只读取 `DEEPSEEK_API_KEY`，
  会话日志上传默认关闭。本机装有 dsh 时随默认启动一并带起，没装时不提示；其余能力与限制见配置文档。
- DeepSeek Harness 入口在桌面端的表现：新线程的标题由 dsh 生成后推给桌面，不再停在首条消息原文；边栏不再出现以项目路径
  为标题的空条目，dsh 的会话存储里也不再留下空会话（桌面端生成标题用的临时线程只存在于适配器内存里）。命令条目带执行时长，
  `thread/resume` 支持 `excludeTurns`；桌面端会调用而 dsh 没有对应能力的方法明确答复"不适用"，不再报方法不存在。
- Claude 子代理在后台运行时，主回合等到子代理真正结束再收尾，子代理的结果不再丢失；等待期间主回合的输出照常显示。
- Claude 子代理的正文、思考和工具调用显示在它自己的子线程里；结果不再带 CLI 的内部说明文字。
- 可以在已结束的 Claude 子代理子线程里继续追问：消息经主会话原样转给该子代理，子代理带着此前的上下文作答。
  主任务运行中、工作流子代理不支持；追问进行中主线程不能开始新回合。
- Claude 子代理的子线程不再标成临时线程：在桌面端于子代理运行中打开它的子线程，之后的内容、追问的回答和结束状态
  都能显示出来；此前画面停在打开那一刻，线程摘要里一直显示运行中。
- `thread/list` 对子代理线程的处理与 Codex 一致：普通列表不返回，按来源或按父线程、祖先线程查询才返回；
  同时给出 `parentThreadId` 与 `ancestorThreadId` 时报错。子代理线程的昵称创建后不再变化，各处显示同一个名字。
- 声明 2019-09 或 2020-12 草案的 `outputSchema` 不再让 Claude CLI 启动失败，桌面端给新线程起标题的回合因此恢复正常
  （此前一律以“Claude Code process exited with code 1”失败，标题只能取首条消息）。交给 CLI 前换成 draft-07 的等价写法；
  CLI 无法表达的约束（如 `unevaluatedProperties`）和自定义关键字不会被丢掉，回合直接报出原因。
- 恢复 Claude 的任务清单：固定让 CLI 使用 TodoWrite，`turn/plan/updated` 在新模型下重新出现。
- Claude 入口的 MCP 状态：一个服务启动失败不再让排在它后面的服务没有状态；声明了资源能力但没有实现资源模板目录的服务
  不再被判为失败（此前会让整个 MCP 状态列表报错）。
- 删除从未生效的 `CHA_CLAUDE_ENABLE_FILE_CHECKPOINTING`。
- Claude 包的 Node 要求与其余部分一致，放宽为 24（>= 24.0.0）；此前子包仍写着 24.14.0，低于它的 24.x 安装依赖时会有引擎版本警告。
- Pi 入口 `model/list` 的默认推理强度改为该模型实际生效的值；此前对不支持 medium 的模型也报 medium，
  例如 DeepSeek 模型实际按 high 运行。

## 0.4.4

- `thread/resume` 与回退响应返回真实的 `turnsBackwardsCursor` / `itemsBackwardsCursor` 头部游标（Claude 与 Pi）。
  桌面对 `historyMode: paginated` 的线程要求这两个字段，Pi 此前不返回，恢复对话报
  `itemsBackwardsCursor` / `turnsBackwardsCursor` 缺失；Claude 此前返回 null，桌面会把历史当作空。
- `thread/items/list` 的游标改为线程级：桌面用同一个头部游标逐回合带 `turnId` 取条目，此前会被判为无效游标。

## 0.4.3

- Pi 被打断或失败的模型请求不再上报全零用量，桌面的上下文占用不会被清零；
  `thread/resume` 回放最近一次请求的用量，重连或重新打开线程后上下文占用保持可见。

## 0.4.2

- Pi 支持 `thread/archive` / `thread/unarchive`：归档只改变适配器侧列表状态，不改动 Pi 原生会话文件；
  `thread/list` 按 `archived` 过滤，归档活动会话会先中断当前回合。

## 0.4.1

- CLI 启动时读取 `~/.codex-harness-adapter/env`（每行 `KEY=VALUE`），后台服务也可配置
  `CHA_CLAUDE_*`、`PI_CLI`、代理等；启动进程已有的同名变量优先。
- 文档补充 Homebrew 用法、环境文件与 Claude 登录前提，标注仅适用于远程 shim 部署的内容，删除过时的 `TYRS_HAND.md`。

## 0.4.0

- macOS 可通过 `brew install slovx2/tap/codex-harness-adapter` 安装，并用
  `brew services` 在后台常驻；依赖 Homebrew 的 `node@24`。
- Node 要求放宽为 24（>= 24.0.0）；CLI 检查不满足时直接报错。
- Linux 运行包不再附带 Node，改用宿主 PATH 中的 Node 24。
- CLI 通过符号链接启动时按真实安装位置推导根目录。

## Unreleased

### App-server and protocol compatibility

- Updated the adapter to advertise Codex app-server protocol v2 compatibility at
  the current pinned Codex CLI compatibility version, while keeping a
  `codex-harness-adapter` suffix so hosts can distinguish the adapter from upstream
  Codex.
- Expanded Codex App Remote coverage across thread lifecycle, turn envelopes,
  item streaming, approvals, MCP status, fuzzy file search sessions, Claude
  skills/hooks, and `thread/turns/list` item views.
- Added protocol fixture coverage for `config/read`, including the sanitized
  `config.provider_loop_config` shape, so the Rust fixture drift gate covers
  provider-loop config projection behavior.
- Kept compatibility-only account, plugin, marketplace, realtime, and other
  OpenAI-specific surfaces inert or schema-shaped where Claude Code has no
  equivalent.
- Aligned `process/spawn` and `command/exec` with Codex 0.157.1: 10s default
  timeout with exit code 124, immediate process-group SIGKILL on
  kill/terminate/disconnect/timeout, 1 MiB per-stream output cap with
  `capReached` on the truncating chunk, 2s post-exit output drain, native error
  codes and messages, and the native non-inheritable environment filtering.
  PTY sessions keep running through `scripts/pty-bridge.py` (handshake reports
  spawn success or failure), which the packaged runtime now ships alongside a
  `--pty-self-check` build gate.
- Ported `gitDiffToRemote` from Codex 0.157.1 `git-utils`: the base is the
  closest commit that also exists on a remote (current branch, default branch,
  then remote branches containing HEAD), the diff includes unpushed commits and
  untracked files, and a missing base is a -32600 error.
- Aligned `fuzzyFileSearch` sessions with Codex: the tree is indexed once
  (hidden entries, directories, symlinks followed, gitignore only inside git
  repos), `sessionUpdate` responds before `sessionUpdated` + `sessionCompleted`,
  stale queries are dropped, and `sessionStop` sends no completion. Unlike
  Codex, notifications go to the connection that last started or updated the
  session instead of every connection.
- Implemented `thread/backgroundTerminals/list|terminate|clean` over the live
  turn's background Bash tasks (`background_tasks_changed` / `stopTask`).
  Background shells end with the per-turn CLI, and `processId` matches the Bash
  item (`claude:<toolUseId>`) rather than a numeric OS pid.

### Provider and multi-agent boundaries

- Added the provider and multi-agent loop boundaries RFC to separate runtime
  backends, provider metadata, agent-loop fidelity, credential ownership, and
  subscription/entitlement boundaries.
- Added static provider/agent-loop descriptors with validation for allowed and
  unsupported credential source labels.
- Added sanitized provider-loop projection helpers and exposed the read-only
  `config.provider_loop_config` field through `config/read`.
- Added explicit provider/agent-loop selection for known descriptor ids and loop
  ids. Selection maps only to existing runtime backends, preserves legacy
  runtime environment overrides and `CHA_CLAUDE_MOCK=1` precedence, filters
  raw saved selection keys from public `config/read`, and exposes sanitized
  selection metadata through `config.provider_loop_config.selection`.
- Added tests proving built-in descriptors validate cleanly, unsupported
  credential labels are not projected as allowed, and secret-like descriptor
  text is redacted from public projection results.

### Rust-first protocol groundwork

- Added the Rust-first runtime boundaries RFC, keeping the TypeScript
  app-server adapter as the shipping runtime path while defining incremental
  Rust protocol, transport, store, and launcher boundaries.
- Added an experimental Rust workspace scaffold and protocol crate with
  representative Codex app-server JSON fixtures.
- Added Rust parse/reserialize tests for the covered fixtures.
- Added a pinned fixture drift check against the configured Codex CLI version
  and made it part of CI alongside `cargo test --workspace`.
- Extended fixture coverage to include config projection data without claiming a
  Rust production runtime, transport, store, or provider execution path.

### Release readiness and compliance docs

- Added open-source compliance documentation and release-readiness reference
  material for maintainers and reviewers.
- Clarified the README and documentation homepage around the TypeScript
  production path, Rust-first experimental boundaries, provider/agent-loop
  descriptor and selection boundaries, supported credential ownership models,
  unsupported subscription/session/private endpoint/bypass behavior, and release
  verification expectations.
- Documented provider selection configuration for `CHA_CLAUDE_PROVIDER`,
  `CHA_CLAUDE_AGENT_LOOP`, saved provider-loop config keys, precedence rules,
  and sanitized `config.provider_loop_config.selection` projection.
- Documented the current shippable baseline: TypeScript remains the production
  path; Rust pieces are opt-in protocol boundary work; provider/loop descriptors
  are read-only metadata, not runtime dispatch.
- Documented supported credential ownership models: local user-provided API
  keys, official cloud-provider credential chains, organization-managed
  gateways, and local CLI auth for same-host user-directed execution.
- Documented unsupported credential models, including personal subscription
  sharing, browser cookie/session-token reuse, private provider endpoints,
  bypass guidance, and credential redistribution.

### Validation and release gates

- Default CI runs Biome checks, TypeScript typechecking, the Node test suite,
  Rust workspace tests, and the pinned Rust protocol fixture drift gate.
- Documentation changes should run `npm run docs:build`.
- Credentialed smoke and acceptance checks remain opt-in and must use
  credentials already owned by the local user or organization on the host.

### Still experimental or not yet included

- No Rust production runtime, transport, store, provider execution path, or
  default-on Rust launcher is included.
- No executable new provider loop is included beyond the existing runtime
  backends.
- No broad runtime dispatch rewrite is included.
- No new credential collection model is included.
- No support is included for personal subscription sharing, credential pooling,
- Terminals no longer need python3: on macOS and Linux, commands and processes that need a terminal are now started by the CLI's own `pty-bridge` subcommand (as they already were on Windows), and `scripts/pty-bridge.py` is gone. Runtime artifacts now carry `bin/codex-harness-adapter`, so the machine that builds them needs Go. Behaviour changes: the spawn error text is now `<command>: <reason>`; commands no longer inherit an ignored SIGPIPE; a blocked input no longer delays termination.
  browser cookie/session-token reuse, private provider endpoints, or provider
  bypass behavior.
