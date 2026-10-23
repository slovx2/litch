package main

// 扫码绑定手机（设备服务的 devicePairing 扩展）在命令行这一头的两个子命令，共用的部分在这里：
//   pair-enroll <配对号>  authorized_keys 里一次性钥匙行的强制命令（pair_enroll.go）
//   pair                  用户 ssh 进这台机器后自己跑：在终端里出码、确认（pair_run.go）
// 约定（方法名、二维码格式、一行进一行出的格式、错误码）在 packages/protocol/src/device-pairing.mts，
// 这里照着写，改形状要两边一起改。两个子命令都直连 device.sock，不握手（方法不要求声明，通知收不到，用长轮询）。
// 这台机器开着 Tailscale SSH 时 pair 可以出 Tailscale 方式的码（不写一次性钥匙行，二维码里带登记命令，
// 手机登进来后自己执行 pair-enroll），见 12 号设计第七之四节。

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/slovx2/litch/internal/hostplatform"
)

const (
	pairStartMethod  = "litch/pair/start"
	pairCancelMethod = "litch/pair/cancel"
	pairDecideMethod = "litch/pair/decide"
	pairWaitMethod   = "litch/pair/wait"
	pairEnrollMethod = "litch/pair/enroll"

	pairPayloadPrefix = "LITCHPAIR1:"

	// 出码的方式（PairMode）
	pairModeKey       = "key"
	pairModeTailscale = "tailscale"
)

// DevicePairStartResponse。key 方式带 Seed，tailscale 方式带 EnrollCommand
type pairStartResponse struct {
	PairID        string        `json:"pairId"`
	Mode          string        `json:"mode"`
	Seed          string        `json:"seed"`
	EnrollCommand string        `json:"enrollCommand"`
	ExpiresAt     int64         `json:"expiresAt"`
	HostKey       pairHostKey   `json:"hostKey"`
	HostKeys      []pairHostKey `json:"hostKeys"`
	Hostname      string        `json:"hostname"`
	User          string        `json:"user"`
	TailscaleSSH  bool          `json:"tailscaleSsh"`
	// 这台机器在 tailnet 里的 MagicDNS 名和地址；老的设备服务、没开 MagicDNS 时没有
	Tailnet *pairTailnet `json:"tailnet,omitempty"`
}

type pairTailnet struct {
	Name      string   `json:"name"`
	Addresses []string `json:"addresses"`
}

type pairHostKey struct {
	Type        string `json:"type"`
	Fingerprint string `json:"fingerprint"`
	PublicKey   string `json:"publicKey"`
}

// PairStatus
type pairStatus struct {
	PairID    string            `json:"pairId"`
	State     string            `json:"state"`
	ExpiresAt int64             `json:"expiresAt"`
	Phone     *pairPhoneRequest `json:"phone"`
}

type pairPhoneRequest struct {
	PhoneID     string `json:"phoneId"`
	Name        string `json:"name"`
	Fingerprint string `json:"fingerprint"`
	Code        string `json:"code"`
}

// PairPayload：二维码和“配对文本”里的东西。Tailscale 方式没有 Seed，有 Command
type pairPayload struct {
	Name        string // n
	Host        string // h
	Port        int    // p
	User        string // u
	HostKeyType string // k.t
	HostKeyFP   string // k.f
	Seed        string // s
	Tailscale   bool   // m 为 tailscale
	Command     string // c
	PairID      string // i
	ExpiresAt   int64  // e
}

// encodePairPayload 和 device-pairing.mts 的 encodePairPayload 一字不差：前缀加 base64url（无填充）的
// UTF-8 JSON，JSON 是 JSON.stringify 的写法，键的顺序 v n h p u k s i e（Tailscale 方式是 v n h p u k m c i e）。
// 不用 encoding/json：它会把 U+2028、U+2029 写成转义（JSON.stringify 原样输出），出来的字节就不一样了。
func encodePairPayload(payload pairPayload) string {
	var b strings.Builder
	b.WriteString(`{"v":1,"n":`)
	writeJSString(&b, payload.Name)
	b.WriteString(`,"h":`)
	writeJSString(&b, payload.Host)
	b.WriteString(`,"p":` + strconv.Itoa(payload.Port) + `,"u":`)
	writeJSString(&b, payload.User)
	b.WriteString(`,"k":{"t":`)
	writeJSString(&b, payload.HostKeyType)
	b.WriteString(`,"f":`)
	writeJSString(&b, payload.HostKeyFP)
	if payload.Tailscale {
		b.WriteString(`},"m":"tailscale","c":`)
		writeJSString(&b, payload.Command)
	} else {
		b.WriteString(`},"s":`)
		writeJSString(&b, payload.Seed)
	}
	b.WriteString(`,"i":`)
	writeJSString(&b, payload.PairID)
	b.WriteString(`,"e":` + strconv.FormatInt(payload.ExpiresAt, 10) + `}`)
	return pairPayloadPrefix + base64.RawURLEncoding.EncodeToString([]byte(b.String()))
}

// writeJSString 照 JSON.stringify 写一个字符串：只转义引号、反斜杠和 U+0020 以下的控制字符
// （\b \t \n \f \r 用短写法，其余 \u00xx 小写十六进制），别的字符原样写 UTF-8。
// Go 的字符串里不合法的 UTF-8 写成 U+FFFD（JS 的字符串里本来就不会有这种东西）。
func writeJSString(b *strings.Builder, text string) {
	b.WriteByte('"')
	for _, r := range text {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case '\f':
			b.WriteString(`\f`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

// 设备服务回的 JSON-RPC 错误里 data.reason 的值（DEVICE_PAIR_ERROR）
func pairErrorReason(err *deviceRPCError) string {
	var data struct {
		Reason string `json:"reason"`
	}
	if len(err.Data) > 0 {
		_ = json.Unmarshal(err.Data, &data)
	}
	return data.Reason
}

// 在跑的设备服务还不认识配对的方法：不握手调不认识的方法，它回“没握手”；握了手它回“方法不存在”
func pairTooOld(err error) bool {
	var rpcErr *deviceRPCError
	return errors.As(err, &rpcErr) && (rpcErr.Message == "Not initialized" || rpcErr.Code == -32601)
}

// 两个子命令找设备服务的办法：--home 给了就是那个状态目录；不然有 LITCH_DEVICE_SOCKET（在 Litch 的终端里跑）就用它；
// 都没有是默认的状态目录。home 为空表示套接字来自环境变量，这时不知道状态目录，也就不替它拉起服务。
type pairTarget struct {
	socket string
	home   string
}

func resolvePairTarget(home string, env func(string) string) pairTarget {
	if home == "" {
		if socket := env(deviceSocketEnvironment); socket != "" {
			return pairTarget{socket: socket}
		}
		base, err := os.UserHomeDir()
		if err != nil {
			base = "."
		}
		home = filepath.Join(base, ".codex-harness-adapter")
	}
	if absolute, err := filepath.Abs(home); err == nil {
		home = absolute
	}
	return pairTarget{socket: hostplatform.DeviceSocketPath(filepath.Join(home, "device")), home: home}
}

// ensurePairDevice：设备服务没在跑就照 device-start 的办法拉起来（已在跑就什么都不做），那一行 JSON 不要。
// 套接字来自环境变量（不知道状态目录）时不拉，连不上由调用方报。
func ensurePairDevice(ctx context.Context, target pairTarget, stderr io.Writer) error {
	if canDial(target.socket) || target.home == "" {
		return nil
	}
	cfg, err := parseConfiguration([]string{"--home", target.home})
	if err != nil {
		return err
	}
	fmt.Fprintln(stderr, tr("设备服务没在运行，正在启动……", "The device service is not running; starting it..."))
	return deviceStartTo(ctx, cfg, io.Discard)
}
