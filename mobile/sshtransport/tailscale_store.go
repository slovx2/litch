package sshtransport

import (
	"encoding/json"
	"fmt"
	"sync"

	"tailscale.com/ipn"
)

// TailscaleStorage 由原生平台同步实现。JSON 含节点秘密，只能加密保存，不得经过 JS 或日志。
// Read 空串表示不存在；Write 必须原子落盘；Clear 删除密文和加密密钥。调用不得重入 Go。
type TailscaleStorage interface {
	Read() (string, error)
	Write(state string) error
	Clear() error
}

type tailSaved struct {
	Enabled    bool                    `json:"enabled"`
	ControlURL string                  `json:"controlURL"`
	States     map[ipn.StateKey][]byte `json:"states"`
}

type tailStore struct {
	mu      sync.Mutex
	storage TailscaleStorage
	saved   tailSaved
}

func newTailStore(storage TailscaleStorage) (*tailStore, error) {
	text, err := storage.Read()
	if err != nil {
		return nil, fmt.Errorf("[tailscaleStorage] 读取加密状态失败: %w", err)
	}
	s := &tailStore{storage: storage, saved: tailSaved{States: make(map[ipn.StateKey][]byte)}}
	if text != "" {
		var saved tailSaved
		if err := json.Unmarshal([]byte(text), &saved); err != nil || saved.States == nil {
			return nil, fmt.Errorf("[tailscaleStorage] 加密状态格式无效，请清除状态后登录")
		}
		s.saved = saved
	}
	return s, nil
}

func (s *tailStore) ReadState(id ipn.StateKey) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.saved.States[id]
	if !ok {
		return nil, ipn.ErrStateNotExist
	}
	return append([]byte{}, b...), nil
}

func (s *tailStore) WriteState(id ipn.StateKey, b []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := tailSaved{Enabled: s.saved.Enabled, ControlURL: s.saved.ControlURL, States: make(map[ipn.StateKey][]byte)}
	for key, value := range s.saved.States {
		next.States[key] = value
	}
	if b == nil {
		delete(next.States, id)
	} else {
		next.States[id] = append([]byte{}, b...)
	}
	return s.saveLocked(next)
}

func (s *tailStore) saveLocked(next tailSaved) error {
	b, err := json.Marshal(next)
	if err != nil {
		return err
	}
	if err = s.storage.Write(string(b)); err != nil {
		return fmt.Errorf("[tailscaleStorage] 保存加密状态失败: %w", err)
	}
	s.saved = next
	return nil
}

func (s *tailStore) control() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saved.ControlURL
}

func (s *tailStore) setControl(control string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.saved.ControlURL != "" && s.saved.ControlURL != control {
		return fmt.Errorf("[tailscaleControl] 更换控制服务器前请先清除状态")
	}
	return s.saveLocked(tailSaved{Enabled: true, ControlURL: control, States: s.saved.States})
}

func (s *tailStore) enabled() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saved.Enabled
}

func (s *tailStore) disable() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.saved
	next.Enabled = false
	return s.saveLocked(next)
}
