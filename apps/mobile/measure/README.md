# chatmeasure：聊天界面录屏逐帧测量

对安卓模拟器录屏做逐帧分析，客观度量聊天界面的「飘、跳、闪、卡」，用来比较旧应用（不能改代码）和新原型（可以加标记线）。

- 飘：内容末尾与输入区之间的距离短暂变化后又回来（`markers`、`gap` 的回弹事件）
- 跳：内容沿不该走的方向移动，或位置突变（`motion` 的反向位移、`track` 的偏移）
- 闪：对话区短暂空白（`blank`）
- 卡：帧耗时超过刷新周期（`frametimes`）

## 安装与运行

依赖由 uv 管理（`pyproject.toml` 里写死了精确版本，`exclude-newer` 保证传递依赖也只取 2026-10-03 之前发布的版本）。需要 ffmpeg/ffprobe，默认用 `/opt/homebrew/bin/` 下的，可以用环境变量 `CHATMEASURE_FFMPEG`、`CHATMEASURE_FFPROBE` 改。

```sh
cd apps/mobile/measure
uv sync
uv run python -m chatmeasure --help
uv run pytest            # 自测：合成视频 + 断言，约 50 秒
```

## 录屏

```sh
adb shell screenrecord --bit-rate 20000000 /sdcard/t1.mp4   # Ctrl-C 结束，最长 3 分钟
adb pull /sdcard/t1.mp4
```

screenrecord 是可变帧率：画面不变时不出帧。本工具按每帧的原始时间戳（pts）分析，抽帧时不丢帧也不补帧（`-fps_mode passthrough`），时间戳由 ffmpeg 的 showinfo 过滤器逐帧给出。

## 通用约定

- 坐标一律用**原始分辨率像素**（如 1080x2400 的坐标），即使加了 `--scale 0.5` 也一样，工具内部换算。矩形写成 `x,y,w,h`，区间写成 `起,止`。
- 输入可以是 mp4，也可以是 `frames` 导出的帧目录。
- dp 换算用 `--density`（默认 2.625，即 1dp = 2.625px）。
- 输出：结果 JSON（`--json`，不给就打印到标准输出）+ 可选逐帧 CSV（`--csv`）。JSON 里有 `summary`（指标）、`events`（事件列表）、`checks`（检查项及是否通过）、`perf`（耗时）。有未通过的检查项时在标准错误里列出，退出码仍为 0。

视频类子命令都有这些参数：

| 参数 | 含义 | 默认 |
|---|---|---|
| `--start` / `--end` | 只分析这段时间（秒，原始时间戳） | 全部 |
| `--scale` | 读取时缩放，0.5 为半分辨率，快约 3 倍 | 1（帧目录取导出时的缩放） |
| `--density` | px/dp | 2.625 |
| `--threshold-dp` | 偏差、位移的判定阈值 | 2 |
| `--label` | 报告里的列名 | 文件名 |
| `--json` / `--csv` | 输出路径 | 标准输出 / 不输出 |

`markers` 和 `gap` 还有：`--rebound-frames`（偏离后几帧内回到原值算回弹，默认 3）、`--rebound-tol-dp`（「回到原值附近」的容差，默认等于阈值）。

## 子命令

### frames：抽帧

```sh
uv run python -m chatmeasure frames t1.mp4 --out t1_frames --start 2 --end 8 --scale 0.5
```

导出 `frame_000000.png …` 和 `frames.json`（每帧序号、时间戳、文件名、原始尺寸、缩放）。分析时直接用 mp4 更快，帧目录适合人工翻看或反复分析同一段。

### markers：标记线（新原型）

新原型在界面上画两条 2px 高的纯色线：内容末尾线 `#FF00FF`、输入区上沿线 `#00FFFF`。逐帧找两条线的 y（线的中心行），算距离 = 输入区线 y − 内容末尾线 y。

```sh
uv run python -m chatmeasure markers t1.mp4 --x-range 0,256 --line-height-dp 22 \
  --json out/t1_markers.json --csv out/t1_markers.csv
```

| 参数 | 含义 | 默认 |
|---|---|---|
| `--content-color` / `--input-color` | 两条线的颜色 | `#FF00FF` / `#00FFFF` |
| `--match` | `chroma`：按色度方向匹配（抗 4:2:0 色度冲淡和亮度偏移）；`rgb`：各通道差 ≤ `--tol` | chroma |
| `--min-ratio` / `--min-cos` | chroma 方式：色度强度至少为目标色的比例 / 色度方向相似度下限 | 0.3 / 0.8 |
| `--tol` | rgb 方式的通道容差 | 80 |
| `--x-range` / `--y-range` | 只在这个区间找线。只读这一条竖带，能明显加速 | 全画面 |
| `--min-fill` | 一行里命中像素的最小占比 | 0.6 |
| `--max-thickness` | 线最厚多少像素，超过的色块不算线 | 12 |
| `--col-step` / `--coarse-step` | 细查/粗查的横向抽样步长 | 2 / 16 |
| `--steady` | 稳态距离（px），不给取中位数 | 中位数 |
| `--line-height-dp` | 行高，给出时增加「最大偏差不超过一个行高」的检查 | 无 |

输出：
- `summary.distance`：相对稳态值的偏差，`abs_dev_p50/p95/p99/max`（px 和 dp）、`max_up_dev_px`（距离变小，最后一行可能被输入区盖住）、`max_down_dev_px`（距离变大）、`over_threshold_frames/ratio`（超过阈值的帧数和占比）、`longest_over_run_frames`（最长连续超标帧数及起始时间）、`missing_frames`（任一条线找不到的帧数）。
- `summary.events` 与 `events.rebounds/steps`：回弹事件和阶跃事件（见下文）。
- `summary.content_line` / `input_line`：每条线自身 y 的相邻帧跳变，`abs_jump_p50…max`、`moved_pairs`（变化超过 0.5px 的帧对数）、`over_threshold_pairs`。
- CSV：`frame,t,content_y,input_y,distance_px,deviation_px`，找不到为空。

### gap：内容末尾到输入区（旧应用，无标记线）

```sh
uv run python -m chatmeasure gap old_t1.mp4 --region 0,220,1080,1760 \
  --input-search 1900,2100 --json out/old_t1_gap.json --csv out/old_t1_gap.csv
```

| 参数 | 含义 | 默认 |
|---|---|---|
| `--region` | 对话区矩形（必填） | |
| `--bg` | 背景色 `#RRGGBB`，或 `auto`：首帧对话区的众数色 | auto |
| `--bg-tol` | 与背景任一通道差超过它算非背景像素 | 40 |
| `--min-row-pixels` | 一行非背景像素达到这么多才算内容行（滤噪点） | 6 |
| `--min-run-rows` | 内容行至少连续几行 | 2 |
| `--input-top` | 输入区上沿 y；`auto` 时逐帧在 `--input-search y0,y1` 里找最强的一条横贯水平边缘 | auto |
| `--edge-tol` / `--min-edge-fill` | 水平边缘：相邻两行通道差阈值 / 有差异的列占比下限 | 8 / 0.6 |
| `--col-step` | 找边缘时横向抽样 | 2 |
| `--steady` / `--line-height-dp` | 同 markers | |

只在输入区上沿以上找内容（输入区本身不算内容）。从下往上分块扫描，找到最下面一段内容的下沿即停。输出结构同 markers，两条线换成 `content_bottom` 和 `input_top`。

### 回弹事件与阶跃事件（markers、gap）

流式输出时行底会按行高阶梯式变化，这是正常的；「飘」是短暂偏离后又弹回。算法：以当前平台值为准，某帧偏离超过容差（默认 2dp）后，如果在 `--rebound-frames`（默认 3）帧内回到平台值附近，记一次**回弹事件**（开始时间、持续帧数和毫秒数、带符号的峰值幅度）；否则认为平台值变了，记一次**阶跃事件**（从多少变到多少）。相隔不超过 `--rebound-frames` 帧的连续阶跃合并为一次（动画逐帧变化算一次）。缺失帧跳过，不触发事件。

### motion：相邻帧垂直位移

```sh
uv run python -m chatmeasure motion t1.mp4 --region 0,220,1080,1700 --expect up --csv out/t1_motion.csv
```

| 参数 | 含义 | 默认 |
|---|---|---|
| `--region` | 分析区域（必填） | |
| `--method` | `template`：上一帧中段作模板，只沿纵向做归一化互相关；`phase`：相位相关 | template |
| `--max-shift` | 单帧最大可测位移（px） | 区域高 1/4 |
| `--subpixel` | 输出亚像素位移 | 取整 |
| `--profile-width` | 先把区域横向压缩到这么多列再算（纵向分辨率不变），0 为不压缩 | 96 |
| `--min-std` | 区域灰度标准差低于它判为低纹理，不给数 | 3 |
| `--min-confidence` | 置信度下限（template 为相关系数，phase 为峰值响应） | 0.6 / 0.05 |
| `--expect` | 预期方向：`up` 只上移或不动（流式贴底）、`down`、`none` 应静止、`any` | up |
| `--move-threshold-px` | 位移达到它才算一次移动 | 1 |
| `--jitter-window` | 方向在这么多帧内反复算抖动 | 3 |

位移向下为正。输出：`reverse_moves`（与预期方向相反的移动次数，事件里有逐次时间和位移）、`direction_changes` / `quick_direction_changes`（方向反复 / 在窗口内的快速反复，即抖动）、`max_abs_step_px/dp`（单帧最大位移）、`net_displacement_px`、`max_abs_cumulative_px/dp`（累计位移的最大绝对值）、`unreliable_pairs` 及原因（`low_texture` 低纹理、`low_confidence`、`out_of_range` 超出搜索范围）。CSV：`frame,t,dy_px,confidence,flag,cumulative_px`。

### track：跟踪一行

在参考帧上框一个矩形（被点的那一行、锚点行），之后每帧只沿纵向做模板匹配找它。

```sh
uv run python -m chatmeasure track t5.mp4 --ref-time 1.20 --rect 32,880,700,96 --search 150
```

| 参数 | 含义 | 默认 |
|---|---|---|
| `--rect` | 参考帧上的目标矩形（必填）。要包含文字或边框，纯色矩形会报错 | |
| `--ref-frame` / `--ref-time` | 参考帧序号 / 时间（秒），给时间时从这一刻开始分析 | 第 0 帧 |
| `--search` | 纵向搜索半径（px） | 200 |
| `--min-confidence` | 低于它记为丢失 | 0.7 |
| `--no-follow` | 始终以参考位置为中心搜（默认以上次找到的位置为中心，能跟住大位移） | |
| `--y-range` | 只在这个纵向区间里找 | 全高 |

输出：`max_abs_offset_px/dp`（相对参考位置的最大偏移）、`max_offset_t`、`final_offset_px`、`max_up/down_offset_px`、`lost_frames`、`first_lost_t`、`jumps`（相邻帧跳变）。CSV：`frame,t,y_px,offset_px,confidence`。

### blank：空白帧

```sh
uv run python -m chatmeasure blank t7.mp4 --region 0,220,1080,1760 --max-blank-frames 2
```

| 参数 | 含义 | 默认 |
|---|---|---|
| `--region` | 对话区（必填） | |
| `--bg` / `--bg-tol` | 同 gap | auto / 40 |
| `--max-content-ratio` | 非背景像素占比低于它判为空白 | 0.003 |
| `--max-blank-frames` | 检查项：允许的最长连续空白帧数（T7 用 2，T6 用 0） | 2 |
| `--sample-step` | 横纵向抽样 | 2 |

输出：`blank_frames`、`blank_runs`、`longest_blank_frames`、`longest_blank_start_t`、`longest_blank_ms`（从第一帧空白到下一帧非空白）、`runs_over_limit`；事件里列出每段空白。

### frametimes：帧耗时

```sh
adb shell dumpsys gfxinfo com.example.chat reset
# …操作…
adb shell dumpsys gfxinfo com.example.chat framestats > gfx.txt
uv run python -m chatmeasure frametimes gfx.txt --refresh-ms 16.67 --csv out/gfx.csv
```

- `framestats` 段（`---PROFILEDATA---`）：总帧耗时 = `FrameCompleted − IntendedVsync`；`Flags` 非 0 的帧按 Android 文档忽略；耗时超过一个刷新周期（`--refresh-ms`，默认 16.67）记为卡顿帧。输出 `janky_frames/ratio`、`frame_ms_p50/p90/p95/p99/max`、`over_2x_refresh_frames`，有 `FrameDeadline` 列时附带 `deadline_missed_frames`。多个窗口的段合并统计。
- 普通输出的汇总行：`Total frames rendered`、`Janky frames`（及 legacy）、`50/90/95/99th percentile`、各 `Number ...` 计数，放在 `gfxinfo_summary`。
- 检查项：卡顿帧占比 ≤ `--max-jank-ratio`（默认 0.05）。只有汇总行时用 `Janky frames` 的百分比。

注意 framestats 只保留最近约 120 帧，长操作要分段取，或改用汇总行。

### report：合并成 markdown

```sh
uv run python -m chatmeasure report out/old_t1_gap.json out/new_t1_markers.json out/*.json --out out/report.md
```

按子命令分组；同一子命令的多个结果并排成列（列名是 `--label`），依次是检查项（通过/不通过及数值）、全部汇总指标、事件计数。

## 与测试场景 T1–T7 的对应

| 场景 | 通过标准 | 新原型（有标记线） | 旧应用（无标记线） |
|---|---|---|---|
| T1 流式贴底 | 两条基准的距离 99% 帧偏差 ≤2dp；最大偏差不超过一个行高且只持续 1 帧 | `markers --line-height-dp <行高>`：检查项 `p99_abs_dev_dp ≤ 2`、`over_threshold_ratio ≤ 0.01`、`max_abs_dev_dp ≤ 行高`、`longest_over_run_frames ≤ 1`；回弹事件看「飘」 | `gap`：同样的偏差统计；阶梯式变化记为阶跃，短暂偏离记为回弹（`rebound_count == 0`）。辅以 `motion --expect up` 看反向位移 |
| T2 流式结束定稿 | 视口内已有内容位移 ≤2dp | 截取定稿前后一段（`--start/--end`），`track` 框一行已有内容：`max_abs_offset_dp ≤ 2`；或 `motion --expect none`：`max_abs_cumulative_dp ≤ 2` | 同左 |
| T3 键盘弹出收起 | 输入区不被盖住；动画结束后零位移；列表保持贴底 | `markers` 全程：`input_line.missing_frames == 0`（被盖住就找不到青线）；再用 `--start <动画结束时刻>` 跑一次：两条线 `abs_jump_max_px` ≈0（≤0.5px）、距离偏差 ≤2dp | `gap --input-search` 给出覆盖键盘行程的范围，看 `input_top` 序列；动画结束后同左 |
| T5 展开收起 | 被点的那一行位移 ≤2dp | `track --rect <被点行> --ref-time <点击前>`：`max_abs_offset_dp ≤ 2` | 同左 |
| T6 加载更早历史 | 锚点行位移 ≤2dp，无空白帧 | `track` 锚点行 + `blank --max-blank-frames 0` | 同左 |
| T7 快速滑过 | 无持续超过 2 帧的空白 | `blank --max-blank-frames 2`：`longest_blank_frames ≤ 2` | 同左 |
| 卡顿（各场景） | — | `frametimes`：`janky_ratio`、帧耗时分位数 | 同左 |

建议每个场景在两个应用上用相同的区域和参数各跑一遍，加 `--label 旧应用` / `--label 新原型`，再用 `report` 合并比较。

## 自测

`uv run pytest` 会用 `chatmeasure/synth.py` 合成 1080x2400、60fps、白底的聊天界面视频（黑色「文字块」逐行生成并逐帧写满、列表贴底、可选洋红/青色标记线），埋入已知事件，再断言各子命令的结果：

- 回弹：第 60 帧向下 40px 持续 1 帧、第 120 帧向上 25px 持续 2 帧、第 180 帧向下 15px 持续 3 帧
- 第 100–104 帧偏离 20px 持续 5 帧（超过 3 帧，应判为两次阶跃；`--rebound-frames 5` 时判为回弹）
- 第 200–209 帧对话区空白 10 帧
- 第 240 帧向下跳 30px 并停住，第 260、280 帧各上移一个行高（阶梯）

断言包括：markers/gap 每帧位置与真值误差 ≤2px（全分辨率和半分辨率），H.264 yuv420p 20Mbps 与无损编码的标记位置差 ≤1px，回弹/阶跃事件的帧号、持续帧数、幅度；motion 每帧位移与真值误差 ≤2px、反向位移恰好是埋入的 5 次、空白期间标为低纹理、纯白区域全部不可靠（template、半分辨率 template、phase 三种）；track 每帧位置误差 ≤2px、空白期间丢失、恢复后重新跟上；blank 恰好识别第 200–209 帧；frames 在可变帧率视频上如实保留时间戳空档；frametimes 解析合成的 framestats 文本与汇总行；report 生成表格。

合成视频也可以单独生成来试参数：

```sh
uv run python -m chatmeasure.synth /path/to/demo.mp4 --frames 600 --codec h264   # --no-markers 生成旧应用版
```

## 性能

Apple M3 Pro，60 秒、60fps、1080x2400 的 H.264 合成视频（3600 帧）：

| 子命令 | 全分辨率 | 半分辨率 |
|---|---|---|
| markers（全宽） | 36 秒 | 12 秒 |
| markers（`--x-range 0,256`） | 15 秒 | — |
| gap | 30 秒 | 10 秒 |
| motion | 38 秒 | 22 秒 |
| blank | 55 秒 | — |
| track | 29 秒 | — |

合成视频画面简单，文件只有约 3.5MB；真实录屏码率更高，解码会慢一些。

## 已知局限

- 只认原始分辨率坐标，需要先在一帧截图上量好区域（可用 `frames` 导出一帧来量）。
- `gap` 依赖背景是纯色：渐变、壁纸、半透明模糊背景下需要调 `--bg-tol`，或改用标记线。内容下沿按像素算，最后一行出现降部字母（g、p、y）时下沿会下移几个像素，表现为一次小阶跃而不是回弹。
- `gap` 的输入区上沿自动检测找的是搜索范围里最强的横贯边缘，范围里有分隔线、气泡底边时可能跳到别的边缘，`input_top` 的跳变统计能看出来；稳定时建议直接给固定值。键盘动画期间输入区上沿在移动，搜索范围要覆盖整个行程。
- `motion` 对周期性内容（等宽、等行距的重复行）可能把位移估成整数倍行高；位移超过 `--max-shift` 时标为超出范围而不给数。快速滑动时单帧位移可能很大，需要调大 `--max-shift`（区域也要够高）。
- `track` 是刚性模板匹配：目标行本身内容变了（展开后文字变化、高亮、按压态）会降低置信度甚至丢失，框选时尽量选不变的部分（如标题、头像）。
- `blank` 只看非背景像素占比：骨架屏、占位色块会被当成有内容。
- 标记线默认按色度匹配，界面里有大面积洋红/青色元素时要用 `--x-range/--y-range` 避开；同一行出现多段候选时取命中最多的那段。
- screenrecord 本身不保证每次界面刷新都录下一帧（编码跟不上时会合并），1 帧的事件可能漏掉；帧计数以录到的帧为准，时长以时间戳为准。
- frametimes 的卡顿定义按「总帧耗时 > 一个刷新周期」，与 Android 新版本基于截止时间的 Janky frames 统计口径不同，两者都输出。
- 合成视频验证的是算法在已知事件上的准确度，还没有在真实录屏上校准过阈值（如 `--min-row-pixels`、`--min-std`）。
