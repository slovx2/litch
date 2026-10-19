package main

const pairHelpZH = `codex-harness-adapter pair [--host 主机] [--port 端口] [--name 名字] [--home DIR]

把这台机器绑到手机上的 Litch：在终端里画一张二维码，手机扫码后用它自己新生成的钥匙登记进 ~/.ssh/authorized_keys。
不需要桌面端，也不需要 root。设备服务没在运行时先把它拉起来。

  --host  手机连这台机器用的主机名或 IP，默认是这台机器的主机名。手机走的地址不一样（比如 Tailscale）时用它指定
  --port  手机连的 SSH 端口，默认 22
  --name  手机上显示的设备名，默认是主机名
  --home  适配器的状态目录，默认 ~/.codex-harness-adapter

二维码 10 分钟有效、只能用一次，过期了自动换一张新的（最多换 5 次）。手机来登记时会打印手机名和确认码，
核对手机上显示的一样后输入 y 允许。按 Ctrl-C 取消，一次性钥匙随之删掉。
本机有 ssh 客户端时，出码前先用一次性钥匙连 127.0.0.1 自检一次（不消耗这张码）。`

const pairHelpEN = `codex-harness-adapter pair [--host HOST] [--port PORT] [--name NAME] [--home DIR]

Pairs this machine with Litch on a phone: draws a QR code in the terminal; after scanning it the phone enrolls a key
of its own into ~/.ssh/authorized_keys. Needs neither the desktop app nor root. Starts the device service first if it
is not running.

  --host  host name or IP the phone uses to reach this machine; defaults to this machine's host name. Set it when the
          phone goes through another address (Tailscale, for example)
  --port  SSH port the phone connects to; defaults to 22
  --name  device name shown on the phone; defaults to the host name
  --home  the adapter's state directory; defaults to ~/.codex-harness-adapter

The code is valid for 10 minutes and for one use; when it expires a new one replaces it (at most 5 times). When the
phone enrolls, its name and a confirmation code are printed: type y once the phone shows the same code. Ctrl-C
cancels and removes the one-time key. With an ssh client on this machine, the one-time key is first tried against
127.0.0.1 (this does not use up the code).`
