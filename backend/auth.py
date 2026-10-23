"""用户认证：注册 / 登录 / 登出，用户表落 R2 的 users.json。

模式抄自 argus/api_auth.py。20 人以内的私有服务：
- 密码 salt+sha256 混存（registry 只存盐水串，不存明文，也不还原）
- 会话身份靠 cookie（fluentchat_user=<用户名>）：登录时种、登出时清，
  浏览器每次请求自动带上。Max-Age 一年常驻，不用每次重开都登。
- 用户名约束同 argus：R2 key 是路径、cookie 要塞，留字母数字和 - _。
"""

import hashlib
import json
import re
import secrets

from workers import Response

USERS_KEY = "users.json"
COOKIE = "fluentchat_user_v1"

# R2 key 是路径，斜杠会把命名空间劈开；留白/怪字符会让 cookie 和 key 都难用。
_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,24}$")
MIN_PASSWORD = 6

_env = None


def bind_r2(env) -> None:
    """entrypoint 加载时注入 users.json 的 R2 环境。"""
    global _env
    _env = env


class Bad(Exception):
    def __init__(self, detail: str, status: int = 400):
        self.detail = detail
        self.status = status


async def load_users() -> dict:
    """读整张用户表。没建过就是空表（首次部署、注册第一个用户时）。"""
    if _env is None:
        return {}
    obj = await _env.DATA.get(USERS_KEY)
    if obj is None:
        return {}
    try:
        return json.loads(await obj.text())
    except Exception:
        # 读坏了当空表：让人能重新注册，而不是整个站都打不开。
        return {}


async def save_users(users: dict) -> None:
    await _env.DATA.put(USERS_KEY, json.dumps(users) + "\n")


def _digest(salt: str, password: str) -> str:
    return hashlib.sha256(f"{salt}:{password}".encode()).hexdigest()


def _cookie_header(value: str) -> dict:
    """Set-Cookie。SameSite=Lax 够同源站用；加上后端签 token 后推给 Chrome、
    Safari 线上就行。Max-Age 一年常驻；logout 用空值 + Max-Age=0 即当场过期。"""
    max_age = 31536000 if value else 0
    cookie = f"{COOKIE}={value}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax"
    return {"set-cookie": cookie}


async def register(body: dict) -> Response:
    name = (body.get("username") or "").strip()
    password = body.get("password") or ""
    if not _NAME_RE.match(name):
        raise Bad("用户名只能用字母数字和 - _，长度 1-24")
    if len(password) < MIN_PASSWORD:
        raise Bad(f"密码至少 {MIN_PASSWORD} 位")
    users = await load_users()
    if name in users:
        raise Bad("这个用户名已被注册", status=409)
    salt = secrets.token_hex(8)
    users[name] = {"salt": salt, "digest": _digest(salt, password)}
    await save_users(users)
    return Response.json({"ok": True, "user": name}, headers=_cookie_header(name))


async def login(body: dict) -> Response:
    name = (body.get("username") or "").strip()
    password = body.get("password") or ""
    users = await load_users()
    rec = users.get(name)
    # 用户名不存在与密码错误同一口径：别替别人确认了哪个用户名注册过。
    if not rec or rec.get("digest") != _digest(rec.get("salt", ""), password):
        raise Bad("用户名或密码不对", status=401)
    return Response.json({"ok": True, "user": name}, headers=_cookie_header(name))


async def logout() -> Response:
    return Response.json({"ok": True}, headers=_cookie_header(""))


def me(user: str) -> Response:
    return Response.json({"user": user})


async def resolve_user(request) -> str:
    """cookie → 用户名，且必须在 users.json 里查到（表读不到就用假户名也不进）。"""
    raw = request.headers.get("cookie") or ""
    for part in raw.split(";"):
        k, _, v = part.strip().partition("=")
        if k != COOKIE or not v:
            continue
        users = await load_users()
        return v if v in users else ""
    return ""
