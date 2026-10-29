package sshtransport

import (
	"context"
	"sync"
)

// 所有认证连接共享闸门，包括开流、探测/启动脚本和配对。
// 登记覆盖拨号、握手和返回后的整条连接，暂停与快速恢复也不能放过旧请求。
var sshGate = struct {
	sync.Mutex
	paused bool
	active map[*sshAttempt]context.CancelFunc
}{active: make(map[*sshAttempt]context.CancelFunc)}

type sshAttempt struct{ context.Context }

func beginSSH(parent context.Context) (*sshAttempt, func(), error) {
	sshGate.Lock()
	defer sshGate.Unlock()
	if sshGate.paused {
		return nil, nil, kindf(kindUnreachable, "后台连接已暂停")
	}
	ctx, cancel := context.WithCancel(parent)
	attempt := &sshAttempt{ctx}
	sshGate.active[attempt] = cancel
	return attempt, func() {
		sshGate.Lock()
		delete(sshGate.active, attempt)
		sshGate.Unlock()
		cancel()
	}, nil
}

func setSSHPaused(paused bool) {
	sshGate.Lock()
	defer sshGate.Unlock()
	sshGate.paused = paused
	if paused {
		for _, cancel := range sshGate.active {
			cancel()
		}
	}
}
