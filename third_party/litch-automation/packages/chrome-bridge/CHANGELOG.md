# 更新记录

## 未发布

### 受控页面开新页面后交还系统前台

受控页面在代理输入后自己打开新标签或弹窗（`target=_blank`、`window.open`）时，Chrome 会激活窗口，在 macOS 上会抢走前台应用。扩展新增 `foreground` 事件，在 Chrome 原本不在前台、因受控标签刚打开的新页面获得焦点时发出。`ChromeExecutorOptions.foreground` 接收 `ForegroundKeeper`：每次代理输入前记下前台应用，收到事件后还给它。`macForegroundKeeper()` 只用 `lsappinfo` 与 `osascript` 的 JavaScript 桥，不需要辅助功能或自动化权限。不传时行为不变。

### 0.42.0

复用 browser 的有界 File 构造与清理逻辑；调用取消后仅清理已持有的上传对象，继续核验租约与来源。

### 一次准备 Chrome 标签

`ensure_claimed({targetId,url?})` 只选精确 URL，省略 url 时选最后焦点窗口的当前标签；多匹配直接要求明确选择。`ensure_claimed({tabId})` 恢复本会话原标签，一次完成列表、来源检查、认领、加载等待和新快照，返回稳定 tabId 与新 ref。未引入扩展 RPC，沿用 v1 list/claim/renew/command。
同一实例的过期租约最多自动恢复一次；断线失效的只读 snapshot 可自动恢复，显式 release 后须明确 ensure_claimed。未知实例、用户停止、登录暂停、站点拒绝和其他会话占用都不猜测替代目标，不自动重放输入。callId 去重规则仍适用。
重认领核对原 DevTools target，防止 Chrome 重启重用数字 tabId 后误接管其他标签；缺少可核对身份时要求明确重新选择。用户停止、显式释放或无法判定原因的调试器撤销不会触发隐式恢复。
失败 JSON 新增 recovery，给明确下一步与保守的执行状态；输入失败以 inputReceipt.recovery 的实际派发记录为准。工具说明优先 ensure_claimed 与 run_actions，批末显式等待业务确认。
