# 更新记录

## 未发布

### 一次准备 Chrome 标签

`ensure_claimed({targetId,url?})` 只选精确 URL，省略 url 时选最后焦点窗口的当前标签；多匹配直接要求明确选择。`ensure_claimed({tabId})` 恢复本会话原标签，一次完成列表、来源检查、认领、加载等待和新快照，返回稳定 tabId 与新 ref。未引入扩展 RPC，沿用 v1 list/claim/renew/command。
同一实例的过期租约最多自动恢复一次；断线失效的只读 snapshot 可自动恢复，显式 release 后须明确 ensure_claimed。未知实例、用户停止、登录暂停、站点拒绝和其他会话占用都不猜测替代目标，不自动重放输入。callId 去重规则仍适用。
重认领核对原 DevTools target，防止 Chrome 重启重用数字 tabId 后误接管其他标签；缺少可核对身份时要求明确重新选择。用户停止、显式释放或无法判定原因的调试器撤销不会触发隐式恢复。
失败 JSON 新增 recovery，给明确下一步与保守的执行状态；输入失败以 inputReceipt.recovery 的实际派发记录为准。工具说明优先 ensure_claimed 与 run_actions，批末显式等待业务确认。
