package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// 常驻服务里管着每个 harness 运行时的那一层。只有它启动、停止运行时；设备进程不许自己起，
// 要停用、启用、重启都经控制通道（control.go）来请它做。
//
// 每个已知的 harness 一个位置，不管这次起没起：起没起来、为什么没起来都记在上面，
// 经控制通道告诉设备进程，客户端在 runtime/info 里看到的就是它。

// 一个 harness 的状态。running 之外的同时是报给客户端的不可用原因分类。
const (
	stateRunning       = "running"
	stateStarting      = "starting"
	stateDisabled      = "disabled"
	stateNotInstalled  = "notInstalled"
	stateVersionTooLow = "versionTooLow"
	stateStartFailed   = "startFailed"
	stateStopped       = "stopped"
)

// 重新应用设置之后等它有结果，最多等这么久：环境检查和等运行时就绪各有 30 秒的上限。
var applySettleTimeout = 75 * time.Second

// 运行时跑起来之后自己停了（崩了、被别人杀了）会自动再起。连着停了几次就每次多等一会儿，
// 这几次都用完还是停就不再试了，留给人看日志、点重启：一起来就倒的运行时再试也是白试。
var autoRestartDelays = []time.Duration{time.Second, 5 * time.Second, 15 * time.Second}

// 一轮稳稳跑过这么久，之前自己停过的次数就不算了。
var autoRestartCalm = 2 * time.Minute

// 等 SSH 入口写下状况最多等这么久。入口每条路都很快写下结果（听上了、端口被占、没备好），正常远用不了这么久。
var entrySettleTimeout = 5 * time.Second

type harnessSlot struct {
	id    string
	state string
	text  *bilingual
	// 这一轮（或者最近一轮）是照哪份设置起的。和现在的设置算出来的不一样，就是“待重启”。
	applied string
	// 第几轮。每重新应用一次设置加一。
	round int
	// 停掉现在这一轮。
	cancel context.CancelFunc
	// 这一轮是被“重新应用”叫停的，不是自己结束的。
	replaced bool
	wake     chan struct{}
	// SSH 入口的设置变了。
	sshWake chan struct{}
	// 最近一次没起来的原因，散场时交回去。
	failure error
	// 这一轮是什么时候跑起来的。没跑起来过是零值。
	ranAt time.Time
	// 连着自己停了几次（每次都自动再起了）。稳稳跑过一阵、或者人来重新应用，就清零。
	crashes int
}

type harnessManager struct {
	base   configuration
	schema settingsSchema
	stage  *startStage
	// 这个状态目录的聚合面归本进程管，而且给得出来。这样的话一个 harness 都没在跑服务也留着：
	// 客户端要能连上来，看到每个 harness 没起来的原因，在设置里改了再试。
	aggregate bool
	// 状态或者设置变了。keys 是这次改了的设置键，只是状态变了时为空。
	changed func(keys []string)

	mu       sync.Mutex
	slots    map[string]*harnessSlot
	quit     chan struct{}
	quitting bool
	// 已经告过警“没有一个 harness 在跑、服务留着”。有 harness 跑起来之后再落到这一步才再说一遍。
	idleWarned bool
	// 官方桌面端经各个 SSH 入口连着的条数，合在一起数（entry.go 的 localRuntime 记）。
	desktops atomic.Int64
}

func newHarnessManager(c configuration) *harnessManager {
	manager := &harnessManager{base: c, schema: buildSettingsSchema(c), slots: map[string]*harnessSlot{}, quit: make(chan struct{})}
	manager.base.desktops = &manager.desktops
	for _, id := range knownHarnesses {
		manager.slots[id] = &harnessSlot{id: id, state: stateStarting, wake: make(chan struct{}, 1), sshWake: make(chan struct{}, 1)}
	}
	return manager
}

// 全部已知 harness 的现行配置，按固定的次序。
func (m *harnessManager) entries() []configuration {
	entries := make([]configuration, 0, len(knownHarnesses))
	for _, id := range knownHarnesses {
		entries = append(entries, m.base.forHarness(id))
	}
	return entries
}

func (m *harnessManager) notify(keys ...string) {
	if m.changed != nil {
		m.changed(keys)
	}
}

// 设置里明确写了停用。
func (m *harnessManager) switchedOff(id string) bool {
	var enabled bool
	raw, written := m.base.settings.lookup(enabledKey(id))
	return written && json.Unmarshal(raw, &enabled) == nil && !enabled
}

// 这个 harness 现在该不该跑；不该跑时是哪种状态、怎么说。
func (m *harnessManager) wanted(id string) (bool, string, bilingual) {
	var enabled bool
	// 原生 codex 只经聚合面提供。聚合面不归本进程管（或者给不出来）时起了它也没有谁能连，不起。
	if id == nativeCodex && !m.aggregate {
		return false, stateDisabled, both(
			"原生 Codex 只经聚合面提供，这次启动没有聚合面",
			"Native Codex is offered through the aggregate endpoint only, and this run has none",
		)
	}
	if raw, written := m.base.settings.lookup(enabledKey(id)); written && json.Unmarshal(raw, &enabled) == nil {
		if enabled {
			return true, "", bilingual{}
		}
		return false, stateDisabled, both("已在设置里停用", "Turned off in settings")
	}
	switch {
	case m.base.harness == id:
	case m.base.harness != "":
		return false, stateDisabled, both(
			"这次启动只选了 %s（--harness）；在设置里启用它就会起来",
			"This run was started for %s only (--harness); enable it in settings to start it",
		).with(harnessNames[m.base.harness])
	case id == "dsh" && !dshInstalled(m.base.forHarness(id)):
		// 怎么办和别的 harness 找不到命令行时是同一句（cliMissing），前面多交代一句它为什么没有照常去试。
		remedy := cliMissing(m.base.forHarness(id))
		return false, stateNotInstalled, both(
			"%s 还在实验阶段，检测到装了才启用。%s",
			"%s is experimental and only starts when it is installed. %s",
		).pair(verbatim(harnessNames[id]), remedy)
	case id == nativeCodex && !codexInstalled(m.base.forHarness(id)):
		return false, stateNotInstalled, both(
			"检测到这台设备装了 %s 才启用。%s",
			"%s is turned on once it is found on this device. %s",
		).pair(verbatim(harnessNames[id]), cliMissing(m.base.forHarness(id)))
	}
	return true, "", bilingual{}
}

func classifyFailure(err error) (string, bilingual) {
	var failure *harnessFailure
	if errors.As(err, &failure) {
		return failure.kind, failure.text
	}
	return stateStartFailed, verbatim(err.Error())
}

// 已经当场告过警的失败。散场时交回去只是为了汇总，不再打印一遍。
type reportedFailure struct{ error }

func (r *reportedFailure) Unwrap() error { return r.error }

// run 是一个 harness 的一生：照现行的设置起它，停了（自己停的，或者被叫停的）就等下一次“重新应用”。
// 一直到 ctx 结束，或者散场（没有一个运行时在跑，聚合面也给不出来）。
func (m *harnessManager) run(ctx context.Context, id string) error {
	slot := m.slots[id]
	for {
		entry := m.base.forHarness(id)
		entry.statusChanged = func() { m.notify() }
		enabled, state, text := m.wanted(id)
		roundContext, cancel := context.WithCancel(ctx)
		m.mu.Lock()
		slot.round++
		slot.replaced = false
		slot.cancel = cancel
		slot.applied = m.base.runtimeFingerprint(id, enabled)
		slot.ranAt = time.Time{}
		select {
		case <-slot.wake:
		default:
		}
		if enabled {
			starting := both("正在检查环境并启动", "Checking the environment and starting")
			slot.state, slot.text, slot.failure = stateStarting, &starting, nil
		} else {
			slot.state, slot.text, slot.failure = state, &text, nil
		}
		m.mu.Unlock()
		m.notify()
		var err error
		if enabled {
			fmt.Printf(tr("[%s] 正在检测本机 CLI 和运行环境…\n", "[%s] Checking the local CLI and runtime…\n"), id)
			err = serveRuntime(roundContext, entry, true, m.stage, &runtimeHooks{
				running: func() {
					m.mu.Lock()
					slot.ranAt = time.Now()
					m.mu.Unlock()
					m.setState(slot, stateRunning, nil)
				},
				ssh: func() (bool, int) {
					current := m.base.forHarness(id)
					return !current.sshDisabled, current.port
				},
				sshWake: slot.sshWake,
			})
		} else {
			m.stage.settle(id, false)
			if id == nativeCodex {
				// 上一次的服务被强杀时它可能正开着：现在不用它了，留下的 app-server 也要收掉
				sweepCodexOrphan(entry)
			}
			if m.switchedOff(id) {
				fmt.Printf(tr("[%s] 已在设置里停用，不启动。\n", "[%s] Turned off in settings; not started.\n"), id)
			}
		}
		cancel()
		if ctx.Err() != nil {
			return nil
		}
		m.mu.Lock()
		replaced := slot.replaced
		m.mu.Unlock()
		if replaced {
			continue
		}
		if enabled && err == nil {
			err = errors.New(tr("引擎已停止", "The engine has stopped"))
		}
		if enabled {
			if delay, attempt, again := m.autoRestart(slot, err); again {
				if m.waitAutoRestart(ctx, slot, err, delay, attempt) {
					continue
				}
				return nil
			}
			// 先把这个入口的原因说出来，再改状态：最后一个落空时接着要说“原因见上”。
			warnEntryFailure(fmt.Errorf("%s: %w", id, err))
		}
		m.mu.Lock()
		if slot.replaced {
			m.mu.Unlock()
			continue
		}
		if enabled {
			kind, reason := classifyFailure(err)
			if kind == stateStopped && slot.crashes > 0 {
				reason = bilingual{
					ZH: fmt.Sprintf("%s（已经自动重启了 %d 次，还是停了，不再自动试）", reason.ZH, slot.crashes),
					EN: fmt.Sprintf("%s (restarted automatically %d times and it stopped again; not retrying)", reason.EN, slot.crashes),
				}
			}
			slot.state, slot.text, slot.failure = kind, &reason, &reportedFailure{err}
		}
		idle := m.considerQuit()
		m.mu.Unlock()
		if enabled {
			m.notify()
		}
		if idle {
			warnNoHarness()
		}
		select {
		case <-ctx.Done():
			return nil
		case <-m.quit:
			return slot.failure
		case <-slot.wake:
		}
	}
}

// autoRestart 看这一轮停下来之后要不要自己再起。只管跑起来过又自己停了的：没起来的（没装、版本不够、
// 起到一半就倒）再试也是原样，留给人改了设置再试。返回等多久、这是连着的第几次。
func (m *harnessManager) autoRestart(slot *harnessSlot, err error) (delay time.Duration, attempt int, again bool) {
	if kind, _ := classifyFailure(err); kind != stateStopped {
		return 0, 0, false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if slot.replaced || m.quitting {
		return 0, 0, false
	}
	if !slot.ranAt.IsZero() && time.Since(slot.ranAt) >= autoRestartCalm {
		slot.crashes = 0
	}
	if slot.crashes >= len(autoRestartDelays) {
		return 0, 0, false
	}
	delay = autoRestartDelays[slot.crashes]
	slot.crashes++
	return delay, slot.crashes, true
}

// waitAutoRestart 把“过一会儿自己再起”说出来，然后等够时间。返回 false 是服务要收了。
// 等的这一会儿状态是“正在起”：不算没有运行时在跑，不会因此散场；人来重新应用就不等了，马上起。
func (m *harnessManager) waitAutoRestart(ctx context.Context, slot *harnessSlot, err error, delay time.Duration, attempt int) bool {
	fmt.Fprintf(os.Stderr, tr("警告：%s: %v；%s 后自动重启（第 %d 次，最多 %d 次）。\n", "Warning: %s: %v; restarting it automatically in %s (attempt %d of %d).\n"),
		slot.id, err, delay, attempt, len(autoRestartDelays))
	text := both(
		"引擎自己停了，正在自动重启（第 %d 次，最多 %d 次）",
		"The engine stopped on its own; restarting it automatically (attempt %d of %d)",
	).with(attempt, len(autoRestartDelays))
	m.mu.Lock()
	if slot.replaced {
		m.mu.Unlock()
		return true
	}
	slot.state, slot.text, slot.failure = stateStarting, &text, nil
	m.mu.Unlock()
	m.notify()
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-slot.wake:
	case <-timer.C:
	}
	return true
}

func (m *harnessManager) setState(slot *harnessSlot, state string, text *bilingual) {
	m.mu.Lock()
	slot.state, slot.text = state, text
	if state == stateRunning {
		m.idleWarned = false
	}
	m.mu.Unlock()
	m.notify()
}

// 没有一个运行时在跑、也没有哪个正在起的时候：聚合面给得出来就留下（返回 true 表示刚落到这一步，
// 该告一次警），给不出来就散场，和以前“没有可用入口就退出”一样。调用时拿着锁。
func (m *harnessManager) considerQuit() (idle bool) {
	if m.quitting {
		return false
	}
	for _, slot := range m.slots {
		if slot.state == stateRunning || slot.state == stateStarting {
			return false
		}
	}
	if m.aggregate {
		idle = !m.idleWarned
		m.idleWarned = true
		return idle
	}
	m.quitting = true
	close(m.quit)
	return false
}

// 让用户自己去检查环境时提的命令。怎么装的名字就怎么叫：Homebrew 和独立安装包装上的是 codex-harness-adapter，
// 从源码目录运行的是 npm 脚本，两个都写上。桌面端自带的那一份用户碰不到命令行，那时在 Litch 的设备管理里运行诊断。
var doctorCommand = both(
	"codex-harness-adapter doctor（从源码目录运行的是 npm run doctor）",
	"codex-harness-adapter doctor (npm run doctor when running from a source checkout)",
)

// 一个 harness 都没在跑，服务却没有退出：说清楚为什么留着、接下来能做什么。
func warnNoHarness() {
	fmt.Fprintln(os.Stderr, both(
		"警告：现在没有可用的 harness（原因见上）。服务没有退出，留着聚合面让 Litch 能连上：在那里能看到每个 harness 的原因、运行诊断，在设置里填好命令行路径后重试。也可以装好所需的 CLI 后重启本服务，或在终端里运行 %s 检查。",
		"Warning: no harness is available right now (see the reasons above). The service stays up and keeps the aggregate endpoint so that Litch can connect: it shows the reason for each harness, can run diagnostics, and lets you retry after setting the CLI path in settings. You can also install the required CLI and restart this service, or run %s in a terminal to check.",
	).pair(doctorCommand))
}

// apply 照现行的设置重新收敛一个 harness：在跑的停了再起（或者不再起），没在跑的再试一次。
// 返回叫停的是第几轮，等结果时用。散场了就不再受理。
func (m *harnessManager) apply(id string) (int, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	slot, known := m.slots[id]
	if !known || m.quitting {
		return 0, false
	}
	slot.replaced = true
	slot.crashes = 0
	// 先标成正在起：到下一轮真的开始之前，不能被当成“没有运行时在跑”而散场。
	slot.state = stateStarting
	if slot.cancel != nil {
		slot.cancel()
	}
	select {
	case slot.wake <- struct{}{}:
	default:
	}
	return slot.round, true
}

// await 等 apply 叫停的那一轮之后的一轮有了结果：起来了、没起来，或者按设置不用起。
// 到了上限还没有结果就带着当时的样子回去。
func (m *harnessManager) await(ctx context.Context, id string, round int) (string, *bilingual) {
	deadline := time.NewTimer(applySettleTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		state, text, current := m.status(id)
		if current > round && state != stateStarting {
			return state, text
		}
		select {
		case <-ctx.Done():
			return state, text
		case <-deadline.C:
			return state, text
		case <-ticker.C:
		}
	}
}

// settleEntries 等 SSH 入口的状况定下来。运行时在跑、入口却还是 idle，说明入口正在起，或者正在照新设置重来，
// 转眼就会写下新的状况（听上了、关了、没起来和原因）。写设置和重新应用的应答要带定下来的样子，所以应答之前等这一下。
// 运行时没在跑的不等：那时 idle 就是定下来的样子。到了上限就不等了，带着当时的样子回去。
func (m *harnessManager) settleEntries(ctx context.Context) {
	deadline := time.NewTimer(entrySettleTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for m.entriesInFlux() {
		select {
		case <-ctx.Done():
			return
		case <-deadline.C:
			return
		case <-ticker.C:
		}
	}
}

func (m *harnessManager) entriesInFlux() bool {
	for _, id := range adapterHarnesses {
		if state, _, _ := m.status(id); state == stateRunning && m.sshEntry(id).State == "idle" {
			return true
		}
	}
	return false
}

func (m *harnessManager) status(id string) (string, *bilingual, int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	slot := m.slots[id]
	return slot.state, slot.text, slot.round
}

// 设置已经改了、但进程还是照旧设置起的那些 harness。
func (m *harnessManager) pendingRestart() []string {
	pending := []string{}
	for _, id := range knownHarnesses {
		enabled, _, _ := m.wanted(id)
		fingerprint := m.base.runtimeFingerprint(id, enabled)
		m.mu.Lock()
		applied := m.slots[id].applied
		m.mu.Unlock()
		if applied != "" && applied != fingerprint {
			pending = append(pending, id)
		}
	}
	return pending
}

// write 按键写入设置。SSH 入口的设置立刻生效；要重启才生效的只是记下来，
// 由调用方（设备进程）看那个 harness 有没有回合在跑，再决定现在就重新应用还是留着待重启。
// fresh 是因为这次写入才变成待重启的 harness：之前就留着等用户重启的不在里面，不借这次写入去动它。
func (m *harnessManager) write(expected int, edits []settingEdit) (changed, fresh []string, problem *settingsProblem, err error) {
	waiting := map[string]bool{}
	for _, id := range m.pendingRestart() {
		waiting[id] = true
	}
	changed, problem, err = m.base.settings.apply(expected, edits, m.schema, m.base.validateSettings)
	fresh = []string{}
	if err != nil || problem != nil || len(changed) == 0 {
		return changed, fresh, problem, err
	}
	for _, id := range m.pendingRestart() {
		if !waiting[id] {
			fresh = append(fresh, id)
		}
	}
	m.mu.Lock()
	for _, slot := range m.slots {
		select {
		case slot.sshWake <- struct{}{}:
		default:
		}
	}
	m.mu.Unlock()
	m.notify(changed...)
	return changed, fresh, nil, nil
}
