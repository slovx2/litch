package main

import "testing"

// Windows 受管服务的 PATH：注册表里系统、用户的 Path（Git、npm 全局目录在这里），保底的 npm 全局目录与
// ~\.local\bin，最后是 Node 所在目录；大小写不同、末尾带反斜杠的重复项只留第一次出现的。
func TestWindowsAutostartPath(t *testing.T) {
	system := `C:\Windows\system32`
	machine := `C:\WINDOWS\system32;C:\Windows;C:\Program Files\Git\cmd;C:\Program Files\nodejs\;;`
	user := `C:\Users\dev\AppData\Roaming\npm;C:\Users\dev\.local\bin\`
	node := `C:\Users\dev\AppData\Local\Litch\adapter\node\node.exe`
	got := windowsAutostartPath(system, []string{machine, user}, `C:\Users\dev\AppData\Roaming`, `C:\Users\dev`, node)
	want := `C:\Windows\system32;C:\Windows;C:\Program Files\Git\cmd;C:\Program Files\nodejs\;` +
		`C:\Users\dev\AppData\Roaming\npm;C:\Users\dev\.local\bin\;C:\Users\dev\AppData\Local\Litch\adapter\node`
	if got != want {
		t.Fatalf("PATH\n得到 %s\n应为 %s", got, want)
	}

	// 注册表读不到时仍有 System32、npm 全局目录、~\.local\bin 和 Node 所在目录。
	got = windowsAutostartPath(system, []string{"", ""}, `C:\Users\dev\AppData\Roaming\`, `C:\Users\dev`, node)
	want = `C:\Windows\system32;C:\Users\dev\AppData\Roaming\npm;C:\Users\dev\.local\bin;C:\Users\dev\AppData\Local\Litch\adapter\node`
	if got != want {
		t.Fatalf("注册表为空时的 PATH\n得到 %s\n应为 %s", got, want)
	}
}
