package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHookRefusesMissingBridge(t *testing.T) {
	for _, args := range [][]string{nil, {"http://example.com", "token"}, {"http://127.0.0.1:1", "token"}} {
		if err := hook(args, strings.NewReader(`{"hook_event_name":"PreToolUse"}`), io.Discard); err == nil {
			t.Fatal("桥不可用时没有拒绝")
		}
	}
}

func TestHookRequiresExplicitDecision(t *testing.T) {
	for _, result := range []string{`{}`, `null`, `{"hookSpecificOutput":{"permissionDecision":"allow"}}`, `not json`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer token" {
				t.Error("鉴权令牌没传递")
			}
			io.WriteString(w, result)
		}))
		if err := hook([]string{server.URL, "token"}, strings.NewReader(`{"hook_event_name":"PreToolUse"}`), io.Discard); err == nil {
			t.Errorf("接受了没有明确权限决定的应答：%s", result)
		}
		server.Close()
	}
}

func TestHookKeepsUpdatedInput(t *testing.T) {
	const result = `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"safe"}}}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, result) }))
	defer server.Close()
	var output bytes.Buffer
	if err := hook([]string{server.URL, "token"}, strings.NewReader(`{"hook_event_name":"PreToolUse"}`), &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != result+"\n" {
		t.Fatal("权限输入被改写")
	}
}
