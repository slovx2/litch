//go:build !windows

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/slovx2/litch/internal/hostplatform"
)

func powerRegistrationFixture(t *testing.T, cfg configuration, answer func() any) {
	t.Helper()
	listener, err := hostplatform.Listen(hostplatform.ControlSocketPath(cfg.deviceDirectory()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				line, err := bufio.NewReader(c).ReadBytes('\n')
				if err != nil {
					return
				}
				var request controlRequest
				if json.Unmarshal(line, &request) != nil || request.Method != "power.registerLocal" {
					return
				}
				data, _ := json.Marshal(answer())
				_, _ = c.Write(append(data, '\n'))
			}(connection)
		}
	}()
}

func TestDeviceStartLocalPowerOldServiceStillReady(t *testing.T) {
	cfg := testConfiguration(t)
	holdDeviceLock(t, cfg)
	listenAt(t, cfg.deviceSocket())
	facts := &serviceFacts{PID: os.Getpid(), Version: "1.2.3", Root: cfg.root, Build: "old-build", StartedAt: "2026-10-01T00:00:00Z", Detached: true, Options: []string{"--ssh=off"}}
	if err := writePrivateJSON(cfg.serviceStatusPath(), serviceStatus{PID: os.Getpid(), State: "ready", Socket: cfg.deviceSocket(), Service: facts}); err != nil {
		t.Fatal(err)
	}
	var supported atomic.Bool
	powerRegistrationFixture(t, cfg, func() any {
		if !supported.Load() {
			return map[string]any{"id": 1, "error": controlError{Reason: "failed", Text: both("不认识的控制命令 power.registerLocal", "Unknown control command power.registerLocal")}}
		}
		return map[string]any{"id": 1, "result": powerStatus{ConfiguredForLocalService: true}}
	})
	args := deviceStartArguments(cfg, "--local-service")
	output := runCLI(t, "", []string{testCLIEnvironment + "_VERSION=2.0.0"}, args...)
	result := parseDeviceStartOutput(t, output)
	if !result.Ready || result.Started || result.PID != os.Getpid() || !reflect.DeepEqual(result.Service, facts) || result.CLI.Version != "2.0.0" {
		t.Fatalf("旧服务就绪信息或升级依据丢失: %+v", result)
	}
	var extra struct {
		LocalServiceRegistered *bool `json:"localServiceRegistered"`
	}
	if err := json.Unmarshal([]byte(output.stdout), &extra); err != nil || extra.LocalServiceRegistered == nil || *extra.LocalServiceRegistered {
		t.Fatalf("能力缺失被伪装成登记成功: %s", output.stdout)
	}
	if _, err := os.Stat(settingsPath(cfg.home)); !os.IsNotExist(err) {
		t.Fatal("旧服务能力缺失时不应在其背后写设置")
	}
	log, err := os.ReadFile(filepath.Join(cfg.logsDirectory(), "device-start.jsonl"))
	if err != nil || !strings.Contains(string(log), "local_power_unsupported") {
		t.Fatalf("缺少能力降级日志: %s %v", log, err)
	}
	// 升级后的下一次启动仍会尝试登记，没有把能力缺失永久缓存下来。
	supported.Store(true)
	output = runCLI(t, "", nil, args...)
	result = parseDeviceStartOutput(t, output)
	if err := json.Unmarshal([]byte(output.stdout), &extra); err != nil || extra.LocalServiceRegistered == nil || !*extra.LocalServiceRegistered || !reflect.DeepEqual(result.Service, facts) {
		t.Fatalf("服务支持后没有重新登记: %s", output.stdout)
	}
}

func TestDeviceStartLocalPowerRealFailuresStillFail(t *testing.T) {
	for _, test := range []struct {
		name     string
		response any
	}{
		{"disk failure", map[string]any{"id": 1, "error": controlError{Reason: "failed", Text: both("写入设置失败", "Cannot write settings")}}},
		{"unconfirmed", map[string]any{"id": 1, "result": powerStatus{ConfiguredForLocalService: false}}},
		{"different method", map[string]any{"id": 1, "error": controlError{Reason: "failed", Text: both("不认识的控制命令 other", "Unknown control command other")}}},
		{"unrecognized shape", map[string]any{"id": 1, "error": controlError{Reason: "failed", Text: both("", "Unknown control command power.registerLocal")}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			cfg := testConfiguration(t)
			holdDeviceLock(t, cfg)
			listenAt(t, cfg.deviceSocket())
			powerRegistrationFixture(t, cfg, func() any { return test.response })
			output := runCLI(t, "", nil, deviceStartArguments(cfg, "--local-service")...)
			if output.code == 0 || output.stdout != "" || output.stderr == "" {
				t.Fatalf("真实失败被静默忽略: %+v", output)
			}
		})
	}
	t.Run("control unavailable", func(t *testing.T) {
		cfg := testConfiguration(t)
		holdDeviceLock(t, cfg)
		listenAt(t, cfg.deviceSocket())
		output := runCLI(t, "", nil, deviceStartArguments(cfg, "--local-service")...)
		if output.code == 0 || output.stdout != "" || output.stderr == "" {
			t.Fatalf("控制连接失败被忽略: %+v", output)
		}
	})
	t.Run("newly launched service", func(t *testing.T) {
		cfg := testConfiguration(t)
		cfg.localService = true
		holdDeviceLock(t, cfg)
		powerRegistrationFixture(t, cfg, func() any {
			return map[string]any{"id": 1, "error": controlError{Reason: "failed", Text: both("不认识的控制命令 power.registerLocal", "Unknown control command power.registerLocal")}}
		})
		var output bytes.Buffer
		if err := printDeviceStartResult(&output, cfg, true, os.Getpid()); err == nil || output.Len() != 0 {
			t.Fatal("不应把新启动服务的能力异常当作旧服务升级")
		}
	})
}
