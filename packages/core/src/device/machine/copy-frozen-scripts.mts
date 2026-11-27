// 两端都先进入已冻结的规范父目录；外壳只拿位置参数里的绝对目录与文件名。
const stat = `file_id() {
  if [ -x /usr/bin/sha256sum ]; then
    /usr/bin/stat -c '%d:%i:%f:%s:%y:%z' -- "$1"
  else
    /usr/bin/stat -f '%d:%i:%p:%z:%.9Fm:%.9Fc' -- "$1"
  fi
}
dir_id() {
  if [ -x /usr/bin/sha256sum ]; then
    /usr/bin/stat -c '%d:%i:%f' -- "$1"
  else
    /usr/bin/stat -f '%d:%i:%p' -- "$1"
  fi
}
file_mode() {
  if [ -x /usr/bin/sha256sum ]; then /usr/bin/stat -c '%a' -- "$1"
  else /usr/bin/stat -f '%Lp' -- "$1"; fi
}
file_hash() {
  if [ -x /usr/bin/sha256sum ]; then /usr/bin/sha256sum; else /usr/bin/shasum -a 256; fi
}`

const source = `cd -P -- "$1"
[ "$(pwd -P)" = "$1" ]
name=./$2
source_dir=$(dir_id .)
[ -f "$name" ] && [ ! -L "$name" ] || exit 1
source_file=$(file_id "$name")
check_source() {
  [ "$(pwd -P)" = "$1" ] && [ "$(dir_id "$1")" = "$source_dir" ] &&
    [ -f "$name" ] && [ ! -L "$name" ] && [ "$(file_id "$name")" = "$source_file" ]
}
read_source() {
  if [ -x /usr/bin/sha256sum ]; then
    /bin/dd if="$name" iflag=nofollow,nonblock,skip_bytes,count_bytes bs=65536 skip="$1" count="$2" status=none
  else
    /usr/bin/perl -MFcntl=:DEFAULT -e '
      my ($name, $offset, $remaining) = @ARGV;
      sysopen(my $file, $name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or die "source open";
      -f $file or die "source kind";
      defined(sysseek($file, $offset, 0)) or die "source seek";
      while ($remaining > 0) {
        my $n = sysread($file, my $buf, $remaining < 65536 ? $remaining : 65536);
        defined($n) or die "source read";
        last if !$n;
        print $buf or die "output write";
        $remaining -= $n;
      }' "$name" "$1" "$2"
  fi
}`

export const copySourceProbe = `set -eu
${stat}
${source}
hash=$(read_source 0 "$3" | file_hash)
printf '%s\n%s\n%s\n' "$source_dir" "$source_file" "\${hash%% *}"
i=0
while [ "$i" -lt "$5" ]; do
  hash=$(read_source "$((i * $4))" "$4" | file_hash)
  printf '%s\n' "\${hash%% *}"
  i=$((i+1))
done
check_source "$1"`

export const copySourceRead = `set -eu
${stat}
${source}
[ "$source_dir" = "$3" ] && [ "$source_file" = "$4" ] || exit 1
read_source "$5" "$6"
check_source "$1"`

const destination = `destination_id() {
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then printf absent
  elif [ -f "$1" ] && [ ! -L "$1" ]; then file_id "$1"
  else return 1
  fi
}`

export const copyDestProbe = `set -eu
${stat}
${destination}
cd -P -- "$1"
[ "$(pwd -P)" = "$1" ]
[ ! -L "$3" ]
parent=$(dir_id .)
dest=$(destination_id "./$2")
printf '%s\n%s\n' "$parent" "$dest"`

// 只清本 UID 有明确标记的旧暂存目录。24 小时比最长执行/断线等待都长。
const staging = `forget_stage() {
  /bin/rm -f -- "$1/owner" "$1/part"
  /bin/rmdir -- "$1" 2>/dev/null || :
}
cleanup_old() {
  now=$(/bin/date +%s)
  uid=$(/usr/bin/id -u)
  for old in ./.litch-copy.v1.??????????; do
    [ -d "$old" ] && [ ! -L "$old" ] || continue
    (
      CDPATH=
      cd -P -- "$old" || exit 0
      [ "$(pwd -P)" = "$1/\${old#./}" ] || exit 0
      [ "$(file_mode .)" = 700 ] || exit 0
      [ -f ./owner ] && [ ! -L ./owner ] || exit 0
      if [ -x /usr/bin/sha256sum ]; then
        stamp=$(/usr/bin/stat -c '%u:%Y' -- ./owner) || exit 0
      else
        stamp=$(/usr/bin/stat -f '%u:%m' -- ./owner) || exit 0
      fi
      owner="\${stamp%%:*}"; age="\${stamp#*:}"
      [ "$owner" = "$uid" ] && [ "$((now - age))" -ge 86400 ] || exit 0
      [ "$(/usr/bin/head -c 64 ./owner)" = 'Litch deferred copy v1' ] || exit 0
      /bin/rm -f -- ./owner ./part
      cd -P -- "$1" && /bin/rmdir -- "$old" 2>/dev/null || :
    )
  done
}`

export const copyDestWrite = `set -eu
${stat}
${destination}
${staging}
cd -P -- "$1"
name=./$2
check_dest() {
  [ "$(pwd -P)" = "$1" ] && [ "$(dir_id .)" = "$3" ] &&
  [ "$(dir_id "$1")" = "$3" ] && [ "$(destination_id "$name")" = "$4" ]
}
check_dest "$@"
cleanup_old "$1"
stage=$(/usr/bin/mktemp -d ./.litch-copy.v1.XXXXXXXXXX)
trap 'forget_stage "$stage"' EXIT
trap 'exit 1' HUP INT TERM
printf 'Litch deferred copy v1\n' > "$stage/owner"
temp=$stage/part
/bin/cat > "$temp"
[ "$(/usr/bin/wc -c < "$temp" | /usr/bin/tr -d '[:space:]')" = "$5" ]
hash=$(file_hash < "$temp")
[ "\${hash%% *}" = "$6" ]
check_dest "$@"
if [ "$4" = absent ]; then
  # 仍由目标进程的 umask 决定新文件是否允许组或其他用户读写。
  /bin/chmod =rw "$temp"
else
  mode=$(file_mode "$name" | /usr/bin/awk '{print substr($0,length($0)-2)}')
  case "$mode" in [0-7][0-7][0-7]) /bin/chmod "$mode" "$temp";; *) exit 1;; esac
fi
check_dest "$@"
if [ -x /usr/bin/sha256sum ]; then
  if [ "$4" = absent ]; then /bin/ln -T -- "$temp" "$name"; else /bin/mv -fT -- "$temp" "$name"; fi
else
  # BSD ln/mv 会把突然出现的目录当成容器。直接用系统调用发布确切文件名。
  /usr/bin/perl -e 'exit(($ARGV[0] eq "absent" ? link($ARGV[1], $ARGV[2]) : rename($ARGV[1], $ARGV[2])) ? 0 : 1)' "$4" "$temp" "$name"
fi`
