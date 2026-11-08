package chromebridge

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/slovx2/litch-automation/internal/hostplatform"
)

// 每个原生连接持有自己的句柄；操作系统在进程退出时释放锁。锁文件不 unlink，避免换 inode 绕锁。
type claimLocks struct {
	mu        sync.Mutex
	directory string
	closed    bool
	leases    map[string]*os.File
	requests  map[string]string
}

func newClaimLocks(directory string) (*claimLocks, error) {
	if directory != "" {
		if !filepath.IsAbs(directory) {
			return nil, errors.New("Chrome claim lock directory must be absolute")
		}
		if err := os.MkdirAll(directory, 0700); err != nil {
			return nil, err
		}
	}
	return &claimLocks{directory: directory, leases: make(map[string]*os.File), requests: make(map[string]string)}, nil
}

// before 在原 claim 发给扩展前持锁；缺少新元数据的旧扩展保持协议 1 原行为。
func (locks *claimLocks) before(frame []byte) ([]byte, error) {
	var message struct {
		Kind string `json:"kind"`
		ID   string `json:"id"`
		Op   string `json:"op"`
		Args struct {
			TargetID string `json:"targetId"`
			Grant    struct {
				LeaseID string `json:"leaseId"`
			} `json:"grant"`
		} `json:"args"`
	}
	if err := json.Unmarshal(frame, &message); err != nil {
		return nil, err
	}
	if message.Kind != "request" || message.Op != "claim" || message.Args.TargetID == "" {
		return nil, nil
	}
	locks.mu.Lock()
	defer locks.mu.Unlock()
	reject := func(reason string) ([]byte, error) {
		return json.Marshal(map[string]any{"kind": "result", "id": message.ID,
			"error": map[string]string{"code": "busy", "message": reason}})
	}
	if locks.directory == "" || locks.closed {
		return reject("Chrome native host claim locking is unavailable. Update the host and configure its shared lock directory.")
	}
	id := strings.ToLower(message.Args.TargetID)
	decoded, err := hex.DecodeString(id)
	if err != nil || len(decoded) != 16 || message.Args.Grant.LeaseID == "" {
		return reject("Chrome claim has an invalid target identity.")
	}
	lease := message.Args.Grant.LeaseID
	if _, exists := locks.leases[lease]; exists {
		return reject("Chrome lease is already registered.")
	}
	digest := sha256.Sum256([]byte(id))
	file, err := os.OpenFile(filepath.Join(locks.directory, hex.EncodeToString(digest[:])+".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return reject("Chrome native host cannot open its shared claim lock.")
	}
	if err = hostplatform.Lock(file); err != nil {
		_ = file.Close()
		return reject("This Chrome tab is already controlled by another application (native host claim lock).")
	}
	locks.leases[lease] = file
	locks.requests[message.ID] = lease
	return nil, nil
}

// 扩展在 debugger detach 完成之后才发 revoked；不能在 Node 发 release 时提前放锁。
func (locks *claimLocks) after(frame []byte) {
	var message struct {
		Kind    string          `json:"kind"`
		ID      string          `json:"id"`
		LeaseID string          `json:"leaseId"`
		Error   json.RawMessage `json:"error"`
	}
	if json.Unmarshal(frame, &message) != nil {
		return
	}
	locks.mu.Lock()
	defer locks.mu.Unlock()
	if message.Kind == "revoked" {
		locks.release(message.LeaseID)
	}
	if message.Kind == "result" {
		lease, exists := locks.requests[message.ID]
		delete(locks.requests, message.ID)
		if exists && len(message.Error) > 0 && string(message.Error) != "null" {
			locks.release(lease)
		}
	}
}

func (locks *claimLocks) release(lease string) {
	if file := locks.leases[lease]; file != nil {
		hostplatform.Unlock(file)
		_ = file.Close()
		delete(locks.leases, lease)
	}
	for request, owner := range locks.requests {
		if owner == lease {
			delete(locks.requests, request)
		}
	}
}

func (locks *claimLocks) close() {
	locks.mu.Lock()
	defer locks.mu.Unlock()
	locks.closed = true
	for lease := range locks.leases {
		locks.release(lease)
	}
}
