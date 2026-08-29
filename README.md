# 下班发车 · OFF WORK EXPRESS 🚌

> 不是催着离开，是让准点发生。

把「准点下班」从个人选择，变成团队共识：小队组队，17:30 刷工牌检票，18:00 摇号鼓抽出今晚的「列车长」，全队跟车准点走。黑客松作品。

## 跑起来

```bash
npm i
npm run dev            # 前端 :5173 · 离线演示模式（内置假人车队，断网可演）
npm run dev:keep       # 前端后台常驻，并自动打开界面
npm run dev:stop       # 停止后台常驻的前端
npm run server         # 可选联机后端 :8787（服务器 = 唯一裁判）
npm run test:server    # 三客户端全链路冒烟：检票→抽签→发车→收班
```

- `?director=1` 导演台，一键跳任意相位；`?projection=1` 投影模式
- 联机入口：`/?room=G604&live=1`（建房走 `POST :8787/api/rooms`）

## 架构

纯 reducer 状态机（`src/engine`，**前后端共用同一份**）+ 可插拔驱动（`LocalDemo` / `WebSocket`）+ 分相位 UI。
七相位：`idle → boarding → drawing → departing → departed → settled / suspended`。
开奖「结果先定、动画后演」：服务器广播 `DRAW_RESULT + drawStartAt`，各端同秒开播 20s 悬念动画；离线演示可点击“跳过动画，立即揭晓”，联机房间仍由服务器统一控制。

## License

MIT，见 [LICENSE](LICENSE)。

## 目录

| 路径 | 内容 |
|---|---|
| `src/engine` | TripEngine 纯 reducer + 抽签规则 |
| `src/drivers` | LocalDemo（假人+舞台保底）/ WsDriver（断线重连） |
| `src/ui/App.tsx` | 全部相位 UI + 动效 + 音效/震动 |
| `src/theme.css` | 北欧纸面皮肤 token（相位色由 `[data-phase]` 驱动） |
| `server/` | 单文件 Node+ws 房间服务器 + 冒烟测试 |
| `public/art` | 已接入的生图素材 |
| `assets/生图` | 全量 16 张生图素材源 |
| `designs/fache-layered-pages` | 分层页面设计板（北欧风）+ 生图提示词.md |
| `设计参考/` | 原始车票 SVG 三张 |

## 设计语言

暖灰纸面 + 一相一点缀色：焦糖平峰 / 琥珀检票 / **金·开奖（此前全产品不得出现金色）** / 蓝·发车 / 橘·已发车 / 暖灰收班 / 粉·停运。动效对照动画十二原则（设计板 S3），弹簧基准 `spring(300, 20)`、入场 overshoot 5–10%、禁 linear。

## 状态（2026-08-29）

- ✅ 七相位闭环 · S1 联机冒烟通过 · 北欧换皮 · 生图素材接入
- ⏳ 待办：后端地址可配置（现硬编码 `:8787`）· 公网部署 · streak 落盘 · 建队流程 F1–F7 实装
