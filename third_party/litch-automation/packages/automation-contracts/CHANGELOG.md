# 更新记录

## 未发布

### 自动化恢复与观察合同

公开导出 `AutomationRecovery`、`automationRecovery` 和 `observationSlice`。错误文字旁的 JSON 带 `recovery`，字段为 `status/retryable/needs_snapshot/needs_claim/needs_approval/may_have_executed/next_action/hint`；浏览器输入以 `inputReceipt.recovery` 为准，因为只有它知道实际派发情况。未知异常保守标记可能执行，不授权重放。
工具 schema 新增 `ensure_claimed`，snapshot 与 get_app_state 新增可选 `detail/offset`；原字段和工具保留。快照元数据给 `generation/mode/truncated/next_offset/total_lines`；ref 为不透明字符串，不能自行解析或拼接编号。
