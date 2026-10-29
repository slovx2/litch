package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

// device-start 和 device-proxy 是给我们自己的客户端用的，本机和经 ssh 都是这两条。
// 停服务的 device-stop 在 device_stop.go。
//
// device-start 的三种结果，调用方按退出码区分：
//   0  聚合面能连了。标准输出只有一行 JSON：
//      {"ready":true,"started":false,"socket":"…","pid":N,"service":{…},"cli":{…}}
//      service 是在跑的那份服务的来历（版本、根目录、什么时候起的…，见 service_facts.go），
//      cli 是执行这条命令的这份适配器。调用方拿两边比，就知道在跑的是不是比自己旧。
//      这次改动之前的服务不报来历，那时没有 service 这一项：不知道，多半更旧。
//   3  这个状态目录上有一份不带聚合面的服务在运行（多半是旧版）。不另起、不停它、不动它的文件
//   1  拉起失败或等聚合面超时，以及参数错误、被中断
// 说明文字一律走标准错误。

const exitServiceWithoutAggregate = 3

var (
	// 比桌面端等这条命令的时限（60 秒）短一截：超时的原因要由这边说出来，而不是被对面直接结束掉。
	deviceStartTimeout = 45 * time.Second
	deviceStartPoll    = 100 * time.Millisecond
)

// 适配器的引擎和全部受管的 harness 都登记在 harness_table.go。

type deviceStartResult struct {
	// 恒为 true：有这一行就说明聚合面能连了。
	Ready bool `json:"ready"`
	// true：服务是这次调用拉起来的；false：本来就在运行。
	Started bool `json:"started"`
	// 聚合面套接字的绝对路径。
	Socket string `json:"socket"`
	// 常驻的 start 进程。只在确实知道时给出。
	PID int `json:"pid,omitempty"`
	// 在跑的那份服务的来历。它自己没报（旧版）或者拿不准是谁的时候没有。
	Service *serviceFacts `json:"service,omitempty"`
	// 执行这条命令的这份适配器。
	CLI cliFacts `json:"cli"`
	// 仅请求 --local-service 时返回。false 表示已有服务明确不支持登记；仍提供就绪和版本信息，
	// 让桌面能连接忙碌的旧服务，或进入既有升级流程。没有替旧服务写入本机归属。
	LocalServiceRegistered *bool `json:"localServiceRegistered,omitempty"`
}

func canDial(path string) bool {
	connection, err := hostplatform.Dial(path)
	if err != nil {
		return false
	}
	_ = connection.Close()
	return true
}

// 哪个 harness 的运行时在这个状态目录上能连。只连一下就断开，不碰任何文件。
// 只看三个引擎：这是在认“不带聚合面的旧版服务”，那样的服务里没有原生 codex。
func liveRuntime(c configuration) string {
	for _, harness := range adapterHarnesses {
		path := hostplatform.SocketPath(filepath.Join(c.home, harness))
		if runtime.GOOS != "windows" {
			if _, err := os.Stat(path); err != nil {
				continue
			}
		}
		if canDial(path) {
			return harness
		}
	}
	return ""
}

// 设备锁有没有人拿着。锁文件不存在就是没有，不为了探测去创建它。
func deviceLockHeld(c configuration) bool {
	file, err := os.OpenFile(filepath.Join(c.deviceDirectory(), "serve.lock"), os.O_RDWR, 0o600)
	if err != nil {
		return false
	}
	defer file.Close()
	if hostplatform.Lock(file) != nil {
		return true
	}
	hostplatform.Unlock(file)
	return false
}

func withoutAggregate(harness, detail string) error {
	message := fmt.Sprintf(tr(
		"这个状态目录上有一份不带聚合面的适配器服务在运行（%s 的运行时连得上），请先升级并重启它",
		"An adapter service without the aggregate endpoint is running on this state directory (the %s runtime is reachable); upgrade and restart it first",
	), harness)
	if detail != "" {
		message += tr("；", "; ") + detail
	}
	return &exitError{code: exitServiceWithoutAggregate, err: errors.New(message)}
}

func deviceStart(ctx context.Context, c configuration) error {
	return deviceStartTo(ctx, c, os.Stdout)
}

// deviceStartTo 和 device-start 一样，只是那一行 JSON 写到 out：pair、pair-enroll 借它拉起服务时不要这一行。
func deviceStartTo(ctx context.Context, c configuration, out io.Writer) error {
	if runtime.GOOS != "windows" && len(c.deviceSocket()) > 100 {
		return errors.New(tr("状态路径过长，无法创建聚合面的 Unix socket；请使用较短的 --home", "the state path is too long for the aggregate endpoint's Unix socket; use a shorter --home"))
	}
	deadline := time.Now().Add(deviceStartTimeout)
	// 第一遍只看不写：有别人的服务在跑就用它或者让路，不往这个状态目录里放任何东西。
	if settled, err := attachToRunningService(ctx, c, deadline, out); settled {
		return err
	}
	// 这里起要自己拉起了。同一个状态目录上的 device-start 排队，免得两边各起一份。
	if err := os.MkdirAll(c.deviceDirectory(), 0o700); err != nil {
		return fmt.Errorf(tr("无法创建状态目录 %s: %w", "cannot create the state directory %s: %w"), c.deviceDirectory(), err)
	}
	queue, err := os.OpenFile(filepath.Join(c.deviceDirectory(), "start.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer queue.Close()
	for hostplatform.Lock(queue) != nil {
		if err := pause(ctx, deadline, 50*time.Millisecond); err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return errors.New(tr("另一个 device-start 正在启动服务，等它超时了", "timed out waiting for another device-start that is starting the service"))
			}
			return errors.New(tr("已中断", "interrupted"))
		}
	}
	defer hostplatform.Unlock(queue)
	// 排队期间别人可能已经把服务拉起来了，再看一遍。
	if settled, err := attachToRunningService(ctx, c, deadline, out); settled {
		return err
	}
	return launchService(ctx, c, deadline, out)
}

// 已经有服务在这个状态目录上时在这里了结：聚合面能连就成功；新版服务还在起就等它；
// 旧版服务（没有聚合面）就让调用方去提示升级。返回 false 表示这里没有服务，可以自己拉起。
func attachToRunningService(ctx context.Context, c configuration, deadline time.Time, out io.Writer) (bool, error) {
	if canDial(c.deviceSocket()) {
		return true, printDeviceStartResult(out, c, false, 0)
	}
	if deviceLockHeld(c) {
		// 等的那份服务中途退出了就接着往下看，当作这里没有新版服务。
		if err := awaitAggregate(ctx, c, deadline, nil, out); !errors.Is(err, errServiceGone) {
			return true, err
		}
	}
	if harness := liveRuntime(c); harness != "" {
		return true, withoutAggregate(harness, "")
	}
	return false, nil
}

func pause(ctx context.Context, deadline time.Time, duration time.Duration) error {
	if !time.Now().Before(deadline) {
		return context.DeadlineExceeded
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(duration):
		return nil
	}
}

func printDeviceStartResult(out io.Writer, c configuration, started bool, pid int) error {
	result := deviceStartResult{Ready: true, Started: started, Socket: c.deviceSocket(), PID: pid, CLI: describeCLI(c)}
	// 进程号和来历从服务报的状况里取。锁没人拿着时那份状况可能是旧的，不采信；
	// 自己拉起的那一份，状况里的进程号还要对得上（对不上说明拿着锁的另有其人）。
	if deviceLockHeld(c) {
		if status, ok := readServiceStatus(c); ok && (pid == 0 || status.PID == pid) {
			result.PID, result.Service = status.PID, status.Service
		}
	}
	if c.localService {
		registered := true
		if err := registerLocalPowerService(c); err != nil {
			if started || !errors.Is(err, errPowerRegistrationUnsupported) {
				return err
			}
			registered = false
			fields := map[string]any{"servicePID": result.PID, "cliVersion": result.CLI.Version, "registered": false}
			if result.Service != nil {
				fields["serviceVersion"] = result.Service.Version
			}
			newJSONLog(filepath.Join(c.logsDirectory(), "device-start.jsonl"), "device-start").write("warn", "local_power_unsupported", fields)
		}
		result.LocalServiceRegistered = &registered
	}
	encoder := json.NewEncoder(out)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(result)
}

// 被拉起的常驻服务。别人的服务不归我们管，对应 nil。
type launchedService struct {
	process *os.Process
	exited  chan struct{}
	// 服务日志里这次启动之前已有的长度，出错时只摘这之后的内容。
	logPath   string
	logOffset int64
}

func (s *launchedService) stop() {
	_ = hostplatform.Stop(s.process)
	select {
	case <-s.exited:
	case <-time.After(10 * time.Second):
	}
}

// 这次启动以来服务输出的最后一段，原样附在错误后面。
func (s *launchedService) output() string {
	file, err := os.Open(s.logPath)
	if err != nil {
		return ""
	}
	defer file.Close()
	if _, err := file.Seek(s.logOffset, io.SeekStart); err != nil {
		return ""
	}
	data, _ := io.ReadAll(io.LimitReader(file, 64*1024))
	text := strings.TrimSpace(string(data))
	if len(text) > 2000 {
		text = "…" + text[len(text)-2000:]
	}
	return text
}

// 正等着的那份别人的服务不在了（设备锁没人拿着了）。
var errServiceGone = errors.New("service gone")

// 等聚合面能连。service 是这次调用自己拉起的服务；等的是别人的服务时为 nil。
func awaitAggregate(ctx context.Context, c configuration, deadline time.Time, service *launchedService, out io.Writer) error {
	fail := func(message string) error {
		if service == nil {
			return fmt.Errorf(tr("%s；设备进程的日志在 %s", "%s; the device process log is %s"), message, c.deviceLog())
		}
		// 自己拉起的服务没能给出聚合面，就不留着它。
		service.stop()
		if output := service.output(); output != "" {
			message += tr("。服务的输出：\n", ". Service output:\n") + output
		}
		return errors.New(message)
	}
	for {
		if canDial(c.deviceSocket()) {
			if service != nil {
				return printDeviceStartResult(out, c, true, service.process.Pid)
			}
			return printDeviceStartResult(out, c, false, 0)
		}
		status, known := readServiceStatus(c)
		if known && status.State == "unavailable" {
			if service == nil {
				if harness := liveRuntime(c); harness != "" {
					return withoutAggregate(harness, status.Detail)
				}
			} else if service.process.Pid == status.PID {
				return fail(fmt.Sprintf(tr("这份适配器给不出聚合面：%s", "this adapter cannot provide the aggregate endpoint: %s"), status.Detail))
			}
		}
		if service != nil {
			select {
			case <-service.exited:
				// 可能是被一份刚起来的旧版服务占了状态目录。
				if harness := liveRuntime(c); harness != "" {
					return withoutAggregate(harness, "")
				}
				return fail(tr("常驻服务启动后退出了", "the service exited right after starting"))
			default:
			}
		} else if !deviceLockHeld(c) {
			return errServiceGone
		}
		if err := pause(ctx, deadline, deviceStartPoll); err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				detail := ""
				if known && status.Detail != "" {
					detail = tr("；最近的状况：", "; last status: ") + status.Detail
				}
				return fail(fmt.Sprintf(tr("等聚合面就绪超时（%s）%s", "timed out waiting for the aggregate endpoint (%s)%s"), deviceStartTimeout, detail))
			}
			// 被中断时服务留着：它多半还在起，下次调用接着等。
			return errors.New(tr("已中断", "interrupted"))
		}
	}
}

// 以脱离当前会话的方式拉起常驻的 start，等聚合面能连。
func launchService(ctx context.Context, c configuration, deadline time.Time, out io.Writer) error {
	node := c.node
	if strings.ContainsRune(node, filepath.Separator) || strings.Contains(node, "/") {
		// 常驻服务换了工作目录，相对路径要先落成绝对的；指向的还是同一个 Node。
		absolute, err := filepath.Abs(node)
		if err == nil {
			node = absolute
		}
		if _, err := os.Stat(node); err != nil {
			return fmt.Errorf(tr("找不到 --node 指定的 Node.js: %s", "the Node.js given by --node was not found: %s"), node)
		}
	} else if _, err := exec.LookPath(node); err != nil {
		return errors.New(tr("找不到 Node.js，请确认已安装并加入 PATH，或用 --node 指定路径", "Node.js was not found; make sure it is installed and on PATH, or point to it with --node"))
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	log, err := openPrivateLog(c.logsDirectory(), "service.log")
	if err != nil {
		return err
	}
	defer log.Close()
	service := &launchedService{exited: make(chan struct{}), logPath: log.Name()}
	if info, err := log.Stat(); err == nil {
		service.logOffset = info.Size()
	}
	// --detached 排在最后：它标明这份服务是按需拉起、脱离出去的，生死不归别的服务管理器管。
	args := append(append([]string{"start", "--home", c.home, "--root", c.root, "--node", node}, c.launch...), "--detached")
	process := exec.Command(executable, args...)
	process.Env = os.Environ()
	// 标准输入输出都不继承：调用方（比如 ssh）不会因为服务还拿着它的管道而挂住。
	process.Stdin, process.Stdout, process.Stderr = nil, log, log
	if home, err := os.UserHomeDir(); err == nil {
		process.Dir = home
	}
	hostplatform.Detach(process)
	if err := process.Start(); err != nil {
		return fmt.Errorf(tr("无法拉起常驻服务: %w", "cannot launch the service: %w"), err)
	}
	service.process = process.Process
	go func() { _ = process.Wait(); close(service.exited) }()
	return awaitAggregate(ctx, c, deadline, service, out)
}

// device-proxy：把标准输入输出接到聚合面，只做字节转发。标准输出里只有对面来的字节。
func deviceProxy(ctx context.Context, c configuration) error {
	connection, err := hostplatform.Dial(c.deviceSocket())
	if err != nil {
		return fmt.Errorf(tr("聚合面连不上（%s）: %v；请先运行 codex-harness-adapter device-start", "cannot connect to the aggregate endpoint (%s): %v; run codex-harness-adapter device-start first"), c.deviceSocket(), err)
	}
	defer connection.Close()
	stop := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stop()
	go func() { _, _ = io.Copy(connection, os.Stdin); hostplatform.CloseWrite(connection) }()
	_, err = io.Copy(os.Stdout, connection)
	return err
}
