#!/bin/sh
# codex-harness-adapter 的安装脚本：装、升级、卸载都是它。给 Linux 用；macOS 上不用 Homebrew 的人也能用。
#
#   curl -fsSL https://github.com/slovx2/litch/releases/latest/download/install.sh | sh
#   …… | sh -s -- --version 0.5.2        装指定的版本
#   sh install.sh --from <压缩包>         从本地文件装（离线、测试）；校验和清单默认找压缩包旁边的那一份
#   sh install.sh --uninstall             卸载
#
# 装到哪（不要 root，只动自己的主目录）：
#   ~/.local/share/codex-harness-adapter/<版本>/     每个版本一个目录，就是压缩包解开的样子
#   ~/.local/share/codex-harness-adapter/current     指向当前版本的链接
#   ~/.local/share/codex-harness-adapter/history     用过的版本，最近的在最前
#   ~/.local/bin/codex-harness-adapter               指向 current/bin/codex-harness-adapter
#   ~/.local/bin/litch-machine                       指向 current/bin/litch-machine（machine 子命令的短名，0.9.0 之后的包才有）
# 状态目录 ~/.codex-harness-adapter（会话、设置、密钥）不归这个脚本管，装和卸载都不碰它。
#
# 几条规矩：
#   压缩包先解到旁边的临时目录，随包带的 Node 和命令行在这台机器上跑得起来才改名成版本目录；
#   current 是一步换过去的，中途断掉不会留下半个版本。
#   重跑就是升级。装过的版本不重复下载。当前的之外留最近用过的 4 个，再旧的清掉；
#   正有常驻服务在跑的那一版不清。
#   这个脚本不停、不重启正在跑的常驻服务：那会打断进行中的回合。它只说明现状和该怎么办
#   （升级之后旧版的服务还在跑时，给出换上新版的命令：device-stop --if-idle 只在服务闲着时才停）。
#
# 给人看的字中文英文各一份，写在同一处（say、fail 的头两个参数）；
# 语言的判断顺序和命令行一样：CHA_LANG、LANGUAGE、LC_ALL、LC_MESSAGES、LANG，都没有就是英文。
set -eu

NAME=codex-harness-adapter
CHECKSUMS=$NAME-SHA256SUMS.txt
RELEASES=https://github.com/slovx2/litch/releases
# 当前的之外留几个旧版本
KEEP_OLD=4

lang=en
for value in "${CHA_LANG-}" "${LANGUAGE-}" "${LC_ALL-}" "${LC_MESSAGES-}" "${LANG-}"; do
  # LANGUAGE 可以是冒号隔开的一串，取第一个；再去掉编码和修饰（.UTF-8、@pinyin）
  value=$(printf '%s' "${value%%:*}" | tr '[:upper:]' '[:lower:]')
  value=${value%%[.@]*}
  case $value in
    '' | c | posix) continue ;;
    zh | zh-* | zh_*) lang=zh ;;
  esac
  break
done

# say 中文 英文 [要填的值…]：按当前语言取一种，照 printf 的写法填值
say() {
  if [ "$lang" = zh ]; then format=$1; else format=$2; fi
  shift 2
  # shellcheck disable=SC2059  # 格式就是这两句话本身
  printf "$format\n" "$@"
}

fail() {
  say "$@" >&2
  exit 1
}

usage() {
  say '用法：
  sh install.sh                    安装最新版；装过了就是升级
  sh install.sh --version 版本     安装指定的版本（也用来退回旧版本）
  sh install.sh --from 压缩包      从本地的压缩包安装，不联网
        --checksums 清单           配合 --from：校验和清单在哪，默认找压缩包旁边的 %s
  sh install.sh --uninstall        卸载。只删程序，状态目录 ~/.codex-harness-adapter 不动
        --base-url 地址            发布页的地址，默认 %s' \
    'Usage:
  sh install.sh                    install the latest version; upgrades an existing install
  sh install.sh --version VERSION  install that version (also how you go back to an older one)
  sh install.sh --from ARCHIVE     install from a local archive, no network
        --checksums FILE           with --from: the checksum list, default %s next to the archive
  sh install.sh --uninstall        uninstall. Removes the program only; ~/.codex-harness-adapter stays
        --base-url URL             where the releases are, default %s' \
    "$CHECKSUMS" "$RELEASES"
}

action=install
version=
from=
checksums=
base_url=$RELEASES
while [ $# -gt 0 ]; do
  case $1 in
    --version | --from | --checksums | --base-url)
      [ $# -ge 2 ] || fail '%s 后面要跟一个值' '%s needs a value' "$1"
      case $1 in
        --version) version=${2#v} ;;
        --from) from=$2 ;;
        --checksums) checksums=$2 ;;
        --base-url) base_url=${2%/} ;;
      esac
      shift 2
      ;;
    --uninstall)
      action=uninstall
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail '不认识的参数：%s' 'unknown argument: %s' "$1"
      ;;
  esac
done

# 版本号会拿来拼路径，先看它长得像不像一个版本号
valid_version() {
  case $1 in
    '' | [!0-9]* | *[!0-9A-Za-z.+-]*) return 1 ;;
  esac
}
if [ -n "$version" ] && ! valid_version "$version"; then
  fail '%s 不像一个版本号' '%s does not look like a version' "$version"
fi

case ${HOME-} in
  /*) ;;
  *) fail '没有 HOME，不知道往哪装' 'HOME is not set; nowhere to install to' ;;
esac
base_dir=$HOME/.local/share/$NAME
bin_dir=$HOME/.local/bin
bin_link=$bin_dir/$NAME
# machine 子命令的短名（08 号设计决 245）：远程设备上的模型用它操作用户的 Litch 桌面端
SHORT=litch-machine
short_link=$bin_dir/$SHORT
state_dir=$HOME/.$NAME

# 给人看的路径：主目录写成 ~，短一些，贴进 shell 里也照样能用
show() {
  # shellcheck disable=SC2088  # 就是要打出一个波浪号
  case $1 in
    "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# 认系统和架构，对上压缩包名字里的那一段
system=$(uname -s)
machine=$(uname -m)
case $system in
  Linux) system=linux ;;
  Darwin) system=darwin ;;
esac
case $machine in
  x86_64 | amd64) machine=x64 ;;
  aarch64 | arm64) machine=arm64 ;;
esac
target=$system-$machine

# 从常驻服务的启动参数里取它用的状态目录（--home 后面那一个），没给就是空的。
# 参数一行一个从标准输入来。
home_argument() {
  awk 'found { print; exit } $0 == "--home" { found = 1 }'
}

# 正从这个安装位置跑着的常驻服务，每行“进程号 版本 状态目录”；启动时没给 --home 的，状态目录那一栏是空的。
# 认的是可执行文件的位置，不看状态目录：服务用的是哪个状态目录都找得到。
running_services() {
  [ -d "$base_dir" ] || return 0
  real=$(CDPATH='' cd "$base_dir" && pwd -P)
  if [ -r /proc/self/cmdline ]; then
    for process in /proc/[0-9]*; do
      exe=$(readlink "$process/exe" 2>/dev/null) || continue
      # 程序文件被删掉之后，系统会在路径后面加一句 (deleted)
      exe=${exe% (deleted)}
      case $exe in
        "$real"/*/libexec/bin/"$NAME") ;;
        *) continue ;;
      esac
      # 第一个参数是 start 的才是常驻服务，别的（比如 device-proxy）是一条连接
      arguments=$(tr '\0' ' ' <"$process/cmdline" 2>/dev/null) || continue
      case $arguments in
        *"/$NAME start "*) ;;
        *) continue ;;
      esac
      found=${exe#"$real"/}
      printf '%s %s %s\n' "${process#/proc/}" "${found%%/*}" \
        "$(tr '\0' '\n' <"$process/cmdline" 2>/dev/null | home_argument)"
    done
  else
    # 没有 /proc 的系统（macOS）
    ps -axo pid=,args= 2>/dev/null | while read -r pid arguments; do
      case $arguments in
        "$real"/*/libexec/bin/"$NAME"\ start\ *) ;;
        *) continue ;;
      esac
      found=${arguments#"$real"/}
      # ps 给的是拼成一行的参数，分不清路径里的空格：取到下一个选项之前为止
      case $arguments in
        *' --home '*)
          used=${arguments#*' --home '}
          used=${used%%' --'*}
          ;;
        *) used='' ;;
      esac
      printf '%s %s %s\n' "$pid" "${found%%/*}" "$used"
    done
  fi
}

# 有常驻服务在跑时说明现状和该怎么办。$1 是刚换上的版本（卸载时为空）
service_notice() {
  running_services | while read -r pid running used; do
    if [ -z "$1" ]; then
      say '注意：%s 的常驻服务还在跑（进程 %s），它的程序文件已经删掉了。请停掉它：kill %s' \
        'Note: the %s service is still running (process %s) and its program files are gone. Stop it: kill %s' \
        "$running" "$pid" "$pid"
    elif [ "$running" != "$1" ]; then
      # 服务用的不是默认的状态目录时，两条命令都要带上同一个 --home
      at=''
      if [ -n "$used" ] && [ "$used" != "$state_dir" ]; then at=" --home '$used'"; fi
      say '注意：%s 的常驻服务还在跑（进程 %s），在它重启之前用的仍是旧版本。
  这个脚本不替你重启它：停掉它会打断进行中的回合。换上新版用下面两条命令。
  头一条只在服务闲着时才停它：有回合在跑、有终端开着、有客户端连着都不停，并说明是哪一种，那就过一会儿再试。
    %s device-stop%s --if-idle
    %s device-start%s    # 或者照你原来启动它的办法；Litch 下次连接时也会自己拉起
  这份服务要是比 device-stop 这条命令出现得早，头一条会说停不了它，那就等手头的回合结束后：kill %s' \
        'Note: the %s service is still running (process %s) and stays on the old version until it restarts.
  This script does not restart it for you: stopping it interrupts any turn in progress. To move to the new version, run the two commands below.
  The first one stops the service only when it is idle: with a turn in progress, a terminal open or a client connected it leaves the service alone and says which, so try again later.
    %s device-stop%s --if-idle
    %s device-start%s    # or start it the way you did before; Litch also starts it the next time it connects
  If this service predates the device-stop command, the first one says it cannot stop it; in that case wait until nothing is running, then: kill %s' \
        "$running" "$pid" "$(show "$bin_link")" "$at" "$(show "$bin_link")" "$at" "$pid"
    fi
  done
}

uninstall() {
  for link in "$bin_link" "$short_link"; do
    [ -L "$link" ] || continue
    case $(readlink "$link") in
      "$base_dir"/*) rm -f "$link" ;;
      *)
        say '%s 不是这个脚本装的，没有动它' \
          '%s was not put there by this script; left alone' "$(show "$link")"
        ;;
    esac
  done
  if [ -d "$base_dir" ]; then
    # 先记下还在跑的服务：程序目录一删就认不出是哪一版了
    notice=$(service_notice '')
    rm -rf "$base_dir"
    say '已卸载：%s' 'Uninstalled: %s' "$(show "$base_dir")"
    [ -z "$notice" ] || printf '%s\n' "$notice"
  else
    say '没有装过：%s 不存在' 'Not installed: %s does not exist' "$(show "$base_dir")"
  fi
  if [ -d "$state_dir" ]; then
    say '状态目录 %s 没有动（会话、设置、密钥都在里面），不要了请自己删' \
      'The state directory %s was left alone (sessions, settings and keys live there); delete it yourself if you no longer need it' \
      "$(show "$state_dir")"
  fi
}

if [ "$action" = uninstall ]; then
  uninstall
  exit 0
fi

case $target in
  linux-x64 | linux-arm64 | darwin-arm64) ;;
  *) fail '没有给 %s 的发布包（有的是 linux-x64、linux-arm64、darwin-arm64）' \
    'There is no release for %s (available: linux-x64, linux-arm64, darwin-arm64)' "$target" ;;
esac

# 随包带的 Node 是官方按 glibc 编的。musl 的系统（Alpine）上它起不来，而且报的错让人摸不着头脑
# （“not found”），所以在动手之前先说清楚。认法：glibc 的机器上 getconf 认得 GNU_LIBC_VERSION。
if [ "$system" = linux ] && ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
  if ls /lib/ld-musl-* >/dev/null 2>&1 || (ldd --version 2>&1 || true) | grep -qi musl; then
    fail '这台机器的 C 库是 musl（比如 Alpine）。发布包里带的官方 Node 是按 glibc 编的，在这里跑不起来。
请换一台 glibc 的机器（Debian、Ubuntu、Fedora、RHEL 等），或者在这台机器上用它自己的 Node 24 从源码启动：
  https://github.com/slovx2/litch/blob/main/ADAPTER.md' \
      'This machine uses musl as its C library (Alpine, for example). The release bundles the official Node, built for glibc, which cannot run here.
Use a glibc machine (Debian, Ubuntu, Fedora, RHEL, ...), or run from source here with the system'"'"'s own Node 24:
  https://github.com/slovx2/litch/blob/main/ADAPTER.en.md'
  fi
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail '核对不了校验和：这台机器上没有 sha256sum，也没有 shasum' \
      'Cannot verify the checksum: neither sha256sum nor shasum is available'
  fi
}

# 清单里某个文件的校验和。清单是 sha256sum 的格式：校验和、空格、文件名（前面可能有个星号）
listed_sum() {
  while read -r sum file; do
    if [ "${file#\*}" = "$2" ]; then
      printf '%s\n' "$sum"
      return 0
    fi
  done <"$1"
  return 1
}

# 清单里给这个系统和架构的那个压缩包是哪一版
listed_version() {
  while read -r sum file; do
    file=${file#\*}
    case $file in
      "$NAME"-*-"$target".tar.gz)
        file=${file#"$NAME"-}
        printf '%s\n' "${file%-"$target".tar.gz}"
        return 0
        ;;
    esac
  done <"$1"
  return 1
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail '下载不了：这台机器上没有 curl，也没有 wget。可以在别处下好压缩包和 %s，拷过来用 --from 安装' \
      'Cannot download: neither curl nor wget is available. Fetch the archive and %s elsewhere, copy them over and install with --from' \
      "$CHECKSUMS"
  fi || fail '下载失败：%s' 'Download failed: %s' "$1"
}

# 把 $2 这个链接换成指向 $1。一步到位：没有“链接不存在”的那一刻。
# 改名要落在链接自己身上，不能跟着它走进目录里：GNU 和 busybox 的 mv 用 -T，BSD 的用 -h。
switch_link() {
  rm -f "$2.new.$$"
  ln -s "$1" "$2.new.$$"
  if mv -T "$2.new.$$" "$2" 2>/dev/null || mv -h "$2.new.$$" "$2" 2>/dev/null; then
    return 0
  fi
  rm -f "$2.new.$$"
  return 1
}

installed() { [ -x "$base_dir/$1/bin/$NAME" ]; }

# 把 $1 记成最近用的一版，再清掉旧的：当前的之外留最近用过的 KEEP_OLD 个。
# 正有常驻服务在跑的版本不清，等它停了、下次安装时再清。
remember() {
  {
    printf '%s\n' "$1"
    if [ -f "$base_dir/history" ]; then
      while read -r old; do
        [ "$old" = "$1" ] || printf '%s\n' "$old"
      done <"$base_dir/history"
    fi
  } >"$base_dir/history.new.$$"
  busy=$(running_services | while read -r pid running used; do printf '%s ' "$running"; done)
  kept=' '
  count=0
  : >"$base_dir/history"
  while read -r old; do
    if ! valid_version "$old" || [ ! -d "$base_dir/$old" ]; then continue; fi
    case " $busy" in
      *" $old "*) ;;
      *) [ "$count" -le "$KEEP_OLD" ] || continue ;;
    esac
    count=$((count + 1))
    kept="$kept$old "
    printf '%s\n' "$old" >>"$base_dir/history"
  done <"$base_dir/history.new.$$"
  rm -f "$base_dir/history.new.$$"
  # 没留下来的版本目录（包括历史里没有记录的）都清掉
  for directory in "$base_dir"/*/; do
    old=${directory%/}
    old=${old##*/}
    if [ -L "$base_dir/$old" ] || ! valid_version "$old" || ! installed "$old"; then continue; fi
    case $kept in
      *" $old "*) ;;
      *)
        rm -rf "${base_dir:?}/$old"
        say '清掉了旧版本 %s' 'Removed old version %s' "$old"
        ;;
    esac
  done
}

# 短名的链接：这一版带着它就链上；不带（旧版本）就撤掉指向本脚本目录的那个。别人放的同名文件不动，只提一句
link_short() {
  if [ -e "$short_link" ] && [ ! -L "$short_link" ]; then
    say '%s 已经存在，而且不是这个脚本装的，没有动它；短名 %s 用不了，可以用 %s machine' \
      '%s already exists and was not put there by this script; left alone. The short name %s is unavailable; use %s machine' \
      "$(show "$short_link")" "$SHORT" "$NAME"
    return 0
  fi
  if [ -e "$base_dir/$1/bin/$SHORT" ]; then
    if [ "$(readlink "$short_link" 2>/dev/null || true)" != "$base_dir/current/bin/$SHORT" ]; then
      switch_link "$base_dir/current/bin/$SHORT" "$short_link" ||
        fail '建不了命令的链接：%s' 'Cannot create the command link: %s' "$(show "$short_link")"
    fi
  elif [ -L "$short_link" ]; then
    case $(readlink "$short_link") in
      "$base_dir"/*) rm -f "$short_link" ;;
    esac
  fi
}

# 让 $1 成为当前版本，并说明装在哪、接下来怎么用
activate() {
  previous=$(readlink "$base_dir/current" 2>/dev/null || true)
  switch_link "$1" "$base_dir/current" ||
    fail '换不了当前版本的链接：%s' 'Cannot switch the current-version link: %s' "$(show "$base_dir/current")"
  mkdir -p "$bin_dir"
  if [ -e "$bin_link" ] && [ ! -L "$bin_link" ]; then
    fail '%s 已经存在，而且不是这个脚本装的。请先把它挪开' \
      '%s already exists and was not put there by this script. Move it away first' "$(show "$bin_link")"
  fi
  if [ "$(readlink "$bin_link" 2>/dev/null || true)" != "$base_dir/current/bin/$NAME" ]; then
    switch_link "$base_dir/current/bin/$NAME" "$bin_link" ||
      fail '建不了命令的链接：%s' 'Cannot create the command link: %s' "$(show "$bin_link")"
  fi
  link_short "$1"
  remember "$1"
  if [ "$previous" = "$1" ]; then
    say '已经是 %s，没有要做的' 'Already on %s; nothing to do' "$1"
  elif [ -n "$previous" ]; then
    say '已从 %s 换到 %s' 'Switched from %s to %s' "$previous" "$1"
  else
    say '已安装 %s %s' 'Installed %s %s' "$NAME" "$1"
  fi
  say '  程序：%s\n  命令：%s' '  Program: %s\n  Command: %s' "$(show "$base_dir/$1")" "$(show "$bin_link")"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *)
      # shellcheck disable=SC2016  # 那一行 export 是给人照抄的，不在这里展开
      say '%s 不在 PATH 里。直接用全路径就行：%s
想只打命令名的话，把下面这一行加进你的 shell 的启动文件（bash 是 ~/.bashrc，zsh 是 ~/.zshrc），再重新登录；
Debian、Ubuntu 默认的 ~/.profile 在这个目录存在时会自己加上，重新登录即可：
  export PATH="$HOME/.local/bin:$PATH"
经 ssh 直接执行命令（ssh 主机 命令）时不读这些启动文件，要写全路径。' \
        '%s is not on PATH. The full path always works: %s
To type just the name, add this line to your shell'"'"'s startup file (~/.bashrc for bash, ~/.zshrc for zsh) and log in again;
the default ~/.profile on Debian and Ubuntu adds it by itself once the directory exists, so logging in again is enough:
  export PATH="$HOME/.local/bin:$PATH"
Commands run directly over ssh (ssh host command) do not read those files; use the full path there.' \
        "$(show "$bin_dir")" "$(show "$bin_link")"
      ;;
  esac
  service_notice "$1"
}

mkdir -p "$base_dir"
work=$(mktemp -d "$base_dir/.tmp.XXXXXX")
# 临时目录一定删掉；第一次安装就没装成的话，连空的安装目录也不留
trap 'rm -rf "$work"; rmdir "$base_dir" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM

if [ -n "$from" ]; then
  [ -f "$from" ] || fail '找不到压缩包：%s' 'Archive not found: %s' "$from"
  archive=$from
  if [ -z "$checksums" ] && [ -f "$(dirname "$from")/$CHECKSUMS" ]; then
    checksums=$(dirname "$from")/$CHECKSUMS
  fi
  if [ -n "$checksums" ]; then
    [ -f "$checksums" ] || fail '找不到校验和清单：%s' 'Checksum list not found: %s' "$checksums"
  else
    say '提示：压缩包旁边没有 %s，这次不核对校验和' \
      'Note: no %s next to the archive; the checksum is not verified this time' "$CHECKSUMS"
  fi
else
  # 没指定版本就先取最新一版的清单，从里面的文件名知道是哪一版；压缩包再按这个版本号去取，两样对得上
  checksums=$work/$CHECKSUMS
  if [ -n "$version" ]; then
    download "$base_url/download/v$version/$CHECKSUMS" "$checksums"
  else
    download "$base_url/latest/download/$CHECKSUMS" "$checksums"
    version=$(listed_version "$checksums") ||
      fail '最新一版里没有给 %s 的发布包' 'The latest release has no archive for %s' "$target"
    valid_version "$version" ||
      fail '清单里的版本号不对：%s' 'The checksum list names an odd version: %s' "$version"
  fi
  if installed "$version"; then
    # 装过的版本不重复下载，换过去就行
    activate "$version"
    exit 0
  fi
  archive=$work/$NAME-$version-$target.tar.gz
  say '下载 %s' 'Downloading %s' "${archive##*/}"
  download "$base_url/download/v$version/${archive##*/}" "$archive"
fi

if [ -n "$checksums" ]; then
  expected=$(listed_sum "$checksums" "${archive##*/}") ||
    fail '校验和清单里没有 %s，不装' 'The checksum list has no entry for %s; not installing' "${archive##*/}"
  actual=$(sha256_of "$archive")
  if [ "$actual" != "$expected" ]; then
    fail '校验和对不上，不装：%s\n  应为 %s\n  实际 %s' \
      'Checksum mismatch; not installing: %s\n  expected %s\n  actual   %s' \
      "${archive##*/}" "$expected" "$actual"
  fi
fi

mkdir "$work/unpacked"
tar -xzf "$archive" -C "$work/unpacked" ||
  fail '压缩包解不开：%s' 'Cannot unpack the archive: %s' "$archive"
# 压缩包里最外面只有一层目录，名字是 codex-harness-adapter-<版本>-<系统>-<架构>
unpacked=
for entry in "$work/unpacked"/*; do
  [ -z "$unpacked" ] || fail '这不是 %s 的发布包' 'This is not a %s release archive' "$NAME"
  unpacked=$entry
done
packed=${unpacked##*/}
case $packed in
  "$NAME"-*-"$target") ;;
  *) fail '这个压缩包（%s）不是给这台机器（%s）的' \
    'This archive (%s) is not for this machine (%s)' "$packed" "$target" ;;
esac
packed=${packed#"$NAME"-}
packed=${packed%-"$target"}
valid_version "$packed" ||
  fail '压缩包里的版本号不对：%s' 'The archive carries an odd version: %s' "$packed"
if [ -n "$version" ] && [ "$packed" != "$version" ]; then
  fail '要装的是 %s，压缩包里是 %s' 'Asked for %s but the archive holds %s' "$version" "$packed"
fi
version=$packed

if ! installed "$version"; then
  # 先在临时目录里试运行：随包带的 Node 起得来、命令行报得出这一版的版本号，才算数。
  # 标准输入不给它们：这个脚本可能正从管道里读着（curl … | sh），不能让别人把后半截读走
  if ! problem=$("$unpacked/libexec/node/bin/node" --version 2>&1 </dev/null); then
    fail '随包带的 Node 在这台机器上跑不起来，没有安装：
  %s
多半是系统的 C 库不合：官方的 Node 要 glibc 2.28 以上（musl 的系统不行）。' \
      'The bundled Node cannot run on this machine; nothing was installed:
  %s
Most likely the system C library does not fit: the official Node needs glibc 2.28 or newer (musl systems do not work).' \
      "$problem"
  fi
  reported=$("$unpacked/bin/$NAME" version 2>&1 </dev/null) || true
  if [ "$reported" != "$NAME $version" ]; then
    fail '装不了：命令行应当报“%s”，实际是：%s' \
      'Cannot install: the command should report "%s" but said: %s' "$NAME $version" "$reported"
  fi
  mv "$unpacked" "$base_dir/$version"
fi
activate "$version"
