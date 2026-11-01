# 本地补丁

无。UPSTREAM.json 列出的文件逐字保留；Litch 胶水在 cmd/claude-tui-helper 与 packages/claude/src/tui-*。
需要补丁时放 patches/magpie，说明原因、适用上游提交与验收；构建临时应用，不修改此镜像。

上游 tui.go 关于额度倍率的注释属于上游主张，Litch 未验证也不据此承诺节省额度。
