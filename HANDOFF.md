# HANDOFF — Me 页 + 语音计量 / Plus 额度（2026-11-25）

给下一个 session 的交接。代码已在 `ab21745` 提交、线上部署 `b11432b3`，工作区干净。
项目规范见根目录 `AGENTS.md`（tango-tempo gate：每片 ≤25 行审查面，先对齐再改）。

## 本轮完成

Me 页从骨架做到真数据：

- 版式：头像区（无框）+ 本月数据卡（Messages/Calls/Voice 三格）+ 设置卡（Notifications/Sign out）+ 订阅卡（Free/Plus 徽章、额度进度条、Get Plus 描边按钮），微信/WhatsApp inset-list 风格
- 存储：`messages.dur`（毫秒）、`prefs.plan`（`free|plus`）
- 统计：`convo.stats()`（backend/convo.py:267）按用户时区算本月窗口，返回 `messages/calls/voice(秒)/plan/cap`
- 接口：`GET /me/stats`（worker.py:766）、`POST /me/plan`（worker.py:771）
- 额度：Free 30 分钟/月、Plus 90 分钟/月（`CAP_MIN`，backend/convo.py:158）；`/token` 超额 403（worker.py:699 附近），只挡新通话、不打断进行中的通话
- 上报：`live.js` 挂断时 `call.dur` 随 `/transcript` 上报（live.js:649）；Class call 也落库
- 前端：`paintStats()`（site/js/app.js:178）填三格/进度条/徽章/CTA；CTA 点击切 plan（app.js:316）

## 关键事实 / 坑（别重复踩）

- Class call 的 `/transcript` 上报 `unit` 是 **persona-Fiona**（`rec.chatUnit`），真实课堂单元在 `rec.unit`；practice 为 true。
- Class call 的 call 行按 `hidden=1` 存，避免作为气泡漏进 Fiona 普通聊天；但 `stats()` 统计 `kind='call'` 不看 hidden，所以仍计入额度。
- `recent()` 只取 `text/transcript`，`tail()` 取全部 kind；客户端渲染时跳过 `hidden`（live.js:240）。
- 月界用 `prefs.tz_offset`（JS `getTimezoneOffset` 语义，UTC+8 = -480），只在 `/token` 时更新。
- 迁移前（≤2026-11-25）的历史通话 `dur=0`，统计会偏低。
- 沙箱直连 `*.workers.dev` 会被连接重置，别用 curl 验线上；部署只能用下面的 npx 缓存 wrangler。

## 未完成（按优先级）

1. **backfill 本月旧通话 dur**：解析 `text` 里的 `mm:ss`（`Voice call · 3:24` / `Class call · …`）生成一次性 `UPDATE`，remote+local 都跑。建议单独一片。
2. **超额体验**：进度条满/超额没有视觉状态；403 文案带 `Can't start a call:` 英文前缀（live.js `connect()` 的 catch），且 403 会白重试一次（live.js:727-735 内层 catch），应识别 `data.upgrade` / 403 直接失败。建议一片。
3. **Class call 影响 moments engagement**：backend/moments.py:232 的 calls 计数现在包含课堂通话，回声频率略升；若不想算，需要按 unit/practice 区分。可选。
4. **真支付未做**（既定）：Plus 是本地状态，¥29.9 不扣费。
5. **额度拦截未端到端验证**：30 分钟不好实测；可临时把 `CAP_MIN["free"]` 调成 0 验证 403 后恢复，或 D1 插一条 `dur` 大头。需在手机确认。

## 常用命令（本机）

```sh
# 部署（wrangler 只在 npx 缓存里）
HOME=/Users/riceball ~/.npm/_npx/32026684e21afda6/node_modules/.bin/wrangler deploy

# D1 加列（schema.sql 是 CREATE TABLE IF NOT EXISTS，新列必须手工 ALTER；remote 和 local 都要）
W=$HOME/.npm/_npx/32026684e21afda6/node_modules/.bin/wrangler
$W d1 execute fluentchat --remote --command "ALTER TABLE messages ADD COLUMN dur INTEGER NOT NULL DEFAULT 0"
$W d1 execute fluentchat --local  --command "ALTER TABLE messages ADD COLUMN dur INTEGER NOT NULL DEFAULT 0"

# 验证
python3 -m py_compile worker.py backend/convo.py
node tools/smoke.mjs        # 末行 SMOKE PASS
```

## 缓存版本号约定（改前端必做）

三处都要 bump，否则手机拿旧文件：
- `site/index.html`：`css/app.css?v=`、`js/app.js?v=`
- `site/js/app.js`：内部 `import … "./live.js?v="` 等模块各自带版本

## 不要做

- 别删 `.row-list/.row` 系 CSS：Chats/Calls 列表还在用。
- 别把 Class call 改成 `hidden=0`：会污染 Fiona 聊天时间线。
- 别在 `/token` 里拦截进行中的通话：产品决定是“打完再拦新通话”。
