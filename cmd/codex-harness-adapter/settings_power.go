package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const (
	powerLocalKey   = "power.localService"
	powerWorkingKey = "power.preventSleepWhileWorking"
	powerPluggedKey = "power.keepAwakeWhilePluggedIn"
)

type powerSettings struct {
	local, working, plugged bool
}

func (c configuration) powerSettings() powerSettings {
	return powerSettings{
		local:   c.settings.boolean(powerLocalKey, false),
		working: c.settings.boolean(powerWorkingKey, true),
		plugged: c.settings.boolean(powerPluggedKey, false),
	}
}

func powerSettingSpecs() (settingGroup, []settingSpec) {
	description := both("仅阻止系统空闲睡眠，仍允许屏幕熄灭和锁屏；合盖或主动睡眠仍由系统决定。", "Only prevents idle system sleep; the screen can still turn off or lock. Closing the lid or choosing Sleep still follows system behavior.")
	return settingGroup{ID: "power", Scope: deviceScope, Title: both("电源", "Power"), Description: &description}, []settingSpec{
		{Key: powerWorkingKey, Group: "power", Type: settingBoolean, Scope: deviceScope, Restart: restartNone,
			Default: true, Title: both("运行任务时阻止系统睡眠", "Prevent sleep while tasks are running"),
			Description: both("回合、后台任务和等待审批或回答期间阻止系统空闲睡眠，电池供电时也生效，会增加耗电。", "Prevents idle system sleep during turns, background tasks and waits for approval or answers, including on battery power; this uses more energy.")},
		{Key: powerPluggedKey, Group: "power", Type: settingBoolean, Scope: deviceScope, Restart: restartNone,
			Default: false, Title: both("接通电源时始终阻止系统睡眠", "Always prevent sleep when plugged in"),
			Description: both("设备服务运行且接通电源时阻止系统空闲睡眠，即使没有任务、已关闭桌面应用也生效；会增加耗电。", "Prevents idle system sleep while the device service is running and the computer is plugged in, even with no tasks or after the desktop app closes; this uses more energy.")},
	}
}

// 本机归属只由本地启动入口登记，不加入可远程写入的设置清单。
func (s *settingsStore) registerLocalPower() (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var local bool
	if json.Unmarshal(s.values[powerLocalKey], &local) == nil && local {
		return false, nil
	}
	next := make(map[string]json.RawMessage, len(s.values)+1)
	for key, value := range s.values {
		next[key] = value
	}
	next[powerLocalKey] = json.RawMessage("true")
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return false, err
	}
	if err := writePrivateJSON(s.path, settingsFile{Version: s.version + 1, Values: next}); err != nil {
		return false, fmt.Errorf(tr("无法登记本机电源设置: %w", "cannot register local power settings: %w"), err)
	}
	s.version, s.values = s.version+1, next
	return true, nil
}

func (m *harnessManager) settingsSchema() settingsSchema {
	m.schemaMu.RLock()
	defer m.schemaMu.RUnlock()
	return m.schema
}

func (m *harnessManager) registerLocalPower() error {
	m.schemaMu.Lock()
	changed, err := m.base.settings.registerLocalPower()
	if err == nil && changed {
		m.schema = buildSettingsSchema(m.base)
	}
	m.schemaMu.Unlock()
	if changed {
		m.notify(powerLocalKey)
	}
	return err
}
