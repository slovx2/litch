#!/usr/bin/env node
// MCP 桥：ACP agent 按会话起的 stdio MCP 服务（由 client-tools.mts 写进 session/new 等的 mcpServers）。
// 它只是一根管子：经本地套接字（Windows 上是命名管道）接回 ACP 入口进程，先报一行自己是哪一个，
// 之后标准输入输出和套接字两头原样转发。MCP 本身由 ACP 入口进程答（stdio 的 MCP 一行一条 JSON）。
//
// 参数：<套接字路径> <桥的标识>；口令在环境变量 LITCH_ACP_MCP_TOKEN 里（不放参数里，别的用户用 ps 看不到）。
import { createConnection } from 'node:net'

const [path, key] = process.argv.slice(2)
if (!path || !key) {
  process.stderr.write('用法: mcp-bridge <套接字路径> <桥的标识>（口令在 LITCH_ACP_MCP_TOKEN）\n')
  process.exit(2)
}

const socket = createConnection(path)
socket.once('connect', () => {
  socket.write(`${JSON.stringify({ key, token: process.env.LITCH_ACP_MCP_TOKEN ?? '' })}\n`)
  // 标准输入在接上之前是暂停的，先到的数据留在缓冲里，接上之后一起转过去
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
})
socket.on('error', (error) => {
  process.stderr.write(`Litch 的 MCP 桥连不上 ACP 入口：${error.message}\n`)
  process.exit(1)
})
// ACP 入口关了这一头（它退出了，或者口令不对）：桥跟着退，agent 那边看到的是 MCP 服务断了
socket.on('close', () => process.exit(0))
