"""Pure Moments tests: no Workers runtime, no D1. Run:
python3 tools/test_moments.py  (last line: MOMENTS TEST PASS)
"""
import asyncio
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import moments  # noqa: E402


class Rows:
    def __init__(self, rows):
        self.results = rows


class Stmt:
    def __init__(self, db, sql):
        self.db, self.sql, self.args = db, sql, ()

    def bind(self, *args):
        self.args = args
        return self

    async def run(self):
        self.db.execute(self.sql, self.args)
        self.db.commit()
        return self

    async def first(self):
        cur = self.db.execute(self.sql, self.args)
        row = cur.fetchone()
        return dict(row) if row else None

    async def all(self):
        cur = self.db.execute(self.sql, self.args)
        return Rows([dict(r) for r in cur.fetchall()])


class DB:
    def __init__(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.executescript(open("schema.sql").read())

    def prepare(self, sql):
        return Stmt(self.db, sql)


class Env:
    def __init__(self):
        self.DB = DB()


async def main():
    env = Env()
    rows = await moments.feed(env, "u1", 0, 20)
    assert len(rows) == 4, rows
    assert [r["unit"] for r in rows] == [
        "persona-leo", "persona-chole", "persona-sam", "persona-Fiona"]
    print("✓ seed / feed order")

    post = await moments.create_post(env, "u1", "  my   first post  ")
    assert post and post["text"] == "my first post"
    assert (await moments.feed(env, "u1", 0, 20))[0]["id"] == post["id"]
    assert all(r["id"] != post["id"] for r in await moments.feed(env, "u2", 0, 20))
    assert not await moments.visible_post(env, post["id"], "u2")
    print("✓ post create / user isolation")

    assert await moments.toggle_like(env, "u1", post["id"]) is True
    assert await moments.toggle_like(env, "u1", post["id"]) is False
    comment = await moments.add_comment(env, "u1", post["id"], "hello there")
    assert comment and comment["text"] == "hello there"
    first = next(r for r in await moments.feed(env, "u1", 0, 20) if r["id"] == post["id"])
    assert first["reactions"] and first["reactions"][0]["kind"] == "comment"
    print("✓ like toggle / comment / feed reactions")

    async def fake_reaction(env, unit, post_text, comment_text=""):
        return "what beans?"

    old_gen = moments.generate_reaction
    old_random = moments.random.random
    moments.generate_reaction = fake_reaction
    moments.random.random = lambda: 0.0
    try:
        contact = {"hours": ["active"] * 24, "hoursWeekend": ["active"] * 24}
        await moments.react_to_post(env, "u1", "persona-leo", post["id"], contact, 0)
    finally:
        moments.generate_reaction = old_gen
        moments.random.random = old_random
    first = next(r for r in await moments.feed(env, "u1", 0, 20) if r["id"] == post["id"])
    assert any(r["actor"] == "persona-leo" and r["kind"] == "comment"
               for r in first["reactions"])
    print("✓ NPC reaction / comment")

    now = moments.now_ms()
    await moments.schedule_echo(env, "u1", "persona-leo", now)
    row = env.DB.db.execute(
        "SELECT kind,state FROM jobs WHERE user='u1' AND unit='persona-leo'").fetchone()
    assert row and row["kind"] == "moment_echo" and row["state"] == "pending"
    print("✓ echo job scheduling")

    async def fake_load(env, user, unit):
        return {"digest": "They talked about coffee and a hard week."}

    async def fake_recent(env, user, unit, limit=30):
        return [{"role": "me", "text": "I tried the new place"}]

    async def fake_chain(messages):
        return '{"text":"Tried the new place today. The beans were better than the chair."}'

    old = (moments.life.load, moments.convo.recent, moments._chain)
    moments.life.load, moments.convo.recent, moments._chain = (
        fake_load, fake_recent, fake_chain)
    try:
        await moments.generate_echo(env, "u1", "persona-leo")
        made = await moments.generate_canon(env, now)
    finally:
        moments.life.load, moments.convo.recent, moments._chain = old
    echo = env.DB.db.execute(
        "SELECT text,user FROM moment_posts WHERE scope='echo'").fetchone()
    assert echo and echo["user"] == "u1" and "beans" in echo["text"]
    assert made == 4
    assert await moments.canon_context(env, "persona-leo")
    print("✓ echo content / canon generation / canon context")
    print("MOMENTS TEST PASS")


asyncio.run(main())
