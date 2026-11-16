package scripts

import _ "embed"

// CodexControlRepair 是维护脚本与设备动作共用的实现，随 CLI 编译，不依赖用户的源码目录。
//
//go:embed repair-codex-control-windows.ps1
var CodexControlRepair string
