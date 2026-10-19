package sshtransport

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// 扫码绑定（设计见 litch 仓库 packages/protocol/src/device-pairing.mts）：手机拿二维码里的一次性钥匙登进去，
// 对面的 sshd 只让这把钥匙跑强制命令 pair-enroll。手机往标准输入写一行 JSON（PairEnrollInput），
// 等电脑上点允许，读回一行 JSON（PairEnrollOutput）。这里只管把那一行送过去、把那一行拿回来，JSON 由界面那头拼和解。

// 请求执行的命令。对面是强制命令，这里写什么都会被换掉，写成它的名字只是为了日志里看得明白
const enrollCommand = "pair-enroll"

// 等回话最多等多久：对面等电脑上表态最多 2 分钟，再留出连接和写钥匙文件的时间。变量是为了测试能调短
var enrollTimeout = 3 * time.Minute

// 标准输出最多读多少字节来找回话那一行，超过就不认
const enrollLineMax = 64 * 1024

// EnrollPair 用 target（一般带 Seed 和 HostKeyType）连上去，往标准输入写 line（自动补换行），返回回话那一行（去掉换行）。
// 回话那一行是标准输出里第一行带布尔 ok 的 JSON 对象：sshd 经登录 shell 跑强制命令，shell 的启动文件（.bashrc 之类）
// 打出来的字会排在它前面，要跳过。
// 对面没回一整行就退出、等满 enrollTimeout 都算 [enroll] 种类的失败；连不上、指纹不对、钥匙不被接受照旧是原来的种类
func EnrollPair(targetJSON, line string) (string, error) {
	target, err := parseTarget(targetJSON)
	if err != nil {
		return "", err
	}
	if strings.ContainsAny(strings.TrimRight(line, "\n"), "\r\n") {
		return "", kindf(kindInvalid, "登记的内容只能是一行")
	}
	ctx, cancel := context.WithTimeout(context.Background(), enrollTimeout)
	defer cancel()
	client, err := connectSSH(ctx, target)
	if err != nil {
		return "", err
	}
	defer func() { _ = client.Close() }()
	// 等电脑上表态的这一两分钟里连接是静默的：照常发心跳，静默断开时能早点知道
	lost := make(chan string, 1)
	go keepAlive(ctx, client, func(reason string) { lost <- reason })
	session, err := newSession(client, target)
	if err != nil {
		return "", kindf(kindUnreachable, "打开 SSH 会话: %w", err)
	}
	defer func() { _ = session.Close() }()
	stdin, err := session.StdinPipe()
	if err != nil {
		return "", err
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		return "", err
	}
	var stderr bytes.Buffer
	session.Stderr = &stderr
	if err = session.Start(enrollCommand); err != nil {
		return "", kindf(kindUnreachable, "执行登记: %w", err)
	}
	if _, err = io.WriteString(stdin, strings.TrimRight(line, "\n")+"\n"); err != nil {
		return "", kindf(kindUnreachable, "写入登记内容: %w", err)
	}
	_ = stdin.Close()

	type answer struct {
		line string
		err  error
	}
	answered := make(chan answer, 1)
	go func() {
		text, err := readResult(stdout)
		answered <- answer{text, err}
	}()
	select {
	case got := <-answered:
		if got.err == nil {
			return got.line, nil
		}
		// 对面没回一整行就走了：等它的退出码，连同标准错误的末尾一起交给界面当详情
		code := -1
		var exit *ssh.ExitError
		if waitErr := session.Wait(); waitErr == nil {
			code = 0
		} else if errors.As(waitErr, &exit) {
			code = exit.ExitStatus()
		}
		detail := strings.TrimSpace(tail(stderr.String(), 2000))
		if detail == "" {
			detail = got.err.Error()
		}
		return "", kindf(kindEnroll, "对面没有给出登记结果（退出码 %d）: %s", code, detail)
	case reason := <-lost:
		return "", kindf(kindUnreachable, "等登记结果时连接断了: %s", reason)
	case <-ctx.Done():
		return "", kindf(kindEnroll, "等了 %s 没有登记结果", enrollTimeout)
	}
}

// readResult 一行一行读，跳过不是回话的（登录 shell 打出来的字），返回第一行带布尔 ok 的 JSON 对象。
// 读满 enrollLineMax 或者读到头都没有就算错，错误里带上读到的末尾，界面当详情显示
func readResult(reader io.Reader) (string, error) {
	buffered := bufio.NewReaderSize(io.LimitReader(reader, enrollLineMax), 4096)
	var seen strings.Builder
	for {
		text, err := buffered.ReadString('\n')
		line := strings.TrimSpace(text)
		if isEnrollResult(line) && (err == nil || errors.Is(err, io.EOF)) {
			return line, nil
		}
		seen.WriteString(text)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return "", fmt.Errorf("没读到登记结果: %s", strings.TrimSpace(tail(seen.String(), 2000)))
			}
			return "", err
		}
	}
}

// isEnrollResult：是不是 pair-enroll 回的那一行（JSON 对象，ok 是布尔）
func isEnrollResult(line string) bool {
	if !strings.HasPrefix(line, "{") {
		return false
	}
	var probe struct {
		OK *bool `json:"ok"`
	}
	return json.Unmarshal([]byte(line), &probe) == nil && probe.OK != nil
}

// PairConfirmCode 是两边各自算出来比对的 6 位确认码：
// SHA-256(配对号 + "\n" + 公钥行) 的前 4 字节按大端读成无符号整数，模 1000000，左边补零
func PairConfirmCode(pairID, publicKey string) string {
	sum := sha256.Sum256([]byte(pairID + "\n" + strings.TrimSpace(publicKey)))
	return fmt.Sprintf("%06d", binary.BigEndian.Uint32(sum[:4])%1000000)
}

// PairPhoneID 是这部手机在对面钥匙行里的编号：公钥二进制做 SHA-256，前 8 字节的小写十六进制
func PairPhoneID(publicKey string) (string, error) {
	key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(strings.TrimSpace(publicKey)))
	if err != nil {
		return "", kindf(kindKey, "不是一行公钥: %w", err)
	}
	sum := sha256.Sum256(key.Marshal())
	return hex.EncodeToString(sum[:8]), nil
}
