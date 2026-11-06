# 后端回合认领的纯函数单测：脱 Worker 运行时，用 sys.modules 打桩 import worker。
# 覆盖: 认领按到达时刻排序、_prune_pending 只删旧回合未落定行、_reply_owed
# 屏幕最新是欠答用户消息就不让代打插话、写前判活动拒迟到旧回合。
# 跑法：python3 tools/test_backend_turns.py   (最后一行打印 BACKEND TURNS TEST PASS 即通过)
import sys
import os
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 桩掉 Cloudflare Workers 运行时：本文件只测与 env 无关的纯函数
workers = types.ModuleType("workers")
workers.Response = type("Response", (), {"json": staticmethod(lambda *a, **k: None)})
workers.WorkerEntrypoint = type("WorkerEntrypoint", (), {})
workers.fetch = lambda *a, **k: None
workers.wait_until = lambda *a, **k: None
asgi = types.ModuleType("workers.asgi")
asgi.run_in_background = lambda *a, **k: None
workers.asgi = asgi
sys.modules["workers"] = workers
sys.modules["workers.asgi"] = asgi

# backend.* 链里 config/common 不依赖 workers 运行时，直接导
import worker  # noqa: E402

# ── _prune_pending：只删指定 bid 的 pending 行，已落定行保留 ──
rows = [
    {"who": "ai", "text": "a", "t": 1, "bid": "X", "pending": False},
    {"who": "ai", "text": "b", "t": 2, "bid": "Y", "pending": True},
    {"who": "ai", "text": "c", "t": 3, "bid": "Y", "pending": True},
    {"who": "ai", "text": "d", "t": 4, "bid": "Z", "pending": True},
]
pruned = worker._prune_pending(rows, "Y")
assert [r["text"] for r in pruned] == ["a", "d"], pruned
assert worker._prune_pending(rows, "no-such") == rows
print("✓ _prune_pending 只回收旧回合未落定行")

# ── _reply_owed：屏幕最新一条是谁决定 ──
assert not worker._reply_owed([])
assert worker._reply_owed([{"who": "me", "t": 10, "text": "x"},
                           {"who": "ai", "t": 5, "text": "y"}])  # me 最新
assert not worker._reply_owed([{"who": "me", "t": 5, "text": "x"},
                              {"who": "ai", "t": 10, "text": "y"}])  # ai 最新
# 欠答前又冒出未落定预写：pending 行不算屏幕最新，仍是 me 欠着
assert worker._reply_owed([{"who": "me", "t": 10, "text": "x"},
                          {"who": "ai", "t": 12, "pending": True, "text": "p"}])
print("✓ _reply_owed 判定屏幕最新是否欠回复")

# ── _turn_rec：缺省/坏形都退成 [None, 0] ──
assert worker._turn_rec({}, "u") == [None, 0]
assert worker._turn_rec({"activeTurn": {"u": ["B", 99]}}, "u") == ["B", 99]
assert worker._turn_rec({"activeTurn": {"u": "junk"}}, "u") == [None, 0]
print("✓ _turn_rec 兜住缺省/坏形")


# ── 端到端认领链（env 桩 + fake clock）──
class FakeData:
    def __init__(self): self.store = {}
    async def get(self, k):
        if k not in self.store: return None
        v = self.store[k]
        return types.SimpleNamespace(text=lambda: _aret(v))
    async def put(self, k, v): self.store[k] = v


def _aret(v):
    async def _t(): return v
    return _t()


class FakeEnv:
    def __init__(self): self.DATA = FakeData()


def patch_time(seq):
    """给 cloud_npc.now_ms 发一串递进时刻，仿两次到达。"""
    from backend import cloud_npc
    it = iter(seq)
    cloud_npc.now_ms = lambda: next(it)


async def main():
    env = FakeEnv()
    u, unit = "alice", "persona-sam"
    hist = [
        {"who": "me", "t": 1, "text": "m1"},
        {"who": "ai", "t": 2, "bid": "BID1", "pending": True, "text": "a1"},  # 未落定
    ]
    await worker._save_hist(env, u, unit, hist)

    # 回合1：BID1 已认领
    patch_time([100])
    await worker._claim_turn(env, u, unit, "BID1", 100)

    # 回合2：BID2 后到上位，回收 BID1 未落定预写
    patch_time([200])
    prev = await worker._claim_turn(env, u, unit, "BID2", 200)
    assert prev == "BID1", prev
    h = await worker._load_hist(env, u, unit)
    hp = worker._prune_pending(h, prev)
    await worker._save_hist(env, u, unit, hp)
    assert not any(r.get("bid") == "BID1" and r.get("pending") for r in hp)

    # 写前判活动：BID1 已不活动 → 拒
    assert not await worker._is_active_turn(env, u, unit, "BID1")
    assert await worker._is_active_turn(env, u, unit, "BID2")
    print("✓ 认领按到达时刻上位 + 回收旧未落定 + 写前判活动")

    # 迟到的旧请求墙钟更大，但 at 用的是"到达时刻"入参——模拟错时到达仍拒
    patch_time([9999])
    await worker._claim_turn(env, u, unit, "BID2", 250)  # 重放：仍是最新
    assert await worker._is_active_turn(env, u, unit, "BID2")
    # BID1 迟到执行但 at=99 < 200：_turn_merge 取新 → 不夺位
    await worker._claim_turn(env, u, unit, "BID1", 99)
    assert await worker._is_active_turn(env, u, unit, "BID2"), \
        "旧回合用更小 at 迟到不得夺位"
    print("✓ 迟到旧回合(at 更小)经 save_state 合并不夺新回合位")


import asyncio
asyncio.run(main())
print("BACKEND TURNS TEST PASS")
