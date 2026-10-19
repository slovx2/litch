package main

// pair：出码之后的事。自检、把码打出来、长轮询等手机、终端里确认、Ctrl-C 取消。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"
)

// 自检：本机有 ssh 就用一次性钥匙连 127.0.0.1 试一下。失败只提示，照样出码：
// --port 给的可能是手机走的转发端口，本机的 sshd 不在那个端口上
func (s *pairSession) selfCheck(ctx context.Context, start pairStartResponse, payload pairPayload) {
	out := s.pio.stdout
	sshPath, err := s.pio.lookSSH()
	if err != nil {
		fmt.Fprintln(out, tr("自检：本机没有 ssh 客户端，跳过（自检会用一次性钥匙连 127.0.0.1，看 sshd 认不认这把钥匙）。", "Check: no ssh client on this machine, skipped (the check logs in to 127.0.0.1 with the one-time key to see whether sshd accepts it)."))
		return
	}
	dir := s.stateDir
	if dir == "" {
		dir = os.TempDir()
	}
	fmt.Fprintf(out, tr("自检：用一次性钥匙连 127.0.0.1:%d……\n", "Check: logging in to 127.0.0.1:%d with the one-time key...\n"), payload.Port)
	if err := pairSelfCheck(ctx, sshPath, dir, start, payload.Port, payload.User); err != nil {
		fmt.Fprintln(out, tr("自检没通过，ssh 的原话：", "The check failed; ssh said:"))
		fmt.Fprintln(out, "  "+err.Error())
		fmt.Fprintln(out, tr(
			"手机多半也登不进来。常见原因：sshd 不在这个端口上（--port 是转发后的端口时这一步失败可以不管）、sshd 不读 ~/.ssh/authorized_keys（AuthorizedKeysFile）、StrictModes 嫌 ~/.ssh 的权限太宽、AuthenticationMethods 要求不止一种认证。",
			"The phone will most likely fail too. Common causes: sshd is not on this port (ignore this when --port is a forwarded port), sshd does not read ~/.ssh/authorized_keys (AuthorizedKeysFile), StrictModes finds ~/.ssh too permissive, or AuthenticationMethods requires more than one method."))
		return
	}
	fmt.Fprintln(out, tr("自检通过。", "Check passed."))
}

func (s *pairSession) show(start pairStartResponse, payload pairPayload) {
	out := s.pio.stdout
	text := encodePairPayload(payload)
	fmt.Fprintln(out)
	if err := renderQR(out, text); err != nil {
		fmt.Fprintln(s.pio.stderr, tr("画不出二维码：", "Cannot draw the QR code: ")+err.Error())
	}
	expires := time.UnixMilli(start.ExpiresAt)
	minutes := int(time.Until(expires).Round(time.Minute) / time.Minute)
	fmt.Fprintln(out)
	fmt.Fprintln(out, tr("在手机上：Litch → 添加设备 → 扫码添加。没有摄像头时，把下面的配对文本粘贴到扫码页上：", "On the phone: Litch → Add device → Scan code. Without a camera, paste this pairing text on the scan page:"))
	fmt.Fprintln(out, text)
	fmt.Fprintf(out, tr("地址 %s@%s:%d，名字 %s，主机钥匙 %s %s\n", "Address %s@%s:%d, name %s, host key %s %s\n"),
		payload.User, payload.Host, payload.Port, payload.Name, payload.HostKeyType, payload.HostKeyFP)
	fmt.Fprintf(out, tr("有效期到 %s（约 %d 分钟），只能用一次。别在共享屏幕、录屏时显示。手机走的地址不一样时用 --host、--port 指定。\n", "Valid until %s (about %d minutes), for one use only. Do not show it while sharing or recording your screen. Use --host and --port when the phone reaches this machine at another address.\n"),
		expires.Format("15:04:05"), minutes)
	fmt.Fprintln(out, tr("等手机扫码……按 Ctrl-C 取消。", "Waiting for the phone to scan... Press Ctrl-C to cancel."))
}

type pairUpdate struct {
	status pairStatus
	err    error
}

// watch 等这个配对有结果，返回 done、expired、rejected、cancelled、interrupted、closed（标准输入关了）或 failed
func (s *pairSession) watch(ctx context.Context, start pairStartResponse) string {
	out := s.pio.stdout
	pollCtx, stopPoll := context.WithCancel(ctx)
	defer stopPoll()
	updates := make(chan pairUpdate)
	go s.poll(pollCtx, start.PairID, updates)
	current := "waiting"
	var phone *pairPhoneRequest
	for {
		select {
		case <-ctx.Done():
			s.cancel(start.PairID)
			return "interrupted"
		case update := <-updates:
			if update.err != nil {
				if ctx.Err() != nil {
					s.cancel(start.PairID)
					return "interrupted"
				}
				fmt.Fprintln(s.pio.stderr, pairCallError(update.err))
				return "failed"
			}
			state := update.status.State
			if state == current {
				continue
			}
			if current == "requested" {
				fmt.Fprintln(out)
			}
			previous := current
			current = state
			if update.status.Phone != nil {
				phone = update.status.Phone
			}
			switch state {
			case "waiting":
				if previous == "requested" {
					fmt.Fprintln(out, tr("这次请求没有确认，继续等扫码……", "That request was not confirmed; waiting for a scan again..."))
				}
			case "requested":
				name, code := "", ""
				if phone != nil {
					name, code = phone.Name, phone.Code
				}
				if len(code) == 6 {
					code = code[:3] + " " + code[3:]
				}
				fmt.Fprintf(out, tr("\n手机“%s”请求绑定，确认码 %s\n", "\nThe phone %q asks to pair, confirmation code %s\n"), name, code)
				fmt.Fprint(out, tr("请核对手机上显示的确认码是否一样。允许吗？[y/N] ", "Check that the phone shows the same code. Allow it? [y/N] "))
			case "done":
				name := ""
				if phone != nil {
					name = phone.Name
				}
				fmt.Fprintf(out, tr("已绑定手机“%s”。之后它用自己的钥匙连这台机器，一次性钥匙已经删掉。\n", "Paired the phone %q. From now on it connects with its own key; the one-time key has been removed.\n"), name)
				return "done"
			case "expired":
				return "expired"
			case "rejected":
				fmt.Fprintln(out, tr("已拒绝（或者两分钟内没有确认），这张二维码作废了。", "Rejected (or not confirmed within two minutes); this code is no longer valid."))
				return "rejected"
			case "cancelled":
				fmt.Fprintln(out, tr("配对被取消了（可能是设备服务重启了）。", "The pairing was cancelled (the device service may have restarted)."))
				return "cancelled"
			}
		case line, open := <-s.lines:
			// 标准输入关了（经 ssh 跑、没有终端时断开连接也是这样）：再没人能回 y，取消掉，不让一次性钥匙行留到过期
			if !open {
				if current == "requested" {
					fmt.Fprintln(out)
				}
				fmt.Fprintln(out, tr("标准输入已经关了，没人能确认，取消这次配对。", "Standard input is closed and nobody can confirm; cancelling this pairing."))
				s.cancel(start.PairID)
				return "closed"
			}
			if current != "requested" {
				continue
			}
			allow := isYes(line)
			if err := s.decide(ctx, start.PairID, allow); err != nil {
				if ctx.Err() != nil {
					continue
				}
				fmt.Fprintln(s.pio.stderr, pairCallError(err))
				continue
			}
			if allow {
				fmt.Fprintln(out, tr("已允许，等手机登记完成……", "Allowed; waiting for the phone to finish..."))
			}
		}
	}
}

// 长轮询：一条连接上一次接一次地调 litch/pair/wait，状态变了就交出来。出错交出错误后结束
func (s *pairSession) poll(ctx context.Context, pairID string, updates chan<- pairUpdate) {
	send := func(update pairUpdate) bool {
		select {
		case updates <- update:
			return true
		case <-ctx.Done():
			return false
		}
	}
	rpc, err := dialDevice(ctx, s.socket)
	if err != nil {
		send(pairUpdate{err: err})
		return
	}
	defer rpc.Close()
	var since any
	for {
		raw, err := rpc.call(ctx, pairWaitMethod, map[string]any{"pairId": pairID, "since": since})
		if err != nil {
			send(pairUpdate{err: err})
			return
		}
		var status pairStatus
		if json.Unmarshal(raw, &status) != nil || status.State == "" {
			send(pairUpdate{err: errors.New(tr("设备服务的应答看不懂", "the device service sent an answer this command cannot read"))})
			return
		}
		if !send(pairUpdate{status: status}) {
			return
		}
		switch status.State {
		case "done", "expired", "rejected", "cancelled":
			return
		}
		since = status.State
	}
}

func (s *pairSession) decide(ctx context.Context, pairID string, allow bool) error {
	_, err := pairCall(ctx, s.socket, pairDecideMethod, map[string]any{"pairId": pairID, "allow": allow}, 15*time.Second)
	return err
}

// Ctrl-C 之后：原来的 ctx 已经结束，另起一个带时限的去取消，删掉一次性钥匙行
func (s *pairSession) cancel(pairID string) {
	_, err := pairCall(context.Background(), s.socket, pairCancelMethod, map[string]any{"pairId": pairID}, 5*time.Second)
	var rpcErr *deviceRPCError
	if err != nil && !(errors.As(err, &rpcErr) && pairErrorReason(rpcErr) == "unknownPair") {
		fmt.Fprintln(s.pio.stderr, tr("\n已中断，但没能取消这次配对（一次性钥匙行会在过期或设备服务重启时删掉）：", "\nInterrupted, but the pairing could not be cancelled (the one-time key line is removed when it expires or the device service restarts): ")+err.Error())
		return
	}
	fmt.Fprintln(s.pio.stdout, tr("\n已取消，一次性钥匙已删掉。", "\nCancelled; the one-time key has been removed."))
}
