package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

// 常驻服务一旦起来，跑的就一直是起它那一刻的那份程序。应用升级了、安装脚本装了新版，后台的还是旧的。
// 所以服务要说得出自己是哪一份：哪一版、从哪份适配器起的、什么时候起的、怎么起的。
// 这份“来历”在服务启动时定下来，之后不变，出现在四个地方，形状都一样：
//
//	<home>/device/service.json 的 service        只在设备锁被拿着时可信
//	device-start 就绪行的 service                 读的就是上面那个文件
//	device-stop 结果行的 service                  服务自己在应答里报的
//	控制通道 state 的 service                     设备进程据此在 runtime/info 的 device.service 里给客户端
//
// 这次改动之前的服务不报这一项。读的一方看不到它，就是“不知道，多半更旧”。
type serviceFacts struct {
	// 常驻的 start 进程。
	PID int `json:"pid"`
	// 和 version 子命令报的是同一个算法（selfVersion），所以两份适配器的版本能直接比。
	Version string `json:"version"`
	// 适配器的根目录（--root）：运行时和设备进程的代码从这里取。
	Root string `json:"root"`
	// 程序文件的戳，见 selfBuild。取不到时没有。
	Build string `json:"build,omitempty"`
	// RFC 3339，UTC。
	StartedAt string `json:"startedAt"`
	// 见 configuration.detached。
	Detached bool `json:"detached"`
	// 见 configuration.launch。
	Options []string `json:"options"`
}

// 执行当前这条命令的这份适配器。device-start 把它和在跑的那份服务一起报出来，调用方拿两边比。
type cliFacts struct {
	Version string `json:"version"`
	Root    string `json:"root"`
	Build   string `json:"build,omitempty"`
}

// 这份程序的版本号，算法和 version 子命令一样。
func selfVersion() string {
	root, err := executableRoot()
	if err != nil {
		return unknownVersion
	}
	return adapterVersion(root)
}

// 程序文件的戳：修改时间和大小。同一个位置上的程序被换过（应用升级、重新构建），戳就不一样。
// 开发期间版本号不变（一直是 package.json 里的那个），两份构建靠它分辨；
// 它只在同一个根目录上有意义，不同位置的两份适配器之间不能拿它比先后。
func selfBuild() string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	}
	info, err := os.Stat(executable)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%d-%d", info.ModTime().UnixNano(), info.Size())
}

func describeCLI(c configuration) cliFacts {
	return cliFacts{Version: selfVersion(), Root: c.root, Build: selfBuild()}
}

func describeService(c configuration) *serviceFacts {
	options := c.launch
	if options == nil {
		options = c.launchOptions()
	}
	return &serviceFacts{
		PID: os.Getpid(), Version: selfVersion(), Root: c.root, Build: selfBuild(),
		StartedAt: time.Now().UTC().Format(time.RFC3339), Detached: c.detached, Options: options,
	}
}

// 没给 --node 时用哪个 Node。随这份适配器带着的那一份在 <根目录>/node/bin/node：
// 装进 Litch 的（Resources/adapter）和独立发布包（libexec）都是这个布局，在就用它。
// 没有（从源码运行、Homebrew）才是 PATH 里的 node，和以前一样。
// 不靠改 PATH 来用上它：常驻服务里用户跑的命令会继承服务的环境，不能让随包的 Node 盖住用户自己的。
func defaultNode(root string) string {
	name := "node"
	if runtime.GOOS == "windows" {
		name = "node.exe"
	}
	bundled := filepath.Join(root, "node", "bin", name)
	if info, err := os.Stat(bundled); err == nil && !info.IsDir() {
		return bundled
	}
	return "node"
}

// 见 configuration.launch。
func (c configuration) launchOptions() []string {
	mode := "on"
	if c.sshDisabled {
		mode = "off"
	}
	options := []string{"--ssh=" + mode,
		"--claude-port", strconv.Itoa(c.claudePort), "--pi-port", strconv.Itoa(c.piPort), "--dsh-port", strconv.Itoa(c.dshPort)}
	if c.harness != "" {
		options = append(options, "--harness", c.harness, "--port", strconv.Itoa(c.port))
	}
	return options
}
