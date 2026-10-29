package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

// 常驻服务和设备进程之间的控制通道：<home>/device/ctl.sock，和聚合面的套接字在同一个只有属主能进的目录里。
// 只在本机套接字上，不监听任何网络端口。设备进程启动时看这个路径在不在，在就连上来。
//
// 为什么要有它：运行时由这一层起和停，设置也由这一层读写（它先于设备进程决定起哪些运行时）；
// 而客户端连的是设备进程。所以设备进程把“读写设置、重新应用、诊断、读日志、取 ssh 配置”转到这里来做，
// 这一层把每个 harness 的状态和设置的现状推给设备进程。
//
// 线上是一行一条 JSON：
//   设备进程 → 这里   {"id":N,"method":"settings.read","params":{…}}
//   这里 → 设备进程   {"id":N,"result":{…}} 或 {"id":N,"error":{"reason":"…","text":{…},…}}
//   这里 → 设备进程   {"method":"state","params":{"keys":[…],"harnesses":[…],"snapshot":{…},"service":{…}}}（连上时一次，之后每变一次一条）
//   这里 → 设备进程   {"method":"install","params":{…}}（安装任务开始、日志长了、结束，见 control_install.go）
//   这里 → 设备进程   {"ask":N,"method":"activity"}（这一层反过来问设备进程，现在只有“忙不忙”这一件）
//   设备进程 → 这里   {"reply":N,"result":{…}} 或 {"reply":N,"error":"…"}
//
// 连上来的除了设备进程，还有 device-stop：它发一条 service.stop 请服务自己停（control_service.go）。
// 它也会收到 state 和 ask，前者不理，后者答一个 error。
//
// 会改变状态的两个请求（settings.write、harness.apply）有两条约定，设备进程靠它们给客户端一个定下来的结果：
//   - 等事情定下来才应答：重新应用等到那个 harness 有了结果，SSH 入口等到它写下新的状况（都有上限）；
//   - 应答之前先把现状作为一条 state 送到。所以设备进程收到应答时，手上最新的 state 不比应答里的旧。

// 一行最多这么长。环境变量表整张写进来，给得宽一些。
const controlLineLimit = 16 * 1024 * 1024

var controlWriteTimeout = 10 * time.Second

// 对面发来的一行。带 reply 的是它在答这一层问的事（ask），别的是它的请求。
type controlRequest struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Reply  *int            `json:"reply"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

// 请求没做成的原因。reason：conflict（版本号对不上）、invalid（键或者值不对）、
// unknownHarness、busy（这台设备已经有安装任务在跑）、failed（别的）。
type controlError struct {
	Reason   string            `json:"reason"`
	Text     bilingual         `json:"text"`
	Key      string            `json:"key,omitempty"`
	Harness  string            `json:"harness,omitempty"`
	Snapshot *settingsSnapshot `json:"snapshot,omitempty"`
}

func controlFailure(err error) *controlError {
	return &controlError{Reason: "failed", Text: verbatim(err.Error())}
}

type controlServer struct {
	c        configuration
	manager  *harnessManager
	path     string
	listener net.Listener
	ctx      context.Context
	stop     context.CancelFunc

	mu      sync.Mutex
	peers   map[net.Conn]*sync.Mutex
	pending []string
	dirty   chan struct{}
	done    sync.WaitGroup
	// 算一条 state 和把它发出去是一件事，拿着这把锁做（publish）。
	stateMu sync.Mutex
	// 这份服务的来历，随每条 state 带给设备进程，也带在 service.stop 的应答里。
	facts *serviceFacts
	// 让整个服务停下来。
	shutdown func()
	// 问了设备进程、还在等它答的事（control_service.go）。
	asks    map[int]*pendingAsk
	nextAsk int
	// 给设备装 harness（control_install.go）。进度排在 installQueue 里，由 pump 按先后发。
	installs     *installer
	installQueue []installJob
	installDirty chan struct{}
	// 控制请求的摘要（logs/control.jsonl）
	journal *jsonLog
	power   *powerController
	wake    *wakeObserver
}

// 只有拿着设备锁的进程可以调用：遗留的套接字由它清掉。
func openControlServer(ctx context.Context, c configuration, manager *harnessManager, facts *serviceFacts, shutdown func()) (*controlServer, error) {
	path := hostplatform.ControlSocketPath(c.deviceDirectory())
	if runtime.GOOS != "windows" && len(path) > 100 {
		return nil, errors.New(tr("状态路径过长，无法创建控制通道的 Unix socket", "the state path is too long for the control channel's Unix socket"))
	}
	if err := hostplatform.RemoveSocket(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	listener, err := hostplatform.Listen(path)
	if err != nil {
		return nil, err
	}
	server := &controlServer{c: c, manager: manager, path: path, listener: listener, peers: map[net.Conn]*sync.Mutex{}, dirty: make(chan struct{}, 1),
		facts: facts, shutdown: shutdown, asks: map[int]*pendingAsk{}, installDirty: make(chan struct{}, 1),
		journal: newJSONLog(filepath.Join(c.logsDirectory(), "control.jsonl"), "control")}
	server.journal.write("info", "start", map[string]any{"version": adapterVersion(c.root)})
	server.ctx, server.stop = context.WithCancel(ctx)
	server.power = newPowerController(server.ctx, systemPowerBackend{}, c.powerSettings, func() { server.broadcast(nil) }, func(event string, fields map[string]any) { server.journal.write("info", "power_"+event, fields) })
	server.power.run()
	server.wake = newWakeObserver(&systemWakeSource{})
	server.wake.poll()
	server.done.Add(1)
	go func() {
		defer server.done.Done()
		server.wake.run(server.ctx, func() {
			state := server.wake.read()
			server.journal.write("info", "system_resume", map[string]any{"sequence": state.Sequence, "resumedAt": state.ResumedAt})
			server.broadcast(nil)
		})
	}()
	server.installs = server.newInstaller()
	manager.changed = server.broadcast
	server.done.Add(2)
	go server.accept()
	go server.pump()
	return server, nil
}

func (s *controlServer) close() {
	if s == nil {
		return
	}
	s.stop()
	if s.power != nil {
		s.power.close()
		if s.power.done != nil {
			<-s.power.done
		}
	}
	// 正在装的任务随服务停下（连它起的进程一起），等它收完尾
	s.installs.wait()
	_ = s.listener.Close()
	s.mu.Lock()
	for connection := range s.peers {
		_ = connection.Close()
	}
	s.mu.Unlock()
	s.done.Wait()
	_ = hostplatform.RemoveSocket(s.path)
	s.journal.write("info", "stop", nil)
}

func (s *controlServer) accept() {
	defer s.done.Done()
	for {
		connection, err := s.listener.Accept()
		if err != nil {
			return
		}
		s.done.Add(1)
		go s.serve(connection)
	}
}

// 状态变了。不在这里发：发的事交给 pump，几次变化并成一条，也不会让变化的一方等在写上。
func (s *controlServer) broadcast(keys []string) {
	s.mu.Lock()
	s.pending = append(s.pending, keys...)
	s.mu.Unlock()
	select {
	case s.dirty <- struct{}{}:
	default:
	}
}

func (s *controlServer) pump() {
	defer s.done.Done()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.installDirty:
			s.flushInstalls()
			continue
		case <-s.dirty:
		}
		s.publish()
	}
}

// publish 把现状作为一条 state 发给连着的设备进程，带上攒着还没说的设置键。
// state 只从这里发，而且“算出来”和“发出去”拿着同一把锁：先算的先到，设备进程收到的最后一条一定是最新的。
// 除了 pump（状态变了就发），会改变状态的请求在应答之前也调它一次，见文件开头的约定。
func (s *controlServer) publish() {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	s.mu.Lock()
	keys := append([]string{}, s.pending...)
	s.pending = nil
	peers := make(map[net.Conn]*sync.Mutex, len(s.peers))
	for connection, lock := range s.peers {
		peers[connection] = lock
	}
	s.mu.Unlock()
	if len(peers) == 0 {
		return
	}
	state := s.manager.view(keys)
	state.Service = s.facts
	if s.wake != nil {
		state.Wake = s.wake.read()
	}
	if s.power != nil {
		state.Power = s.power.read()
	}
	message := map[string]any{"method": "state", "params": state}
	for connection, lock := range peers {
		s.send(connection, lock, message)
	}
}

func (s *controlServer) send(connection net.Conn, lock *sync.Mutex, message any) {
	data, err := json.Marshal(message)
	if err != nil {
		return
	}
	lock.Lock()
	defer lock.Unlock()
	_ = connection.SetWriteDeadline(time.Now().Add(controlWriteTimeout))
	if _, err := connection.Write(append(data, '\n')); err != nil {
		// 对面不收了：断开它，它会重新连上来，再拿一份完整的状态。
		_ = connection.Close()
	}
}

func (s *controlServer) serve(connection net.Conn) {
	defer s.done.Done()
	lock := &sync.Mutex{}
	s.mu.Lock()
	s.peers[connection] = lock
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.peers, connection)
		s.mu.Unlock()
		s.departed(connection)
		if s.power != nil {
			s.power.disconnected(connection)
		}
		_ = connection.Close()
	}()
	// 连上来先要一份完整的状态。
	s.broadcast(nil)
	reader := bufio.NewReaderSize(connection, 64*1024)
	for {
		line, err := readControlLine(reader)
		if err != nil {
			return
		}
		var request controlRequest
		if json.Unmarshal(line, &request) != nil {
			continue
		}
		if request.Reply != nil {
			s.answered(connection, *request.Reply, request.Result, len(request.Error) > 0)
			continue
		}
		if request.Method == "" || len(request.ID) == 0 {
			continue
		}
		// 重新应用设置要等运行时起来，诊断也要跑一阵：各做各的，不让后面的请求排队。
		s.done.Add(1)
		go func() {
			defer s.done.Done()
			if request.Method == "service.stop" {
				s.stopService(connection, lock, request)
				return
			}
			began := time.Now()
			var result any
			var failure *controlError
			if request.Method == "power.activity" && s.power != nil {
				result, failure = s.handlePowerActivity(request.Params, connection)
			} else {
				result, failure = s.handle(request.Method, request.Params)
			}
			s.record(request, began, failure)
			if request.Method == "settings.write" || request.Method == "harness.apply" || request.Method == "power.registerLocal" {
				// 应答之前先把现状送到：设备进程拿手上最新的 state 当这次请求的结果，不用猜后面还有没有一条。
				s.publish()
			}
			if failure != nil {
				s.send(connection, lock, map[string]any{"id": request.ID, "error": failure})
				return
			}
			s.send(connection, lock, map[string]any{"id": request.ID, "result": result})
		}()
	}
}

// 记一条控制请求的摘要：方法、harness（参数里有的话）、成败、耗时、失败的原因和原文。参数别的不记（设置里有密钥）。
func (s *controlServer) record(request controlRequest, began time.Time, failure *controlError) {
	fields := map[string]any{"method": request.Method, "ok": failure == nil, "ms": time.Since(began).Milliseconds()}
	var params struct {
		Harness string `json:"harness"`
	}
	if json.Unmarshal(request.Params, &params) == nil && params.Harness != "" {
		fields["harness"] = params.Harness
	}
	level := "info"
	if failure != nil {
		level = "warn"
		fields["reason"] = failure.Reason
		fields["error"] = logErrorText(failure.Text.String())
	}
	s.journal.write(level, "control", fields)
}

func readControlLine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		part, err := reader.ReadSlice('\n')
		line = append(line, part...)
		if err == nil {
			return line, nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
		if len(line) > controlLineLimit {
			return nil, errors.New("control line too long")
		}
	}
}

func decodeControlParams(params json.RawMessage, target any) *controlError {
	if len(params) == 0 {
		return nil
	}
	if err := json.Unmarshal(params, target); err != nil {
		return &controlError{Reason: "invalid", Text: both("参数的形状不对", "The parameters are malformed")}
	}
	return nil
}

func (s *controlServer) handle(method string, params json.RawMessage) (any, *controlError) {
	switch method {
	case "power.read", "power.activity", "power.registerLocal":
		return s.handlePower(method, params)
	case "settings.read":
		return map[string]any{
			"schema":       s.manager.settingsSchema(),
			"snapshot":     s.manager.snapshot(),
			"inheritedEnv": inheritedEnvironment(s.c.userEnv),
		}, nil
	case "settings.write":
		var request struct {
			ExpectedVersion *int          `json:"expectedVersion"`
			Edits           []settingEdit `json:"edits"`
		}
		if failure := decodeControlParams(params, &request); failure != nil {
			return nil, failure
		}
		if request.ExpectedVersion == nil {
			return nil, &controlError{Reason: "invalid", Text: both("写入要带 expectedVersion", "A write needs expectedVersion")}
		}
		changed, fresh, problem, err := s.manager.write(*request.ExpectedVersion, request.Edits)
		if err != nil {
			return nil, controlFailure(fmt.Errorf(tr("设置没能写进磁盘: %w", "the settings could not be written to disk: %w"), err))
		}
		if problem != nil {
			failure := &controlError{Reason: problem.reason, Text: problem.text, Key: problem.key}
			if problem.reason == "conflict" {
				snapshot := s.manager.snapshot()
				failure.Snapshot = &snapshot
			}
			return nil, failure
		}
		if s.power != nil {
			s.power.refresh()
		}
		// SSH 入口的设置是当场生效的，入口要照新设置重来一遍：等它写下新的状况再应答，
		// 应答里带的就是定下来的样子，不是“正在换”。
		s.manager.settleEntries(s.ctx)
		return map[string]any{"changed": changed, "newlyPending": fresh, "snapshot": s.manager.snapshot()}, nil
	case "harness.apply":
		var request struct {
			Harness string `json:"harness"`
		}
		if failure := decodeControlParams(params, &request); failure != nil {
			return nil, failure
		}
		return s.applyHarness(request.Harness)
	case "diagnostics.run":
		var request struct {
			Harness string `json:"harness"`
		}
		if failure := decodeControlParams(params, &request); failure != nil {
			return nil, failure
		}
		return s.diagnostics(request.Harness)
	case "logs.tail":
		var request logRequest
		if failure := decodeControlParams(params, &request); failure != nil {
			return nil, failure
		}
		return s.logTail(request)
	case "ssh.config":
		return s.sshConfig(), nil
	case "harness.versions":
		var request struct {
			Latest bool `json:"latest"`
		}
		if failure := decodeControlParams(params, &request); failure != nil {
			return nil, failure
		}
		return map[string]any{"harnesses": s.installs.cache.versions(s.ctx, s.versionSource(), request.Latest)}, nil
	case "harness.install":
		var request struct {
			Harness string `json:"harness"`
			Version string `json:"version"`
		}
		if failure := decodeControlParams(params, &request); failure != nil {
			return nil, failure
		}
		job, failure := s.installs.start(request.Harness, request.Version)
		if failure != nil {
			return nil, failure
		}
		return map[string]any{"job": job}, nil
	case "harness.install.read":
		return map[string]any{"jobs": s.installs.jobs()}, nil
	case "codex.models":
		return s.codexModels()
	}
	return nil, &controlError{Reason: "failed", Text: both("不认识的控制命令 %s", "Unknown control command %s").with(method)}
}

func unknownHarness(id string) *controlError {
	return &controlError{Reason: "unknownHarness", Harness: id, Text: both("这台设备上没有 %s 这个 harness", "This device has no harness named %s").with(id)}
}

func isKnownHarness(id string) bool {
	for _, known := range knownHarnesses {
		if known == id {
			return true
		}
	}
	return false
}

// 照现行的设置重新收敛一个 harness，等到有结果才返回：它起来了、没起来，或者按设置不用起；
// 起来了的话再等它的 SSH 入口写下状况。这样应答里的状态、待重启名单、入口状况都是定下来的。
func (s *controlServer) applyHarness(id string) (any, *controlError) {
	if !isKnownHarness(id) {
		return nil, unknownHarness(id)
	}
	round, accepted := s.manager.apply(id)
	if !accepted {
		return nil, &controlError{Reason: "failed", Harness: id, Text: both("服务正在退出，没有受理", "The service is shutting down; the request was not accepted")}
	}
	state, text := s.manager.await(s.ctx, id, round)
	s.manager.settleEntries(s.ctx)
	return map[string]any{"harness": id, "state": state, "text": text, "snapshot": s.manager.snapshot()}, nil
}
