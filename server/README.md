# 下班发车 · 后端服务

这是技术路线里的 S1 最小可运行后端：Node HTTP + `ws`，内存房间，服务器是唯一裁判，所有客户端接收全量 `STATE` 快照。

## 启动

```bash
npm run server
# 开发时可以缩短发车时间
DEPART_IN_SECONDS=30 npm run server
# 可在烟测时缩短开奖演示（正式默认 20s）
DEPART_IN_SECONDS=5 DRAW_ANIMATION_SECONDS=2 npm run server
```

默认监听 `http://localhost:8787`，WebSocket 地址为 `ws://localhost:8787`。

## HTTP

```bash
curl http://localhost:8787/health

curl -X POST http://localhost:8787/api/rooms \\
  -H 'content-type: application/json' \\
  -d '{"teamCode":"G604","teamName":"604 次晚高峰","departInSeconds":60,"minCrew":3}'

curl http://localhost:8787/api/rooms/G604
```

## WebSocket 协议

1. 客户端连接后发送：

```json
{"type":"JOIN","teamCode":"G604","memberId":"local-me","name":"阿轩","emoji":"🧑‍💻"}
```

2. 服务端返回 `WELCOME` 和全量 `STATE`。
3. 客户端只发送意图：`SUBMIT_TICKET`、`WITHDRAW_TICKET`、`DECLINE_DUTY`、`DEPART`、`BOARD`、`SETTLE`。
4. 服务端定时器负责 T-30、T-0、抽签结果与 `drawStartAt`，并向全房广播 `DRAW_RESULT` + `STATE`。

房间没有数据库；重连时重复 `JOIN` 会无脑返回最新快照。当前版本适合黑客松演示，生产化前需要持久化、鉴权、房间过期清理和常驻实例。
