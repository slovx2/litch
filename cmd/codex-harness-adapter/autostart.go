package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

const autostartFlag = "--litch-autostart="

type autostartSpec struct {
	ID, Executable, Home, Root, Node, Version, Build string
}

func (s autostartSpec) args() []string {
	return []string{"start", autostartFlag + s.ID, "--home", s.Home, "--root", s.Root, "--node", s.Node, "--ssh=off"}
}

func autostartIdentity(home string) string {
	if resolved, err := filepath.EvalSymlinks(home); err == nil {
		home = resolved
	}
	if runtime.GOOS == "windows" {
		home = strings.ToLower(home)
	}
	key := sha256.Sum256([]byte(filepath.Clean(home)))
	return fmt.Sprintf("com.litch.device.%x", key[:12])
}

type autostartInstance struct {
	PID  int    `json:"pid"`
	Mode string `json:"mode"`
}

type autostartRepair struct {
	Code string    `json:"code"`
	Text bilingual `json:"text"`
}

func autoRepair(code, zh, en string) *autostartRepair {
	return &autostartRepair{Code: code, Text: both(zh, en)}
}

type autostartOperation struct {
	OperationID string `json:"operationId"`
	Action      string `json:"action"`
	State       string `json:"state"`
}

type autostartStatus struct {
	Revision       int64               `json:"revision"`
	ServiceManager string              `json:"serviceManager"`
	State          string              `json:"state"`
	ServiceID      string              `json:"serviceId,omitempty"`
	Instance       *autostartInstance  `json:"instance,omitempty"`
	RequiresLogin  bool                `json:"requiresLogin"`
	Linger         string              `json:"linger"`
	LastOperation  *autostartOperation `json:"lastOperation,omitempty"`
	Repair         *autostartRepair    `json:"repair,omitempty"`
}

type autostartManagerState struct {
	registered, enabled, running, foreign bool
	pid                                   int
	linger                                string
	repair, issue                         *autostartRepair
	overrideDisabled                      bool
	exact                                 bool // 当前登记与目标规格一致；对旧规格的匹配只证明归属。
}

type autostartBackend interface {
	name() string
	inspect(context.Context, autostartSpec, ...autostartSpec) autostartManagerState
	install(context.Context, autostartSpec, autostartManagerState) error
	remove(context.Context, autostartSpec, autostartManagerState) error
	quiesce(context.Context, autostartSpec) error
	linger(context.Context) error
	enqueue(context.Context, autostartSpec, int64) error
	cleanupWorker(context.Context, autostartSpec, int64)
}

type autostartCommand func(context.Context, string, ...string) (string, error)

func runAutostartCommand(ctx context.Context, program string, args ...string) (string, error) {
	if !filepath.IsAbs(program) {
		return "", errors.New("system service manager path is not absolute")
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, program, args...)
	hostplatform.Quiet(cmd)
	// 管理器调用也不用调用者的 shell、代理、token 或 PATH。平台所需变量由调用方设置。
	cmd.Env = autostartBaseEnv()
	out, err := cmd.CombinedOutput()
	s := strings.TrimSpace(string(out))
	if err != nil {
		return s, fmt.Errorf("%s: %w: %s", filepath.Base(program), err, s)
	}
	return s, nil
}

type autostartHost struct {
	c       configuration
	spec    autostartSpec
	backend autostartBackend
}

func newAutostartHost(c configuration) (*autostartHost, error) {
	account, err := user.Current()
	if err != nil {
		return nil, err
	}
	home := c.home
	if resolved, err := filepath.EvalSymlinks(home); err == nil {
		home = resolved
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	node := c.node
	if !filepath.IsAbs(node) {
		if resolved, err := exec.LookPath(node); err == nil {
			if absolute, err := filepath.Abs(resolved); err == nil {
				node = absolute
			}
		}
	}
	system, sid, err := autostartPlatformIdentity()
	if err != nil {
		return nil, err
	}
	h := &autostartHost{c: c, spec: autostartSpec{
		ID: autostartIdentity(home), Home: home, Executable: executable, Root: c.root,
		Node: node, Version: selfVersion(), Build: selfBuild(),
	}}
	switch runtime.GOOS {
	case "linux":
		h.backend = linuxAutostart{run: runAutostartCommand, userHome: account.HomeDir, uid: account.Uid}
	case "darwin":
		h.backend = macAutostart{run: runAutostartCommand, userHome: account.HomeDir, domain: "gui/" + account.Uid}
	case "windows":
		h.backend = windowsAutostart{run: runAutostartCommand, powershell: filepath.Join(system, "WindowsPowerShell", "v1.0", "powershell.exe"), sid: sid}
	}
	return h, nil
}

func (s autostartSpec) validate() error {
	for _, path := range []string{s.Executable, s.Home, s.Root, s.Node} {
		if !filepath.IsAbs(path) || strings.ContainsAny(path, "\x00\r\n") ||
			(runtime.GOOS == "windows" && strings.Contains(path, "%")) {
			return errors.New(tr("自启需要绝对路径，且不能含服务管理器无法安全传递的字符", "Autostart requires absolute paths without characters the service manager cannot pass safely"))
		}
	}
	for _, path := range []string{s.Executable, s.Node, s.Home, s.Root} {
		fi, err := os.Stat(path)
		if err != nil {
			return err
		}
		if path == s.Home || path == s.Root {
			if !fi.IsDir() {
				return fmt.Errorf("%q is not a directory", path)
			}
		} else if !fi.Mode().IsRegular() || (runtime.GOOS != "windows" && fi.Mode().Perm()&0o111 == 0) {
			return fmt.Errorf("%q is not an executable file", path)
		}
	}
	return nil
}

// 只有设备锁持有者写的记录可作证；Windows 调度器没有给出 Exec 动作的 PID，
// 要同时核对调度器正在运行和锁持有者自报的服务标识。
func (h *autostartHost) instance(m autostartManagerState, registered autostartSpec, held bool) (*autostartInstance, serviceStatus) {
	var zero serviceStatus
	if !held {
		return nil, zero
	}
	s, ok := readServiceStatus(h.c)
	if !ok || s.PID <= 0 || s.Service == nil || s.Service.PID != s.PID || !hostplatform.Running(s.PID) {
		return nil, zero
	}
	i := &autostartInstance{PID: s.PID, Mode: "manual"}
	if m.running && !m.foreign && registered.ID != "" && (m.pid == 0 || m.pid == s.PID) &&
		slices.Contains(s.Service.Options, autostartFlag+registered.ID) {
		i.Mode = "managed"
	}
	return i, s
}

// 区分设备锁存在、确实被占用和因权限根本读不了。不创建探针文件。
func autostartLockState(c configuration) (bool, error) {
	f, err := os.OpenFile(filepath.Join(c.deviceDirectory(), "serve.lock"), os.O_RDWR, 0)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer f.Close()
	err = hostplatform.Lock(f)
	if err == nil {
		hostplatform.Unlock(f)
		return false, nil
	}
	if autostartLockContended(err) {
		return true, nil
	}
	return false, err
}

func autoWorkerID(s autostartSpec, revision int64) string {
	return s.ID + ".operation-" + strconv.FormatInt(revision, 10)
}

func autoWorkerArgs(s autostartSpec, revision int64) []string {
	return []string{"device-autostart-worker", s.Home, strconv.FormatInt(revision, 10)}
}
