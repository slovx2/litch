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

手动填写 App Secret 和更换 App Secret 不经命令行，在桌面的应用详情里做。
