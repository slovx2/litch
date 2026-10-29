package main

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

func TestPowerSettingsLocalRegistrationAndPersistence(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	manager := newHarnessManager(cfg)
	for _, key := range []string{powerLocalKey, powerWorkingKey, powerPluggedKey} {
		if _, ok := manager.settingsSchema().spec(key); ok {
			t.Fatalf("未登记服务暴露 %s", key)
		}
	}
	if _, problem, _ := cfg.settings.apply(0, []settingEdit{edit(powerLocalKey, true)}, manager.settingsSchema(), nil); problem == nil {
		t.Fatal("内部归属接受通用设置写入")
	}
	if err := manager.registerLocalPower(); err != nil {
		t.Fatal(err)
	}
	if _, ok := manager.settingsSchema().spec(powerLocalKey); ok {
		t.Fatal("内部归属出现在 schema")
	}
	for key, want := range map[string]bool{powerWorkingKey: true, powerPluggedKey: false} {
		spec, ok := manager.settingsSchema().spec(key)
		if !ok || spec.Default != want || spec.Restart != restartNone || spec.Scope != deviceScope {
			t.Fatalf("设置声明错误: %+v", spec)
		}
	}
	if _, problem, err := cfg.settings.apply(1, []settingEdit{edit(powerWorkingKey, false), edit(powerPluggedKey, true)}, manager.settingsSchema(), nil); err != nil || problem != nil {
		t.Fatalf("写入失败: %v %+v", err, problem)
	}
	if err := manager.registerLocalPower(); err != nil {
		t.Fatal(err)
	}
	if cfg.settings.currentVersion() != 2 {
		t.Fatal("重复登记修改了设置版本")
	}
	loaded, err := loadSettings(cfg.home)
	if err != nil {
		t.Fatal(err)
	}
	cfg.settings = loaded
	if got := cfg.powerSettings(); !got.local || got.working || !got.plugged {
		t.Fatalf("用户设置没有持久保留: %+v", got)
	}
	if stat, err := os.Stat(settingsPath(cfg.home)); err != nil || stat.Mode().Perm() != 0600 {
		t.Fatalf("设置文件权限错误: %v %v", stat, err)
	}
}

func TestControlPowerRegistrationAndImmediateSettings(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	manager := newHarnessManager(cfg)
	backend := &fakePowerBackend{available: true, power: "ac"}
	changes := 0
	power := newPowerController(context.Background(), backend, cfg.powerSettings, func() { changes++ }, nil)
	t.Cleanup(power.close)
	server := &controlServer{c: cfg, manager: manager, power: power, ctx: context.Background()}
	params, _ := json.Marshal(powerActivity{Generation: "node", Sequence: 1, Complete: true, Sources: []powerActivitySource{{ID: "thread", Working: 1}}})
	if _, err := server.handle("power.activity", params); err != nil {
		t.Fatal(err)
	}
	if backend.starts != 0 {
		t.Fatal("未登记的远程活动启用了保活")
	}
	if _, err := server.handle("power.registerLocal", json.RawMessage("{}")); err != nil {
		t.Fatal(err)
	}
	if power.read().State != "requested" || backend.starts != 1 {
		t.Fatalf("登记后没有重算: %+v", power.read())
	}
	params, _ = json.Marshal(map[string]any{"expectedVersion": 1, "edits": []settingEdit{edit(powerWorkingKey, false)}})
	if _, err := server.handle("settings.write", params); err != nil {
		t.Fatal(err)
	}
	if power.read().State != "inactive" || !backend.leases[0].stopped || changes < 3 {
		t.Fatal("设置应答前未即时释放并通知")
	}
	result, err := server.handle("power.read", nil)
	if err != nil || result.(powerStatus).State != "inactive" {
		t.Fatal("power.read 与 state 不一致")
	}
}

func TestLocalServiceFlagIsExplicit(t *testing.T) {
	cfg := settingsTestConfiguration(t)
	parsed, err := parseConfiguration([]string{"--home", cfg.home, "--root", cfg.root, "--local-service"})
	if err != nil || !parsed.localService {
		t.Fatalf("参数未解析: %+v %v", parsed, err)
	}
	ordinary, err := parseConfiguration([]string{"--home", cfg.home, "--root", cfg.root})
	if err != nil || ordinary.localService {
		t.Fatal("普通启动自动登记了本机")
	}
	for _, arg := range parsed.launch {
		if arg == "--local-service" {
			t.Fatal("归属登记不应变成重复启动参数")
		}
	}
}
