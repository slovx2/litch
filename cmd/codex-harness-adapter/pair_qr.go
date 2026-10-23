package main

// pair 的两件杂事：在终端里画二维码；用一次性钥匙经本机的 ssh 试连一次（自检，不消耗配对）。

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"rsc.io/qr"
)

// 二维码四周留白几格。标准是 4 格，终端里 2 格就扫得出来，省下的宽度让 80 列的终端放得下
const qrQuietZone = 2

// renderQR 用半格字符画二维码：一个字符是上下两格。颜色写死成白底黑字，深色、浅色主题的终端都能扫。
func renderQR(w io.Writer, text string) error {
	code, err := qr.Encode(text, qr.L)
	if err != nil {
		return err
	}
	const (
		on    = "\x1b[30;107m" // 黑字、亮白底
		reset = "\x1b[0m"
	)
	low, high := -qrQuietZone, code.Size+qrQuietZone
	var out strings.Builder
	for y := low; y < high; y += 2 {
		out.WriteString(on)
		for x := low; x < high; x++ {
			top, bottom := code.Black(x, y), y+1 < high && code.Black(x, y+1)
			switch {
			case top && bottom:
				out.WriteString("█")
			case top:
				out.WriteString("▀")
			case bottom:
				out.WriteString("▄")
			default:
				out.WriteString(" ")
			}
		}
		out.WriteString(reset + "\n")
	}
	_, err = io.WriteString(w, out.String())
	return err
}

// 自检的结果之一：本机没有 ssh 客户端，跳过
var errNoSSHClient = errors.New("no ssh client")

// 自检连哪里、用什么钥匙：一次性钥匙方式 seed 是那把钥匙的种子、连 127.0.0.1，强制命令替它执行登记；
// Tailscale 方式 seed 为空（临时生成一把谁都没登记过的），连手机走的地址，自己执行 command
type pairCheck struct {
	seed     []byte
	host     string
	port     int
	user     string
	hostKeys []pairHostKey
	command  string
}

// pairSelfCheck 经系统的 ssh 登一次，输入自检那一行（{"v":1,"probe":true}），设备服务认出是自检就只回 ok，不消耗配对。
// 一次性钥匙方式下 sshd 不认 authorized_keys（别的 AuthorizedKeysFile、StrictModes 嫌权限、AuthenticationMethods 要双因素）、
// 主机钥匙对不上，在手机扫之前就能发现；Tailscale 方式下 ACL 不放行、登记命令的路径不对也能发现。
// 私钥（OpenSSH 格式，600）和只放设备报的主机钥匙的 known_hosts 放在 dir 下新建的目录里，用完删掉；
// ssh 不读任何配置文件、不用 agent，碰不到用户自己的 ~/.ssh。
func pairSelfCheck(ctx context.Context, sshPath, dir string, check pairCheck) error {
	seed := check.seed
	if seed == nil {
		seed = make([]byte, ed25519.SeedSize)
		if _, err := rand.Read(seed); err != nil {
			return err
		}
	}
	block, err := ssh.MarshalPrivateKey(ed25519.NewKeyFromSeed(seed), "litch-pair-check")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	work, err := os.MkdirTemp(dir, "pair-check-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)
	key := filepath.Join(work, "id")
	if err := os.WriteFile(key, pem.EncodeToMemory(block), 0o600); err != nil {
		return err
	}
	name := check.host
	if check.port != 22 {
		name = "[" + check.host + "]:" + strconv.Itoa(check.port)
	}
	var hosts strings.Builder
	for _, hostKey := range check.hostKeys {
		hosts.WriteString(name + " " + hostKey.PublicKey + "\n")
	}
	knownHosts := filepath.Join(work, "known_hosts")
	if err := os.WriteFile(knownHosts, []byte(hosts.String()), 0o600); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	args := pairSSHArgs(key, knownHosts, check.host, check.port, check.user)
	if check.command != "" {
		args = append(args, check.command)
	}
	command := exec.CommandContext(ctx, sshPath, args...)
	command.Stdin = strings.NewReader(`{"v":1,"probe":true}` + "\n")
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	runErr := command.Run()
	// 回话是第一行带布尔 ok 的 JSON 对象；前面可能有登录 shell 的启动文件打出来的字，跳过
	scanner := bufio.NewScanner(&stdout)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		var output struct {
			OK      *bool  `json:"ok"`
			Probe   bool   `json:"probe"`
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		if !strings.HasPrefix(line, "{") || json.Unmarshal([]byte(line), &output) != nil || output.OK == nil {
			continue
		}
		if *output.OK && output.Probe {
			return nil
		}
		if !*output.OK {
			return fmt.Errorf("%s: %s", output.Error, output.Message)
		}
		break
	}
	said := strings.TrimSpace(stderr.String())
	if said == "" && runErr != nil {
		said = runErr.Error()
	}
	if said == "" {
		said = tr("登录后没有收到自检的应答：", "no answer to the check after logging in: ") + strings.TrimSpace(stdout.String())
	}
	return errors.New(said)
}

// sshQuoted：-o 里的文件路径加引号，ssh 会按空白把 UserKnownHostsFile 拆成好几个文件
func sshQuoted(path string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(path) + `"`
}

func pairSSHArgs(key, knownHosts, host string, port int, user string) []string {
	return []string{
		"-F", os.DevNull, "-T",
		"-p", strconv.Itoa(port), "-l", user, "-i", key,
		"-o", "IdentitiesOnly=yes",
		"-o", "IdentityAgent=none",
		"-o", "BatchMode=yes",
		"-o", "PreferredAuthentications=publickey",
		"-o", "StrictHostKeyChecking=yes",
		"-o", "UserKnownHostsFile=" + sshQuoted(knownHosts),
		"-o", "GlobalKnownHostsFile=" + os.DevNull,
		"-o", "UpdateHostKeys=no",
		"-o", "ConnectTimeout=10",
		"-o", "LogLevel=ERROR",
		"--", host,
	}
}

// tailscaleVerifyURL：Tailscale 要在浏览器里再验证一次时（ACL 的 check 模式）tailscaled 给的链接，
// 和 device-pairing.mts 的 tailscaleVerifyUrl 认法一样。没有是空的
func tailscaleVerifyURL(text string) string {
	if found := tailscaleVisitPattern.FindStringSubmatch(text); found != nil {
		return found[1]
	}
	return tailscaleLoginPattern.FindString(text)
}

var (
	tailscaleVisitPattern = regexp.MustCompile(`(?i)To authenticate, visit:\s*(https?://\S+)`)
	tailscaleLoginPattern = regexp.MustCompile(`https://login\.tailscale\.com/a/\S+`)
)
