package sshtransport

import (
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestBackgroundPolicy(t *testing.T) {
	var pauses []bool
	p := newBackgroundPolicy(func(value bool) { pauses = append(pauses, value) })
	now := time.Unix(100, 0)
	p.now = func() time.Time { return now }
	var fire func()
	var delay time.Duration
	var timers int
	p.schedule = func(after time.Duration, run func()) func() {
		delay, fire = after, run
		timers++
		return func() {}
	}
	p.setBackground(true)
	if delay != 5*time.Minute {
		t.Fatalf("默认不是五分钟: %v", delay)
	}
	p.setBackground(true)
	if timers != 1 {
		t.Fatal("重复后台事件重置了计时")
	}
	old := fire
	// 模拟冻结十一个分钟后直接回前台：不能补执行到期断开。
	now = now.Add(11 * time.Minute)
	p.setBackground(false)
	old()
	if p.state.Suspended || len(pauses) != 1 || pauses[0] {
		t.Fatalf("回前台被旧 timer 暂停: %v", pauses)
	}
	p.setBackground(true)
	old()
	if p.state.Suspended {
		t.Fatal("上一轮 timer 影响了新一轮")
	}
	fire()
	if !p.state.Suspended || !pauses[len(pauses)-1] {
		t.Fatal("后台到期没暂停")
	}
	p.configure(0)
	if !p.state.Suspended {
		t.Fatal("改成从不后在后台恢复了连接")
	}
	p.setBackground(false)
	p.setBackground(true)
	if p.cancel != nil || p.state.Suspended {
		t.Fatal("从不仍安排了 timer")
	}
	now = now.Add(time.Minute)
	p.configure(5 * time.Minute)
	if delay != 4*time.Minute {
		t.Fatalf("后台变更设置没有沿用开始时间: %v", delay)
	}
	old = fire
	p.configure(0)
	old()
	if p.state.Suspended {
		t.Fatal("从不没撤销原 timer")
	}
}

func TestSuspendClosesEveryStreamAndAllowsResume(t *testing.T) {
	setStreamsPaused(false)
	t.Cleanup(func() { setStreamsPaused(true); setStreamsPaused(false) })
	signer, key := newKey(t)
	server := startServer(t, signer.PublicKey())
	target, _ := json.Marshal(server.target(t, key, ssh.FingerprintSHA256(server.host)))
	for _, id := range []string{"background-a", "background-b"} {
		if _, err := OpenStream(id, string(target), "", "marker"); err != nil {
			t.Fatal(err)
		}
	}
	setStreamsPaused(true)
	for _, id := range []string{"background-a", "background-b"} {
		state, _ := StreamState(id)
		if !strings.Contains(state, `"closed":true`) {
			t.Fatalf("%s 没关闭: %s", id, state)
		}
	}
	if _, err := OpenStream("background-retry", string(target), "", "marker"); err == nil {
		t.Fatal("暂停后仍能拨号")
	}
	setStreamsPaused(false)
	if _, err := OpenStream("background-resumed", string(target), "", "marker"); err != nil {
		t.Fatalf("回前台不能重连: %v", err)
	}
}

func TestSuspendCancelsInFlightHandshake(t *testing.T) {
	setStreamsPaused(false)
	t.Cleanup(func() { setStreamsPaused(true); setStreamsPaused(false) })
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() { conn, _ := listener.Accept(); accepted <- conn }()
	_, key := newKey(t)
	address := listener.Addr().(*net.TCPAddr)
	target, _ := json.Marshal(Target{Host: "127.0.0.1", Port: address.Port, User: "test", PrivateKey: key, HostFingerprint: "SHA256:test"})
	done := make(chan error, 1)
	go func() { _, err := OpenStream("background-opening", string(target), "", "marker"); done <- err }()
	select {
	case conn := <-accepted:
		defer conn.Close()
	case <-time.After(time.Second):
		t.Fatal("没有发起握手")
	}
	setStreamsPaused(true)
	setStreamsPaused(false)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("旧握手在回前台后复活")
		}
	case <-time.After(time.Second):
		t.Fatal("取消握手没有关闭 TCP，还在等原来的十五秒超时")
	}
	streams.Lock()
	defer streams.Unlock()
	if len(streams.opening) != 0 || len(streams.items) != 0 {
		t.Fatal("取消后还留着开流或连接")
	}
}

// 与 Android 相同的启动时钟：深睡只推进 elapsedRealtime，不依赖 Go 的运行时 timer。
type fakeBackgroundScheduler struct {
	now, deadline, epoch int64
	cancelled            bool
}

func (s *fakeBackgroundScheduler) NowMillis() int64 { return s.now }
func (s *fakeBackgroundScheduler) Schedule(deadline, epoch int64) {
	s.deadline, s.epoch, s.cancelled = deadline, epoch, false
}
func (s *fakeBackgroundScheduler) Cancel() { s.cancelled = true }

func TestBackgroundElapsedDeadline(t *testing.T) {
	SetAppBackground(false)
	SetBackgroundTimeout(5)
	scheduler := &fakeBackgroundScheduler{now: 1000}
	SetBackgroundScheduler(scheduler)
	t.Cleanup(func() { SetAppBackground(false); SetBackgroundScheduler(nil) })
	SetAppBackground(true)
	if scheduler.deadline != 301000 {
		t.Fatalf("期限不是五分钟: %d", scheduler.deadline)
	}
	// 深睡四分钟后改为十分钟，仍从最初的后台时刻计算。
	scheduler.now += 240000
	SetBackgroundTimeout(10)
	if scheduler.deadline != 601000 {
		t.Fatalf("深睡未计入期限: %d", scheduler.deadline)
	}
	scheduler.now += 420000
	BackgroundDeadline(scheduler.epoch)
	if !strings.Contains(ConnectionPolicyState(), `"suspended":true`) {
		t.Fatal("后台醒来到期未断开")
	}
	SetAppBackground(false)
	SetBackgroundTimeout(5)
	SetAppBackground(true)
	old := scheduler.epoch
	scheduler.now += 360000
	SetAppBackground(false)
	BackgroundDeadline(old)
	if !scheduler.cancelled || strings.Contains(ConnectionPolicyState(), `"suspended":true`) {
		t.Fatal("前台被迟到闹钟补断")
	}
}

func TestSuspendBlocksScriptsAndPairing(t *testing.T) {
	setStreamsPaused(true)
	t.Cleanup(func() { setStreamsPaused(false) })
	for name, run := range map[string]func() error{
		"script": func() error { _, err := RunScript(`{}`, "", ""); return err },
		"pair":   func() error { _, err := EnrollPair(`{}`, "{}"); return err },
	} {
		t.Run(name, func(t *testing.T) {
			if err := run(); err == nil || !strings.Contains(err.Error(), "后台连接已暂停") {
				t.Fatalf("绕过统一闸门: %v", err)
			}
		})
	}
}

func TestSuspendCancelsScriptAndPairHandshake(t *testing.T) {
	for _, operation := range []string{"script", "pair"} {
		t.Run(operation, func(t *testing.T) {
			setStreamsPaused(false)
			t.Cleanup(func() { setStreamsPaused(true); setStreamsPaused(false) })
			listener, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			accepted := make(chan net.Conn, 1)
			go func() { conn, _ := listener.Accept(); accepted <- conn }()
			_, key := newKey(t)
			target, _ := json.Marshal(Target{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port,
				User: "test", PrivateKey: key, HostFingerprint: "SHA256:test"})
			done := make(chan error, 1)
			go func() {
				var err error
				if operation == "script" {
					_, err = RunScript(string(target), "", "")
				} else {
					_, err = EnrollPair(string(target), "{}")
				}
				done <- err
			}()
			select {
			case conn := <-accepted:
				defer conn.Close()
			case <-time.After(time.Second):
				t.Fatal("没有发起握手")
			}
			setStreamsPaused(true)
			setStreamsPaused(false)
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("旧请求复活")
				}
			case <-time.After(time.Second):
				t.Fatal("暂停未取消握手")
			}
		})
	}
}

func TestSuspendClosesAuthenticatedNonStream(t *testing.T) {
	setStreamsPaused(false)
	t.Cleanup(func() { setStreamsPaused(false) })
	signer, key := newKey(t)
	server := startServer(t, signer.PublicKey())
	client, err := connectSSH(t.Context(), server.target(t, key, ssh.FingerprintSHA256(server.host)))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	closed := make(chan error, 1)
	go func() { closed <- client.Wait() }()
	// 不经过 OpenStream 的连接也必须被统一闸门关闭。
	setStreamsPaused(true)
	setStreamsPaused(false)
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("已认证的非 stream 连接绕过暂停")
	}
	resumed, err := connectSSH(t.Context(), server.target(t, key, ssh.FingerprintSHA256(server.host)))
	if err != nil {
		t.Fatal(err)
	}
	defer resumed.Close()
	if _, _, err := resumed.SendRequest("keepalive@openssh.com", true, nil); err != nil {
		t.Fatalf("新连接被上一轮取消: %v", err)
	}
}
