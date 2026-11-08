"""真 TUI 的权限闸验收：隔离目录、假模型、系统沙箱只许回环；不读取用户凭据。"""
from __future__ import annotations

import fcntl
import http.server
import json
import os
import queue
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time
from typing import Any

CLI = os.environ['CHA_CLAUDE_CLI']
OUT = Path(os.environ.get('TUI_PROBE_OUT', tempfile.mkdtemp(prefix='litch-tui-hooks-'))).resolve()
OUT.mkdir(parents=True, exist_ok=True)
ROOT = Path(tempfile.mkdtemp(prefix='lth-')).resolve()
RECORDS: list[dict[str, Any]] = []
MODE = ''
WORK = ROOT


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args: Any) -> None:
        pass

    def do_GET(self) -> None:
        self.reply()

    def do_POST(self) -> None:
        self.reply()

    def reply(self) -> None:
        raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        body = json.loads(raw) if raw else {}
        if self.path.endswith('/slow-hook'):
            time.sleep(3)
        if self.path.endswith('/hook') or self.path.endswith('/slow-hook'):
            payload = {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'allow', 'updatedInput': {'command': 'printf updated > updated-marker'}}}
            if MODE == 'block-stop':
                payload = {'continue': False, 'stopReason': 'handoff', 'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': 'handoff'}}
            self.send_response(200)
            self.end_headers()
            try:
                self.wfile.write(json.dumps(payload).encode())
            except BrokenPipeError:
                pass
            return
        row = {'mode': MODE, 'path': self.path, 'ua': self.headers.get('User-Agent'), 'body': body}
        RECORDS.append(row)
        if '/messages' not in self.path or 'count_tokens' in self.path:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"input_tokens":100}')
            return
        is_main = self.headers.get('x-claude-code-request-class') == 'main'
        # 旧版未发分类头时，由用户提示区分辅助请求。
        is_main = is_main or any('TUI_HOOK_PROBE' in json.dumps(m) for m in body.get('messages', []))
        has_tool_result = any('tool_result' in json.dumps(m) for m in body.get('messages', []))
        tool = is_main and not has_tool_result
        block: dict[str, Any] = {'type': 'tool_use', 'id': 'probe_tool_1', 'name': 'Bash',
                                'input': {'command': 'printf executed > original-marker'}} if tool else {'type': 'text', 'text': 'PROBE_DONE'}
        usage = {'input_tokens': 100, 'output_tokens': 10, 'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 0}
        reason = 'tool_use' if tool else 'end_turn'
        msg = {'id': f'msg_{len(RECORDS)}', 'type': 'message', 'role': 'assistant',
               'model': body.get('model', 'claude-sonnet-4-6'), 'content': [block],
               'stop_reason': reason, 'stop_sequence': None, 'usage': usage}
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream' if body.get('stream') else 'application/json')
        self.end_headers()
        if not body.get('stream'):
            self.wfile.write(json.dumps(msg).encode())
            return
        start = {**block, 'input': {}} if tool else {**block, 'text': ''}
        delta = {'type': 'input_json_delta', 'partial_json': json.dumps(block['input'])} if tool else {'type': 'text_delta', 'text': block['text']}
        events = [
            {'type': 'message_start', 'message': {**msg, 'content': [], 'stop_reason': None}},
            {'type': 'content_block_start', 'index': 0, 'content_block': start},
            {'type': 'content_block_delta', 'index': 0, 'delta': delta},
            {'type': 'content_block_stop', 'index': 0},
            {'type': 'message_delta', 'delta': {'stop_reason': reason, 'stop_sequence': None}, 'usage': usage},
            {'type': 'message_stop'},
        ]
        for event in events:
            self.wfile.write(f'event: {event["type"]}\ndata: {json.dumps(event)}\n\n'.encode())
        self.wfile.flush()


def run(mode: str, server: http.server.ThreadingHTTPServer) -> dict[str, Any]:
    global MODE, WORK
    MODE = mode
    home = ROOT / mode
    home.mkdir()
    WORK = home / 'work'
    WORK.mkdir()
    config = home / '.claude'
    config.mkdir()
    state = {'hasCompletedOnboarding': True, 'theme': 'dark',
             'projects': {str(WORK): {'hasTrustDialogAccepted': True}},
             'customApiKeyResponses': {'approved': ['fake-local-only'], 'rejected': []}}
    (home / '.claude.json').write_text(json.dumps(state))
    (config / '.claude.json').write_text(json.dumps(state))
    hook = home / 'hook.sh'
    if mode in ('update', 'ask-update'):
        output = {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'allow',
                                         'updatedInput': {'command': 'printf updated > updated-marker'}}}
        action = "printf '%s\\n' '" + json.dumps(output) + "'\n"
    elif mode == 'deny':
        action = 'echo "bridge unavailable" >&2\nexit 2\n'
    else:
        action = 'exit 127\n'
    hook.write_text('#!/bin/sh\ncat > ' + str(home / 'hook-input.json') + '\n' + action)
    settings = {'hooks': {'PreToolUse': [{'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': f'/bin/sh {hook}'}]}]}}
    if mode.startswith('ask-'):
        settings['permissions'] = {'ask': ['Bash']}
    if mode == 'timeout':
        hook.write_text('#!/bin/sh\ncat > ' + str(home / 'hook-input.json') + '\nsleep 5\nexit 2\n')
        settings['hooks']['PreToolUse'][0]['hooks'][0]['timeout'] = 1
    if mode.startswith('block-'):
        token_file = home / 'bridge-token'
        token_file.write_text('a' * 64)
        token_file.chmod(0o600)
        hook_command: dict[str, Any] = {'type': 'command', 'command': '/tmp/litch-claude-tui-helper',
            'args': ['hook', f'http://127.0.0.1:{server.server_port}/hook', str(token_file)], 'onFailure': 'block'}
        if mode == 'block-missing':
            hook_command['command'] = '/tmp/litch-tui-missing-executable'
        if mode == 'block-unavailable':
            hook_command['args'][1] = 'http://127.0.0.1:1/hook'
        if mode == 'block-timeout':
            hook_command['args'][1] = f'http://127.0.0.1:{server.server_port}/slow-hook'
            hook_command['timeout'] = 1
        settings['hooks']['PreToolUse'][0]['hooks'] = [hook_command]
    (config / 'settings.json').write_text(json.dumps(settings))
    env = {'PATH': '/opt/homebrew/opt/node@24/bin:/usr/bin:/bin:/usr/sbin:/sbin',
           'HOME': str(home), 'CODEX_HOME': str(home / '.codex'), 'CLAUDE_CONFIG_DIR': str(config),
           'CLAUDE_CODE_TMPDIR': str(home / 'ct'), 'TMPDIR': str(home), 'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8',
           'ANTHROPIC_API_KEY': 'fake-local-only', 'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{server.server_port}',
           'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_AUTOUPDATER': '1',
           'CLAUDE_CODE_DISABLE_TERMINAL_TITLE': '1', 'DISABLE_TELEMETRY': '1', 'DISABLE_ERROR_REPORTING': '1'}
    # 隔离子进程之前解析真实用户目录，禁止读取凭据；不把某个开发者的路径写进仓库。
    personal_home = Path.home()
    protected = ' '.join(
        f'({kind} {json.dumps(str(personal_home / relative), ensure_ascii=False)})'
        for kind, relative in [('subpath', '.claude'), ('literal', '.claude.json'),
                               ('subpath', 'Library/Keychains')]
    )
    profile = '(version 1)(allow default)(deny network*)(allow network* (remote ip "localhost:*"))' + f'(deny file-read* {protected})'
    command = ['/usr/bin/sandbox-exec', '-p', profile, CLI, '--model', 'claude-sonnet-4-6', '--setting-sources', 'user']
    if mode in ('unavailable', 'timeout', 'ask-unavailable', 'ask-update') or mode.startswith('block-'):
        # 用已被原生规则允许的工具检查 hook 失效会否绕过宿主权限。
        command.extend(['--allowedTools', 'Bash'])
    if os.environ.get('TUI_PROBE_DRIVER') == 'helper':
        return run_helper(mode, command, env, home)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 200, 0, 0))

    def controlling_terminal() -> None:
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

    proc = subprocess.Popen(command, env=env, cwd=WORK, stdin=slave, stdout=slave, stderr=slave, preexec_fn=controlling_terminal)
    os.close(slave)
    output = bytearray()
    start = time.monotonic()
    sent = False
    submitted = False
    try:
        while time.monotonic() - start < 35:
            if select.select([master], [], [], 0.2)[0]:
                try:
                    chunk = os.read(master, 1000000)
                except OSError:
                    break
                output.extend(chunk)
                if b'\x1b[6n' in chunk:
                    os.write(master, b'\x1b[1;1R')
                if b'\x1b[c' in chunk:
                    os.write(master, b'\x1b[?1;2c')
            if proc.poll() is not None:
                break
            if not sent and time.monotonic() - start > 7:
                os.write(master, b'\x1b[200~TUI_HOOK_PROBE execute the requested Bash tool then reply PROBE_DONE.\x1b[201~')
                sent = True
            if sent and not submitted and time.monotonic() - start > 8:
                os.write(master, b'\r')
                submitted = True
            if time.monotonic() - start > 12 and any(r['mode'] == mode and 'tool_result' in json.dumps(r['body']) for r in RECORDS):
                break
    finally:
        os.close(master)
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=3)
    (OUT / f'{mode}-terminal.txt').write_bytes(output)
    (OUT / f'{mode}-requests.json').write_text(json.dumps([r for r in RECORDS if r['mode'] == mode], indent=2))
    hook_input = home / 'hook-input.json'
    result = {'mode': mode, 'home': str(home), 'hook_called': hook_input.exists(),
              'original_executed': (WORK / 'original-marker').exists(),
              'updated_executed': (WORK / 'updated-marker').exists(),
              'has_tool_result': any(r['mode'] == mode and 'tool_result' in json.dumps(r['body']) for r in RECORDS)}
    if hook_input.exists():
        (OUT / f'{mode}-hook.json').write_text(hook_input.read_text())
    return result


def run_helper(mode: str, command: list[str], env: dict[str, str], home: Path) -> dict[str, Any]:
    command.insert(3, '/tmp/litch-claude-tui-helper')
    proc = subprocess.Popen(command, env=env, cwd=WORK, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    assert proc.stdin is not None and proc.stdout is not None and proc.stderr is not None
    rows: queue.Queue[bytes] = queue.Queue()
    stderr: list[bytes] = []
    def read_output() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            rows.put(line)
    def read_error() -> None:
        assert proc.stderr is not None
        stderr.append(proc.stderr.read())
    reader = threading.Thread(target=read_output, daemon=True)
    errors = threading.Thread(target=read_error, daemon=True)
    reader.start()
    errors.start()
    proc.stdin.write((json.dumps({'type': 'user', 'message': {'role': 'user', 'content': 'TUI_HOOK_PROBE execute the requested Bash tool then reply PROBE_DONE.'}}) + '\n').encode())
    proc.stdin.flush()
    lines: list[bytes] = []
    deadline = time.monotonic() + 40
    try:
        while time.monotonic() < deadline and proc.poll() is None:
            try:
                line = rows.get(timeout=0.2)
                lines.append(line)
                if json.loads(line).get('type') == 'result':
                    break
            except queue.Empty:
                continue
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=3)
        reader.join(timeout=2)
        errors.join(timeout=2)
    (OUT / f'{mode}-stdout.jsonl').write_bytes(b''.join(lines))
    (OUT / f'{mode}-stderr.txt').write_bytes(b''.join(stderr))
    (OUT / f'{mode}-requests.json').write_text(json.dumps([r for r in RECORDS if r['mode'] == mode], indent=2))
    return {'mode': mode, 'driver': 'helper', 'home': str(home), 'original_executed': (WORK / 'original-marker').exists(),
            'updated_executed': (WORK / 'updated-marker').exists(), 'events': [json.loads(line).get('type') for line in lines]}


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    results = []
    for mode in os.environ.get('TUI_PROBE_MODES', 'update,deny,unavailable').split(','):
        result = run(mode, server)
        results.append(result)
        print(json.dumps(result), flush=True)
    (OUT / 'summary.json').write_text(json.dumps({'cli': CLI, 'root': str(ROOT), 'results': results}, indent=2))
finally:
    server.shutdown()
print(str(OUT), flush=True)
