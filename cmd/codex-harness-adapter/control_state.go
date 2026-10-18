package main

import (
	"path/filepath"

	"github.com/slovx2/litch/internal/hostplatform"
)

// 经控制通道推给设备进程的那一份现状：每个 harness 的状态，加设置的快照。

type harnessView struct {
	ID string `json:"id"`
	// 它的运行时在哪个套接字上，写法和设备进程的 --upstream 一样。没在跑时那里没有东西。
	Socket string `json:"socket"`
	State  string `json:"state"`
	// 不在运行时的说明。
	Text *bilingual `json:"text"`
	// 它的运行时是原生的 codex，不是适配器：不认识我们的协议扩展，能力声明由设备进程替它整理。
	Native bool `json:"native,omitempty"`
}

type controlState struct {
	// 这一次改了的设置键；只是状态变了时为空。
	Keys      []string         `json:"keys"`
	Harnesses []harnessView    `json:"harnesses"`
	Snapshot  settingsSnapshot `json:"snapshot"`
	// 属于设备的进程（可重连的终端）的上限和期限现在是多少，键和设备进程那边的字段同名。
	// 设备进程照它当场换上：这几项设置改了不用重启它（settings_processes.go）。
	Processes map[string]int `json:"processes"`
	// 定时任务的总开关和同时运行的上限（settings_tasks.go），设备进程照它当场换上。
	Tasks map[string]any `json:"tasks"`
	// 这份服务的来历（service_facts.go）。设备进程在 runtime/info 的 device.service 里把它给客户端。
	Service *serviceFacts `json:"service,omitempty"`
}

type settingsSnapshot struct {
	Version        int            `json:"version"`
	Values         map[string]any `json:"values"`
	Explicit       []string       `json:"explicit"`
	PendingRestart []string       `json:"pendingRestart"`
	SSHEntries     []sshEntryView `json:"sshEntries"`
}

// 给官方桌面端的一个 SSH 入口现在的状况。
type sshEntryView struct {
	Harness string `json:"harness"`
	Enabled bool   `json:"enabled"`
	Port    int    `json:"port"`
	// off、listening、failed；idle 表示运行时没在跑（或者入口正在换设置），入口还没起。
	State  string          `json:"state"`
	Reason *sshEntryReason `json:"reason"`
}

type sshEntryReason struct {
	Kind   string    `json:"kind"` // portUnavailable、setupFailed、startFailed
	Text   bilingual `json:"text"`
	Detail string    `json:"detail"`
}

func (m *harnessManager) view(keys []string) controlState {
	state := controlState{Keys: append([]string{}, keys...), Snapshot: m.snapshot(), Processes: m.base.processLimits(), Tasks: m.base.taskSettings()}
	for _, id := range knownHarnesses {
		current, text, _ := m.status(id)
		if current == stateRunning {
			text = nil
		}
		state.Harnesses = append(state.Harnesses, harnessView{
			ID: id, State: current, Text: text, Native: id == nativeCodex,
			Socket: hostplatform.ListenURL(hostplatform.SocketPath(filepath.Join(m.base.home, id))),
		})
	}
	return state
}

func (m *harnessManager) snapshot() settingsSnapshot {
	version, values, explicit := m.base.settings.present(m.schema)
	snapshot := settingsSnapshot{Version: version, Values: values, Explicit: explicit, PendingRestart: m.pendingRestart()}
	for _, id := range adapterHarnesses {
		snapshot.SSHEntries = append(snapshot.SSHEntries, m.sshEntry(id))
	}
	return snapshot
}

func (m *harnessManager) sshEntry(id string) sshEntryView {
	entry := m.base.forHarness(id)
	view := sshEntryView{Harness: id, Enabled: !entry.sshDisabled, Port: entry.port, State: "idle"}
	if state, _, _ := m.status(id); state != stateRunning {
		return view
	}
	status, recorded := loadSSHEntryStatus(entry)
	// 记下来的和设置对不上，说明入口正在照新设置重来，等它写下新的状况。
	if !recorded || (status.State == "off") == view.Enabled || (view.Enabled && status.Port != view.Port) {
		return view
	}
	view.State = status.State
	if status.State != "failed" {
		return view
	}
	reason := sshEntryReason{Kind: "startFailed", Detail: status.Detail, Text: both(
		"入口没能启动，详见这个 harness 的运行日志",
		"The entry failed to start; see this harness's runtime log",
	)}
	switch status.Reason {
	case "port-unavailable":
		reason.Kind = "portUnavailable"
		reason.Text = both(
			"端口 %d 被占用或者用不了。关掉占用它的程序，或者换一个端口；端口空出来之后入口会自己接上",
			"Port %d is taken or unavailable. Close the program using it, or pick another port; the entry comes up by itself once the port is free",
		).with(status.Port)
	case "setup-failed":
		reason.Kind = "setupFailed"
		reason.Text = both(
			"入口的身份或者主机密钥没有备好",
			"The entry's identity or host key could not be prepared",
		)
	}
	view.Reason = &reason
	return view
}
