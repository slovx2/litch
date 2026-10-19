//go:build !windows

package main

// pair-enroll、pair 对着假的设备服务（machine_unix_test.go 的 fakeDevice）跑：
// pair-enroll 发出去的请求、写回的一行、各种错误；pair 的出码、长轮询、确认、拒绝、过期换码、Ctrl-C 取消、自检。
// 对着真的设备进程跑的端到端由主线在合并后做。

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func runPairEnrollAgainst(t *testing.T, socket, stdin string, argv ...string) map[string]any {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := pairEnrollMain(context.Background(), argv, machineIO{
		stdin: strings.NewReader(stdin), stdout: &stdout, stderr: &stderr,
		env: envOf(map[string]string{deviceSocketEnvironment: socket}),
	})
	if code != 0 || stderr.Len() != 0 || strings.Count(stdout.String(), "\n") != 1 || !strings.HasSuffix(stdout.String(), "\n") {
		t.Fatalf("应当只往标准输出写一行、退出码 0：%d %q %q", code, stdout.String(), stderr.String())
	}
	var output map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("不是 JSON：%q", stdout.String())
	}
	return output
}

func TestPairEnrollAgainstFakeDevice(t *testing.T) {
	device := startFakeDevice(t)
	device.answer = func(method string, params map[string]any) (any, *deviceRPCError) {
		if method != pairEnrollMethod {
			return nil, &deviceRPCError{Code: -32601, Message: "no"}
		}
		input, _ := params["input"].(map[string]any)
		switch params["pairId"] {
		case "Ab3dEf6hIj9kLm2n":
			if input["probe"] == true {
				return map[string]any{"ok": true, "probe": true}, nil
			}
			return map[string]any{"ok": true, "phoneId": "f83898df0bef57a4"}, nil
		case "Rejected":
			return map[string]any{"ok": false, "error": "rejected", "message": "拒绝了"}, nil
		case "Gone":
			return nil, &deviceRPCError{Code: -32602, Message: "没有这个配对", Data: json.RawMessage(`{"reason":"unknownPair"}`)}
		case "Keys":
			return nil, &deviceRPCError{Code: -32000, Message: "只读", Data: json.RawMessage(`{"reason":"keysFile"}`)}
		case "Old":
			return nil, &deviceRPCError{Code: -32600, Message: "Not initialized"}
		case "Garbled":
			return map[string]any{"hello": 1}, nil
		}
		return nil, &deviceRPCError{Code: -32602, Message: "参数不对"}
	}
	enroll := `{"v":1,"publicKey":"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl","name":"Pixel 8"}` + "\n"

	output := runPairEnrollAgainst(t, device.socket, enroll, "Ab3dEf6hIj9kLm2n")
	if output["ok"] != true || output["phoneId"] != "f83898df0bef57a4" || len(output) != 2 {
		t.Fatalf("登记成功：%v", output)
	}
	device.mu.Lock()
	sent := device.seen[0]
	device.mu.Unlock()
	params := sent["params"].(map[string]any)
	input := params["input"].(map[string]any)
	if sent["method"] != pairEnrollMethod || params["pairId"] != "Ab3dEf6hIj9kLm2n" || input["name"] != "Pixel 8" || input["v"] != float64(1) {
		t.Fatalf("发出去的请求不对：%v", sent)
	}
	if output := runPairEnrollAgainst(t, device.socket, `{"v":1,"probe":true}`, "Ab3dEf6hIj9kLm2n"); output["ok"] != true || output["probe"] != true {
		t.Fatalf("自检：%v", output)
	}
	cases := []struct {
		name, stdin, pairID, want string
	}{
		{"设备服务回拒绝", enroll, "Rejected", "rejected"},
		{"配对号不认识", enroll, "Gone", "expired"},
		{"钥匙文件改不了", enroll, "Keys", "keysFile"},
		{"设备服务太旧", enroll, "Old", "unavailable"},
		{"应答看不懂", enroll, "Garbled", "unavailable"},
		{"别的参数错误", enroll, "Other", "invalid"},
		{"输入不是 JSON", "hello\n", "Ab3dEf6hIj9kLm2n", "invalid"},
		{"输入是数组", "[1]\n", "Ab3dEf6hIj9kLm2n", "invalid"},
		{"没有输入", "", "Ab3dEf6hIj9kLm2n", "invalid"},
		{"输入超长", strings.Repeat("x", 5000), "Ab3dEf6hIj9kLm2n", "invalid"},
		{"配对号里有怪字符", enroll, "a b;rm", "expired"},
	}
	for _, c := range cases {
		output := runPairEnrollAgainst(t, device.socket, c.stdin, c.pairID)
		if output["ok"] != false || output["error"] != c.want || output["message"] == "" {
			t.Fatalf("%s：%v", c.name, output)
		}
	}
	// 参数不对也只写一行
	if output := runPairEnrollAgainst(t, device.socket, enroll); output["error"] != "invalid" {
		t.Fatalf("没给配对号：%v", output)
	}
	// 设备服务没在运行：不拉起，回 unavailable
	missing := filepath.Join(filepath.Dir(device.socket), "missing.sock")
	if output := runPairEnrollAgainst(t, missing, enroll, "Ab3dEf6hIj9kLm2n"); output["error"] != "unavailable" || !strings.Contains(output["message"].(string), "没在运行") {
		t.Fatalf("连不上：%v", output)
	}
}

// 假的设备服务里的配对：一个状态，长轮询等它变
type fakePairing struct {
	mu        sync.Mutex
	changed   chan struct{}
	pairID    string
	state     string
	phone     map[string]any
	starts    int
	decisions []bool
	cancels   []string
	waits     int
	// 每次 start 之后立刻过期（测换码的上限）
	autoExpire bool
}

func (f *fakePairing) set(state string, phone map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.state, f.phone = state, phone
	close(f.changed)
	f.changed = make(chan struct{})
}

func (f *fakePairing) status() map[string]any {
	return map[string]any{"pairId": f.pairID, "state": f.state, "expiresAt": time.Now().Add(10 * time.Minute).UnixMilli(), "phone": f.phone}
}

func (f *fakePairing) answer(method string, params map[string]any) (any, *deviceRPCError) {
	f.mu.Lock()
	switch method {
	case pairStartMethod:
		f.starts++
		f.pairID, f.state, f.phone = fmt.Sprintf("Pair%d", f.starts), "waiting", nil
		if f.autoExpire {
			f.state = "expired"
		}
		f.mu.Unlock()
		return map[string]any{
			"pairId": f.pairID, "seed": pairSample.Seed, "expiresAt": time.Now().Add(10 * time.Minute).UnixMilli(),
			"hostKey":  map[string]any{"type": "ssh-ed25519", "fingerprint": "SHA256:host", "publicKey": "ssh-ed25519 AAAAhost"},
			"hostKeys": []any{}, "hostname": "song-debian", "user": "song",
		}, nil
	case pairWaitMethod:
		f.waits++
		deadline := time.After(2 * time.Second)
		for params["pairId"] == f.pairID && params["since"] == f.state {
			changed := f.changed
			f.mu.Unlock()
			select {
			case <-changed:
			case <-deadline:
				f.mu.Lock()
				defer f.mu.Unlock()
				return f.status(), nil
			}
			f.mu.Lock()
		}
		defer f.mu.Unlock()
		return f.status(), nil
	case pairDecideMethod:
		f.decisions = append(f.decisions, params["allow"] == true)
		f.mu.Unlock()
		if params["allow"] == true {
			f.set("done", f.phone)
		} else {
			f.set("rejected", f.phone)
		}
		return map[string]any{}, nil
	case pairCancelMethod:
		f.cancels = append(f.cancels, params["pairId"].(string))
		f.mu.Unlock()
		f.set("cancelled", nil)
		return map[string]any{}, nil
	}
	f.mu.Unlock()
	return nil, &deviceRPCError{Code: -32601, Message: "no"}
}

// 多个协程一起写、一起读的输出
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func eventually(t *testing.T, what string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatalf("等不到：%s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

type pairRun struct {
	fake           *fakePairing
	home           string
	stdout, stderr *lockedBuffer
	stdin          *io.PipeWriter
	cancel         context.CancelFunc
	done           chan int
	ensured        chan pairTarget
}

// 起一次 pair：状态目录是新建的临时目录，假的设备服务就在它下面的 device/device.sock
func startPairRun(t *testing.T, fake *fakePairing, lookSSH func() (string, error), extra ...string) *pairRun {
	t.Helper()
	home, err := os.MkdirTemp("/tmp", "lp-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	fake.changed = make(chan struct{})
	device := startFakeDeviceAt(t, filepath.Join(home, "device", "device.sock"))
	device.answer = fake.answer
	if lookSSH == nil {
		lookSSH = func() (string, error) { return "", os.ErrNotExist }
	}
	reader, writer := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	run := &pairRun{fake: fake, home: home, stdout: &lockedBuffer{}, stderr: &lockedBuffer{}, stdin: writer,
		cancel: cancel, done: make(chan int, 1), ensured: make(chan pairTarget, 1)}
	t.Cleanup(func() { cancel(); _ = writer.Close() })
	pio := pairIO{
		stdin: reader, stdout: run.stdout, stderr: run.stderr, env: envOf(nil), lookSSH: lookSSH,
		ensure: func(_ context.Context, target pairTarget, _ io.Writer) error { run.ensured <- target; return nil },
	}
	go func() { run.done <- pairMain(ctx, append([]string{"--home", home}, extra...), pio) }()
	return run
}

func (r *pairRun) exit(t *testing.T) int {
	t.Helper()
	select {
	case code := <-r.done:
		return code
	case <-time.After(10 * time.Second):
		t.Fatalf("pair 没有结束。输出：\n%s\n%s", r.stdout, r.stderr)
		return -1
	}
}

func (r *pairRun) polled(t *testing.T, starts int) {
	t.Helper()
	eventually(t, "开始长轮询", func() bool {
		r.fake.mu.Lock()
		defer r.fake.mu.Unlock()
		return r.fake.starts == starts && r.fake.waits >= starts
	})
}

func (r *pairRun) request(t *testing.T) {
	t.Helper()
	r.fake.set("requested", map[string]any{"phoneId": "f83898df0bef57a4", "name": "Pixel 8", "fingerprint": "SHA256:phone", "code": "482913"})
	eventually(t, "问 y/N", func() bool { return strings.Contains(r.stdout.String(), "允许吗？[y/N]") })
}

// 输出里的配对文本，一张码一份，解回来
func pairTextsIn(t *testing.T, output string) []map[string]any {
	t.Helper()
	var found []map[string]any
	for _, line := range strings.Split(output, "\n") {
		if body, ok := strings.CutPrefix(line, pairPayloadPrefix); ok {
			var payload map[string]any
			data, err := base64.RawURLEncoding.DecodeString(body)
			if err != nil || json.Unmarshal(data, &payload) != nil {
				t.Fatalf("配对文本解不开：%q", line)
			}
			found = append(found, payload)
		}
	}
	if len(found) == 0 {
		t.Fatalf("输出里没有配对文本：\n%s", output)
	}
	return found
}

func pairTextIn(t *testing.T, output string) map[string]any {
	t.Helper()
	return pairTextsIn(t, output)[0]
}

func TestPairAllowsPhone(t *testing.T) {
	run := startPairRun(t, &fakePairing{}, nil, "--host", "device-ts", "--port", "2222", "--name", "开发机")
	if target := <-run.ensured; target.socket != filepath.Join(run.home, "device", "device.sock") || target.home != run.home {
		t.Fatalf("找设备服务的地方不对：%+v", target)
	}
	run.polled(t, 1)
	run.request(t)
	_, _ = run.stdin.Write([]byte("y\n"))
	if code := run.exit(t); code != 0 {
		t.Fatalf("退出码 %d：%s\n%s", code, run.stdout, run.stderr)
	}
	output := run.stdout.String()
	for _, want := range []string{"本机没有 ssh 客户端，跳过", "\x1b[30;107m", "确认码 482 913", "已允许", "已绑定手机“Pixel 8”"} {
		if !strings.Contains(output, want) {
			t.Fatalf("输出里没有 %q：\n%s", want, output)
		}
	}
	payload := pairTextIn(t, output)
	k := payload["k"].(map[string]any)
	if payload["v"] != float64(1) || payload["n"] != "开发机" || payload["h"] != "device-ts" || payload["p"] != float64(2222) ||
		payload["u"] != "song" || k["t"] != "ssh-ed25519" || k["f"] != "SHA256:host" || payload["s"] != pairSample.Seed || payload["i"] != "Pair1" {
		t.Fatalf("配对文本不对：%v", payload)
	}
	if run.fake.decisions[0] != true || len(run.fake.decisions) != 1 || len(run.fake.cancels) != 0 {
		t.Fatalf("decide %v cancel %v", run.fake.decisions, run.fake.cancels)
	}
}

func TestPairDefaultsAndReject(t *testing.T) {
	run := startPairRun(t, &fakePairing{}, nil)
	run.polled(t, 1)
	// 没有请求时敲的回车不算数
	_, _ = run.stdin.Write([]byte("y\n"))
	run.request(t)
	_, _ = run.stdin.Write([]byte("n\n"))
	if code := run.exit(t); code != pairExitFailed {
		t.Fatalf("退出码 %d", code)
	}
	payload := pairTextIn(t, run.stdout.String())
	if payload["n"] != "song-debian" || payload["h"] != "song-debian" || payload["p"] != float64(22) {
		t.Fatalf("默认值不对：%v", payload)
	}
	if len(run.fake.decisions) != 1 || run.fake.decisions[0] || !strings.Contains(run.stdout.String(), "已拒绝") {
		t.Fatalf("decide %v：%s", run.fake.decisions, run.stdout)
	}
}

func TestPairRenewsExpiredCode(t *testing.T) {
	run := startPairRun(t, &fakePairing{}, nil)
	run.polled(t, 1)
	run.fake.set("expired", nil)
	run.polled(t, 2)
	run.request(t)
	_, _ = run.stdin.Write([]byte("yes\n"))
	if code := run.exit(t); code != 0 {
		t.Fatalf("退出码 %d：%s", code, run.stderr)
	}
	output := run.stdout.String()
	texts := pairTextsIn(t, output)
	if !strings.Contains(output, "换一张新的") || len(texts) != 2 || texts[0]["i"] != "Pair1" || texts[1]["i"] != "Pair2" {
		t.Fatalf("应当出了两张码，第二张是新的配对号：\n%s", output)
	}
	// 自检只在第一张码之前做一次
	if strings.Count(output, "自检：") != 1 {
		t.Fatalf("自检做了不止一次：\n%s", output)
	}
}

func TestPairStopsRenewingAfterLimit(t *testing.T) {
	run := startPairRun(t, &fakePairing{autoExpire: true}, nil)
	if code := run.exit(t); code != pairExitFailed {
		t.Fatalf("退出码 %d", code)
	}
	if run.fake.starts != pairMaxRenewals+1 || !strings.Contains(run.stdout.String(), "不再换") {
		t.Fatalf("start 了 %d 次：%s", run.fake.starts, run.stdout)
	}
}

func TestPairCtrlCCancels(t *testing.T) {
	run := startPairRun(t, &fakePairing{}, nil)
	run.polled(t, 1)
	run.cancel()
	if code := run.exit(t); code != pairExitInterrupted {
		t.Fatalf("退出码 %d", code)
	}
	if len(run.fake.cancels) != 1 || run.fake.cancels[0] != "Pair1" || !strings.Contains(run.stdout.String(), "已取消") {
		t.Fatalf("cancel %v：%s %s", run.fake.cancels, run.stdout, run.stderr)
	}
	// 请求来了、正在问 y/N 时按 Ctrl-C 也一样
	run = startPairRun(t, &fakePairing{}, nil)
	run.polled(t, 1)
	run.request(t)
	run.cancel()
	if code := run.exit(t); code != pairExitInterrupted || len(run.fake.cancels) != 1 || len(run.fake.decisions) != 0 {
		t.Fatalf("退出码 %d，cancel %v，decide %v", code, run.fake.cancels, run.fake.decisions)
	}
}

func TestPairStdinClosedMeansNo(t *testing.T) {
	run := startPairRun(t, &fakePairing{}, nil)
	run.polled(t, 1)
	run.request(t)
	_ = run.stdin.Close()
	if code := run.exit(t); code != pairExitFailed || len(run.fake.decisions) != 1 || run.fake.decisions[0] {
		t.Fatalf("退出码 %d，decide %v", code, run.fake.decisions)
	}
}

// 假的 ssh：记下参数、私钥的权限和内容、known_hosts、标准输入，再按 answer 回话。不碰真的 ssh 和 ~/.ssh
func fakeSSH(t *testing.T, answer string) (path, logs string) {
	t.Helper()
	dir := t.TempDir()
	logs = filepath.Join(dir, "logs")
	if err := os.Mkdir(logs, 0o700); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
log='` + logs + `'
printf '%s\n' "$@" > "$log/args"
key=; hosts=
while [ $# -gt 0 ]; do
  case "$1" in
    -i) key=$2; shift ;;
    -o) case "$2" in UserKnownHostsFile=*) hosts=${2#UserKnownHostsFile=} ;; esac; shift ;;
  esac
  shift
done
ls -l "$key" | cut -c1-10 > "$log/keymode"
cat "$key" > "$log/key"
cat "$hosts" > "$log/known_hosts"
dirname "$key" > "$log/workdir"
IFS= read -r line
printf '%s' "$line" > "$log/stdin"
` + answer + "\n"
	path = filepath.Join(dir, "ssh")
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return path, logs
}

func readLog(t *testing.T, logs, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(logs, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestPairSelfCheck(t *testing.T) {
	sshPath, logs := fakeSSH(t, `echo '{"ok":true,"probe":true}'`)
	run := startPairRun(t, &fakePairing{}, func() (string, error) { return sshPath, nil }, "--port", "2222")
	run.polled(t, 1)
	if output := run.stdout.String(); !strings.Contains(output, "自检通过") {
		t.Fatalf("自检应当通过：\n%s\n%s", output, run.stderr)
	}
	run.cancel()
	run.exit(t)
	args := readLog(t, logs, "args")
	for _, want := range []string{"-F\n/dev/null\n", "-T\n", "-p\n2222\n", "-l\nsong\n", "IdentitiesOnly=yes\n", "IdentityAgent=none\n",
		"BatchMode=yes\n", "StrictHostKeyChecking=yes\n", "GlobalKnownHostsFile=/dev/null\n", "\n127.0.0.1\n"} {
		if !strings.Contains(args, want) {
			t.Fatalf("ssh 的参数里没有 %q：\n%s", want, args)
		}
	}
	if mode := strings.TrimSpace(readLog(t, logs, "keymode")); mode != "-rw-------" {
		t.Fatalf("私钥文件的权限是 %s", mode)
	}
	signer, err := ssh.ParsePrivateKey([]byte(readLog(t, logs, "key")))
	if err != nil {
		t.Fatalf("私钥不是 OpenSSH 认得的格式：%v", err)
	}
	seed, _ := base64.RawURLEncoding.DecodeString(pairSample.Seed)
	want, _ := ssh.NewPublicKey(ed25519.NewKeyFromSeed(seed).Public())
	if !bytes.Equal(signer.PublicKey().Marshal(), want.Marshal()) {
		t.Fatal("私钥不是种子对应的那一把")
	}
	if hosts := readLog(t, logs, "known_hosts"); hosts != "[127.0.0.1]:2222 ssh-ed25519 AAAAhost\n" {
		t.Fatalf("known_hosts：%q", hosts)
	}
	if stdin := readLog(t, logs, "stdin"); stdin != `{"v":1,"probe":true}` {
		t.Fatalf("标准输入：%q", stdin)
	}
	// 临时文件放在状态目录里，用完删掉
	work := strings.TrimSpace(readLog(t, logs, "workdir"))
	if filepath.Dir(work) != filepath.Join(run.home, "device") {
		t.Fatalf("临时目录不在状态目录里：%s", work)
	}
	if _, err := os.Stat(work); !os.IsNotExist(err) {
		t.Fatalf("临时目录没删：%v", err)
	}
}

func TestPairSelfCheckFailureStillShowsCode(t *testing.T) {
	sshPath, _ := fakeSSH(t, `echo 'song@127.0.0.1: Permission denied (publickey).' >&2; exit 255`)
	run := startPairRun(t, &fakePairing{}, func() (string, error) { return sshPath, nil })
	run.polled(t, 1)
	run.cancel()
	run.exit(t)
	output := run.stdout.String()
	for _, want := range []string{"自检没通过", "Permission denied (publickey).", "AuthorizedKeysFile", pairPayloadPrefix} {
		if !strings.Contains(output, want) {
			t.Fatalf("输出里没有 %q：\n%s", want, output)
		}
	}
	// 设备服务回的自检失败（比如配对号已经作废）也照原话说
	sshPath, _ = fakeSSH(t, `echo '{"ok":false,"error":"expired","message":"过期了"}'`)
	run = startPairRun(t, &fakePairing{}, func() (string, error) { return sshPath, nil })
	run.polled(t, 1)
	run.cancel()
	run.exit(t)
	if output := run.stdout.String(); !strings.Contains(output, "expired: 过期了") {
		t.Fatalf("输出里没有设备服务的原话：\n%s", output)
	}
}
