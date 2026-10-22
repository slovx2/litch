package main

// pair：用户 ssh 进这台机器后运行，不用桌面端就能把它绑到手机上。设备服务没在跑先拉起来；
// 调 litch/pair/start 拿一次性钥匙，在终端里画二维码、打印配对文本；用 litch/pair/wait 长轮询，
// 有手机来登记时打印手机名和确认码、问 y/N，按回答调 litch/pair/decide。Ctrl-C 调 litch/pair/cancel 删掉一次性钥匙行。
// 标准输入关了（没人能回 y）也取消。二维码过期了自动换一张新的（和桌面端一样，决 292），最多换 pairMaxRenewals 次，免得没人管的终端一直挂着。
// 这台机器开着 Tailscale SSH（tailscale debug prefs 里 RunSSH 为 true）时先问手机是不是走 Tailscale 地址，
// 是就出 Tailscale 方式的码：设备服务不写一次性钥匙行，自检改成用临时钥匙经本机 ssh 连 --host 给的地址执行登记命令。

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// 过期后最多再换几张：一张 10 分钟，加上第一张一共一个小时
const pairMaxRenewals = 5

// 退出码：绑上了是 0；拒绝、过期、被取消是 1；Ctrl-C 是 130
const (
	pairExitFailed      = 1
	pairExitInterrupted = 130
)

type pairIO struct {
	stdin          io.Reader
	stdout, stderr io.Writer
	env            func(string) string
	// 设备服务没在跑时拉起来（ensurePairDevice）。测试里换成什么都不做
	ensure func(ctx context.Context, target pairTarget, stderr io.Writer) error
	// 找 ssh 客户端，找不到就跳过自检
	lookSSH func() (string, error)
	// 这台机器开着 Tailscale SSH 没有。测试里换成固定的
	tailscaleSSH func(ctx context.Context) bool
	// 读 host:port 的 SSH 横幅（头一行），连不上是空的。测试里换成固定的
	banner func(ctx context.Context, host string, port int) string
}

type pairOptions struct {
	host, name, home string
	port             int
	help             bool
}

func runPair(ctx context.Context, argv []string) error {
	// 经 ssh 在终端里跑时，断开连接来的是 SIGHUP：和 Ctrl-C 一样取消，删掉一次性钥匙行
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGHUP)
	defer stop()
	code := pairMain(ctx, argv, pairIO{
		stdin: os.Stdin, stdout: os.Stdout, stderr: os.Stderr, env: os.Getenv,
		ensure:       ensurePairDevice,
		lookSSH:      func() (string, error) { return exec.LookPath("ssh") },
		tailscaleSSH: func(ctx context.Context) bool { return detectTailscaleSSH(ctx, os.Getenv) },
		banner:       sshBanner,
	})
	if code == 0 {
		return nil
	}
	return &exitError{code: code, err: errSilent}
}

func parsePairArgs(argv []string) (pairOptions, error) {
	options := pairOptions{}
	flags := flag.NewFlagSet("pair", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&options.host, "host", "", "")
	flags.IntVar(&options.port, "port", 22, "")
	flags.StringVar(&options.name, "name", "", "")
	flags.StringVar(&options.home, "home", "", "")
	if err := flags.Parse(argv); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			options.help = true
			return options, nil
		}
		return options, err
	}
	if flags.NArg() != 0 {
		return options, errors.New(tr("不接受位置参数", "positional arguments are not accepted"))
	}
	if options.port < 1 || options.port > 65535 {
		return options, errors.New(tr("--port 必须在 1 到 65535 之间", "--port must be between 1 and 65535"))
	}
	return options, nil
}

func pairMain(ctx context.Context, argv []string, pio pairIO) int {
	options, err := parsePairArgs(argv)
	if err != nil {
		fmt.Fprintln(pio.stderr, err)
		fmt.Fprintln(pio.stderr, tr("用法见 codex-harness-adapter pair --help", "See codex-harness-adapter pair --help"))
		return machineExitUsage
	}
	if options.help {
		fmt.Fprintln(pio.stdout, tr(pairHelpZH, pairHelpEN))
		return 0
	}
	target := resolvePairTarget(options.home, pio.env)
	if err := pio.ensure(ctx, target, pio.stderr); err != nil {
		fmt.Fprintln(pio.stderr, err)
		return pairExitFailed
	}
	session := &pairSession{pio: pio, socket: target.socket, options: options, lines: readLines(pio.stdin)}
	if target.home != "" {
		session.stateDir = filepath.Join(target.home, "device")
	}
	return session.run(ctx)
}

// 一次 pair 的全过程，可能换好几张码
type pairSession struct {
	pio      pairIO
	socket   string
	stateDir string
	options  pairOptions
	// 标准输入一行一行地来；读完了通道关掉
	lines <-chan string
	// pairModeKey 或 pairModeTailscale
	mode string
}

func (s *pairSession) run(ctx context.Context) int {
	mode, outcome := s.chooseMode(ctx)
	switch outcome {
	case "interrupted":
		return pairExitInterrupted
	case "closed":
		return pairExitFailed
	}
	s.mode = mode
	for renewals := 0; ; renewals++ {
		start, err := s.start(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return pairExitInterrupted
			}
			fmt.Fprintln(s.pio.stderr, err)
			return pairExitFailed
		}
		payload := s.payload(start)
		if renewals == 0 {
			s.selfCheck(ctx, start, payload)
		}
		s.show(start, payload)
		switch s.watch(ctx, start) {
		case "done":
			return 0
		case "expired":
			if renewals < pairMaxRenewals {
				fmt.Fprintln(s.pio.stdout, tr("\n二维码过期了，换一张新的。", "\nThe code expired; here is a new one."))
				continue
			}
			fmt.Fprintf(s.pio.stdout, tr("\n二维码过期了，已经换过 %d 次，不再换。需要时重新运行 pair。\n", "\nThe code expired and has been renewed %d times already; run pair again when you need one.\n"), pairMaxRenewals)
			return pairExitFailed
		case "interrupted":
			return pairExitInterrupted
		default:
			return pairExitFailed
		}
	}
}

// 这台机器开着 Tailscale SSH 时问一句手机是不是走 Tailscale 地址；没开就是一次性钥匙。
// 第二个返回值：ok、interrupted（Ctrl-C）、closed（标准输入关了，没人能回答）
func (s *pairSession) chooseMode(ctx context.Context) (string, string) {
	if s.pio.tailscaleSSH == nil || !s.pio.tailscaleSSH(ctx) {
		return pairModeKey, "ok"
	}
	out := s.pio.stdout
	fmt.Fprintln(out, tr(
		"这台机器开着 Tailscale SSH：经 tailnet 进来的 SSH 连接由 tailscaled 按 ACL 放行，不看 authorized_keys，一次性钥匙的强制命令不生效。",
		"This machine runs Tailscale SSH: SSH connections arriving over the tailnet are let in by tailscaled according to the ACL, without reading authorized_keys, so the one-time key's forced command has no effect."))
	fmt.Fprint(out, tr("手机经 Tailscale 地址连这台机器吗？[y/N] ", "Will the phone reach this machine at its Tailscale address? [y/N] "))
	select {
	case <-ctx.Done():
		fmt.Fprintln(out)
		return "", "interrupted"
	case line, open := <-s.lines:
		if !open {
			fmt.Fprintln(out)
			fmt.Fprintln(out, tr("标准输入已经关了，没人能回答，不出码。", "Standard input is closed and nobody can answer; no code is shown."))
			return "", "closed"
		}
		if isYes(line) {
			return pairModeTailscale, "ok"
		}
		return pairModeKey, "ok"
	}
}

// 调 litch/pair/start。每次单独连一条：长轮询的那条在等应答，不和它挤
func (s *pairSession) start(ctx context.Context) (pairStartResponse, error) {
	var start pairStartResponse
	params := map[string]any{}
	if s.mode == pairModeTailscale {
		params["mode"] = pairModeTailscale
	}
	raw, err := pairCall(ctx, s.socket, pairStartMethod, params, 30*time.Second)
	if err != nil {
		return start, pairCallError(err)
	}
	if json.Unmarshal(raw, &start) != nil || start.PairID == "" || start.HostKey.Fingerprint == "" {
		return start, errors.New(tr("设备服务的应答看不懂", "the device service sent an answer this command cannot read"))
	}
	if s.mode == pairModeTailscale {
		if start.Mode != pairModeTailscale || start.EnrollCommand == "" {
			// 老的设备服务不认 mode，照旧写了一次性钥匙行：作废掉
			s.cancelQuietly(start.PairID)
			return start, errors.New(tr("这台机器上在跑的设备服务太旧，不支持 Tailscale 方式。请升级适配器，用 device-stop 停掉设备服务后再试。", "The device service running on this machine is too old for the Tailscale way. Upgrade the adapter, stop the device service with device-stop, then try again."))
		}
	} else if start.Seed == "" {
		return start, errors.New(tr("设备服务的应答看不懂", "the device service sent an answer this command cannot read"))
	}
	return start, nil
}

// 单独连一条、调一次就断开。timeout 为 0 表示只跟着 ctx
func pairCall(ctx context.Context, socket, method string, params any, timeout time.Duration) (json.RawMessage, error) {
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	rpc, err := dialDevice(ctx, socket)
	if err != nil {
		return nil, err
	}
	defer rpc.Close()
	return rpc.call(ctx, method, params)
}

// 出错时给人看的话
func pairCallError(err error) error {
	if pairTooOld(err) {
		return errors.New(tr("这台机器上在跑的设备服务太旧，还不支持扫码绑定。请升级适配器，用 device-stop 停掉设备服务后再试。", "The device service running on this machine is too old for pairing. Upgrade the adapter, stop the device service with device-stop, then try again."))
	}
	var rpcErr *deviceRPCError
	if errors.As(err, &rpcErr) {
		message := tr("设备服务回了错误：", "The device service answered with an error: ") + rpcErr.Message
		switch pairErrorReason(rpcErr) {
		case "keysFile":
			message += "\n" + tr("这台机器的 authorized_keys 改不了（符号链接、只读、属主或权限不对，常见于被配置管理工具管着），请手动添加手机的公钥。", "This machine's authorized_keys cannot be changed (a symlink, read-only, or wrong owner or permissions, often because a configuration tool manages it); add the phone's public key by hand.")
		case "noHostKey":
			message += "\n" + tr("读不到这台机器的主机钥匙（/etc/ssh/ssh_host_*_key.pub），手机没法核对连到的是不是它。", "The host keys of this machine (/etc/ssh/ssh_host_*_key.pub) cannot be read, so the phone has no way to check it reaches this machine.")
		}
		return errors.New(message)
	}
	var unreachable *deviceUnreachable
	if errors.As(err, &unreachable) {
		return fmt.Errorf("%w\n%s", err, unreachableHint(err))
	}
	return err
}

// 二维码里的东西：地址四项按参数，没给就用设备服务报的主机名和用户
func (s *pairSession) payload(start pairStartResponse) pairPayload {
	hostname := start.Hostname
	if hostname == "" {
		hostname, _ = os.Hostname()
	}
	payload := pairPayload{
		Name: s.options.name, Host: s.options.host, Port: s.options.port, User: start.User,
		HostKeyType: start.HostKey.Type, HostKeyFP: start.HostKey.Fingerprint,
		PairID: start.PairID, ExpiresAt: start.ExpiresAt,
	}
	if s.mode == pairModeTailscale {
		payload.Tailscale, payload.Command = true, start.EnrollCommand
	} else {
		payload.Seed = start.Seed
	}
	if payload.Host == "" {
		payload.Host = hostname
	}
	if payload.Name == "" {
		payload.Name = hostname
	}
	return payload
}

// 标准输入一行一行地交出来，读完了关掉通道
func readLines(stdin io.Reader) <-chan string {
	lines := make(chan string)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(stdin)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
	}()
	return lines
}

// detectTailscaleSSH：tailscale debug prefs 的 JSON 里 RunSSH 为 true。和设备服务（pair-host.mts）的判断一样，
// 命令行换成 LITCH_TAILSCALE_CLI 给的（测试用）；命令不在、跑不通、看不懂都算没开
func detectTailscaleSSH(ctx context.Context, env func(string) string) bool {
	cli := env("LITCH_TAILSCALE_CLI")
	if cli == "" {
		cli = "tailscale"
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, cli, "debug", "prefs").Output()
	if err != nil {
		return false
	}
	var prefs struct {
		RunSSH bool `json:"RunSSH"`
	}
	return json.Unmarshal(output, &prefs) == nil && prefs.RunSSH
}

// sshBanner 只连 TCP、读 SSH 服务的头一行，不登录。最多等 3 秒，连不上、不是 SSH 是空的
func sshBanner(ctx context.Context, host string, port int) string {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	connection, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return ""
	}
	defer connection.Close()
	deadline, _ := ctx.Deadline()
	_ = connection.SetReadDeadline(deadline)
	line, _ := bufio.NewReader(io.LimitReader(connection, 255)).ReadString('\n')
	line = strings.TrimRight(line, "\r\n")
	if !strings.HasPrefix(line, "SSH-") {
		return ""
	}
	return line
}

func isYes(answer string) bool {
	switch strings.ToLower(strings.TrimSpace(answer)) {
	case "y", "yes", "是":
		return true
	}
	return false
}
