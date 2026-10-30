# 中文强调规则的维护

桌面使用 `marked@18.0.14` 和 `marked-cjk-friendly@0.1.3`；手机保留
`react-native-enriched-markdown@1.1.0`，只补丁修改 md4c 的强调与删除线定界符。
不预处理强调原文、不插入零宽字符，原生选字及复制仍使用原来的 AST 文本。

三条路径：Android 的 CMake 和 iOS 的 podspec 都编译 `cpp/md4c/md4c.c`（UTF-8）；
网页预览使用同包 `lib/module/web/wasm/md4c-litch.js`。补丁同时保存源码入口的
`src/web/wasm/md4c-litch.js`，并修改两入口的 parseMarkdown 动态导入。
上游原来的 md4c.js 内含 NUL，是二进制文件，因此新增纯文本产物，不直接补丁替换它。

采用原生补丁是为了保留已有的选字、表格、代码排版与流式行为。
JS 插入零宽字符会污染复制内容和选区偏移；整体替换解析器及原生渲染器的改动范围更大。

`cpp/md4c/litch_cjk.h` 的字符范围来自 `marked-cjk-friendly@0.1.3`，并保留 MIT
版权声明；md4c 与 enriched-markdown 也都是 MIT。不要从参考应用复制实现。
桌面额外拒绝扩展 0.1.3 错误接受的内侧空白，例如 `**标题： **正文`。
纯英文 `**English:**text`、词内 `a**b**c` 继续遵循 CommonMark；单个 `~` 不表示删除线。

升级依赖或修改 C 补丁时：

1. 锁定新版本，重新审查补丁；不忽略 patch-package 的应用失败。
2. 同步桌面扩展和 CJK 范围，运行共同语料；不单独升级一个端的规则。
3. 安装隔离的 Emscripten **4.0.19**，通过 `EMCC` 指向它的 `emcc`。
   在 `apps/mobile` 执行 `npm run markdown:wasm`，再执行
   `npx patch-package react-native-enriched-markdown`。
   编译脚本固定编译器版本，重新生成两份 WASM JS 和源码/产物 SHA-256 清单。
   必须保留 `SINGLE_FILE_BINARY_ENCODE=0`：默认二进制字符串包含 NUL，patch-package
   只会写入 `Binary files differ`，安装时却不应用它；脚本和测试都拒绝这种产物。
4. 从干净依赖安装运行 `npm ci` 验证补丁，再运行手机单测、类型检查、`preview:check`。
   手机单测需要 C/C++ 编译器（`CC`/`CXX`，默认 `cc`/`c++`），测试原生解析器、WASM
   与清单；普通安装和测试不需要 Emscripten。
5. 同时运行桌面单测和对话区验收。共同语料在
   `packages/ui/test/fixtures/cjk-emphasis.json`；手机另测现有 `$...$` / `$$...$$` 数学式。
   桌面目前未实现数学解析，不据此宣称两端全部 Markdown 功能一致。
6. 隐藏窗口检查桌面 `test/cjk-emphasis/index.html` 和手机网页预览的
   `?app=1&scene=cjk-emphasis`；真机选字/复制仍需在 iOS、Android 发版验收中检查。

测试中的源码摘要确保修改原生解析器后，不能遗忘网页产物。只有在审核源码变化、
重新编译并通过行为用例后，才能更新摘要；不能为了通过检查直接修改摘要值。
