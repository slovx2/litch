package main

import (
	"context"
	"encoding/json"
	"slices"
)

// 控制通道上“给设备装 harness”的那一部分（harness.versions、harness.install、harness.install.read），
// 和任务进度的推送：{"method":"install","params":<任务>}，发给连着的每一条（设备进程转成
// litch/device/harness/install/changed，只发给握手时声明了 harnessInstall 的客户端连接）。

func (s *controlServer) newInstaller() *installer {
	return newInstaller(s.ctx, installHooks{
		source: s.versionSource(),
		// 拿着安装任务的锁调用：只排进队，由 pump 按先后发出去，不等在写上
		notify: func(job installJob) {
			s.mu.Lock()
			s.installQueue = append(s.installQueue, job)
			s.mu.Unlock()
			select {
			case s.installDirty <- struct{}{}:
			default:
			}
		},
		after: s.afterInstall,
	})
}

// 查版本和跑安装命令用的现场：harness 起的时候看到的那份环境、设置里的命令行。
func (s *controlServer) versionSource() versionSource {
	return versionSource{
		environment: func(id string) []string { return s.manager.base.forHarness(id).environment() },
		configured: func(id string) string {
			entry := s.manager.base.forHarness(id)
			if id == nativeCodex {
				return entry.settings.text(cliPathKey(nativeCodex))
			}
			return entry.environmentValue(specOf(id).cliVariable)
		},
		settings: func() int { return s.manager.base.settings.currentVersion() },
		registry: registryFrom(s.c),
	}
}

// 装成以后：停用着的写成启用（装就是想用），命令行只在官方装法的位置找到时写进命令行路径，
// 然后照 harness.apply 重启它。它有回合在跑（或者判断不了）时不重启，新版下次重启生效。
func (s *controlServer) afterInstall(ctx context.Context, id string, found locatedCLI) []string {
	notes := []string{}
	edits := []settingEdit{}
	if enabled, state, _ := s.manager.wanted(id); !enabled && state == stateDisabled {
		edits = append(edits, settingEdit{Key: enabledKey(id), Value: json.RawMessage("true")})
	}
	if found.installer && s.manager.base.settings.text(cliPathKey(id)) == "" {
		value, _ := json.Marshal(found.path)
		edits = append(edits, settingEdit{Key: cliPathKey(id), Value: value})
	}
	if len(edits) > 0 {
		var problem *settingsProblem
		var err error
		// 和别处的写入撞了版本号就照最新的再写一次
		for attempt := 0; attempt < 3; attempt++ {
			_, _, problem, err = s.manager.write(s.manager.base.settings.currentVersion(), edits)
			if err != nil || problem == nil || problem.reason != "conflict" {
				break
			}
		}
		switch {
		case err != nil:
			notes = append(notes, both("[litch] 设置没能写进磁盘：%s", "[litch] The settings could not be written: %s").with(err.Error()).String())
		case problem != nil:
			notes = append(notes, both("[litch] 设置没能写入：%s", "[litch] The settings could not be written: %s").pair(problem.text).String())
		default:
			for _, edit := range edits {
				notes = append(notes, both("[litch] 已写设置 %s = %s", "[litch] Set %s = %s").with(edit.Key, string(edit.Value)).String())
			}
		}
		s.publish()
	}
	var activity deviceActivity
	if answer, answered := s.ask("activity", nil, activityTimeout); answered && json.Unmarshal(answer, &activity) == nil && slices.Contains(activity.Turns, id) {
		return append(notes, both(
			"[litch] %s 有回合在跑，这次没有重启它；装好的版本在它下次重启后生效",
			"[litch] %s has a turn in progress, so it was not restarted; the installed version takes effect the next time it restarts",
		).with(harnessNames[id]).String())
	}
	result, failure := s.applyHarness(id)
	s.publish()
	if failure != nil {
		return append(notes, both("[litch] 重启没有做成：%s", "[litch] The restart did not go through: %s").pair(failure.Text).String())
	}
	applied, _ := result.(map[string]any)
	state, _ := applied["state"].(string)
	return append(notes, both("[litch] 已重启 %s：%s", "[litch] Restarted %s: %s").with(harnessNames[id], state).String())
}

// 把排着队的任务进度按先后发给连着的每一条。由 pump 调。
func (s *controlServer) flushInstalls() {
	s.mu.Lock()
	queue := s.installQueue
	s.installQueue = nil
	peers := make([]func(any), 0, len(s.peers))
	for connection, lock := range s.peers {
		peers = append(peers, func(message any) { s.send(connection, lock, message) })
	}
	s.mu.Unlock()
	for _, job := range queue {
		for _, send := range peers {
			send(map[string]any{"method": "install", "params": job})
		}
	}
}
