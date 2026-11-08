"""Pure scheduling tests: no Workers runtime, no D1. Run:
python3 tools/test_convo.py  (last line: CONVO TEST PASS)
"""
import datetime
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import convo  # noqa: E402

contact = json.load(open("site/assets/contacts/chole/contact.json"))
tz = -480
sat_night = int(datetime.datetime(2026, 11, 7, 14, 33, tzinfo=datetime.timezone.utc).timestamp() * 1000)
cst = datetime.timezone(datetime.timedelta(hours=8))

assert convo.status(contact, {"glow_until": 0}, "riceball", "persona-chole", sat_night, tz) == "offline"
assert convo.reply_delay(contact, "offline") is None
wake = convo.wake_at(contact, sat_night, tz)
wake_dt = datetime.datetime.fromtimestamp(wake / 1000, cst)
assert wake_dt.hour == 8 and wake_dt.minute <= 12, wake_dt
assert 500 <= convo.reply_delay(contact, "active") <= 12000
assert convo._drift("u", "persona-chole", "active", contact, sat_night) == \
       convo._drift("u", "persona-chole", "active", contact, sat_night)
print("✓ offline / wake / delay / deterministic drift")

db = sqlite3.connect(":memory:")
db.executescript(open("schema.sql").read())
now = sat_night
db.execute("INSERT INTO conversations(user,unit,updated_at,reply_due_at,turn_kind) VALUES(?,?,?,?,'reply')",
           ("u", "persona-chole", now, now))
turn = "t1"
cur = db.execute(
    "UPDATE conversations SET turn_id=?, turn_expires_at=?, updated_at=? "
    "WHERE user=? AND unit=? AND reply_due_at IS NOT NULL AND reply_due_at<=? "
    "AND (turn_id IS NULL OR turn_expires_at<?)",
    (turn, now + 120000, now, "u", "persona-chole", now, now))
assert cur.rowcount == 1
cur = db.execute(
    "UPDATE conversations SET turn_id=?, turn_expires_at=?, updated_at=? "
    "WHERE user=? AND unit=? AND reply_due_at IS NOT NULL AND reply_due_at<=? "
    "AND (turn_id IS NULL OR turn_expires_at<?)",
    ("t2", now + 120000, now, "u", "persona-chole", now, now))
assert cur.rowcount == 0
cur = db.execute(
    "UPDATE conversations SET turn_id=NULL, turn_expires_at=0, reply_due_at=NULL, "
    "turn_kind=NULL, glow_until=?, npc_read_seq=MAX(npc_read_seq,?), updated_at=? "
    "WHERE user=? AND unit=? AND turn_id=? RETURNING user",
    (now + 900000, 0, now, "u", "persona-chole", turn))
assert cur.fetchone() == ("u",)
print("✓ claim is single-writer; completion clears the fence")
print("CONVO TEST PASS")
