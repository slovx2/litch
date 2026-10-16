//go:build windows

package main

// Windows 上还不能把原生 Codex 接进来（inspectCodex 一开始就拒绝了），这几样用不到。

func recordCodexProcess(configuration, int) {}
func forgetCodexProcess(configuration)      {}
func reapCodexOrphan(configuration)         {}
func sweepCodexOrphan(configuration)        {}
