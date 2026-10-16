//go:build !windows

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

// 扮演设备进程的那一头：连上控制通道，收 state，发请求。
type controlClient struct {
	t          *testing.T
	connection net.Conn
	mu         sync.Mutex
	next       int
	waiting    map[int]chan controlReply
	states     []controlState
	// 服务问“忙不忙”时怎么答。nil：答不上（像一条不是设备进程的连接）。
	activity func() deviceActivity
	// 被问过几次。
	asked int
}

type controlReply struct {
	Result json.RawMessage `json:"result"`
	Error  *controlError   `json:"error"`
}

func dialControl(t *testing.T, cfg configuration) *controlClient {
	t.Helper()
	path := hostplatform.ControlSocketPath(cfg.deviceDirectory())
	var connection net.Conn
	waitUntil(t, "控制通道能连", func() bool {
		var err error
		connection, err = hostplatform.Dial(path)
		return err == nil
	})
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("控制通道的套接字应只有属主可读写: %v %v", info, err)
	}
	client := &controlClient{t: t, connection: connection, waiting: map[int]chan controlReply{}}
	t.Cleanup(func() { _ = connection.Close() })
	go func() {
		reader := bufio.NewReader(connection)
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			var frame struct {
				ID     *int            `json:"id"`
				Ask    *int            `json:"ask"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
				controlReply
			}
			if json.Unmarshal(line, &frame) != nil {
				continue
			}
			if frame.Ask != nil {
				client.mu.Lock()
				client.asked++
				answer := map[string]any{"reply": *frame.Ask, "error": "not the device process"}
				if client.activity != nil && frame.Method == "activity" {
					answer = map[string]any{"reply": *frame.Ask, "result": client.activity()}
				}
				client.mu.Unlock()
				data, _ := json.Marshal(answer)
				_, _ = connection.Write(append(data, '\n'))
				continue
			}
			client.mu.Lock()
			if frame.Method == "state" {
				var state controlState
				if json.Unmarshal(frame.Params, &state) == nil {
					client.states = append(client.states, state)
				}
			} else if frame.ID != nil {
				if reply, ok := client.waiting[*frame.ID]; ok {
					delete(client.waiting, *frame.ID)
					reply <- frame.controlReply
				}
			}
			client.mu.Unlock()
		}
	}()
	return client
}

func (c *controlClient) call(method string, params any) (json.RawMessage, *controlError) {
	c.t.Helper()
	reply := make(chan controlReply, 1)
	c.mu.Lock()
	c.next++
	id := c.next
	c.waiting[id] = reply
	c.mu.Unlock()
	data, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		c.t.Fatal(err)
	}
	if _, err := c.connection.Write(append(data, '\n')); err != nil {
		c.t.Fatal(err)
	}
	select {
	case answer := <-reply:
		return answer.Result, answer.Error
	case <-time.After(30 * time.Second):
		c.t.Fatalf("%s 没有等到应答", method)
		return nil, nil
	}
}

// 只发不等应答。
func (c *controlClient) post(method string, params any) {
	c.t.Helper()
	data, err := json.Marshal(map[string]any{"id": 0, "method": method, "params": params})
	if err != nil {
		c.t.Fatal(err)
	}
	if _, err := c.connection.Write(append(data, '\n')); err != nil {
		c.t.Fatal(err)
	}
}

// 调用并要求成功，把结果解到 target 里。
func (c *controlClient) must(method string, params, target any) {
	c.t.Helper()
	result, failure := c.call(method, params)
	if failure != nil {
		c.t.Fatalf("%s 失败: %+v", method, failure)
	}
	if target != nil {
		if err := json.Unmarshal(result, target); err != nil {
			c.t.Fatalf("%s 的结果解不开: %v\n%s", method, err, result)
		}
	}
}

func (c *controlClient) latest() (controlState, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.states) == 0 {
		return controlState{}, false
	}
	return c.states[len(c.states)-1], true
}

// 等最新的一条 state 满足条件。
func (c *controlClient) waitState(what string, condition func(controlState) bool) controlState {
	c.t.Helper()
	var found controlState
	waitUntil(c.t, what, func() bool {
		state, ok := c.latest()
		found = state
		return ok && condition(state)
	})
	return found
}

// 收到过的 state 里有没有哪一条带着这个设置键。
func (c *controlClient) sawKey(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, state := range c.states {
		for _, seen := range state.Keys {
			if seen == key {
				return true
			}
		}
	}
	return false
}

func (s controlState) harness(id string) harnessView {
	for _, view := range s.Harnesses {
		if view.ID == id {
			return view
		}
	}
	return harnessView{}
}

func (s settingsSnapshot) sshEntry(id string) sshEntryView {
	for _, view := range s.SSHEntries {
		if view.Harness == id {
			return view
		}
	}
	return sshEntryView{}
}

func (s settingsSnapshot) pending(id string) bool {
	for _, harness := range s.PendingRestart {
		if harness == id {
			return true
		}
	}
	return false
}

// 写入并要求成功，返回写入之后的快照。
func (c *controlClient) write(version int, edits ...settingEdit) settingsSnapshot {
	c.t.Helper()
	var result struct {
		Changed  []string         `json:"changed"`
		Snapshot settingsSnapshot `json:"snapshot"`
	}
	c.must("settings.write", map[string]any{"expectedVersion": version, "edits": edits}, &result)
	if len(result.Changed) != len(edits) || result.Snapshot.Version != version+1 {
		c.t.Fatalf("写入的结果不对: %+v", result)
	}
	return result.Snapshot
}

type applyResult struct {
	Harness  string           `json:"harness"`
	State    string           `json:"state"`
	Text     *bilingual       `json:"text"`
	Snapshot settingsSnapshot `json:"snapshot"`
}

// 重新应用一个 harness 的设置，等它有结果。
func (c *controlClient) apply(id string) applyResult {
	c.t.Helper()
	var result applyResult
	c.must("harness.apply", map[string]any{"harness": id}, &result)
	return result
}

// 管理用例里的假运行时：比 writeStartFixture 多三样——
// 启动时把 FIXTURE_MARK 和自己的进程号记在状态目录里（看环境变量有没有生效、进程换没换）；
// 命令行路径指向不存在的文件时照真引擎的原话报“未找到”；认得终端自检。
func writeManagedFixture(t *testing.T, entry configuration) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(entry.adapter()), 0o700); err != nil {
		t.Fatal(err)
	}
	fixture := fmt.Sprintf(`import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
const cli = process.env[%q];
if (process.argv.includes('--runtime-info')) {
  if (cli && !fs.existsSync(cli)) { console.error('Error: 宿主 CLI 不可执行或未找到: ' + cli + ' INTERNAL_DETAIL'); process.exit(1); }
  console.log(JSON.stringify({engine:%q,protocolVersion:'0.157.1',nodeVersion:process.versions.node}));
} else if (process.argv.includes('--pty-self-check')) {
  console.log('pty-self-check ok');
} else {
  const socket = process.argv.at(-1).slice(7);
  console.error('fixture runtime started ' + (process.env.FIXTURE_MARK ?? ''));
  fs.writeFileSync(path.join(path.dirname(socket), 'fixture-env.json'), JSON.stringify({mark: process.env.FIXTURE_MARK ?? null, pid: process.pid}));
  net.createServer(c=>{c.on('error',()=>{});c.end('runtime-proxy')}).listen(socket);
}
`, harnessCLIVariable[entry.harness], entry.harness)
	if err := os.WriteFile(entry.adapter(), []byte(fixture), 0o600); err != nil {
		t.Fatal(err)
	}
}

type fixtureEnvironment struct {
	Mark *string `json:"mark"`
	PID  int     `json:"pid"`
}

func readFixtureEnvironment(t *testing.T, entry configuration) fixtureEnvironment {
	t.Helper()
	var environment fixtureEnvironment
	data, err := os.ReadFile(filepath.Join(entry.directory(), "fixture-env.json"))
	if err != nil || json.Unmarshal(data, &environment) != nil {
		t.Fatalf("假运行时没有留下记录: %v", err)
	}
	return environment
}

// 两个入口都用管理用例的假运行时，带一个能就绪的假设备进程；服务已经起来，控制通道已经连上。
func startManaged(t *testing.T) (configuration, []configuration, *controlClient, func()) {
	t.Helper()
	cfg, entries := deviceTestConfiguration(t)
	for _, entry := range entries {
		writeManagedFixture(t, entry)
	}
	writeDeviceFixture(t, cfg, "ok", 0)
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() { done <- start(ctx, cfg) }()
	for _, entry := range entries {
		waitStartedHarness(t, entry, done)
	}
	var once sync.Once
	return cfg, entries, dialControl(t, cfg), func() { once.Do(func() { stopStarted(t, cancel, done) }) }
}
