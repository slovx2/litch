package sshserver

import (
	"testing"

	"github.com/stretchr/testify/require"
)

const remoteDesktopLauncherFixture = `sh -c 'if [ -z "$SHELL" ] || [ ! -x "$SHELL" ]; then ` +
	`echo "Codex remote SSH requires SHELL to point to an executable login shell" >&2; ` +
	`exit 127; fi; CODEX_REMOTE_PAYLOAD="$1"; export CODEX_REMOTE_PAYLOAD; ` +
	`exec /bin/sh -c "$CODEX_REMOTE_PAYLOAD"' sh ` +
	`'printf '\''%b'\'' '\''\373\351\203\326\054\020\265\233'\''; ` +
	`PATH="${CODEX_INSTALL_DIR:-$HOME/.local/bin}:$PATH"; export PATH; codex app-server proxy'`

func TestParseDesktopProxyCommand(t *testing.T) {
	for _, command := range []string{"codex app-server proxy", "exec codex app-server proxy"} {
		handshake, matched, err := parseDesktopProxyCommand(command)
		require.NoError(t, err)
		require.True(t, matched)
		require.Empty(t, handshake)
	}

	command := `printf '%b' '\033\124\376\322\310\106\334\116'; ` +
		`PATH="${CODEX_INSTALL_DIR:-$HOME/.local/bin}:$PATH"; export PATH; codex app-server proxy`
	handshake, matched, err := parseDesktopProxyCommand(command)
	require.NoError(t, err)
	require.True(t, matched)
	require.Equal(t, []byte{0x1b, 'T', 0xfe, 0xd2, 0xc8, 'F', 0xdc, 'N'}, handshake)

	handshake, matched, err = parseDesktopProxyCommand(remoteDesktopLauncherFixture)
	require.NoError(t, err)
	require.True(t, matched)
	require.Equal(t, []byte{0xfb, 0xe9, 0x83, 0xd6, ',', 0x10, 0xb5, 0x9b}, handshake)

	for _, command := range []string{
		"printf wrong; codex app-server proxy",
		"printf wrong; exec codex app-server proxy",
		"codex -c features.code_mode_host=true app-server --listen unix://",
		"exec codex -c features.code_mode_host=true app-server --listen unix://",
	} {
		handshake, matched, err = parseDesktopProxyCommand(command)
		require.NoError(t, err)
		require.False(t, matched)
		require.Empty(t, handshake)
	}

	handshake, matched, err = parseDesktopProxyCommand("printf ordinary")
	require.NoError(t, err)
	require.False(t, matched)
	require.Empty(t, handshake)
}

// 当前客户端的启动器（含登录 shell 分派与 agent 软链），以及外层文案变化后的变体，
// 都只以最终负载是否执行 proxy 为准。
func TestParseDesktopProxyCommandToleratesLauncherChanges(t *testing.T) {
	payload := `'printf '\''%b'\'' '\''\370\026\365\332\303\151\333\206'\''; ` +
		`PATH="${CODEX_INSTALL_DIR:-$HOME/.local/bin}:$PATH"; export PATH; ` +
		`if [ -S "${SSH_AUTH_SOCK:-}" ]; then ln -sfn -- "$SSH_AUTH_SOCK" x; fi && exec codex app-server proxy'`
	handshake := []byte{0xf8, 0x16, 0xf5, 0xda, 0xc3, 0x69, 0xdb, 0x86}
	for _, launcher := range []string{
		`sh -c 'if [ -z "$SHELL" ] || [ ! -x "$SHELL" ]; then echo "Codex remote SSH requires SHELL to point to an executable login shell" >&2; exit 127; fi; ` +
			`CODEX_REMOTE_PAYLOAD="$1"; export CODEX_REMOTE_PAYLOAD; case "${SHELL##*/}" in ` +
			`*) exec "$SHELL" -l -i -c '\''exec /bin/sh -c "$CODEX_REMOTE_PAYLOAD"'\'' ;; esac' sh ` + payload,
		`sh -c 'test -x "$SHELL" || { echo "login shell unavailable" >&2; exit 127; }; exec "$SHELL" -l -c "$1"' sh ` + payload,
	} {
		parsed, matched, err := parseDesktopProxyCommand(launcher)
		require.NoError(t, err)
		require.True(t, matched)
		require.Equal(t, handshake, parsed)
	}

	parsed, matched, err := parseDesktopProxyCommand(`sh -c 'exec "$SHELL" -l -c "$1"' sh 'exec codex app-server proxy'`)
	require.NoError(t, err)
	require.True(t, matched)
	require.Empty(t, parsed)

	for _, command := range []string{
		`sh -c 'echo codex app-server proxy; true'`,
		`sh -c 'mycodex app-server proxy'`,
		`bash -c 'codex app-server proxy'`,
	} {
		_, matched, err = parseDesktopProxyCommand(command)
		require.NoError(t, err)
		require.False(t, matched, command)
	}
}
