# 更新记录

## 未发布

### 紧凑观察与恢复

snapshot 默认最多 180 行、约 10K 字符，仍略去装饰容器与重复文字。`detail:"full"` 提高到 1500 行、约 60K；`offset` 根据 `observation.next_offset` 读取后续行。分页针对完整快照，`diff:true` 在有完整基准时只回变化；截断后不推进基准，避免漏掉从未返回的内容。
ref 含文档代次（如 `e3g12`）；同一文档保留稳定编号，文档更换、重新认领或节点消失后旧 ref 失效。错误给 `recovery.needs_snapshot` 与修复提示；输入的精确恢复字段在 `inputReceipt.recovery`。
已知连续操作优先 run_actions，以 wait(selector/text/url) 结束验证业务条件。结果新增 `verification.status`（matched/notConfirmed/notRequested），只证明所给条件匹配；业务结果仍由调用方判断。最终快照优先紧凑 diff。截图继续显式调用 screenshot。
