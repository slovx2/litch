package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
)

// 设备的设置。存在 <home>/device/settings.json，只有属主可读写。
//
// 这一层是设置唯一的读写方：它先于设备进程决定起哪些运行时，所以结构、校验、落盘都在这里。
// 设备进程只是协议上的门面，经控制通道（control.go）把读写转过来。
//
// 文件里只有“写过的”键。没写过的键用默认值，默认值由启动参数决定（--ssh、--claude-port 等）：
// 所以文件不存在时，一切和没有这个功能时一样。
//
// 环境文件（<home>/env）不导入进来，它一直是设置下面的一层：只用官方桌面端的安装没有界面可改设置，
// 改配置靠的就是那个文件；拷一份进来的话，之后再改文件会被拷进来的旧值盖住。

type settingsFile struct {
	Version int                        `json:"version"`
	Values  map[string]json.RawMessage `json:"values"`
}

type settingsStore struct {
	path    string
	mu      sync.Mutex
	version int
	values  map[string]json.RawMessage
}

func settingsPath(home string) string { return filepath.Join(home, "device", "settings.json") }

// 文件不存在不是错误：一切用默认值，版本号是 0。内容坏了就报错，不猜。
func loadSettings(home string) (*settingsStore, error) {
	store := &settingsStore{path: settingsPath(home), values: map[string]json.RawMessage{}}
	data, err := os.ReadFile(store.path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf(tr("无法读取设置文件 %s: %w", "cannot read the settings file %s: %w"), store.path, err)
	}
	var file settingsFile
	if err := json.Unmarshal(data, &file); err != nil || file.Version < 0 {
		return nil, fmt.Errorf(tr(
			"设置文件 %s 的内容无效；请修正它，或者删掉它回到默认设置",
			"the settings file %s is invalid; fix it, or delete it to go back to the defaults",
		), store.path)
	}
	store.version = file.Version
	if file.Values != nil {
		store.values = file.Values
	}
	return store, nil
}

// 下面几个读取方法都接受 nil：没有设置（比如用例里手工拼的配置）就是全用默认值。
// 文件被手工改坏了的那一项也按没写过算。

func (s *settingsStore) lookup(key string) (json.RawMessage, bool) {
	if s == nil {
		return nil, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, ok := s.values[key]
	return raw, ok
}

func (s *settingsStore) boolean(key string, fallback bool) bool {
	var value bool
	if raw, ok := s.lookup(key); ok && json.Unmarshal(raw, &value) == nil {
		return value
	}
	return fallback
}

func (s *settingsStore) integer(key string, fallback int) int {
	var value int
	if raw, ok := s.lookup(key); ok && json.Unmarshal(raw, &value) == nil {
		return value
	}
	return fallback
}

func (s *settingsStore) text(key string) string {
	var value string
	if raw, ok := s.lookup(key); ok && json.Unmarshal(raw, &value) == nil {
		return value
	}
	return ""
}

func (s *settingsStore) env(key string) []envEntry {
	var value []envEntry
	if raw, ok := s.lookup(key); ok && json.Unmarshal(raw, &value) == nil {
		return value
	}
	return nil
}

// 环境变量表里的一项。Value 用指针：密钥读出去时不带值，写进来时不带值表示保留原来的。
type envEntry struct {
	Name   string  `json:"name"`
	Value  *string `json:"value,omitempty"`
	Secret bool    `json:"secret,omitempty"`
}

// 名字看着像密钥的变量，不标也按密钥处理：读的时候不给值。
var secretLikeName = regexp.MustCompile(`(?i)(key|token|secret|passw|credential|auth)`)

type settingEdit struct {
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value"`
}

// 写入被拒绝的原因。conflict：版本号对不上；invalid：键不认识或者值不合规矩。
type settingsProblem struct {
	reason string
	key    string
	text   bilingual
}

func invalidSetting(key string, text bilingual) *settingsProblem {
	return &settingsProblem{reason: "invalid", key: key, text: text}
}

// apply 按键写入：要么全部写入，要么一项都不写。返回真的变了的键。
// validate 看的是写入之后的整份值，用来查跨键的规矩（端口不能撞）。
func (s *settingsStore) apply(expected int, edits []settingEdit, schema settingsSchema, validate func(func(string) (json.RawMessage, bool)) *settingsProblem) ([]string, *settingsProblem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if expected != s.version {
		return nil, &settingsProblem{reason: "conflict", text: both(
			"设置已经被别处改过了，请按最新的内容再改",
			"The settings were changed elsewhere; make the change again on the latest version",
		)}, nil
	}
	next := make(map[string]json.RawMessage, len(s.values))
	for key, raw := range s.values {
		next[key] = raw
	}
	touched := map[string]bool{}
	for _, edit := range edits {
		spec, known := schema.spec(edit.Key)
		if !known {
			return nil, invalidSetting(edit.Key, both("没有这个设置项", "There is no such setting")), nil
		}
		if touched[edit.Key] {
			return nil, invalidSetting(edit.Key, both("同一个设置项在一次写入里出现了两次", "The same setting appears twice in one write")), nil
		}
		touched[edit.Key] = true
		normalized, problem := normalizeSetting(spec, edit.Value, s.values[edit.Key])
		if problem != nil {
			return nil, problem, nil
		}
		if normalized == nil {
			delete(next, edit.Key)
		} else {
			next[edit.Key] = normalized
		}
	}
	if validate != nil {
		if problem := validate(func(key string) (json.RawMessage, bool) { raw, ok := next[key]; return raw, ok }); problem != nil {
			return nil, problem, nil
		}
	}
	changed := []string{}
	for key := range touched {
		before, had := s.values[key]
		after, has := next[key]
		if had != has || !bytes.Equal(before, after) {
			changed = append(changed, key)
		}
	}
	sort.Strings(changed)
	if len(changed) == 0 {
		return changed, nil, nil
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return nil, nil, err
	}
	if err := writePrivateJSON(s.path, settingsFile{Version: s.version + 1, Values: next}); err != nil {
		return nil, nil, err
	}
	s.version, s.values = s.version+1, next
	return changed, nil, nil
}

// present 给出读设置时看到的那一份：每个设置项的现行值（写过的，否则默认值），密钥不带值。
func (s *settingsStore) present(schema settingsSchema) (version int, values map[string]any, explicit []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	values, explicit = map[string]any{}, []string{}
	for _, spec := range schema.Settings {
		raw, written := s.values[spec.Key]
		if written {
			explicit = append(explicit, spec.Key)
		}
		values[spec.Key] = presentSetting(spec, raw, written)
	}
	sort.Strings(explicit)
	return s.version, values, explicit
}
