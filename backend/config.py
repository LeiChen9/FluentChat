"""纯配置：常量与白名单的唯一事实源，不含代码。

加新 Unit / 新 persona / 换声线，改这里即可，不用碰业务文件。
"""

# Gemini 接口地址
AUTH_TOKENS_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens"

# 已实测可用的 Live 模型。注意它不出现在 /v1beta/models 列表里，
# 所以别用那个列表选模型，列不出来不代表不能用。
MODEL = "gemini-3.8-live"

# 音色。已实测接受：Kore / Puck / Charon / Aoede / Zephyr / Laomedeia
VOICE = "Kore"

# 允许的 Unit 白名单。前端只能传这些 id，避免任意文件读取。
UNITS = {f"unit-{i:02d}" for i in range(1, 13)}

# Persona 好友（聊天列表）。prompt 是 prompts/personas/persona-*.md，
# 每人一条自己的声线 —— 见 prompts/personas.md 的声线速查表。
PERSONAS = {"persona-leo", "persona-chole", "persona-sam"}
VOICE_BY_ID = {
    "persona-leo": "Puck",    # Upbeat · 男
    "persona-chole": "Leda",  # Youthful · 女
    "persona-sam": "Umbriel", # Easy-going · 男
}

# 随 token 注入 system instruction 的历史：掐条数、掐单条长度，
# 免得请求体膨胀（也防前端传一堆垃圾进来）。
HIST_MAX_ITEMS = 30
HIST_MAX_CHARS = 400
