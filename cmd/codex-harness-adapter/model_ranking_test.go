package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestModelRankingPersistence(t *testing.T) {
	home := t.TempDir()
	s := &controlServer{c: configuration{home: home}}
	read, e := s.handleModelRanking("modelRanking.read", nil)
	if e != nil {
		t.Fatal(e)
	}
	if read.(modelRankingConfig).Mode != "builtin" {
		t.Fatal(read)
	}
	key := `["codex","","gpt-6-sol"]`
	for revision := 0; revision < 6; revision++ {
		request := map[string]any{"expectedRevision": revision, "tiers": [][]string{{key}}, "unranked": []string{}, "models": []rankedModel{{Key: key, Harness: "codex", Model: "gpt-6-sol", Name: "Sol", Available: true}}}
		raw, _ := json.Marshal(request)
		out, e := s.handleModelRanking("modelRanking.write", raw)
		if e != nil {
			t.Fatal(e)
		}
		if out.(modelRankingConfig).Revision != revision+1 {
			t.Fatal(out)
		}
	}
	for i := 1; i <= 4; i++ {
		if _, err := os.Stat(filepath.Join(home, "device", "model-ranking.json.bak."+string(rune('0'+i)))); err != nil {
			t.Fatal(err)
		}
	}
	stale := json.RawMessage(`{"expectedRevision":0}`)
	if _, e := s.handleModelRanking("modelRanking.reset", stale); e == nil || e.Reason != "conflict" {
		t.Fatal(e)
	}
	valid := json.RawMessage(`{"expectedRevision":6}`)
	out, e := s.handleModelRanking("modelRanking.reset", valid)
	if e != nil || out.(modelRankingConfig).Mode != "builtin" {
		t.Fatal(out, e)
	}
	if err := os.WriteFile(filepath.Join(home, "device", "model-ranking.json"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, e := s.handleModelRanking("modelRanking.read", nil); e == nil {
		t.Fatal("corrupt state must not disable cap")
	}
}
func TestModelRankingValidation(t *testing.T) {
	value := emptyModelRanking()
	value.Models = []rankedModel{{Key: `["codex","","x"]`, Harness: "codex", Model: "x"}}
	if validateModelRanking(value) == nil {
		t.Fatal("missing placement")
	}
	value.Unranked = []string{value.Models[0].Key}
	if err := validateModelRanking(value); err != nil {
		t.Fatal(err)
	}
	value.Tiers = [][]string{{value.Models[0].Key}}
	if validateModelRanking(value) == nil {
		t.Fatal("duplicate")
	}
}

func TestModelRankingCrossHarnessDefaultAndPersistence(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "device", "model-ranking.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	// 现有 custom 文件没有新字段：直接按 false 读取，不迁移、不改 revision。
	raw := []byte(`{"schemaVersion":1,"revision":7,"mode":"custom","tiers":[],"unranked":[],"models":[]}`)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	before, err := readModelRanking(path)
	if err != nil || before.CrossHarness || before.Revision != 7 {
		t.Fatal(before, err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != string(raw) {
		t.Fatal("读取不得迁移或重写配置", err)
	}
	s := &controlServer{c: configuration{home: home}}
	for _, enabled := range []bool{true, false, true} {
		params, _ := json.Marshal(map[string]any{"expectedRevision": before.Revision, "crossHarness": enabled, "tiers": [][]string{}, "unranked": []string{}, "models": []rankedModel{}})
		out, failure := s.handleModelRanking("modelRanking.write", params)
		if failure != nil {
			t.Fatal(failure)
		}
		before = out.(modelRankingConfig)
		if before.CrossHarness != enabled {
			t.Fatal(before)
		}
		// 自动补目录不能变更开关，即使其请求缺字段。
		params, _ = json.Marshal(map[string]any{"expectedRevision": before.Revision, "tiers": [][]string{}, "unranked": []string{}, "models": []rankedModel{}})
		out, failure = s.handleModelRanking("modelRanking.merge", params)
		if failure != nil || out.(modelRankingConfig).CrossHarness != enabled {
			t.Fatal(out, failure)
		}
		before = out.(modelRankingConfig)
	}
	params, _ := json.Marshal(map[string]any{"expectedRevision": before.Revision})
	out, failure := s.handleModelRanking("modelRanking.reset", params)
	if failure != nil || out.(modelRankingConfig).CrossHarness {
		t.Fatal(out, failure)
	}
}
