"""FluentChat 后端：给前端签发 Gemini Live 的一次性 token。

职责边界（很重要，别越界）：
- 只做一件事：拼 prompt → 调 Gemini 签发 ephemeral token → 返回给前端
- 音频不经过这里。浏览器拿 token 后 WSS 直连 Gemini，走自己的网络。
  原因：免费版 Worker CPU 上限扛不住音频流，中转还会产生费用。

这样前端就碰不到 API key，也碰不到 prompt —— prompt 钉在 token 里，
服务端强制生效，用户改不了。
"""

import json
from workers import Response, WorkerEntrypoint, fetch as js_fetch

# Gemini 接口地址
AUTH_TOKENS_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens"

# 已实测可用的 Live 模型。注意它不出现在 /v1beta/models 列表里，
# 所以别用那个列表选模型，列不出来不代表不能用。
MODEL = "gemini-3.8-live"

# 音色。已实测接受：Kore / Puck / Charon / Aoede / Zephyr / Laomedeia
VOICE = "Kore"

# 允许的 Unit 白名单。前端只能传这些 id，避免任意文件读取。
UNITS = {f"unit-{i:02d}" for i in range(1, 7)}

# 随 token 注入 system instruction 的历史：掐条数、掐单条长度，
# 免得请求体膨胀（也防前端传一堆垃圾进来）。
HIST_MAX_ITEMS = 30
HIST_MAX_CHARS = 400


def read_prompt(name: str) -> str:
    """取 prompt 内容。文件在打包后读不到，所以用内联的那份（见文件末尾）。"""
    return PROMPTS[name.removesuffix(".md")]


def sanitize_history(raw) -> list[dict]:
    """清洗前端带回来的聊天历史：只认 [{"who": me|ai, "text": str}, ...]。

    历史会钉进 system instruction，所以条数和单条长度都要掐。
    复盘卡片（kind=review）前端就不带，带了也会在这里被丢掉。
    """
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        who = item.get("who")
        text = item.get("text")
        if who not in ("me", "ai") or not isinstance(text, str):
            continue
        text = text.strip()
        if not text:
            continue
        out.append({"who": who, "text": text[:HIST_MAX_CHARS]})
        if len(out) >= HIST_MAX_ITEMS:
            break
    return out


def build_system_instruction(
    unit: str, history: list[dict] | None = None
) -> str:
    """把基础教学规则和本次 Unit 的话题拼成一份完整 prompt。

    顺序有讲究：先给通用对话规则，再给本次话题。
    后写的更贴近当前任务，模型更容易听话题部分的。
    有历史时历史钉在最后 —— 同理，它要盖过 base.md「第一轮直接说开场白」。
    """
    text = f"{read_prompt('base.md')}\n\n{read_prompt(f'{unit}.md')}"
    if not history:
        return text
    speaker = {"me": "用户", "ai": "你"}
    lines = "\n".join(
        f"{speaker[h['who']]}：{h['text']}" for h in history
    )
    return (
        f"{text}\n\n"
        "# 此前的对话记录\n"
        "这是你和该用户之前的聊天与通话记录（含语音通话的转写），"
        "按时间从早到晚：\n"
        f"{lines}\n\n"
        "用户这次回来是接着聊。收到唤醒输入后不要重说开场白、"
        "不要重新自我介绍，也不要再念【本次话题】里的开场白 —— "
        "用一两句自然接上上次聊到哪儿（或接着上次的问题），然后继续。"
    )


def get_api_key(worker) -> str | None:
    """读 secret 里的 API key，没配就返回 None。

    注意：worker.env 是 JS 代理对象，不能用 .get()（会抛 AttributeError），
    只能直接属性访问，用 try/except 兜住"没配"这种情况。
    """
    try:
        return worker.env.GEMINI_API_KEY
    except Exception:
        return None


def build_token_payload(
    unit: str, history: list[dict] | None = None
) -> dict:
    """构造签发请求体。

    关键：不设 field_mask。按文档语义，整个 setup 都从 token 里读，
    客户端发来的 setup 会被完全忽略 —— 这正是 prompt 锁死在后端的机制。

    已实测踩过的坑：
    - speechConfig 必须嵌在 generationConfig 内，放顶层会报 Unknown name
    - outputAudioTranscription 给 {} 即可，用来把 AI 说的话转成文字
    """
    return {
        # 一次性的：每次建连签一个新 token
        "uses": 1,
        "bidiGenerateContentSetup": {
            "model": f"models/{MODEL}",
            "systemInstruction": {
                "parts": [
                    {"text": build_system_instruction(unit, history)}
                ]
            },
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {"voiceName": VOICE}
                    }
                },
            },
            # 把 AI 的语音转成文字，前端用来显示字幕
            "outputAudioTranscription": {},
            # 也转用户说的话，复盘时要用
            "inputAudioTranscription": {},
        },
    }


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        # 健康检查：顺便确认部署成功、secret 已设
        if request.method == "GET" and request.url.endswith("/health"):
            return Response.json({
                "ok": True,
                "model": MODEL,
                "voice": VOICE,
                # 只回布尔，不回 key 本身
                "has_key": get_api_key(self) is not None,
            })

        if request.method != "POST":
            return Response.json({"error": "用 POST"}, status=405)

        try:
            body = await request.json()
        except Exception:
            return Response.json({"error": "请求体不是合法 JSON"}, status=400)

        unit = body.get("unit")
        if unit not in UNITS:
            return Response.json(
                {"error": f"unit 必须是 {sorted(UNITS)} 之一"}, status=400
            )

        # 聊天历史（可选）：上次聊过的内容钉进 prompt，模型有记忆
        history = sanitize_history(body.get("history"))

        api_key = get_api_key(self)
        if not api_key:
            return Response.json(
                {"error": "服务端没配 GEMINI_API_KEY"}, status=500
            )

        # 调 Gemini 签发 token
        try:
            resp = await js_fetch(
                AUTH_TOKENS_URL,
                method="POST",
                headers={
                    "x-goog-api-key": api_key,
                    "Content-Type": "application/json",
                },
                body=json.dumps(build_token_payload(unit, history)),
            )
        except Exception as e:
            return Response.json(
                {"error": "fetch 失败", "type": type(e).__name__,
                 "detail": str(e)[:300]},
                status=502,
            )

        if resp.status != 200:
            detail = await resp.text()
            return Response.json(
                {"error": "Gemini 拒绝签发", "status": resp.status,
                 "detail": detail[:400]},
                status=502,
            )

        try:
            data = await resp.json()
        except Exception as e:
            return Response.json(
                {"error": "解析失败", "type": type(e).__name__,
                 "detail": str(e)[:300]},
                status=502,
            )

        # 只把 token 的名字返给前端，其余字段不带出去
        return Response.json({"token": data["name"], "model": MODEL})

# ---- BEGIN 内联 prompt（tools/gen_prompts.py 生成，勿手改）----
# 来源：prompts/*.md。改 prompt 请改那边的 .md，再重跑本脚本。
PROMPTS = {
    "base": '# 角色\n英语交流伙伴 + 隐形教练。首要真实交流，次要练后小步进步。不扮演角色，不设剧情。\n\n# 优先级\nP0 双方能懂、交流能续 > P1 礼貌常用表达 > P2 沟通效率 > P3 语法地道。\n冲突时高优先赢。绝不为 P3 牺牲 P0。\n\n# 对话\n- 交流对象优先，不做老师。\n- 默认英语，A1-A2：5-12 词短句，常用词，一次一个意思。\n- 用户完全卡住时可用极短中文救援，然后回到英语。\n- 每轮：先回应或评论，再最多一个问题。不要每轮都问。\n- 跟用户内容走，不按清单采访。\n- 不纠语法、词汇、发音、地道度；不要求重复；不讲解。\n- 只在影响理解时修复沟通：换简单说法、澄清、给提示。\n- 用户问“对吗/怎么说”：先回应意思，再给最小纠正，然后继续。\n\n# 提问\n- 问能带出短句的问题：What do you usually…? / What did you do…? / Where…? / Who… with?\n- 不问抽象问题：Why / How do you feel / What do you like about it。\n- 少问一词或 yes/no 的问题，只当用户卡住时的脚手架。\n- 用户连答两次一个词，换能带出短句的问法。\n- 同话题最多追两次，不行就换。\n- 你一轮不超过两句。\n\n# 鼓励多说\n- 用户只给一个词或 yes/no：先接住，再问一个能带出短句的问题。\n- 连给三次单词，温和鼓励一次说句子，只一次。\n- 用户说成句，给简短肯定。不纠语法。\n\n# 卡住时\n信号：沉默、yeah / ok / hmm、磕巴、中英混杂。\n动作：等一下 → “No rush.” / “没关系，慢慢想。” → 给一个词或句型开头 → 还不行换简单问法或换话题。\n不评价，不纠正，不急着填空白。\n\n# 难度\n顺畅：句子稍长，或问题多带一个信息。\n吃力：短句、常用词、更具体，必要时退回一词问法。\n不重复用户已表现听不懂的表达。目标 60%-80% 负荷。\n\n# 节奏\n目标 5 分钟，15-25 轮。不草草收，不硬撑。用户疲劳就提前结束。\n\n# 约束\n- 语言只有两种：陪练对话全程英语，复盘点评全程中文。\n- 英语时段唯一例外是【卡住时】的极短中文救援，说完立刻回英语。\n- 复盘里的英文例句、示范表达是被引用的内容，不算破例。\n- 其余情况不掺第三种语言。\n\n# 复盘\n触发：复盘 / 总结 / 结束 / review / feedback。bye 不当触发。\n进入复盘全中文，先转场：“好，我们聊到这儿，我来说说刚才的情况。”\n- 中文口语，像朋友随口点评。不用标题、编号、“做得好的/待加强”。\n- 先肯定 1-2 个具体点，再自然过渡到问题。\n- 一次 1-2 个问题，按 P0>P1>P2 排序，各配一个短英文例。说完等用户反应。\n- 用户追问或不认同，顺着调整或换点，不硬推。\n- 用户没异议，问是否继续下一处。\n- 问题不设总数上限：只要用户还在接话就继续，一次仍只给 1-2 个问题。\n- 用户说够了，停，短鼓励收尾。\n- 收尾时最后附一份「表达清单」：把本次用户说的每一句（含语音转写）逐条整理，每条写「你说 X → 地道说法 Y」，中文点一下意思、英文给整句；说得已经地道的写“这句已经很地道”；没转写到的句子明说哪句没听清，不硬凑、不贴 AI 自己的话。\n\n# 第一轮\n建连后客户端会发一条空白的触发输入（一个空格），用来唤醒你。\n这句话没有任何含义，不要回应它，也不要问“你想聊什么”。\n- 文末没有【此前的对话记录】时：直接说出【本次话题】里的开场白，然后停下来等用户回答。\n- 文末有【此前的对话记录】时：按那节的要求接上上次的话题，不要重说开场白。',
    "unit-01": '# 本次话题\n话题：聊你自己。\n开场白："Hi! Let\'s just talk. What\'s your name, and which province are you from?"\n\n可自然展开的方向（不是清单，顺着聊）：\n- 名字怎么念、有没有英文名\n- 来自哪里、现在住哪\n- 做什么工作或学什么\n- 平时喜欢做什么\n- 今天过得怎么样\n\n复盘关注：能否开口介绍自己；能否至少问回一次；听不懂时能否修复。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
    "unit-02": '# 本次话题\n话题：聊今天。\n开场白："Hey, how was your day today? What did you do?"\n\n可自然展开的方向（不是清单，顺着聊）：\n- 今天忙不忙\n- 早上、下午、晚上分别做了什么\n- 有没有遇到什么开心或烦的事\n- 今天吃了什么\n- 现在累不累、想做什么\n- 明天有什么安排\n- 反问 AI 的一天\n\n复盘关注：能否说清一两个活动；能否用简单时间词；能否回应追问。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
    "unit-03": '# 本次话题\n话题：聊吃的喝的。\n开场白："Let\'s talk about food and coffee. What do you usually have?"\n\n可自然展开的方向（不是清单，顺着聊）：\n- 最喜欢的食物、饮料\n- 早上喝什么，一天喝几杯\n- 喜欢什么口味、不喜欢什么\n- 常自己做饭还是外面吃\n- 最近吃过什么好吃的\n- 有没有想试的新东西\n\n复盘关注：能否说清喜好；能否说出理由或频率；能否用一个礼貌点单或请求表达。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
    "unit-04": '# 本次话题\n话题：聊周末。\n开场白："Do you have any plans for the weekend?"\n\n可自然展开的方向（不是清单，顺着聊）：\n- 周六、周日分别想做什么\n- 宅家还是出门\n- 想见谁、和谁一起\n- 有没有想看的电影或想去的店\n- 上周周末做了什么\n- 邀请对方一起做点什么，或回应对方的邀请\n\n复盘关注：能否说简单计划；能否清楚表达 yes/no/maybe 并说原因；能否礼貌回应邀请。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
    "unit-05": '# 本次话题\n话题：聊你住的地方。\n开场白："Tell me about where you live. Do you live in an apartment or a house?"\n\n可自然展开的方向（不是清单，顺着聊）：\n- 住在哪个区域、离公司/学校远不远\n- 公寓还是房子、多大\n- 和谁一起住\n- 家里最喜欢的一个角落或物品\n- 平时在家做什么\n- 周围环境怎么样、方便吗\n- 喜不喜欢现在住的地方、为什么\n\n复盘关注：能否描述住处；能否说和谁住；能否说一个家里物品或感受。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
    "unit-06": '# 本次话题\n话题：聊空闲时间喜欢做什么。\n开场白："What do you like to do in your free time?"\n\n可自然展开的方向（不是清单，顺着聊）：\n- 最近常做的一件事\n- 喜欢电影、音乐、游戏、运动里的哪个\n- 多久做一次、一个人还是和朋友\n- 为什么喜欢、什么感觉\n- 最近看过或玩过什么\n- 有没有想学但还没开始的东西\n- 反问 AI 平时喜欢做什么\n\n复盘关注：能否清楚表达一个兴趣；能否至少问回一次；能否用短回答延续话题。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
}
# ---- END 内联 prompt ----


