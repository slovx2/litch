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
