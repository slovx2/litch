//go:build !windows

package main

import "testing"

func TestDeviceStartLocalServiceRegistration(t *testing.T) {
	for _, existing := range []bool{false, true} {
		name := "new"
		if existing {
			name = "existing"
		}
		t.Run(name, func(t *testing.T) {
			cfg, _ := deviceTestConfiguration(t)
			writeDeviceFixture(t, cfg, "ok", 0)
			t.Cleanup(func() { stopLaunchedService(t, cfg) })
			args := deviceStartArguments(cfg, "--ssh=off")
			pid := 0
			if existing {
				started := parseDeviceStartOutput(t, runCLI(t, "", nil, args...))
				pid = started.PID
				settings, err := loadSettings(cfg.home)
				if err != nil || settings.boolean(powerLocalKey, false) {
					t.Fatal("普通启动登记了本机")
				}
			}
			registered := parseDeviceStartOutput(t, runCLI(t, "", nil, append(args, "--local-service")...))
			if existing && registered.PID != pid {
				t.Fatal("登记现有服务重新启动了它")
			}
			store, err := loadSettings(cfg.home)
			if err != nil || !store.boolean(powerLocalKey, false) {
				t.Fatalf("未持久登记: %v", err)
			}
			version := store.currentVersion()
			repeated := parseDeviceStartOutput(t, runCLI(t, "", nil, append(args, "--local-service")...))
			store, err = loadSettings(cfg.home)
			if err != nil || repeated.PID != registered.PID || repeated.Started || store.currentVersion() != version {
				t.Fatal("重复登记不是幂等操作")
			}
			client := dialControl(t, cfg)
			var result struct {
				Schema settingsSchema `json:"schema"`
			}
			client.must("settings.read", nil, &result)
			if _, ok := result.Schema.spec(powerWorkingKey); !ok {
				t.Fatal("运行中的服务没有更新设置 schema")
			}
		})
	}
}
