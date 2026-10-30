// 用正式的 C++ 解析入口验证 iOS、安卓共同使用的解析层，不启动模拟器。
#include "parser/MD4CParser.hpp"
#include "wasm/ASTSerializer.hpp"
#include <iostream>
#include <iterator>

int main() {
    const std::string source(std::istreambuf_iterator<char>(std::cin), {});
    Markdown::MD4CParser parser;
    auto root = parser.parse(source);
    std::cout << Markdown::ASTSerializer::serialize(*root);
}
