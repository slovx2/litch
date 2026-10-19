package main

// pair-enroll <配对号>：一次性钥匙行的强制命令。手机用一次性钥匙 SSH 登录后，sshd 只让它跑这一条，
// 客户端要求执行的是什么都不管（sshd 放在 SSH_ORIGINAL_COMMAND 里，这里不看它）。
// 从标准输入读一行 PairEnrollInput，交给设备服务（litch/pair/enroll，一直挂到允许、拒绝或超时），
// 把 PairEnrollOutput 写成一行到标准输出，退出码一律是 0：手机只看那一行。
//
// 设备服务没在跑时不替它拉起，直接回 unavailable：配对只存在设备服务的内存里，服务没在跑就说明这个配对号已经作废了
// （服务重启时会删掉所有一次性钥匙行，这一行是残留），拉起来也只会回 expired；
// 而且拿着这把钥匙的不一定是自己人（二维码可能被人拍走），不让它能在这台机器上拉起常驻服务，
// 何况 sshd 给强制命令的环境很简陋，在那里拉起的服务连 PATH 都可能不对。

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"
)

var (
	// 读手机那一行最多等多久：连上来却一直不写，不能让这个进程一直挂着
	pairEnrollReadTimeout = 30 * time.Second
	// 等设备服务回的上限。正常最多 2 分钟（PAIR_DECIDE_TIMEOUT_MS）就有结果，这里只防设备服务卡死，所以给得很宽
	pairEnrollCallTimeout = 15 * time.Minute
)

// 输入一行最多 4 KB（不算换行）
const pairEnrollInputMax = 4096

// 配对号：设备服务生成的随机 16 字符；这里放宽一点，只挡掉明显不是配对号的东西
var pairIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// PairEnrollOutput。键的顺序就是写出来的顺序
type pairEnrollOutput struct {
	OK      bool   `json:"ok"`
	Probe   bool   `json:"probe,omitempty"`
	PhoneID string `json:"phoneId,omitempty"`
	Error   string `json:"error,omitempty"`
	Message string `json:"message,omitempty"`
}

func pairEnrollFailure(code, message string) pairEnrollOutput {
	return pairEnrollOutput{OK: false, Error: code, Message: message}
}

func runPairEnroll(ctx context.Context, argv []string) error {
	code := pairEnrollMain(ctx, argv, machineIO{stdin: os.Stdin, stdout: os.Stdout, stderr: os.Stderr, env: os.Getenv})
	if code == 0 {
		return nil
	}
	return &exitError{code: code, err: errSilent}
}

func pairEnrollMain(ctx context.Context, argv []string, io machineIO) int {
	home, pairID, help, err := parsePairEnrollArgs(argv)
	if help {
		fmt.Fprintln(io.stdout, tr(pairEnrollHelpZH, pairEnrollHelpEN))
		return 0
	}
	var output pairEnrollOutput
	if err != nil {
		output = pairEnrollFailure("invalid", err.Error())
	} else {
		output = pairEnroll(ctx, resolvePairTarget(home, io.env).socket, pairID, io.stdin)
	}
	encoder := json.NewEncoder(io.stdout)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(output)
	return 0
}

// pair-enroll [--home DIR] <配对号>
func parsePairEnrollArgs(argv []string) (home, pairID string, help bool, err error) {
	var positional []string
	for index := 0; index < len(argv); index++ {
		arg := argv[index]
		switch {
		case arg == "--help" || arg == "-h":
			return "", "", true, nil
		case arg == "--home":
			if index+1 >= len(argv) {
				return "", "", false, errors.New(tr("选项 --home 要跟一个值", "the option --home needs a value"))
			}
			index++
			home = argv[index]
		case strings.HasPrefix(arg, "--home="):
			home = strings.TrimPrefix(arg, "--home=")
		default:
			positional = append(positional, arg)
		}
	}
	if len(positional) != 1 {
		return "", "", false, errors.New(tr("用法：pair-enroll [--home DIR] <配对号>", "usage: pair-enroll [--home DIR] <pair id>"))
	}
	return home, positional[0], false, nil
}

func pairEnroll(ctx context.Context, socket, pairID string, stdin io.Reader) pairEnrollOutput {
	if !pairIDPattern.MatchString(pairID) {
		return pairEnrollFailure("expired", tr("配对号不对，请在电脑上重新生成二维码", "unknown pair id; generate a new code on the computer"))
	}
	line, err := readPairEnrollLine(stdin, pairEnrollReadTimeout)
	if err != nil {
		return pairEnrollFailure("invalid", err.Error())
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(line, &object) != nil || object == nil {
		return pairEnrollFailure("invalid", tr("输入不是一个 JSON 对象", "the input is not a JSON object"))
	}
	ctx, cancel := context.WithTimeout(ctx, pairEnrollCallTimeout)
	defer cancel()
	rpc, err := dialDevice(ctx, socket)
	if err != nil {
		return pairEnrollFailure("unavailable", tr("这台机器上的设备服务没在运行，二维码已经作废，请在电脑上重新生成", "the device service on this machine is not running, so the code is no longer valid; generate a new one on the computer"))
	}
	defer rpc.Close()
	raw, err := rpc.call(ctx, pairEnrollMethod, map[string]any{"pairId": pairID, "input": json.RawMessage(line)})
	if err != nil {
		return pairEnrollRPCFailure(err)
	}
	var output pairEnrollOutput
	if json.Unmarshal(raw, &output) != nil || (!output.OK && output.Error == "") {
		return pairEnrollFailure("unavailable", tr("设备服务的应答看不懂", "the device service sent an answer this command cannot read"))
	}
	return output
}

// 调用出错时换成 PairEnrollOutput
func pairEnrollRPCFailure(err error) pairEnrollOutput {
	if pairTooOld(err) {
		return pairEnrollFailure("unavailable", tr("这台机器上的设备服务太旧，不支持扫码绑定，请升级适配器并重启设备服务", "the device service on this machine is too old for pairing; upgrade the adapter and restart the device service"))
	}
	var rpcErr *deviceRPCError
	if !errors.As(err, &rpcErr) {
		return pairEnrollFailure("unavailable", err.Error())
	}
	switch pairErrorReason(rpcErr) {
	case "unknownPair":
		return pairEnrollFailure("expired", rpcErr.Message)
	case "keysFile":
		return pairEnrollFailure("keysFile", rpcErr.Message)
	}
	if rpcErr.Code == -32602 {
		return pairEnrollFailure("invalid", rpcErr.Message)
	}
	return pairEnrollFailure("unavailable", rpcErr.Message)
}

// 读一行：到换行或读完为止，最多 pairEnrollInputMax 字节。手机写完不一定关标准输入，所以见到换行就停，不等读完。
// 什么都没读到、超长、超时都算输入不对。
func readPairEnrollLine(stdin io.Reader, timeout time.Duration) ([]byte, error) {
	type result struct {
		line []byte
		err  error
	}
	done := make(chan result, 1)
	go func() {
		reader := bufio.NewReader(io.LimitReader(stdin, pairEnrollInputMax+1))
		line, err := reader.ReadBytes('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			done <- result{err: err}
			return
		}
		done <- result{line: line}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil, fmt.Errorf(tr("%s 内没有收到输入", "no input within %s"), timeout)
	case got := <-done:
		if got.err != nil {
			return nil, fmt.Errorf(tr("读输入出错：%v", "cannot read the input: %v"), got.err)
		}
		line := bytes.TrimRight(got.line, "\r\n")
		if len(got.line) > pairEnrollInputMax && !bytes.HasSuffix(got.line, []byte("\n")) {
			return nil, fmt.Errorf(tr("输入超过 %d 字节", "the input is longer than %d bytes"), pairEnrollInputMax)
		}
		if len(bytes.TrimSpace(line)) == 0 {
			return nil, errors.New(tr("没有收到输入", "no input"))
		}
		return line, nil
	}
}

const pairEnrollHelpZH = `pair-enroll [--home DIR] <配对号>

扫码绑定手机时，一次性钥匙行的强制命令（设备服务写进 authorized_keys），不是给人直接用的。
从标准输入读一行 JSON（最多 4 KB），交给本机的设备服务，把结果写成一行 JSON 到标准输出。
要在终端里出码，用 pair。`

const pairEnrollHelpEN = `pair-enroll [--home DIR] <pair id>

The forced command of the one-time key line the device service writes to authorized_keys while pairing a phone;
not meant to be run by hand. Reads one JSON line (at most 4 KB) from stdin, hands it to the device service on this
machine, and writes the result as one JSON line to stdout. To show a pairing code in the terminal, use pair.`
