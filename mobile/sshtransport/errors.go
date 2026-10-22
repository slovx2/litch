package sshtransport

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// 失败的种类：界面按它决定怎么提示、要不要自动重试。错误经 gomobile 过去只剩一段文字，
// 所以种类写在文字开头的方括号里（`[auth] …`），JS 那头认这个前缀（apps/mobile/src/platform/ssh-errors.ts）。
const (
	// 连不到：地址解析不了、端口没人听、超时、网络断了。过一会儿再试可能就好了
	kindUnreachable = "unreachable"
	// 还没确认过这台主机的指纹
	kindHostKeyUnknown = "hostKeyUnknown"
	// 主机给的指纹和记下的不一样
	kindHostKeyChanged = "hostKeyChanged"
	// 对面不接受这把钥匙
	kindAuth = "auth"
	// 钥匙本身用不了：内容坏了、口令不对、不支持的算法
	kindKey = "key"
	// 钥匙加了口令，没给口令
	kindKeyLocked = "keyLocked"
	// 连接配置不对：主机、端口、用户没填对
	kindInvalid = "invalid"
	// 扫码绑定时登进去了，对面却没给出登记结果：没回一整行就退了、或者等满了时间
	kindEnroll = "enroll"
	// Tailscale SSH 要在浏览器里再验证一次（ACL 的 check 模式）。错误文字就是那个链接
	kindVerify = "verify"
)

type kindError struct {
	kind string
	err  error
}

func (e *kindError) Error() string { return "[" + e.kind + "] " + e.err.Error() }

func (e *kindError) Unwrap() error { return e.err }

func withKind(kind string, err error) error {
	var known *kindError
	if errors.As(err, &known) {
		return err
	}
	return &kindError{kind: kind, err: err}
}

func kindf(kind, format string, args ...any) error {
	return &kindError{kind: kind, err: fmt.Errorf(format, args...)}
}

// errHostKeyChanged 由钉住指纹的回调返回，握手失败时据此认出“指纹变了”
type hostKeyChangedError struct {
	expected string
	actual   string
}

func (e *hostKeyChangedError) Error() string {
	return fmt.Sprintf("SSH 主机指纹已变化：期望 %s，实际 %s", e.expected, e.actual)
}

// verifyError 由横幅回调返回：tailscaled 给了验证链接
type verifyError struct {
	url string
}

func (e *verifyError) Error() string { return e.url }

// 和 device-pairing.mts 的 tailscaleVerifyUrl 认法一样
var (
	tailscaleVisitPattern = regexp.MustCompile(`(?i)To authenticate, visit:\s*(https?://\S+)`)
	tailscaleLoginPattern = regexp.MustCompile(`https://login\.tailscale\.com/a/\S+`)
)

// tailscaleVerifyURL：横幅里 Tailscale 要求浏览器验证的链接，没有是空的
func tailscaleVerifyURL(text string) string {
	if found := tailscaleVisitPattern.FindStringSubmatch(text); found != nil {
		return found[1]
	}
	return tailscaleLoginPattern.FindString(text)
}

// handshakeKind 认出握手失败是哪一种。x/crypto 的认证失败只有一句话可认（unable to authenticate）
func handshakeKind(err error) string {
	var changed *hostKeyChangedError
	if errors.As(err, &changed) {
		return kindHostKeyChanged
	}
	var verify *verifyError
	if errors.As(err, &verify) {
		return kindVerify
	}
	if strings.Contains(err.Error(), "unable to authenticate") {
		return kindAuth
	}
	return kindUnreachable
}
