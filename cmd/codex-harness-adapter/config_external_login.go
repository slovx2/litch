package main

// CLI 的配置桥一次只回一个答案。设备码登录拆为发起、查询和确认，
// 终端先显示一次性码，再读取公开状态；远程目标也使用同一条配置链路。
import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const externalVerificationURL = "https://github.com/login/device"

var externalUserCode = regexp.MustCompile("^[A-Z0-9]{4}-[A-Z0-9]{4}$")

type configLoginStatus struct {
	LoginID           string `json:"loginId"`
	State             string `json:"state"`
	UserCode          string `json:"userCode,omitempty"`
	VerificationURL   string `json:"verificationUrl,omitempty"`
	NeedsConfirmation bool   `json:"needsConfirmation,omitempty"`
	Result            *struct {
		Account struct {
			Login  string `json:"login"`
			UserID string `json:"userId"`
		} `json:"account"`
		Scopes       []string `json:"scopes"`
		Repositories []struct {
			Owner string `json:"owner"`
			Name  string `json:"name"`
		} `json:"repositories"`
		IsOwner  bool            `json:"isOwner"`
		Identity *configIdentity `json:"identity,omitempty"`
	} `json:"result,omitempty"`
}

type configLoginAnswer struct {
	OK   bool            `json:"ok"`
	Op   string          `json:"op"`
	Data json.RawMessage `json:"data"`
	Text string          `json:"text"`
}

func externalDeviceCodeCommand(args []string) bool {
	if len(args) < 2 || args[0] != "device-identity" || args[1] != "add" {
		return false
	}
	for _, arg := range args[2:] {
		if arg == "--help" || arg == "-h" {
			return false
		}
	}
	return true
}

func externalLoginDeviceOption(args []string) []string {
	var target string
	for i := 2; i < len(args); i++ {
		if args[i] == "--" {
			break
		}
		if args[i] == "--device" && i+1 < len(args) {
			i++
			target = args[i]
		} else if value, ok := strings.CutPrefix(args[i], "--device="); ok {
			target = value
		}
	}
	if target == "" {
		return nil
	}
	return []string{"--device", target}
}

func configExternalLogin(ctx context.Context, argv []string, asJSON bool, streams machineIO) int {
	ctx, stop := context.WithTimeout(ctx, 20*time.Minute)
	defer stop()
	var last configLoginAnswer
	var state configLoginStatus
	run := func(ctx context.Context, args []string, showFailure bool) int {
		var output, errors bytes.Buffer
		capture := streams
		capture.stdout, capture.stderr = &output, &errors
		code := configDesktopMain(ctx, args, true, capture)
		if code != 0 {
			if showFailure {
				_, _ = output.WriteTo(streams.stdout)
				_, _ = errors.WriteTo(streams.stderr)
			}
			return code
		}
		var received configLoginAnswer
		var result configLoginStatus
		if json.Unmarshal(output.Bytes(), &received) != nil || !received.OK ||
			json.Unmarshal(received.Data, &result) != nil || result.LoginID == "" {
			if showFailure {
				fmt.Fprintln(streams.stderr, tr("授权状态无法读取。", "Could not read the authorization status."))
			}
			return machineExitFailed
		}
		last, state = received, result
		return 0
	}
	if code := run(ctx, argv, true); code != 0 {
		return code
	}

	options := externalLoginDeviceOption(argv)
	loginID := state.LoginID
	login := func(action string) []string {
		return append([]string{"device-identity", "login", action, loginID}, options...)
	}
	cancel := func() {
		cleanup, stop := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer stop()
		_ = run(cleanup, login("cancel"), false)
	}

	if state.State == "waiting" {
		if !externalUserCode.MatchString(state.UserCode) || state.VerificationURL != externalVerificationURL {
			cancel()
			fmt.Fprintln(streams.stderr, tr("设备没有返回有效的 GitHub 授权码。", "The device did not return a valid GitHub device code."))
			return machineExitFailed
		}
		to := streams.stdout
		if asJSON {
			to = streams.stderr
		}
		fmt.Fprintf(to, tr("请用机器人账号打开 %s，输入一次性码 %s。授权页显示 GitHub CLI。\n",
			"Open %s with the bot account and enter code %s. The authorization page shows GitHub CLI.\n"),
			externalVerificationURL, state.UserCode)
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		for state.State == "waiting" {
			select {
			case <-ctx.Done():
				cancel()
				return 130
			case <-tick.C:
				if code := run(ctx, login("status"), true); code != 0 {
					if ctx.Err() != nil {
						cancel()
						return 130
					}
					fmt.Fprintf(streams.stderr, tr("可继续查询授权状态，登录 ID：%s。\n", "To check the authorization again, use login ID %s.\n"), loginID)
					return code
				}
			}
		}
	}
	if state.State == "succeeded" && state.NeedsConfirmation {
		if state.Result != nil {
			fmt.Fprintf(streams.stderr, tr("@%s 是你的 GitHub 账号，需在 Litch 桌面端确认。\n", "@%s is your GitHub account. Confirm in the Litch desktop app.\n"), state.Result.Account.Login)
		}
		if code := run(ctx, login("confirm"), true); code != 0 {
			cancel()
			return code
		}
	}
	if asJSON {
		last.Op = "device-identity add"
		_ = json.NewEncoder(streams.stdout).Encode(last)
	} else if last.Text != "" {
		fmt.Fprintln(streams.stdout, last.Text)
	}
	if state.State != "succeeded" || state.NeedsConfirmation {
		return machineExitFailed
	}
	return 0
}
