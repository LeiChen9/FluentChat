# 开发日志 - FluentChat 录音实验

## 背景
原本项目只有「文字链路」可跑（点 Unit → 拿 token → 连 Gemini Live → 显示 AI 转写）。本次实验要加上「麦克风上行」和「AI 音频播放」。

## 已完成
- 前端 live.js：AI 音频播放（解析 serverContent.modelTurn.parts[].inlineData）
- 前端 live.js：麦克风采集（getUserMedia + ScriptProcessor，base64 分片发 realtimeInput.audio）
- 前端 live.js：setupComplete 后 600ms 自动开启麦克风，close/onclose 清理麦克风和定时器
- 技术文档 tech_doc.md 增加「环境」一节（conda 环境名 echo）

## 修复：手机上听不到 AI、说话没反应（2026-10-03）

症状：手机端能连上、能看到 AI 的转写文字，但**听不到声音**，且**对着麦克风说话 AI 无反应**。

根因（都在 `site/js/live.js`，是两处独立 bug，再加一个移动端前提）：

| # | 症状 | 原因 | 修法 |
| --- | --- | --- | --- |
| 1 | 听不到 | 用 `decodeAudioData` 解 Gemini 的音频。它是**裸 PCM16，没有 WAV 头**，解码必然 reject，而 `.catch(() => {})` 把错误吞了 → 静音且无任何提示 | 手工把 PCM16 转 Float32 塞进 `AudioBuffer`，按 `playHead` 排队连续播放 |
| 2 | 说了没反应 | 把 `new AudioContext({sampleRate:24000})` 当采集率，但设了之后 `ctx.sampleRate` 被改成 24000，而麦克风真实数据是 48000 → 发上去是**变速音频**（音调被拉低一半），AI 听不懂 | 不强制采样率，按 `ctx.sampleRate` 采，再线性插值降到 **16000**，mime 标 `audio/pcm;rate=16000` |
| 3 | 手机无声 / 麦克风被拒 | `AudioContext` 没在用户手势里创建，一直停在 `suspended` | 点 Unit 时同步调 `ensureAudio()` 解锁 |

顺带修的：
- 麦克风 `ScriptProcessor` 原来直连 `destination`，会把你的声音原样放出来（回声/啸叫）；改成串一个增益 0 的节点。
- 麦克风打不开原来只在 `console.warn`，手机上根本看不到；现在显示到通话卡片上。
- 收到 `serverContent.interrupted` 时停掉已排队的音频，否则被打断后模型还会继续念。
- 采样率魔法数字改成 `MIC_RATE` / `OUT_RATE` 常量。

## 待测试
- 手机端双向对话（音频播放 + 麦克风上行）
- Unit 列表在某些环境下点击无响应（需排查）

## 对话页改版：WhatsApp 式聊天 + 正常猫色 + 挂断后文字复盘（2026-10-03）

> 本条覆盖上一个 commit `6ac8177` 之后的全部改动：`site/index.html`、`site/css/app.css`、`site/js/app.js`、`site/js/live.js`、`tools/preview.py`，外加本期新建的 `tools/smoke.mjs`。

### 需求
上一版是「Unit 列表里点一个，就地在列表下方展开一张通话卡（`.talk`）」。这次三条：

1. 每个 Unit 点进去应该是**独立聊天页**，像 WhatsApp / 微信的单个会话；底部一条栏里同时能打电话和打字。
2. 猫头像毛色要正常，不要粉的、蓝的。
3. 挂断之后复盘要以**文字**给出来。

### 配色（这批顺带定稿）
| | 之前（`6ac8177`） | 现在 |
| --- | --- | --- |
| 底 | `#fbfbfd` 冷白 | `#faf6ee` 暖奶油 |
| 墨 | `#1c1c1e` | `#3e362e` 暖褐墨 |
| accent | `#5e5ce6` 靛蓝 | `#47703f` 鼠尾草绿 |
| 深色模式 | `@media (prefers-color-scheme: dark)` | **移除**，全站钉死浅色 |

- `--accent` 是算过的：白字压它 5.7:1，它压 `--glow` 4.6:1，都过 AA。要更淡就把 `--glow` 的 alpha 调小，别动 `--accent`。
- `<meta name="color-scheme">` / `theme-color` 从「light dark 双条」收敛成单条 `light` + `#FAF6EE`。
- `tools/preview.py` 的 ASCII 底色同步成 `#FAF6EE`（原来打印三套底色，深色两套删掉）。
- `--bubble-in: #fffdf7`（纸白）、`--bubble-out: #dce9d0`（淡青草绿，压深墨 9.4:1）是新加的 token。

### 猫毛色（`AVATARS`，`site/js/live.js`）
图是抠好底的透明 PNG，底下垫一层毛色当背景，再用 `filter` 把奶油白的猫染过去：

| | 底色 | filter |
| --- | --- | --- |
| 奶油 | `#e8ddc8` | `none` |
| 橘猫 | `#efc793` | `sepia(.6) saturate(2) hue-rotate(-15deg)` |
| 银渐层 | `#cbc7c0` | `grayscale(.9) brightness(1.02)` |
| 棕虎斑 | `#cdb187` | `sepia(.85) saturate(1.8) brightness(.9)` |
| 灰猫 | `#bdb9b1` | `grayscale(.9) brightness(.76) contrast(1.05)` |
| 深灰/黑 | `#d5d1c9` | `grayscale(1) brightness(.6) contrast(1.2)` |

粉、蓝全去掉，6 个 Unit 按下标取色。`.unit__av` 改名成通用的 `.avatar`，列表 40px / 聊天头 48px / 通话 112px 共用同一个文件，靠 `transform` 裁切（**裁切参数没真机验证过**，见下面待测试）。

### 聊天页 `#view-chat`
`site/index.html` 结构：

```
section#view-chat
├ header.chat-head    chat-back · .avatar#chat-av · .chat-id(chat-name + chat-state)
├ .chat-body#chat-body  .chat-day「今天」+ 气泡 + 复盘卡片
├ form.chat-bar#chat-bar  chat-call · chat-input · chat-send   ← 打电话和打字在同一条栏
└ .call#call              全屏通话：call-av / call-name / call-state / call-said / call-end
```

- **导航**：`app.js` 的 `VIEWS` 加了 `"chat"`；`TAB_OF = { chat: "unit" }` 让 push 进去后底部仍亮 Unit；进聊天页时 `topbar.hidden` 和 `tabbar.hidden` 都置 `true` —— 不藏 tabbar 的话，iPhone 上输入框下面会垫出一条 safe-area 空白。
- `initChat({ show, back })` 在 `app.js` 里**只调一次**，`leaveChat = () => chat.close()`；离开聊天页由 `showView()` 调它拆连接。
- **气泡**：AI 左 `.msg--ai`（纸白 + 发丝边，左下角 6px），我右 `.msg--me`（草绿，右下角 6px），新气泡走 `msgIn` 弹簧动画；聊天页 push 走 `chatIn`。
- 转写是**整轮覆盖**上来的，所以同一条气泡直接改 `textContent`，不能拼接。

### 文字模式不碰 AudioContext
`mode === "text"` 时 AI 的 `modelTurn.parts[].inlineData` **直接丢弃** —— 文字回复本来就走 `outputTranscription`。这样纯打字聊天从头到尾不创建 `AudioContext`，iOS 的「自动播放受限」根本不成立。只有 `startCall()` 在用户手势里同步调 `ensureAudio()` 才解锁音频。

### 挂断后文字复盘（`REVIEW_REQ`）—— **没改后端**
`worker.py` 已经开了 `inputAudioTranscription`，模型手里也已经有整段对话，所以复盘走**同一条 Live 连接**：挂断 → 停麦克风/停播放 → 缓 700ms → 发一条 `REVIEW_REQ`（把 `prompts/base.md` 里「对话式点评、说完等用户反应」掰成一次性交稿的中文文字：不分轮、不提问，先用一两句说清做得好的一两个具体点，再给 2-3 个要改的、每个配一句英文例句，最后一句鼓励收尾）→ 转写流式写进 `.review` 卡片。

收尾三重兜底：`turnComplete` / 3.5s 无新字（`armReviewIdle`）/ 30s 硬上限（`reviewCap`）。挂断瞬间上一轮的 `turnComplete` 可能迟到，所以有 700ms 宽限，且至少要攒到字才认。

### 顺带修的竞态
| 症状 | 原因 | 修法 |
| --- | --- | --- |
| 快速切 Unit / 返回后，UI 被旧连接打乱 | `connect()` 是异步的（等 token），`onmessage` / `onclose` 直接写全局状态，旧 socket 的消息能落进新会话 | `connectSeq` 代际计数器，每次建连/拆连自增，过期的 `connect()` 直接丢；三个回调再各自闭包持有自己那个 socket，触发时先比对 `ws === this` |
| 等 token 时点返回，回来残留连接 | 同上 | `teardown()` 统一清 `ws` / 麦克风 / `micStream` / 气泡 / 复盘定时器 |
| 点 Unit 报 `showView is not a function` | `initChat` 返回的是 `{ close }` 对象，却被当成函数直接当回调用 | `app.js` 改成先拿对象，再 `leaveChat = () => chat.close()` |

### 本次踩的坑
| # | 干了什么 | 后果 | 教训 |
| --- | --- | --- | --- |
| 1 | 重写时先 `rm site/js/live.js` 再写新文件 | 写到一半中断就丢了整条已验证的 PCM16 音频链路（上个 commit 刚修好的播放 + 上行采样率） | 改大文件**别先删**。这次从 `git show 6ac8177:site/js/live.js` 恢复，音频部分逐字对回去，只动列表/气泡/复盘 |
| 2 | 没有真机就开写 | 只能靠 `node --check` 心算逻辑 | 写了个 DOM / AudioContext / WebSocket 全桩的 `tools/smoke.mjs` 把全流程跑一遍，**当场抓到坑 3** |
| 3 | `initChat({show, back})` 直接当回调赋值 | 点 Unit 白屏 | 桩测试里真 fire 一次 `click` 就能暴露 |

### 验证
- `node --check site/js/*.js tools/smoke.mjs`；`python -m py_compile tools/preview.py worker.py`；CSS 花括号配平（117 对）。
- **`node tools/smoke.mjs`** —— 16 步全流程（进聊天页 → setupComplete → 打字气泡 → 通话 → 挂断 → 复盘流式 → 返回），最后打印 `SMOKE PASS`。
- 部署后 fetch 线上比对 `/`、`/js/app.js`、`/js/live.js`、`/css/app.css` 与本地一致；确认无 `prefers-color-scheme`、无残留 `.talk` / `.unit__av` / `initUnits`。
- 本次部署 Version `333dda92-0326-4b31-93ab-b04c22d9f1dc`（`fluentchat-api` @ workers.dev）。

### 待测试 / 已知限制
- **真机一次都没测过**（沙箱里没有浏览器和麦克风）。重点看：聊天页 push 动画、头像在 40/48/112px 圆里裁得对不对、气泡配色、麦克风上行 + AI 播放、挂断后复盘的实际耗时。
- 复盘文字来自 Live 会话的**音频转写**，得等模型把复盘「念完」才逐字出现，`正在整理刚才的对话…` 会挂几秒 —— 这是不改后端换来的代价。
- 聊天记录**不持久化**：离开聊天页就 `teardown()`，重连后模型没有记忆，回同一个 Unit 是白纸一张。
- 上一条日志留的「Unit 列表某些环境下点击无响应」还没排查，可能已被 `connectSeq` 修掉，待真机确认。

## 交接：下一个 session 从这里开始（2026-10-03）

### 现状
- 站点已部署到 **https://fluentchat-api.luent-hat.workers.dev**，本次 Version `333dda92-0326-4b31-93ab-b04c22d9f1dc`；线上 `/`、`/js/app.js`、`/js/live.js`、`/css/app.css` 已 fetch 比对，与本地一致。
- `git status` 应该是干净的（本条写完就提交 push）；若有残留，先看 `git log` 确认范围。
- **没有任何真机验证**，全部结论来自静态检查 + 桩测试。

### 怎么跑
```bash
node tools/smoke.mjs                 # 无浏览器冒烟测试，看到 SMOKE PASS 才算过
node --check site/js/live.js site/js/app.js
npx wrangler deploy                  # 改了 site/ 必须部署，workers.dev 上才看得到
```
`tools/smoke.mjs` 用桩模拟 DOM / `AudioContext` / `WebSocket`，把「进聊天页 → setupComplete → 打字气泡 → 通话 → 挂断 → 复盘流式 → 返回」整条链跑一遍。**改了 HTML 结构要同步更新它的桩**（它只认 `live.js` 用到的那些属性和事件）。

### 关键文件
| 文件 | 职责 |
| --- | --- |
| `site/index.html` | 四个 view：`view-home`（NPC）/ `view-unit`（列表）/ `view-chat`（聊天页）/ `view-me`。`view-chat` 里同时装着聊天页和全屏通话页 `#call` |
| `site/js/app.js` | 视图路由 `showView()`、`TAB_OF`、topbar/tabbar 显隐。`initChat()` **只在这里调一次** |
| `site/js/live.js` | 全部业务逻辑：`UNITS` / `AVATARS` / `REVIEW_REQ`、Live WebSocket、文字↔通话两模式、麦克风与播放、气泡与复盘渲染 |
| `site/css/app.css` | 全部样式。设计 token 在 `:root`；深色模式已移除，全站钉死浅色 |
| `worker.py` | 只签 token + 内联 prompt，**音频不经过它**。`inputAudioTranscription` 已开（复盘靠它） |
| `prompts/*.md` + `tools/gen_prompts.py` | 提示词源文件。**运行时用的是 `worker.py` 里内联的那份**，改 md 要跑 `gen_prompts.py` 再部署 |
| `tools/smoke.mjs` | 冒烟测试 |

### 约定（别踩）
- **改大文件别先删**：`live.js` 被 `rm` 过一次，音频链路只能从 `git show` 恢复。动它之前先 commit 或 `git stash`。
- 注释是**中文**的，按现有风格写；提交信息是**英文祈使句 + 正文解释 why**（见 `git log`）。
- `wrangler.toml` 里 assets 只指 `./site`（指到项目根会把 `.env` 一起传上去，API key 就公开了）。
- 视觉上有算过的对比度：`--accent: #47703f` 别随便调，动 `--glow` 的 alpha 来调节深浅。

### 下一步（按优先级）
1. **真机过一遍**上一条「待测试」里的全部项 —— 尤其头像在 40/48/112px 圆里的裁切（现在是 `transform-origin: 50% 0` + `scale()`，纯猜的）和麦克风/播放。
2. 复盘体验：现在是「等模型把复盘念完才逐字出字」，前面有几秒空白。可选：后端加纯文本端点（要动 `worker.py`），或前端做打字机进度条掩盖延迟。
3. 聊天历史持久化（现在离开即清空）。
4. 「Unit 列表某些环境下点击无响应」——上一条日志留的，**还没排查**，可能已被 `connectSeq` 修掉。
5. Free Chat tab 还是灰的占位，没设计。

## 回复显示修复 + 去流式换 typing + 聊天历史持久化（2026-10-04）

> 改动：`site/js/live.js`、`site/css/app.css`、`worker.py`、`tools/smoke.mjs`。

### 需求
1. 点开 Unit 的开场白只显示最后一段（如只剩 `province are you from?`），要能显示完整。
2. 不要流式逐字：等待期间给「正在输入…」提示，后台慢慢算；文字聊天和通话都是这样。
3. 持久化：同一个用户，聊天记录和语音通话的记忆每次都留存，下次进来不从头开始。

### 根因（开场白截断）
旧代码注释假设 `outputTranscription.text` 是「整轮到目前为止的完整文本」，同一条气泡
**整轮覆盖写**（`upsert`）；实际服务端给的是**分片**，覆盖写就只剩最后一片。
另外上一版修复只落在本地、**没部署**，线上一直是旧代码 —— 用户真机复现才暴露。
教训：改了 `site/` 不 `wrangler deploy` + fetch 比对，等于没修。

### 改法
| # | 问题 | 修法 |
| --- | --- | --- |
| 1 | 只显示最后一片 | `mergeChunk()` 按内容判断服务端语义：新包含旧文→整轮累计（覆盖）；旧文含新包→重复（丢）；否则→增量（拼）。分片只攒进 `pendingAi`/`pendingMe`，`turnComplete` 才一次性 `flushPending()` 落成整条气泡 |
| 2 | 流式逐字 | 等待期间显示 WhatsApp 式三点气泡 `.msg--typing`（CSS `typingDot` 动画）+ 顶栏「对方正在输入…」，发送/唤醒后立即出现。复盘卡片同样攒 `reviewBuf`，收尾才一次性贴正文，中途保持「正在整理…」占位 |
| 3 | 无持久化 | 每条消息落定即写 `localStorage`（`fluentchat:hist:v1:<unit>`，每 Unit 上限 120 条），重开同一 Unit 渲染全部气泡 + 复盘卡片；`/token` 请求带上 history（最近 30 条 × 400 字，**复盘卡片不算对话不带**），`worker.py` 的 `sanitize_history()` 清洗后把历史钉进 system instruction **末尾**（后写的盖过 base.md「第一轮直接说开场白」），指示模型接着上次聊、不重说开场白 |

- 通话页 `callSaid` **保留实时字幕**（跟着语音走才有用）；聊天区的落泡节奏不受影响。
- 通话中的转写（`inputTranscription`/`outputTranscription`）同样攒到 `turnComplete` 落泡 —— 所以语音通话的内容天然进历史，通话记忆一并保住。
- 断线（`onClose`）、打断（`interrupted`）、挂断（`hangUp`）都先 `flushPending()`，攒着的话不丢。
- `smoke.mjs` 桩升级：`remove()` 真的从父节点摘节点（typing 靠它消失）、补 `localStorage` 内存桩、记录 `/token` 请求体断言 history。

### 验证
- `node --check site/js/*.js tools/smoke.mjs`；`python -m py_compile worker.py`；CSS 花括号 124 对配平。
- **`node tools/smoke.mjs` → SMOKE PASS**（26 步：分片期间只出 typing → 整轮一次出完整开场白 → 通话转写攒轮落泡 → 复盘占位不流式 → 返回 → 重进恢复 6 个历史节点、`/token` 带 5 条 history）。
- worker 历史逻辑本地单测（清洗/截断/历史位于 prompt 末尾）通过。
- 用 `.dev.vars` 真 key 把 `build_token_payload(unit, history)` 实际 payload 打给 Gemini → **200 签发成功**（本机直连 `generativelanguage.googleapis.com` 超时，走 `127.0.0.1:8118` 代理验证；`wrangler dev` 的 outbound fetch 过不了代理，本地 dev 起不来，别在这台机器上等它）。
- 部署 Version `a1db9a5e-cc9a-4dd9-9387-51f6da3894cf`；fetch 远端 `/js/live.js`、`/css/app.css` 与本地 md5 一致，`/health` 正常。

### 待测试
- 真机回归：开场白完整度、typing 动画、退出重进恢复历史、通话字幕、挂断复盘。
- 历史只存在**本机浏览器** localStorage，换设备/清缓存即全新；多设备不同步。
- 历史随每次签 token 进 system instruction，单次上限约 30×400 字（约 8KB payload，已实测可签发）；聊得极久后要留意是否需要摘要压缩。

## Chapter 2 Expression 提示词搭建与进阶链重构（2026-10-04）

> 改动：`prompts/ch2-expression/unit-07..12.md`、`prompts/base.md`、`tools/gen_prompts.py`、`worker.py`、`readme.md`。

### 需求与变更
1. **Ch1 归档与改名**：原 `prompts/unit-01..06.md` 移动至 `prompts/ch1-survival/`。
2. **Ch2 表达篇搭建**：新建 `prompts/ch2-expression/unit-07..12.md`，主题围绕职场工作展开（At Work, What Happened, How It's Done, Describe It, The Reason, Fix Mix-up）。
3. **表达要求强化**：各单元增设「本章要求」区，明确全句输出约束、句型支架（First/Then/Finally, Because...）与流利度优先于准确度的原则。
4. **内联 Prompt 生成工具修复**：`tools/gen_prompts.py` 原 `glob("unit-*.md")` 无法搜到子目录，改用 `rglob("unit-*.md")` 递归搜索并内联至 `worker.py`。
5. **文档更新**：更新 README.md，补充 Chapter 2 表达篇的定位与 Unit 07..12 列表信息。

### 详细清单
| 文件 | 改动 |
| --- | --- |
| `prompts/ch1-survival/unit-01..06.md` | 存储生存篇 Prompt 源码 |
| `prompts/ch2-expression/unit-07..12.md` | 包含工作日常、经历阐述、步骤说明、物品描述、原因解释、误会澄清 |
| `tools/gen_prompts.py` | 采用 `Path.rglob("unit-*.md")` 抓取多级目录 prompt |
| `worker.py` | 同步内联最新的 Ch1 与 Ch2 完整 prompt 字典 |
| `readme.md` | 补充 Expression 章节结构说明与对应 Units 目录 |

### 验证
- `python3 tools/gen_prompts.py` 成功生成全量 12 个 Units 的 Prompt 内联代码。
- `python3 -m py_compile worker.py tools/gen_prompts.py` 语法编译无错误。
- `worker.py` 内部 `PROMPTS` 字典检索确认包含 `unit-01` 至 `unit-12` 全部新版内容。

### 待测试
- 真机验证 Chapter 2 表达篇各个 Unit 的 AI 对话引导与复盘质量。

### Ch2 独立 base prompt（base-ch2.md）
- Ch2 不再和 Ch1 共用 `base.md`：新建 `prompts/base-ch2.md`，难度升到 A2-B1（单轮 1-3 句、8-18 词），优先级改为 P1 表达流利度与连贯完整句 > P2 结构与专业度 > P3 语法；提问改为开放性问题（What happened / How do you usually handle / Why did you choose），引导用户用单元里的表达支架。
- `worker.py` 的 `build_system_instruction()` 按 unit 号选 base：unit-07..12 用 `base-ch2.md`，unit-01..06 仍用 `base.md`。
- 单元话题同步调整：unit-08 改「最近的一段工作经历」，unit-09 改「具体做法带专业细节」，unit-12 从「澄清误会」改成「聊哪里不足可以提升」。

## worker.py 分层重构（2026-10-23）

### 需求与变更
1. **工具层下沉** `backend/common.py`：模型容灾链（ENDPOINTS / GROQ 闸门 / MODEL_CHAIN / _chat_via / run_chain）、env 绑定与 secret 读取（`bind_worker_env` + 新的 `env_key`，合并原 `_env_key`/`get_api_key` 两套防御）、token 估算、KV 订阅存取、vapid_pubkey。写法对照 argus/backend/common.py。
2. **配置层** `backend/config.py`：AUTH_TOKENS_URL / MODEL / VOICE / UNITS / PERSONAS / VOICE_BY_ID / HIST_MAX_* 全部常量与白名单的唯一事实源。
3. **prompt 数据层** `backend/prompt_data.py`：`tools/gen_prompts.py` 的注入目标从 worker.py 内联区改为生成独立文件，worker.py 只 `from backend.prompt_data import PROMPTS`。早期"不敢确认模块导入可靠性"才内联——argus 的多模块 Python Worker 已实测线上可靠，此顾虑解除。
4. `TEXT_STYLE` 主体改为 `prompts/text_style.md`，走 gen_prompts 流水线；`to_messages` 拼接分隔符由原前导空格改为 `\n`（字符级 gen_prompts 会 strip md 边界空白），其余逐字节一致。
5. **清死代码**：`import hashlib`、`push_send`（定义后零调用，实际发推送在 pusher/index.js）、`import json`（重构后无直接使用）。
6. 业务函数（to_messages / build_system_instruction / build_token_payload / sanitize_history）与 fetch 路由原样保留；`_load_subs` 坏数据兜底、JSON 400、502 边界 try/except 按需保留。

### 详细清单
| 文件 | 改动 |
| --- | --- |
| `backend/common.py`（新） | 工具层：容器链、env、订阅存取（含 `backend/__init__.py`） |
| `backend/config.py`（新） | 配置层常量 |
| `backend/prompt_data.py`（新，生成） | 19 个 prompt（15 md + 3 persona + text_style） |
| `prompts/text_style.md`（新） | TEXT_STYLE 源文件 |
| `tools/gen_prompts.py` | 目标改 `backend/prompt_data.py`，更新 docstring |
| `worker.py` | 502 → ~250 行：只留 import、业务组装函数、`Default.fetch` 路由 |

### 验证
- 离线桩（stub workers/pyodide）import 全部模块通过；`run_chain`/`bind_worker_env` 与 common 为同一函数对象；config 常量为同一对象。
- 对 HEAD 逐字节回归：sanitize_history / build_system_instruction / build_token_payload / to_messages / run_chain 等，唯一差异是 text_style 的 1 个分隔符字符（见上）。
- 重跑 gen_prompts 顺带修复了历史漂移：`prompts/personas.md` 上次编辑后未重跑脚本，本次一并补进生成数据。

### 待测试
- `wrangler dev` / 部署后实测跨目录 import（`from backend.…`）打包是否正常，以及 /health、/token、/chat、/push/* 四条路由。
- 遗留小账：`prompts/personas.md` 里的 "one whitelist line in `worker.py`" 文案指向旧位置，下次改该文件时顺手改成 `backend/config.py`。

### 片 5：路由层去防御（同日追加)
- 删 `/token` 的「没配 GEMINI_API_KEY → 500」前置检查与 `/push/pubkey` 的「没配 VAPID → 500」检查：secret 由我们 `wrangler secret put` 配置，缺配视为部署错误，让其自然失败（Worker 500 / /health 的 has_key 可见）。
- `/token` 的 fetch 失败 / 非 200 / JSON 解析三个 try 合并为一个 → 502；`/chat` 删 `except Exception → 500` 二次包装（run_chain 已统一包成 RuntimeError → 502）；`/push/subscribe` 删整体 500 兜底，只留 JSON → 400。
- worker.py 260 → 250 行。保留的 except 共 5 处：3 处 JSON→400（HTTP 协议边界）、/chat 的 RuntimeError→502（链耗尽）、/token 的签发统一→502。`sanitize_history`（前端输入钉 prompt 的信任边界）、`env_key` try/except（链「没配 key 跳过」语义）、`_load_subs` KV 坏数据兜底（common.py，按先前拍板保留）不在删列。
- wrangler dev 复测：/health 200、/chat 502（本地无链 key，走通 backend 链）、跨包 import 正常。`/token` 实签本地网络外发不通（需部署环境验证），代码路径由同一 try 在 NameError 时期的 502 响应证明已执行。
- **线上部署冒烟通过（2026-10-23）**：`wrangler deploy` → `fluentchat-api.luent-hat.workers.dev`。/health 200（has_key=true、chain_ready=6）；POST / 实签成功（unit-01 裸调 + persona-sam 带历史各持一个新 token）；/chat 实答（链上 command-a-plus-05-2026 回复）；unit 白名单 400、subscribe 缺参 400、/push/pubkey 200 均正常。重构收口。

## 聊天列表状态点 + 未读角标（2026-10-23 后续）
- Chat 列表每行：名字旁加 7px 状态点（复用 Contacts 的 dot--active/-away/-busy/-offline 与 statusOf），头像包进 .row__avwrap 并叠 .row__badge 角标（红底白字微信式，无未读隐藏）。
- 未读来源：deliverProactive 后台落盘分支每条 +1（内存 Map，reflush 即清）；openChat 进对话即清零该行；页内气泡不计数。
- paintDots 挂在每分钟 proactive tick 上，状态漂移 60 秒内跟上；初始建行即刷一遍。
- CSS：app.css 新增 .row__avwrap/.row__name/.row__name .dot/.row__badge（#fa5151，--bg 描边 1.5px 破卡片感）。
- 底部 Chats tab 同款角标：unread 汇总即 tab 徽章数，setBadge 顺带刷（增/清都流经它）；CSS .tab 加 position:relative，.tab__badge 用 --bar-bg 描边贴在图标右上。页面加载时由建行后首刷一并归零。

## 用户系统 · 片 1 后端（2026-10-23）
- 抄 argus api_auth 模式：`backend/auth.py`（cookie 会话 + R2 users.json 单文件用户表，20 人私有服务的取舍——注册/登录/登出/me/resolve_user，Bad 异常统一 400/401/409）。密码 salt+sha256 混存，不存明文。
- wrangler.jsonc 新增 R2 绑定 `DATA` 指向 `fluentchat-data`（已 bucket create；私有 bucket，读写一律经 Worker）。用户数据位形：`{user}/hist/{persona}.json`（历史镜像）、`{user}/state.json`、`{user}/subs.json`，片 2 起用。
- worker.py：`/register /login /logout /me` 四条公开认证路由（_auth_route 壳，JSON 出错当空 body 给 Bad 打 400）；`/health`、`/push/pubkey` 豁免门外，其余全部业务路由要求登录（401 提示「请先登录」）。
- wrangler dev 全口径实测：healthy 公开 200；未登录 /token 401；短密码 400；注册种 cookie（HttpOnly+Secure+SameSite=Lax，一年）；重复注册 409；/me 带 cookie 识别「rice」；登出 Max-Age=0 当场过期；错密码 401 同口径不暴露用户名存在性。
- localStorage 历史照旧在线上跑（片 2 才接 R2 镜像 + 前端登录 UI）。

## 用户系统 · 片 2 前端（2026-10-23）
- 新增 `/hist/{unit}` GET/PUT（`_hist_route`）：unit 全白名单化（`[A-Za-z0-9_-]{1,64}`，路径穿越/`users.json` 同名覆盖全部 400），R2 位形 `{user}/hist/{unit}.json`，挂在登录门禁之后。
- index.html 登录/注册覆盖层 `.auth`（遮满全屏，卡片两个按钮：Sign in 主按钮 / Register 幽灵钮，错误行居中）；app.js boot 重构：先 `/me`，未登录 await showAuth，登录成功才 loadPeople 装联系人+朋友圈；initChat 保持启动即绑 DOM（只等 loadContacts 后才建列表）。
- live.js 镜像三处：pushHist 与 deliverProactive 后台落盘 均 fire-and-forget PUT 本地切片；openChat 本地 hist 空时 GET 云端补位（换设备/清缓存接续，本地为准原则只在本地空时读云）；resetChat 清本地 → `await mirrorHist` 把云端清成空表再重开，防止 GET 复活死聊天。
- wrangler dev 实测：登录态 PUT/GET 镜像原样往返；dana 拿不到 rice 的镜像（用户隔离）；怪物 unit 400；未登录 401。
- 待真机确认：覆盖层输入聚焦、iOS 键盘遮挡（下次真机过）。

