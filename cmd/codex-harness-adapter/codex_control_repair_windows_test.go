package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func badCodexControlACL(t *testing.T, directory string) {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sid := user.User.Sid
	sd, err := windows.SecurityDescriptorFromString("D:AI(A;OICI;FA;;;" + sid.String() + ")(A;OICI;FA;;;BA)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err = windows.SetNamedSecurityInfo(directory, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.UNPROTECTED_DACL_SECURITY_INFORMATION,
		sid, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
}

func TestCodexControlRepairWindowsBoundaries(t *testing.T) {
	c := settingsTestConfiguration(t)
	// 父进程可能来自 PowerShell 7；系统修复不能加载它继承的其他模块。
	modules := filepath.Join(t.TempDir(), "foreign-modules")
	security := filepath.Join(modules, "Microsoft.PowerShell.Security")
	if err := os.MkdirAll(security, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(security, "Microsoft.PowerShell.Security.psm1"),
		[]byte("throw 'unexpected external module import'\nfunction Get-Acl {}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PSModulePath", modules)
	home := filepath.Join(c.home, "isolated codex's home")
	t.Setenv("CODEX_HOME", home)
	c = c.forHarness(nativeCodex)
	directory := filepath.Join(home, "app-server-control")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	for range 5 {
		badCodexControlACL(t, directory)
		if err := repairCodexControlDirectory(context.Background(), c); err != nil {
			t.Fatal(err)
		}
	}
	backups, err := os.ReadDir(filepath.Join(c.home, "backups", "codex-control-acl"))
	if err != nil || len(backups) != 4 {
		t.Fatalf("备份应保留四份: %v %v", backups, err)
	}
	// 已受保护的目录可重复修复，不继续轮换备份。
	before, _ := os.ReadFile(filepath.Join(c.home, "backups", "codex-control-acl", "codex-control-acl.1.json"))
	if err := repairCodexControlDirectory(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(filepath.Join(c.home, "backups", "codex-control-acl", "codex-control-acl.1.json"))
	if string(before) != string(after) {
		t.Fatal("重复修复不应覆盖备份")
	}
	unknown := filepath.Join(directory, "other")
	if err := os.WriteFile(unknown, []byte("do not modify"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := repairCodexControlDirectory(context.Background(), c); err == nil {
		t.Fatal("未知文件应拒绝")
	}
	if err := os.Remove(unknown); err != nil {
		t.Fatal(err)
	}
	lock, err := os.OpenFile(filepath.Join(directory, "app-server-startup.lock"), os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := repairCodexControlDirectory(context.Background(), c); err == nil {
		t.Fatal("占用锁应拒绝")
	}
	lock.Close()
	link := filepath.Join(c.home, "linked-home")
	if err := os.Symlink(home, link); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", link)
	if err := repairCodexControlDirectory(context.Background(), c); err == nil {
		t.Fatal("CODEX_HOME 链接应拒绝")
	}
	t.Setenv("CODEX_HOME", home)
	badCodexControlACL(t, directory)
	backup := filepath.Join(c.home, "backups", "codex-control-acl", "codex-control-acl.2.json")
	if err := os.Remove(backup); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(backup, 0700); err != nil {
		t.Fatal(err)
	}
	if err := repairCodexControlDirectory(context.Background(), c); err == nil {
		t.Fatal("备份失败时应拒绝修复")
	}
}

func TestCodexControlRepairHomeOnWindows(t *testing.T) {
	home := `C:\isolated\codex`
	if got, err := codexControlHome([]string{"codex_home=" + home}); err != nil || got != home {
		t.Fatalf("Windows 环境名大小写不应改变目录: %q %v", got, err)
	}
	if _, err := codexControlHome([]string{"CODEX_HOME=" + home, `codex_home=C:\other`}); err == nil {
		t.Fatal("目录有歧义时应拒绝")
	}
	if _, err := codexControlHome([]string{"CODEX_HOME=relative"}); err == nil {
		t.Fatal("相对路径应拒绝")
	}
	profile, err := windows.KnownFolderPath(windows.FOLDERID_Profile, 0)
	if err != nil {
		t.Fatal(err)
	}
	got, err := codexControlHome([]string{`USERPROFILE=C:\unrelated`})
	if err != nil || got != filepath.Join(profile, ".codex") {
		t.Fatalf("默认目录应匹配 Codex 的 KnownFolder: %q %v", got, err)
	}
}
