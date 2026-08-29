# 下班发车（黑客松项目）

一句话：把「准点下班」变成团队共识——组队、检票、摇号抽列车长、全队准点走。

## 跑
- `npm run dev` → :5173，默认离线演示（假人自动投票），启动时自动打开页面；`?director=1` 导演台跳任意相位
- `npm run dev:keep` / `npm run dev:stop` → 后台常驻 / 停止前端页面服务，适合演示时关闭终端仍保持页面可访问
- `npm run server` → :8787 联机后端；前端 `?room=X&live=1` 接入；`npm run test:server` 冒烟

## 栈与结构
- Vite + React + TS + motion(Framer) + zustand + canvas-confetti + qrcode；后端 Node + ws
- `src/engine` = 纯 reducer，前后端共用，**禁止加副作用**；`src/drivers` = LocalDemo / Ws 可插拔
- UI 全在 `src/ui/App.tsx`；皮肤 token 全在 `src/theme.css :root`，相位底色由 `.phone-screen[data-phase]` 驱动

## 铁律
- 金色 `var(--gold)` 只允许出现在 drawing 之后的组件（列车长专属），review 时可 grep
- 动效禁 linear：基准 `spring(300, 20)`、overshoot 5–10%、一次只夸张一个通道（对照设计板 S3 十二原则）
- 文案口径：永不显示「谁还没投」，只奖励不追责，「全队都走，列车长只是先站起来的那个」
- `demoDraw` 舞台模式保证 'me' 必中列车长（路演稳定出滑动发车环节）——这是特性不是 bug
- 插画不手绘：走 `designs/fache-layered-pages/生图提示词.md` 生图管线，替换 `public/art/`
- Banban 组件的 CSS 静态 transform 会被 Framer 行内样式覆盖，姿态类改动要用 keyframes

## 当前状态 / 下一步
- 已完成：七相位闭环、S1 联机（冒烟通过）、北欧换皮、生图素材接入关键相位
- 下一步：后端地址改环境变量（App.tsx 硬编码 :8787）、公网部署、streak 落盘、建队流程 F1–F7
- 设计真源：`designs/fache-layered-pages/分层页面设计板 · 北欧风.html`；repo：github.com/zexuanw958-svg/xiaban-fache（公开）
