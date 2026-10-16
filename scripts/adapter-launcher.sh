#!/bin/sh
# 独立发布包的入口，装好之后就是 bin/codex-harness-adapter（scripts/package-adapter.mjs 把它放进包里）。
#
# 包里的布局：
#   bin/codex-harness-adapter           这个脚本
#   libexec/bin/codex-harness-adapter   Go 写的命令行，它按自己的位置把 libexec 认作安装根目录
#   libexec/node/bin/node               随包带的 Node，适配器的各个进程都用它跑
#
# 这个脚本只做一件事：找到真实的位置，把参数原样交给命令行。
# 用哪个 Node 由命令行自己定：没给 --node 时，安装根目录里有随包带的那一份就用它
# （cmd/codex-harness-adapter/service_facts.go 的 defaultNode），机器上不用另装 Node；用户给了 --node 就以用户给的为准。
# 这里不替它加 --node，也不去动 PATH：常驻服务里用户跑的命令会继承服务的环境，
# 把这份 Node 放到 PATH 最前面的话，就盖住了用户自己装的那一份。
set -eu

# 经符号链接执行时（~/.local/bin 里的那个、指向当前版本的那个）先找到真实的位置
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
root=$(CDPATH='' cd "$(dirname "$self")/.." && pwd -P)

exec "$root/libexec/bin/codex-harness-adapter" "$@"
