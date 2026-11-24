# 飞书

设备可以接一个或多个飞书自建应用（机器人），每个应用分配给一位经理。设备用飞书官方 SDK 的长连接收事件，不需要公网地址或开放端口；只支持国内飞书，不支持 Lark。

## 添加应用

桌面：设备详情的“飞书”一行进入，点“添加应用”。手机：设备详情的“飞书”同样可以添加（只有创建向导）。

- **创建向导**（推荐）：填机器人名，Litch 打开飞书的创建页，在飞书里选企业、头像和可用范围后提交。设备自动检测完成，拿到 App ID 和 App Secret 后保存并连上。创建页会带上 Litch 需要的权限、事件和回调清单。向导最多等 10 分钟；设备重启后进行中的向导作废，重新开始即可。
- **手动填写**（只在桌面）：已有自建应用时填 App ID（`cli_` 开头）和 App Secret。保存前设备会换一次令牌、读机器人信息来核对。应用要开机器人能力，事件和回调的订阅方式选“长连接”。

App Secret 只保存在设备的私有目录里（只有设备账号能读），界面和命令都不会显示；能换不能看。

**同一个应用不能同时被两处长连接接收**：飞书会把事件随机推给其中一处。把已有应用接进 Litch 之前，先停掉别的程序对它的长连接。

## 应用详情

- **经理**：选同一台设备上的经理。一个应用只分给一位经理，一位经理也只绑一个应用；要接多位经理就建多个应用。
- **连接状态**：已连接、连接中、重连中、连接失败（带原因）、已停用。断线后 SDK 自动重连；设备另有看门狗，长时间连不上会重建连接。App Secret 在飞书侧被重置或应用被停用时显示“凭据被拒”，不会自动重试，在桌面“更换 App Secret”后恢复。
- **能力检查**：读应用在线版本的权限、事件和回调，列出和 Litch 清单相比缺的项。需要应用有“应用自管理”权限（`application:application:self_manage`）。
- **补申请**：只追加清单里缺的项（不删你自己加的），然后提交一个新版本。需要企业管理员审核的，显示“待企业管理员审核”，审核通过后再点一次检查。补申请需要 `application:application:patch` 权限，不会在后台自动做。
- **停用**：断开飞书，配置和凭据保留。**移除**：断开并删除设备上保存的 App Secret，不可撤销。

## 群

机器人被拉进群后，群只出现在应用详情的“群”列表里，标“未接入”：设备不收、不记、不回这个群的任何消息，也不会提醒或自动退群。要让经理在群里工作，必须在 Litch 里明确接入。

- **接入**：在群列表里点群，选发言模式（必选，不设默认）、叫醒名单和保留天数。
  - **自由发言**：经理在群里发言不经审批。**审批发言**：每条发言都先给审批人批，批准后原样发出。审批多久过期按群设，默认 24 小时。
  - **叫醒名单**：只有名单里的人 @ 机器人或回复机器人的消息才会叫醒经理。名单从群成员里选；“包括已绑定用户”默认打开，私聊绑定过的人在所有接入群里都能叫醒经理。
  - **外部群**（群里有组织外的人）在列表上标出，接入时预选审批发言，还要再确认一次。
  - 保留天数是这个群的消息记录留多久，默认 90 天。
- **改设置**：群设置里可以改发言模式、叫醒名单、保留天数和审批过期时间。
- **取消接入**：确认框默认同时删除这个群的记录，不可撤销；不勾就按保留期清理，群上标“未接入（有记录）”。
- 机器人被移出已接入的群时，接入设置保留，群上标“机器人已不在群里”，停收停发；再被拉回来时自动恢复，不用重新接入。群解散后停收停发。

## 记录与历史

- 设备只记录已接入群里的消息（所有人的，不只是 @ 机器人的），存在设备上，按群的保留天数清理。未接入的群的消息在入口直接丢弃。
- **接入时**自动补最近 7 天的消息，最多 1000 条，超过时只留最新的。补的进度和结果在群设置里能看到。
- **补更早的消息**：群设置里选起止日期手动补，单次最多 1000 条。机器人进群之前的消息能不能读到，取决于群设置“新成员可查看历史消息”，可能补不全。
- 每次长连接连上（含断线重连），设备补断线期间的消息，群设置里能看到最近一次补到多少条、有没有补全。
- 撤回的消息本地换成“[已撤回]”，正文删掉。在飞书上编辑过的消息，补历史时按最新版更新。
- 合并转发、卡片、群名片、个人名片会再向飞书读一次，补全内容。图片、文件只记名字和标识，用到时再下载。

## 权限清单

| 用途 | 权限 |
|---|---|
| 收消息、读历史 | `im:message.group_msg`、`im:message.group_at_msg:readonly`、`im:message.p2p_msg:readonly`、`im:message:readonly` |
| 发言 | `im:message:send_as_bot` |
| 图片与文件 | `im:resource` |
| 群与成员 | `im:chat:read`、`im:chat.members:read`、`im:chat.members:bot_access` |
| 名字 | `contact:user.base:readonly` |
| 能力检查与补申请 | `application:application:self_manage`、`application:application:patch` |
| 经理调用的其他接口 | `docx:document`、`drive:drive`、`sheets:spreadsheet`、`bitable:app`、`wiki:wiki`、`calendar:calendar`、`task:task` |

事件：`im.message.receive_v1`、`im.message.recalled_v1`、`im.chat.member.bot.added_v1`、`im.chat.member.bot.deleted_v1`、`im.chat.member.user.added_v1`、`im.chat.member.user.deleted_v1`、`im.chat.member.user.withdrawn_v1`、`im.chat.updated_v1`、`im.chat.disbanded_v1`。回调：`card.action.trigger`。

`im:message.group_msg` 是应用级权限，开了以后飞书会把机器人所在全部群的消息推给设备；设备只处理在 Litch 里明确接入的群，其余在入口直接丢弃，不保存。

## 配置命令

以下用法也可在终端运行 `litch config`，把命令开头的 `scripts/litch` 换成 `litch config`。设备命令默认本机，远程设备加 `--device <设备>`。

- `scripts/litch feishu-app list` 列出应用、分配的经理和连接状态。
- `scripts/litch feishu-app register <机器人名>` 开始创建向导，返回飞书创建页地址和向导 ID；在浏览器打开地址完成创建，用 `scripts/litch feishu-app registration <向导ID>` 查看结果。
- `scripts/litch feishu-app assign <App ID> <经理ID>` 分配经理，`none` 取消分配。
- `scripts/litch feishu-app enable <App ID>`、`scripts/litch feishu-app disable <App ID>` 启用、停用。
- `scripts/litch feishu-app check <App ID>` 能力检查；`scripts/litch feishu-app upgrade <App ID>` 补申请并提交新版本。
- `scripts/litch feishu-app remove <App ID>` 移除应用，不可撤销，先在对话里问过用户。
- `scripts/litch feishu-chat list <App ID> [--refresh]` 列出机器人所在的群和接入状态；`--refresh` 先从飞书重新拉一遍。
- `scripts/litch feishu-chat members <App ID> <群>` 列出群成员。`<群>` 用 chat_id（`oc_` 开头）或唯一的群名。
- `scripts/litch feishu-chat access <App ID> <群> --speech free|approval [--wakers 成员,成员] [--no-wake-bound] [--retention 天] [--review-ttl 小时]` 接入群。外部群要加 `--confirm-external`。`--wakers` 写成员名或 open_id，重名时报错。选自由发言前先在对话里问过用户。
- `scripts/litch feishu-chat update <App ID> <群> [--speech …] [--wakers …] [--wake-bound|--no-wake-bound] [--retention 天] [--review-ttl 小时]` 改已接入群的设置。
- `scripts/litch feishu-chat unaccess <App ID> <群> [--keep-records]` 取消接入，默认同时删除记录，不可撤销，先在对话里问过用户。
- `scripts/litch feishu-chat backfill <App ID> <群> --since YYYY-MM-DD [--until YYYY-MM-DD]` 补一段更早的消息，单次最多 1000 条；`list` 里能看到进度。

手动填写 App Secret 和更换 App Secret 不经命令行，在桌面的应用详情里做。
