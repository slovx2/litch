// Copyright (c) 2026 tyrs-hand contributors. SPDX-License-Identifier: MIT
package sshserver

import "sync"

// ClientAuthorization 在同一 SSH 的入口之间共享；替换授权时关闭已撤销的连接。
type ClientAuthorization struct {
	replaceMu sync.Mutex
	mu        sync.RWMutex
	clients   map[string]string
	servers   map[*SSHServer]struct{}
}

func NewClientAuthorization(clients []AuthorizedClient) *ClientAuthorization {
	a := &ClientAuthorization{servers: map[*SSHServer]struct{}{}}
	a.Replace(clients)
	return a
}

func (a *ClientAuthorization) Lookup(key string) (string, bool) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	id, ok := a.clients[key]
	return id, ok
}

func (a *ClientAuthorization) Replace(clients []AuthorizedClient) {
	a.replaceMu.Lock()
	defer a.replaceMu.Unlock()
	next := make(map[string]string, len(clients))
	for _, client := range clients {
		next[string(client.PublicKey.Marshal())] = client.ID
	}
	a.mu.Lock()
	a.clients = next
	servers := make([]*SSHServer, 0, len(a.servers))
	for server := range a.servers {
		servers = append(servers, server)
	}
	a.mu.Unlock()
	for _, server := range servers {
		server.mu.Lock()
		for connection := range server.connections {
			if id, ok := next[connection.Permissions.Extensions["client-key"]]; !ok || id != connection.Permissions.Extensions["client-id"] {
				_ = connection.Close()
			}
		}
		server.mu.Unlock()
	}
}
