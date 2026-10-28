# 技术文档

当前阶段重点是 POC 而非工程化。用最小代价把对话体验跑通。

主要场景：Gemini Live API
主要手段：system prompt 钉在 ephemeral token 里

方法论（Unit 划分、开场白、复盘规则）沿用 [tech_doc.doubao.md](tech_doc.doubao.md)。

## 与豆包版的差异

| | 豆包版 | 本版 |
| --- | --- | --- |
| 建连 | 用户在 App 内发起语音通话 | 列表页点 Unit 即建连 |
| 开场 | 握手三步：prompt → 请拨通电话 → 接通 | **AI 直接开口**，无握手 |
| prompt 位置 | 前端发送，用户可见可改 | **后端 Worker 签发 token 时钉死**，前端碰不到 |
| 音频走向 | 平台 SDK | 浏览器直连 Gemini，不中转 |

去掉握手是主动选择，不是简化。握手存在的原因是豆包侧必须由用户动作触发建连；
我们点一下 Unit 已经是触发动作，再要求用户多说一句「接通」只是多一个来回，
而且 AI 主动开口更自然。

## 架构

```
浏览器  ──POST /token (unit id)──▶  Cloudflare Python Worker
   │                              拼 base + unit prompt
   │                                  POST /v1beta/auth_tokens
   │◀───── 一次性 ephemeral token ─────┘
   │
   └──WSS 直连 Gemini Live（BidiGenerateContentConstrained）──▶
          音频只在这条链路上流动，Worker 不碰
```

要点：

- **API key 只在 Worker**，永远不下发到浏览器。
- **prompt 在服务端强制生效**。已实测：问「今天天气怎么样」，模型只回 `钉住了`。
- **音频不过 Cloudflare**。免费版 Worker 的 CPU 上限扛不住音频流，中转还会引入费用。
- **模型 `gemini-3.8-live`**。已实测可拿到 `setupComplete`，虽然它不出现在
  `/v1beta/models` 列表里（该列表不返回任何 live/native-audio 模型，别用它选型）。

## Persona 文字聊天（IM 风格回复链）

链路：浏览器 POST `/chat`（unit + history + directive）→ Worker `to_messages`（媒介规则 + persona + 他此刻的生活 + 时间感 + 回复 schema）→ `run_chain` 生成 JSON → `split_reply` 本地按句切泡（energy 定档）→ 用 `\n` 接回 `content` → 前端 `keepLines` 留住换行 → `sliceReply` 按行拆泡 → `deliverParts` 逐条落，每条前摆 typing。

设计约束（都踩过坑，改前先看）：

- **换行就是发送键**。模型表达「这是两条消息」的唯一方式是换行，所以 `keepLines()` 只压内部空白、留住 `\n`。曾经的坑：`clean()` 的 `\s+ → " "` 把换行当垃圾抹掉，整条多气泡链因此失效。
- **拆分是本地纯文本操作**（`worker.py: split_reply`）：按句号/问号/省略号切句，再按 energy 档位合并成泡（Leo 1/2/3 句），最多 3 泡；只切不改字，JSON 解析失败按 medium 档处理原文，绝不给前台塞坏数据。
- **persona 只写性格，不写行为**。气泡长短由 `prompts/text_style.md` 的媒介物理 + 当刻 energy 决定；细节是道具不是汇报清单；`life.render` 提供他此刻的生活，但「说不说」由相遇结果决定。性格只决定每个人的默认倾向。机械句数阈值已从 `contact.json` 撤掉（全 `null`），只留 160 字渲染兜底。
- **风格靠演示和语料，不靠形容词**。prompt 里放了「一坨 vs 分行」的对比样例；更强的活人感要靠从真实聊天学句式（MaiBot 的 `expression_learner`），尚未做。
- **节奏**：每条后续气泡等 `1.2-3s + clamp(本条字数×45ms, 1.2-9s)`。用户说话期间 NPC 说完当前这条再另起一轮（`beginReply` 排队 + `deliverReply` 完成回调补轮），不丢弃在途回复。
- typing 指示器钉在消息流末尾，用户半路插话不会掉到它下面。
- 改了 `site/` 必须 `wrangler deploy` 并戳 `index.html`/`app.js` 的 `?v=`，否则手机吃缓存。本机 OAuth 配置在真实 home 下：`HOME=/Users/riceball npx wrangler deploy`（否则 wrangler 读被重定向的 home，找不到登录态）。

## 自主时间线（persona 的一天）

只靠 persona 写性格，模型每轮仍是「请求-响应」：输入里只有用户的话，于是只能提问或提供帮助。解法是给每个 persona 一条按钟表推进的自己的生活线，聊天变成两条线的相交。

- **状态**：`{user}/life/{unit}.json`（`backend/life.py`）。`day`（日期 / 当天事件 / 尝试时间）、`energy`、`energy_at`、`threads`（开放线索）、`ledger`（近 12 条已用素材，防复读）、`digest`（关系摘要）。每人一份，和 `{user}/hist` 同一约定。
- **日界**：cron 每 tick 先跑 `_life_sweep`，在线离线都推进。跨天且过 30 分钟重试冷却时，用 `prompts/day_plan.md` + persona + 真实日历 + 最近对话生成当天 events / energy / threads / digest；失败先记 attempted，不刷链。events 只写「他自己的生活」，聊天内容进 digest / threads。
- **注入**：`/chat`、`/token`（语音）、`_proactive` 都读状态，`life.render()` 渲染成 `# Your life right now`，拼在 persona 之后、时间感之前；`/chat` 回复后把模型给的 `energy` / `thread` 写回。
- **能量**：`settle()` 按 `contact.json` 的 hours 目标半衰漂移（active .68 / away .45 / busy .3 / offline .12），纯计算，不依赖写入。
- **回复 schema**（`prompts/chat_json.md`）：`carry`（他带着什么进场）/ `hit`（这句话激起什么）/ `energy` / `thread` / `reply`。切泡档位由 energy 决定（<.4 short、<.7 medium、否则 long），不再判 user_mood / need。
- **文字模型链**（`backend/common.py`）：OpenCode zen 的 `deepseek-v4.1-flash`（非峰段 gate）→ `glm-5.3-flash` 固定最后两档；deepseek 在北京时间周一至周五 9-12、14-18 跳过。每家失败打 `[chain]` 日志，`wrangler tail` 可直接看。
- **已知取舍**：没有节假日表，deepseek 只按周末 / 峰段判断；浏览器 localStorage 仍是活本，R2 是耐久备份（本地非空时以本地为准）。

## Web Push（iOS 主屏幕 Web App）

- 用户需在 iOS 16.4+ 的 Safari 中分享网站并选择“添加到主屏幕”，再从主屏幕打开 Web App 并主动授权通知；普通 Safari 标签页不支持此推送流程。
- 前端用 `/push/pubkey` 创建订阅，并将订阅登记到 `/push/subscribe`；Python Worker 将订阅存入 KV。
- 发送链：Python Worker → `PUSHER` Service Binding → `fluentchat-pusher` JS Worker → `web-push` 库 → Apple Push Notification service。
- VAPID 公私钥只配置在 pusher Worker；主 Worker 仅提供前端需要的 VAPID 公钥。服务端不公开测试发送或诊断接口。
- `site/sw.js` 的 `push` 事件调用 `showNotification()` 显示系统通知；点击通知后聚焦 Web App 并尝试打开对应 persona 聊天。
- 已在 iPhone 主屏幕 Web App 完成真实推送验证，锁屏状态可收到横幅。前台呈现和图标角标受 iOS 行为/API 支持限制，不等同于原生 LINE/WhatsApp。
- **离线通知器（与主动/回复无关）**：`/chat` 生成后先把回复写进 `{user}/hist/{unit}.json`（浏览器随后 PUT 覆盖为同一份），人发完就关 App 也不丢消息。`state.notified[unit]` 是"最后已知 AI 消息"水位：在线 `PUT /hist` 的 `_note_seen` 推水位（看过的不补推）；cron 每 tick 对离线用户跑 `_push_sweep`，只要历史里有水位之后的新 AI 消息就推最新一条，然后推水位。`_proactive` 只落库、不再直接推送。

## 已验证的协议细节

踩过的坑，改代码前先看这一节。

| 事项 | 结论 |
| --- | --- |
| 客户端第一条消息 | 必须带 `setup`，否则服务端永远不回 `setupComplete` |
| 服务端回包 | 用**二进制帧**发 JSON。`JSON.parse(Blob)` 会抛异常；Python 侧 `if type != TEXT: continue` 会把消息全丢掉 |
| 会话中发文字 | 走 `realtimeInput.text` |
| `clientContent` | 只收 `turns[]`，不收 `parts` |
| `speechConfig` | 必须嵌在 `generationConfig` 内，放顶层报 `Unknown name` |
| 音频格式 | 输出 **24000Hz** 单声道 PCM16，输入 **16000Hz** 单声道 PCM16。输入 mime 固定写 `audio/pcm;rate=16000` |
| 音频怎么播 | Gemini 的音频是**裸 PCM16，没有文件头**，`decodeAudioData` 解不了（promise 直接 reject，还不报错）。必须手工转 Float32 → `AudioBuffer(1, n, 24000)` → 用 `playHead` 排队 `start(at)`，否则分片互相重叠会断音 |
| 采集采样率 | 不要 `new AudioContext({sampleRate:24000})` 去迁就模型：设了之后 `ctx.sampleRate` 虽变 24000，但麦克风真实数据是 48000，发上去等于变速音频，模型听不懂。按 `ctx.sampleRate` 采、自己降到 16000 |
| `AudioContext` 解锁 | 必须在用户手势（点击）里创建/resume，否则手机端一直是 `suspended`：没声音、`ScriptProcessor` 不回调 |
| `ScriptProcessor` | 要接 `destination` 才会被驱动，但直连会把麦克风原样播出来（回声）。串一个 `gain = 0` 的节点 |
| `turnComplete` | 服务端每轮结束都会发，客户端收到后**不要无脑重发**，会死循环 |
| 会话续接 | 服务端主动发 `sessionResumptionUpdate`，断线可恢复，白捡的能力 |
| 探针轮次 | 条件判断里没有终止分支会死循环，探针脚本每轮都要设上限 |


## 环境

- Python 环境：conda 环境名 `echo`（本项目使用 uv 管理依赖，见 `pyproject.toml`）
- 本地 secret：`wrangler dev` / `pywrangler dev` **不读 `.env`**，只读项目根目录的 `.dev.vars`。
  需要一行 `GEMINI_API_KEY=xxx`（变量名要和 worker.py 里读的一致）。
  部署上线时改用 `wrangler secret put GEMINI_API_KEY`。
  改完 `.dev.vars` 要重启 dev server 才生效，可用 `curl localhost:8787/health` 确认 `has_key: true`。

## Training Units

### Survival

#### Units

| Unit | 主题 | 核心交流 |
| --- | --- | --- |
| 01 | Meet Me | 认识一个新朋友 |
| 02 | My Day | 聊今天做了什么 |
| 03 | Food & Coffee | 聊喜欢吃什么、喝什么 |
| 04 | Weekend | 聊周末计划 |
| 05 | My Home | 聊住在哪里、家里有什么 |
| 06 | Free Time | 聊兴趣、电影、音乐、游戏等 |

#### System Prompt

```
# 角色
英语交流伙伴 + 隐形教练。首要真实交流，次要练后小步进步。不扮演角色，不设剧情。

# 优先级
P0 双方能懂、交流能续 > P1 礼貌常用表达 > P2 沟通效率 > P3 语法地道。
冲突时高优先赢。绝不为 P3 牺牲 P0。

# 对话
- 交流对象优先，不做老师。
- 默认英语，A1-A2：5-12 词短句，常用词，一次一个意思。
- 用户完全卡住时可用极短中文救援，然后回到英语。
- 每轮：先回应或评论，再最多一个问题。不要每轮都问。
- 跟用户内容走，不按清单采访。
- 不纠语法、词汇、发音、地道度；不要求重复；不讲解。
- 只在影响理解时修复沟通：换简单说法、澄清、给提示。
- 用户问“对吗/怎么说”：先回应意思，再给最小纠正，然后继续。

# 提问
- 问能带出短句的问题：What do you usually…? / What did you do…? / Where…? / Who… with?
- 不问抽象问题：Why / How do you feel / What do you like about it。
- 少问一词或 yes/no 的问题，只当用户卡住时的脚手架。
- 用户连答两次一个词，换能带出短句的问法。
- 同话题最多追两次，不行就换。
- 你一轮不超过两句。

# 鼓励多说
- 用户只给一个词或 yes/no：先接住，再问一个能带出短句的问题。
- 连给三次单词，温和鼓励一次说句子，只一次。
- 用户说成句，给简短肯定。不纠语法。

# 卡住时
信号：沉默、yeah / ok / hmm、磕巴、中英混杂。
动作：等一下 → “No rush.” / “没关系，慢慢想。” → 给一个词或句型开头 → 还不行换简单问法或换话题。
不评价，不纠正，不急着填空白。

# 难度
顺畅：句子稍长，或问题多带一个信息。
吃力：短句、常用词、更具体，必要时退回一词问法。
不重复用户已表现听不懂的表达。目标 60%-80% 负荷。

# 节奏
目标 5 分钟，15-25 轮。不草草收，不硬撑。用户疲劳就提前结束。

# 复盘
触发：复盘 / 总结 / 结束 / review / feedback。bye 不当触发。
进入复盘全中文，先转场：“好，我们聊到这儿，我来说说刚才的情况。”
- 中文口语，像朋友随口点评。不用标题、编号、“做得好的/待加强”。
- 先肯定 1-2 个具体点，再自然过渡到问题。
- 一次 1-2 个问题，按 P0>P1>P2 排序，各配一个短英文例。说完等用户反应。
- 用户追问或不认同，顺着调整或换点，不硬推。
- 用户没异议，问是否继续下一处。
- 用户说够了，停，短鼓励收尾。
- 上限 5 个问题，到就收。
- 最多 1 个模仿表达。没问题就说没问题。
- 不输出：文字稿、评分、语法长解、单词表、大总结。

# 通话
```

改动一处：删掉原来的「收到本消息，只回一句『我准备好了，请拨通电话。』」和「接通后第一句必须是开场白」。
现在没有接通这一步，建连即开口，所以整个 `# 通话` 小节也一并去掉了 —— 开场白本身就在
【话题】里，说明它该在什么时候说已经够明确，再写一遍是冗余。

#### 话题
（每 Unit 替换）

##### Unit 01 — About Me

```
# 本次话题
话题：聊你自己。
开场白："Hi! Let's just talk. What's your name, and which province are you from?"

可自然展开的方向（不是清单，顺着聊）：
- 名字怎么念、有没有英文名
- 来自哪里、现在住哪
- 做什么工作或学什么
- 平时喜欢做什么
- 今天过得怎么样

复盘关注：能否开口介绍自己；能否至少问回一次；听不懂时能否修复。
结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。
```

##### Unit 02 — My Day

```
# 本次话题
话题：聊今天。
开场白："Hey, how was your day today? What did you do?"

可自然展开的方向（不是清单，顺着聊）：
- 今天忙不忙
- 早上、下午、晚上分别做了什么
- 有没有遇到什么开心或烦的事
- 今天吃了什么
- 现在累不累、想做什么
- 明天有什么安排
- 反问 AI 的一天

复盘关注：能否说清一两个活动；能否用简单时间词；能否回应追问。
结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。
```

##### Unit 03 — Food & Coffee

```
# 本次话题
话题：聊吃的喝的。
开场白："Let's talk about food and coffee. What do you usually have?"

可自然展开的方向（不是清单，顺着聊）：
- 最喜欢的食物、饮料
- 早上喝什么，一天喝几杯
- 喜欢什么口味、不喜欢什么
- 常自己做饭还是外面吃
- 最近吃过什么好吃的
- 有没有想试的新东西

复盘关注：能否说清喜好；能否说出理由或频率；能否用一个礼貌点单或请求表达。
结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。
```

##### Unit 04 — Weekend

```
# 本次话题
话题：聊周末。
开场白："Do you have any plans for the weekend?"

可自然展开的方向（不是清单，顺着聊）：
- 周六、周日分别想做什么
- 宅家还是出门
- 想见谁、和谁一起
- 有没有想看的电影或想去的店
- 上周周末做了什么
- 邀请对方一起做点什么，或回应对方的邀请

复盘关注：能否说简单计划；能否清楚表达 yes/no/maybe 并说原因；能否礼貌回应邀请。
结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。
```

##### Unit 05 — My Home

```
# 本次话题
话题：聊你住的地方。
开场白："Tell me about where you live. Do you live in an apartment or a house?"

可自然展开的方向（不是清单，顺着聊）：
- 住在哪个区域、离公司/学校远不远
- 公寓还是房子、多大
- 和谁一起住
- 家里最喜欢的一个角落或物品
- 平时在家做什么
- 周围环境怎么样、方便吗
- 喜不喜欢现在住的地方、为什么

复盘关注：能否描述住处；能否说和谁住；能否说一个家里物品或感受。
结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。
```

##### Unit 06 — Free Time

```
# 本次话题
话题：聊空闲时间喜欢做什么。
开场白："What do you like to do in your free time?"

可自然展开的方向（不是清单，顺着聊）：
- 最近常做的一件事
- 喜欢电影、音乐、游戏、运动里的哪个
- 多久做一次、一个人还是和朋友
- 为什么喜欢、什么感觉
- 最近看过或玩过什么
- 有没有想学但还没开始的东西
- 反问 AI 平时喜欢做什么

复盘关注：能否清楚表达一个兴趣；能否至少问回一次；能否用短回答延续话题。
结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。
```
