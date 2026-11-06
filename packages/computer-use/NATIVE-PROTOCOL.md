# 原生组件接入协议

本文对应 `wire.mts`、Swift `Wire.swift/Engine.swift` 与 Rust `wire.rs/win/engine.rs` 的 v1。原生通道仅交给可信宿主后端；不要将任意 RPC、`selfAllowed`、`targetPid` 暴露给网页或模型。AI 调用使用 `/tools` 和默认入口的执行器，执行器才负责审批、引用和参数转换。

## 帧与认证

每帧：**4 字节无符号大端长度 + UTF-8 JSON-RPC 2.0**，长度不含头，最大 33,554,432 字节。允许拆包、粘包；非法 JSON、超长帧断开。请求 `{jsonrpc:"2.0",id:number,method:string,params:object}`；结果 `{jsonrpc:"2.0",id,result}`；错误 `{jsonrpc:"2.0",id,error:{code,message,data:{kind}}}`。通知没有 id，不等待应答。不能按 JSONL 或 Chrome Native Messaging 小端帧读取。

第一条请求为 `hello`，`params={protocol:1,lang:"zh-CN"|"en",token?:string}`。两平台各自的协议号均为 1。Mac 开发签名提供启动时生成的随机 token；正式签名模式只接受同系统用户、同签名团队、签名有效且标识在构建白名单内的宿主，正确 token 也不能绕过。请求方自报 team/id 不参与判断。握手失败关闭连接。

Mac 返回 `protocol,pid,version,bundleId,bundlePath,auth,teamId`；`auth` 为 team/token。Windows 返回 `protocol,pid,version,platform:"win32",integrity,uacEnabled`，integrity 为 low/medium/high/system。宿主核对协议/版本及 Mac 的实际组件路径和 bundle ID。重连后重新观察，不能复用断线前的元素或截图。

Mac 通过 `open -n -g -a <helper.app> --env KEY=value` 启动，再连 `<运行目录>/helper.sock`。目录 0700、socket 0600，socket UTF-8 路径最长 103 字节。必须经 LaunchServices 启动，不能直接 spawn 包内 executable，否则系统权限责任会落到父应用。Windows 通过 stdin/stdout 二进制帧，stderr 只记日志；传 `--parent-pid <pid>`，非 detached 子进程。自定义宿主必须提供等价父退出和进程收尾。

## 请求表

表中动作参数以 Mac 原生参数为基准；Windows 的具体变换见表后。对象键区分大小写；`?` 为可选字段。数字必须有限。`session`、`turnId`、`actionId` 是宿主生成的不透明字符串，不是模型输入。

| 方法 | 平台 | 参数 | 结果 |
|---|---|---|---|
| hello | 两者 | protocol:number, lang?:string, token?:string（仅 Mac 开发） | 上述握手对象 |
| diagnostics | 两者 | 空对象 | 进程、版本、权限/平台诊断；字段因平台不同 |
| listApps | 两者 | 空对象 | `{apps:HelperApp[]}` / `{apps:WinHelperApp[]}` |
| inspectTarget | 两者 | app:string；Windows 可带 windowId:number | `{self:boolean,pid:number}`；只是判定，不授权 |
| permissions | Mac | 空对象 | `{accessibility:boolean,screenRecording:boolean,captureStatus?:untested\|pending\|ready\|denied\|failed}`；不弹系统授权 |
| openSettings | Mac | pane:accessibility\|screenRecording | `{opened:boolean}`；只能从可信宿主 UI 触发 |
| setLanguage | 两者 | lang:string | 空对象 |
| getAppState | 两者 | 公共目标字段；Mac full?:boolean，Win screenshot?:boolean | Mac AppStateResult 或 AppMenuStateResult；Win WinAppStateResult |
| click | 两者 | 目标字段，加 element 或 x/y；button?:left\|right\|middle,count?:1..3,modifiers?:string | Mac `{text}`；Win `{}` 或 `{notes:string[]}`，随后由 TS 再观察生成差异 |
| typeText | 两者 | 目标字段，加 text:string, element? | 同上 |
| pressKey | 两者 | 目标字段，加 key:string, repeat?:正整数 | 同上；Windows 键被拒 |
| scroll | 两者 | 目标字段，加 direction:up\|down\|left\|right,amount?:正整数,element? 或 x/y | 同上 |
| setValue | 两者 | 目标字段，加 element,value:string | 同上 |
| drag | 两者 | 目标字段，加 from_element 或 from_x/from_y，to_element 或 to_x/to_y | 同上 |
| selectText | 两者 | 目标字段，加 element,text?:string 或 start?:整数,length?:整数 | 同上；范围按 UTF-16 单元 |
| cancelAction | Mac | actionId:string | 空对象；也接受通知，不重放动作 |
| turnEnded | 两者 | session:string,turnId:string | Mac 释放本回合输入/预览/引用/停止状态，拒绝迟到输入；Win 释放 session 截图/活动，停止与观察索引由 TS 清理 |
| shutdown | 两者 | 空对象 | 空对象，随后退出 |
| backgroundCapabilities | Mac | 空对象 | `{mouse:string,sipEnabledVerified:false}` |
| previewSubscribe | Mac | session:string | 空对象；订阅本机预览 |
| previewAck | Mac | session:string,streamId:string,seq:number | 空对象；ACK 对应流与帧，旧 ACK 不推进新流 |
| previewPin | Mac | session:string | 空对象；原生悬浮预览 |
| previewUnpin | Mac | 空对象 | 空对象 |
| previewHide | Mac | session:string | 空对象 |
| stopSession | Mac | session:string | 空对象；用户停止，撤输入所有权 |
| takeover | Mac | session:string | 空对象；撤输入所有权并等空闲后才激活目标，只能由用户接管触发 |

Mac 目标字段：`app:string,session:string,turnId:string,actionId:string`，宿主检查后覆盖 `selfAllowed:boolean,targetPid:number`。`element` 为当前会话 AX 编号；x/y 为最新截图像素。无唯一窗口时仍可返回菜单树，无截图时禁止坐标动作。

Windows 原生目标字段不同于 AI schema：执行器解析应用后发送 `appId:string,windowId?:number,session,selfAllowed,targetPid`；元素号转为 UIA `ref`；坐标带 `screenshotId`，在 TS 侧核对观测尺寸。drag 转成 `from:{x,y},to:{x,y},screenshotId`；modifiers 变为字符串数组，pressKey 的组合键拆成 key 与 modifiers；repeat/amount 为 1..50。由 `win-params.mts` 生成。窗口号/截图号/UIA 引用不是同一编号，宿主不得自行互换。具体转换以该纯函数与 `WinAppStateResult` 声明为准。批量 `run_actions` 只在 TS 执行器编排，没有同名原生 RPC。

## 通知、预览与取消

- `stopped`：Mac `{session,app,bundleId}`，Windows `{session,appId}`。明确停止在该回合内不可因释放按键或重试而恢复；结束回合后新回合可重新观察。
- Mac `automation`：预览/指针/几何通知。宿主经 Node 入口 `onAutomation` 接收，展示端的 ACK 由可信后端发 `previewAck`。预览帧不属于工具结果，不进设备协议或聊天历史。公共几何合同来自 automation-contracts；宿主负责展示与生命周期。
- 单动作及观察最多 60 秒；批次动作共 60 秒，最后观察额外 10 秒；权限查询 5 秒，目标检查 10 秒。带 actionId 的 Mac 请求在超时或 AbortSignal 时发 `cancelAction(actionId)`，不等待未完成原请求、不重放可能已经执行的输入。Windows 原有 v1 没有原生 cancelAction，动作帧也未携带 actionId：取消可终止调用等待，但不能保证已经发出的 Windows 原生输入立即停止。取消后不要自动补发或换助手重试；输入安全与停止收尾须在实机阶段另验，不能宣称两个平台等价。
- 推荐收尾顺序：禁止新调用 → 中止在途信号 → 撤审批 → `turnEnded` → 停预览 → `shutdown` → 断开 → 等子进程退出。SDK `endTurn/endSession/dispose` 提供对应边界；桌面适配层保持原工具结果格式。
- Mac 无连接 60 秒退出；Windows EOF、父进程退出、60 秒空闲或 shutdown 收尾。Node 看护 Mac 可退避重启、Windows 只按需重启；自动重连不会自动重放动作。

## 错误

`invalid` 为 -32602，`unauthorized` 为 -32001，其余 -32000；宿主按 `data.kind` 分类，不按自然语言匹配授权结论。

| kind | 含义与后续 |
|---|---|
| unauthorized | 未握手、身份/token 不符或自身未获授权，拒绝输入 |
| invalid | 参数或工具/引用非法，修正后重新观察 |
| permission | Mac 缺系统权限，由用户授予后再试 |
| capturePending / captureDenied / captureFailed | 实际采集状态，不能把 TCC 预检查 true 当成采集成功 |
| notFound | 应用/窗口不存在 |
| stopped | 本回合明确停止，结束回合后等用户新请求 |
| userActive | 物理输入冲突；Mac 每次用 `.hidSystemState` 校准按住状态，漏失释放事件不会永久占用 |
| stale | 目标进程/窗口/引用/截图已变，重新观察；不自动重放 |
| failed | 系统/传输/执行失败，可能已经执行部分动作 |
| elevated / locked / foreground | Windows 完整性级别、安全桌面或前台切换失败；不提权绕过 |

Windows 在 `Local` 命名空间中的 `LitchComputerUse-<SID>` 保持原名称：同一 Windows 登录会话、同一用户的所有这些组件共享互斥量。第二助手/互斥量获取失败在握手前以退出码 3 退出，Node 返回明确 busy。不同应用不能通过换互斥名并行输入。Mac 当前只有各运行目录的单实例，**没有跨宿主全局输入仲裁**，不要同时运行两个宿主的输入执行器。

## 构建身份与证据

Mac 的 `ComputerUseHostIdentity` JSON 写入 Info.plist，并由组件签名覆盖：productName/helperName/helperId、allowedPeerIds、protectedTargetIds、isolationEnvironmentKeys、directoryEnvironmentKey/tokenEnvironmentKey/defaultStateSubdirectory。缺失/损坏/组件 bundle ID 不一致时退出。只有构建者能改变身份；正式组件的同团队校验保持不变。开发 token 不是正式签名的替代品。

Windows 构建期注入 `CU_HOST_PRODUCT`、`CU_HOST_REGISTRY_KEY`、`CU_HOST_EXECUTABLE`、`CU_HOST_ISOLATION_KEYS`（分号分隔）、`CU_HELPER_VERSION`。编译后不读取这些运行时环境变量。目标按安装器 HKCU 的 InstallLocation 加 executable 识别；受保护目标环境的隔离键仍由原生进程查询，不信任模型参数。保持 x64 的进程参数读取约束。

`test/native-frames.json` 是 TS/Swift/Rust 共跑的黄金帧，包含握手、取消、回合结束和认证错误。单元测试证明帧与身份判定；ad-hoc LaunchServices 自检证明隔离组件启动和收尾。正式签名、TCC、Windows 真机和两个实际宿主集成仍须单独验收。
