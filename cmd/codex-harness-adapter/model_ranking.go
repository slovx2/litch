package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// 等级配置由控制进程独占写入；独立版本避免与无关设备设置竞争。
var modelRankingMu sync.Mutex

type rankedModel struct {
	Key       string `json:"key"`
	Harness   string `json:"harness"`
	Model     string `json:"model"`
	Name      string `json:"name"`
	Provider  string `json:"provider,omitempty"`
	Resolved  string `json:"resolved,omitempty"`
	Trusted   bool   `json:"trusted,omitempty"`
	Available bool   `json:"available"`
}
type modelRankingConfig struct {
	SchemaVersion int           `json:"schemaVersion"`
	Revision      int           `json:"revision"`
	Mode          string        `json:"mode"`
	Tiers         [][]string    `json:"tiers"`
	Unranked      []string      `json:"unranked"`
	Manual        []string      `json:"manual,omitempty"`
	Models        []rankedModel `json:"models"`
}

func emptyModelRanking() modelRankingConfig {
	return modelRankingConfig{SchemaVersion: 1, Mode: "builtin", Tiers: [][]string{}, Unranked: []string{}, Models: []rankedModel{}}
}
func rankingIdentity(m rankedModel) string {
	if m.Resolved != "" {
		return m.Resolved
	}
	prefix := m.Provider + "/"
	if m.Provider != "" && len(m.Model) > len(prefix) && m.Model[:len(prefix)] == prefix {
		return m.Model[len(prefix):]
	}
	return m.Model
}
func validateModelRanking(value modelRankingConfig) error {
	if value.Models == nil || value.Tiers == nil || value.Unranked == nil {
		return fmt.Errorf("model ranking arrays are required")
	}
	if value.SchemaVersion != 1 || value.Revision < 0 || (value.Mode != "builtin" && value.Mode != "custom") || len(value.Models) > 10000 || len(value.Tiers) > 10000 {
		return fmt.Errorf("invalid model ranking")
	}
	known := map[string]bool{}
	for _, m := range value.Models {
		var identity []string
		if m.Key == "" || len(m.Key) > 2048 || m.Harness == "" || m.Model == "" || len(m.Name) > 2048 || known[m.Key] || json.Unmarshal([]byte(m.Key), &identity) != nil || len(identity) != 3 || identity[0] != m.Harness || identity[1] != m.Provider || identity[2] != rankingIdentity(m) {
			return fmt.Errorf("invalid model identity")
		}
		known[m.Key] = true
	}
	for _, key := range value.Manual {
		if !known[key] {
			return fmt.Errorf("unknown manually placed model")
		}
	}
	placed := map[string]bool{}
	for _, group := range value.Tiers {
		if len(group) == 0 {
			return fmt.Errorf("empty model rank")
		}
	}
	groups := append(append([][]string{}, value.Tiers...), value.Unranked)
	for _, group := range groups {
		for _, key := range group {
			if !known[key] || placed[key] {
				return fmt.Errorf("unknown or duplicated model placement")
			}
			placed[key] = true
		}
	}
	if len(placed) != len(known) {
		return fmt.Errorf("every model needs a placement")
	}
	return nil
}
func readModelRanking(path string) (modelRankingConfig, error) {
	value := emptyModelRanking()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return value, nil
	}
	if err != nil {
		return value, err
	}
	if len(data) > 4*1024*1024 {
		return value, fmt.Errorf("model ranking too large")
	}
	value = modelRankingConfig{}
	if err = json.Unmarshal(data, &value); err != nil {
		return value, err
	}
	return value, validateModelRanking(value)
}
func (s *controlServer) handleModelRanking(method string, params json.RawMessage) (any, *controlError) {
	modelRankingMu.Lock()
	defer modelRankingMu.Unlock()
	path := filepath.Join(s.c.home, "device", "model-ranking.json")
	current, err := readModelRanking(path)
	if err != nil {
		return nil, controlFailure(fmt.Errorf("cannot read model ranking: %w", err))
	}
	if method == "modelRanking.read" {
		return current, nil
	}
	var request struct {
		ExpectedRevision *int          `json:"expectedRevision"`
		Tiers            [][]string    `json:"tiers"`
		Unranked         []string      `json:"unranked"`
		Manual           []string      `json:"manual,omitempty"`
		Models           []rankedModel `json:"models"`
	}
	if len(params) > 4*1024*1024 {
		return nil, &controlError{Reason: "invalid", Text: both("模型等级配置过大", "Model ranking is too large")}
	}
	if failure := decodeControlParams(params, &request); failure != nil {
		return nil, failure
	}
	if request.ExpectedRevision == nil || *request.ExpectedRevision != current.Revision {
		return nil, &controlError{Reason: "conflict", Text: both("模型等级已更新，请重新读取后保存", "Model ranking changed. Reload before saving")}
	}
	next := emptyModelRanking()
	next.Revision = current.Revision + 1
	if method == "modelRanking.write" || method == "modelRanking.merge" {
		next.Mode = "custom"
		if method == "modelRanking.merge" {
			next.Mode = current.Mode
		}
		next.Tiers = request.Tiers
		next.Unranked = request.Unranked
		next.Manual = request.Manual
		next.Models = request.Models
	}
	if err := validateModelRanking(next); err != nil {
		return nil, &controlError{Reason: "invalid", Text: both("模型等级配置无效", err.Error())}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, controlFailure(err)
	}
	// 最近四次成功配置用于恢复；原子写入主文件前备份，不删除未知路径。
	if data, err := os.ReadFile(path); err == nil {
		for i := 3; i >= 1; i-- {
			old := fmt.Sprintf("%s.bak.%d", path, i)
			if b, e := os.ReadFile(old); e == nil {
				if e = os.WriteFile(fmt.Sprintf("%s.bak.%d", path, i+1), b, 0600); e != nil {
					return nil, controlFailure(e)
				}
			}
		}
		if err = os.WriteFile(path+".bak.1", data, 0600); err != nil {
			return nil, controlFailure(err)
		}
	}
	if err := writePrivateJSON(path, next); err != nil {
		return nil, controlFailure(err)
	}
	return next, nil
}
