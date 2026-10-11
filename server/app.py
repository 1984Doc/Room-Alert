"""
RoomFlow - Oscar EMR room turnover notifier (server)

A plain relay. It never connects to Oscar or its database.

Physician clicks "Save & Load" or "Save & Clean" on the Oscar billing review
page. The userscript sends: the action, the appointment number (from the
billing page's hidden fields), and the room name + colour it read off the
schedule page. Reception userscripts poll for tasks, cross-check the room
against their own schedule screen, and acknowledge.

Stored per task: action, room name, room colour, when that room was seen on a
schedule, the appointment number (needed so reception can cross-check it on
their own schedule), and timestamps. No patient names or health card numbers.
Tasks are deleted after they're acknowledged (or expire unacknowledged).
"""

import ipaddress
import logging
import sqlite3
import threading
import time
import uuid

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # Python 3.8-3.10: same library, installed from pip
    import tomli as tomllib
from pathlib import Path

from flask import Flask, jsonify, request, abort

BASE = Path(__file__).resolve().parent
with open(BASE / "config.toml", "rb") as f:
    CFG = tomllib.load(f)

SERVER = CFG.get("server", {})
TASKS = CFG.get("tasks", {})

API_TOKEN = SERVER["api_token"]
ALLOWED_NETS = [ipaddress.ip_network(n) for n in SERVER.get("allowed_networks", [])]
DB_PATH = BASE / SERVER.get("sqlite_path", "roomflow.sqlite3")
DEDUPE_SECONDS = int(TASKS.get("dedupe_seconds", 600))
EXPIRE_UNACKED_SECONDS = int(TASKS.get("expire_unacked_seconds", 4 * 3600))
KEEP_ACKED_SECONDS = int(TASKS.get("keep_acked_seconds", 30))

VALID_ACTIONS = {"load", "clean"}

app = Flask(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("roomflow")
_lock = threading.Lock()


# --------------------------------------------------------------------------
# Local task store (SQLite) - this server's own small file, not Oscar's DB
# --------------------------------------------------------------------------
def db():
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with _lock, db() as c:
        c.execute(
            """CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                action TEXT NOT NULL,
                appointment_no TEXT,
                room_name TEXT,
                room_color TEXT,
                room_seen_at REAL,
                acked_at REAL,
                acked_by TEXT
            )"""
        )
        c.execute("CREATE INDEX IF NOT EXISTS ix_tasks_appt ON tasks(appointment_no)")


def purge(c):
    now = time.time()
    # Acknowledged tasks only need to linger long enough for other screens to see who took them.
    c.execute("DELETE FROM tasks WHERE acked_at IS NOT NULL AND acked_at < ?",
              (now - max(KEEP_ACKED_SECONDS, 60),))
    c.execute("DELETE FROM tasks WHERE acked_at IS NULL AND created_at < ?",
              (now - EXPIRE_UNACKED_SECONDS,))


def clean_str(v, n):
    if v is None:
        return None
    v = str(v).strip()[:n]
    return v or None


def clean_color(v):
    v = clean_str(v, 20)
    if not v:
        return None
    # Accept #rgb / #rrggbb / plain colour names as Oscar renders them in bgcolor.
    ok = all(ch.isalnum() or ch == "#" for ch in v)
    return v if ok else None


def clean_appt(v):
    v = clean_str(v, 20)
    return v if v and v.isdigit() else None


def task_json(r):
    return {
        "id": r["id"],
        "created_at": r["created_at"],
        "action": r["action"],
        "appointment_no": r["appointment_no"],
        "room_name": r["room_name"],
        "room_color": r["room_color"],
        "room_seen_at": r["room_seen_at"],
        "acked_at": r["acked_at"],
        "acked_by": r["acked_by"],
    }


# --------------------------------------------------------------------------
# Access control
# --------------------------------------------------------------------------
@app.before_request
def guard():
    if request.path == "/health":
        return
    if ALLOWED_NETS:
        raw = request.headers.get("X-Real-IP") if SERVER.get("behind_proxy") else None
        ip = ipaddress.ip_address(raw or request.remote_addr)
        if not any(ip in n for n in ALLOWED_NETS):
            log.warning("REJECTED (address not allowed) %s %s from %s", request.method, request.path, ip)
            abort(403)
    if request.headers.get("X-RoomFlow-Token") != API_TOKEN:
        log.warning("REJECTED (wrong token) %s %s from %s", request.method, request.path, request.remote_addr)
        abort(401)


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------
@app.get("/health")
def health():
    return {"ok": True}


@app.post("/api/notify")
def notify():
    """Physician side.
    Body: {action: 'load'|'clean', appointment_no?, room_name?, room_color?, room_seen_at?}
    """
    data = request.get_json(silent=True) or {}
    action = str(data.get("action", "")).lower()
    if action not in VALID_ACTIONS:
        abort(400, "action must be 'load' or 'clean'")

    appt = clean_appt(data.get("appointment_no"))
    room_name = clean_str(data.get("room_name"), 60)
    room_color = clean_color(data.get("room_color"))
    try:
        room_seen_at = float(data["room_seen_at"]) if room_name and data.get("room_seen_at") else None
    except (TypeError, ValueError):
        room_seen_at = None

    now = time.time()
    with _lock, db() as c:
        purge(c)
        existing = None
        if appt:
            existing = c.execute(
                """SELECT * FROM tasks WHERE appointment_no = ? AND acked_at IS NULL
                   AND created_at > ?""",
                (appt, now - DEDUPE_SECONDS),
            ).fetchone()

        if existing:
            # Repeat click (e.g. Oscar's validation stopped the first save).
            # Keep the room we already have unless this click brought a fresher one.
            if not room_name or (existing["room_seen_at"] or 0) > (room_seen_at or 0):
                room_name, room_color, room_seen_at = (
                    existing["room_name"], existing["room_color"], existing["room_seen_at"])
            c.execute(
                """UPDATE tasks SET action=?, room_name=?, room_color=?, room_seen_at=?,
                       updated_at=? WHERE id=?""",
                (action, room_name, room_color, room_seen_at, now, existing["id"]),
            )
            tid = existing["id"]
        else:
            tid = uuid.uuid4().hex
            c.execute(
                """INSERT INTO tasks (id, created_at, updated_at, action, appointment_no,
                                      room_name, room_color, room_seen_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (tid, now, now, action, appt, room_name, room_color, room_seen_at),
            )
        row = c.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
    log.info("NOTIFY %s %s | room=%s | appt=%s | from %s",
             "UPDATED" if existing else "NEW", action.upper(), room_name or "(not identified)",
             appt or "-", request.remote_addr)
    return jsonify({"ok": True, "task": task_json(row)})


@app.get("/api/tasks")
def tasks():
    """Reception side: open tasks plus briefly-visible acknowledged ones."""
    now = time.time()
    with _lock, db() as c:
        purge(c)
        rows = c.execute(
            """SELECT * FROM tasks WHERE acked_at IS NULL OR acked_at > ?
               ORDER BY created_at ASC""",
            (now - KEEP_ACKED_SECONDS,),
        ).fetchall()
    return jsonify({"ok": True, "now": now, "tasks": [task_json(r) for r in rows]})


@app.post("/api/tasks/<tid>/ack")
def ack(tid):
    data = request.get_json(silent=True) or {}
    who = clean_str(data.get("by"), 40) or "Reception"
    now = time.time()
    with _lock, db() as c:
        row = c.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
        if not row:
            abort(404)
        if row["acked_at"] is None:
            c.execute("UPDATE tasks SET acked_at=?, acked_by=? WHERE id=?", (now, who, tid))
            log.info("ACK %s | room=%s | by %s | from %s",
                     row["action"].upper(), row["room_name"] or "(not identified)", who, request.remote_addr)
        row = c.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
    return jsonify({"ok": True, "task": task_json(row)})


init_db()

if __name__ == "__main__":
    from waitress import serve
    serve(app, host=SERVER.get("bind", "0.0.0.0"), port=int(SERVER.get("port", 8765)))
