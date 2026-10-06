#!/usr/bin/env python3
"""
AKANDO AI student chat website — backend.

FastAPI + SQLite. Students register (go to PENDING), Billah approves them
in the admin panel, then they can chat. Chat replies are produced by the
background worker (a separate agent) through a simple JSONL pipeline:

  student message  -> appended to  ~/workspace/akando-bot/site_inbox.jsonl
  worker reply     -> appended to  ~/workspace/akando-bot/site_outbox.jsonl
  site poller (background thread in this app) moves replies into SQLite,
  and the frontend picks them up by polling GET /api/chats/{id}/messages.

No external services, no API keys, no costs.
Run:  venv/bin/python -m uvicorn app:app --host 0.0.0.0 --port 8000
"""
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------- paths ---
BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE, "akando.db")
STATIC_DIR = os.path.join(BASE, "static")
OFFSET_FILE = os.path.join(BASE, ".site_outbox.offset")

# Pipeline files shared with the background worker agent.
# On Render (hosted mode) these local paths don't exist — messages stay in
# SQLite and the worker uses /api/worker/pending + /api/worker/reply instead.
SITE_INBOX = "/home/hatch/workspace/akando-bot/site_inbox.jsonl"
SITE_OUTBOX = "/home/hatch/workspace/akando-bot/site_outbox.jsonl"
HOSTED = not os.path.isdir(os.path.dirname(SITE_INBOX))

SESSION_DAYS = 7

# ------------------------------------------------------------ db helpers ---
def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def init_db():
    with db() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS users(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                mobile TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',   -- pending|approved|rejected
                is_admin INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions(
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chats(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                role TEXT NOT NULL,            -- user|assistant
                text TEXT NOT NULL,
                msg_local_id TEXT,            -- links a user msg to its worker reply
                delivered INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
            CREATE INDEX IF NOT EXISTS idx_messages_local ON messages(msg_local_id);
            """
        )
        # Seed the admin account (Billah). He should change the password
        # after first login (admin panel -> "Password bodlan").
        # ADMIN_MOBILE / ADMIN_PASSWORD env vars override the defaults (used on Render).
        admin_mobile = os.environ.get("ADMIN_MOBILE", "01700000000") or "01700000000"
        admin_password = os.environ.get("ADMIN_PASSWORD", "akando-admin") or "akando-admin"
        row = con.execute("SELECT id FROM users WHERE mobile = ?", (admin_mobile,)).fetchone()
        if not row:
            con.execute(
                "INSERT INTO users(name, mobile, password_hash, status, is_admin, created_at)"
                " VALUES(?,?,?,?,?,?)",
                ("Admin", admin_mobile, hash_password(admin_password),
                 "approved", 1, utcnow()),
            )
            print(f"[akando-site] seeded admin account: mobile {admin_mobile}")
        else:
            # Rename the old seeded name so it never shows "Billah (Admin)".
            con.execute(
                "UPDATE users SET name = 'Admin' WHERE mobile = ? AND name = 'Billah (Admin)'",
                (admin_mobile,),
            )


def utcnow():
    return datetime.now(timezone.utc).isoformat()


# ------------------------------------------------------- password hashing ---
# stdlib PBKDF2-HMAC-SHA256 — no extra dependency, no plaintext passwords.
def hash_password(pw: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 200_000)
    return f"pbkdf2$200000${salt}${dk.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        _, iters, salt, hexdk = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), int(iters))
        return hmac.compare_digest(dk.hex(), hexdk)
    except Exception:
        return False


# ------------------------------------------------------------------ auth ---
def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    exp = (datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)).isoformat()
    with db() as con:
        con.execute("INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)",
                    (token, user_id, exp))
    return token


def get_user(req: Request):
    token = req.cookies.get("akando_session")
    if not token:
        return None
    with db() as con:
        row = con.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id"
            " WHERE s.token = ? AND s.expires_at > ?",
            (token, utcnow()),
        ).fetchone()
        return dict(row) if row else None


def require_user(req: Request):
    u = get_user(req)
    if not u:
        raise HTTPException(401, "Please login first.")
    if not u["is_admin"] and u["status"] != "approved":
        raise HTTPException(403, "Your account is not approved yet.")
    return u


def require_admin(req: Request):
    u = get_user(req)
    if not u or not u["is_admin"]:
        raise HTTPException(403, "Admin only.")
    return u


# ------------------------------------------------- site outbox poller thread ---
def handle_outbox_line(line: str):
    """Move one worker reply from site_outbox.jsonl into SQLite."""
    try:
        rep = json.loads(line)
    except Exception:
        return
    local_id = rep.get("msg_local_id")
    text = rep.get("text", "")
    if not local_id or not text:
        return
    with db() as con:
        umsg = con.execute(
            "SELECT id, chat_id FROM messages WHERE msg_local_id = ? AND role = 'user'",
            (local_id,),
        ).fetchone()
        if not umsg:
            print(f"[poller] reply for unknown msg_local_id {local_id}; skipped")
            return
        # Avoid double-insert if the worker retries.
        dup = con.execute(
            "SELECT id FROM messages WHERE msg_local_id = ? AND role = 'assistant'",
            (local_id,),
        ).fetchone()
        if dup:
            con.execute("UPDATE messages SET delivered = 1 WHERE id = ?", (umsg["id"],))
            return
        con.execute(
            "INSERT INTO messages(chat_id, role, text, msg_local_id, delivered, created_at)"
            " VALUES(?,?,?,?,1,?)",
            (umsg["chat_id"], "assistant", text, local_id, utcnow()),
        )
        con.execute("UPDATE messages SET delivered = 1 WHERE id = ?", (umsg["id"],))
        print(f"[poller] delivered site reply for {local_id}")


def read_offset() -> int:
    try:
        with open(OFFSET_FILE) as f:
            return int(f.read().strip() or 0)
    except Exception:
        return 0


def write_offset(n: int):
    try:
        with open(OFFSET_FILE, "w") as f:
            f.write(str(n))
    except Exception:
        pass


def site_poller():
    """Background thread: tail site_outbox.jsonl, feed replies into the DB."""
    offset = read_offset()
    while True:
        try:
            if os.path.exists(SITE_OUTBOX):
                size = os.path.getsize(SITE_OUTBOX)
                if size < offset:      # file was rotated/truncated
                    offset = 0
                with open(SITE_OUTBOX, "r", encoding="utf-8") as f:
                    f.seek(offset)
                    for line in f:
                        if line.strip():
                            handle_outbox_line(line)
                    offset = f.tell()
                write_offset(offset)
        except Exception as e:
            print("[poller] error:", e)
        time.sleep(2)


# ------------------------------------------------------------------- app ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    t = threading.Thread(target=site_poller, daemon=True, name="site-poller")
    t.start()
    print("[akando-site] site poller started")
    yield


app = FastAPI(title="AKANDO AI student chat", lifespan=lifespan)


@app.exception_handler(HTTPException)
async def http_exc_handler(req: Request, exc: HTTPException):
    return JSONResponse({"ok": False, "error": exc.detail}, status_code=exc.status_code)


# --------------------------------------------------------------- API: auth ---
@app.post("/api/register")
async def api_register(req: Request):
    body = await req.json()
    name = (body.get("name") or "").strip()
    mobile = "".join((body.get("mobile") or "").strip().split())
    password = body.get("password") or ""
    if len(name) < 2:
        raise HTTPException(400, "Please enter your name.")
    if len(mobile) < 6:
        raise HTTPException(400, "Please enter a valid mobile number.")
    if len(password) < 4:
        raise HTTPException(400, "Password must be at least 4 characters.")
    try:
        with db() as con:
            con.execute(
                "INSERT INTO users(name, mobile, password_hash, status, is_admin, created_at)"
                " VALUES(?,?,?,?,0,?)",
                (name, mobile, hash_password(password), "pending", utcnow()),
            )
    except sqlite3.IntegrityError:
        raise HTTPException(400, "This mobile number is already registered.")
    return {"ok": True, "message": "Registered! You can chat once the admin approves your account."}


@app.post("/api/login")
async def api_login(req: Request):
    body = await req.json()
    mobile = "".join((body.get("mobile") or "").strip().split())
    password = body.get("password") or ""
    with db() as con:
        row = con.execute("SELECT * FROM users WHERE mobile = ?", (mobile,)).fetchone()
    if not row or not verify_password(password, row["password_hash"]):
        raise HTTPException(401, "Wrong mobile number or password.")
    u = dict(row)
    if not u["is_admin"] and u["status"] != "approved":
        msg = ("Your account is still PENDING — you can log in once the admin approves it."
               if u["status"] == "pending" else
               "Your account has been rejected.")
        raise HTTPException(403, msg)
    token = create_session(u["id"])
    resp = JSONResponse({"ok": True, "user": public_user(u)})
    resp.set_cookie("akando_session", token, httponly=True, samesite="lax",
                    max_age=SESSION_DAYS * 86400, path="/")
    return resp


@app.post("/api/logout")
async def api_logout(req: Request):
    token = req.cookies.get("akando_session")
    if token:
        with db() as con:
            con.execute("DELETE FROM sessions WHERE token = ?", (token,))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("akando_session", path="/")
    return resp


@app.get("/api/me")
async def api_me(req: Request):
    u = get_user(req)
    if not u:
        raise HTTPException(401, "Please login first.")
    return {"ok": True, "user": public_user(u)}


@app.post("/api/me/password")
async def api_change_password(req: Request):
    u = require_user(req)
    body = await req.json()
    old = body.get("old") or ""
    new = body.get("new") or ""
    if len(new) < 4:
        raise HTTPException(400, "New password must be at least 4 characters.")
    with db() as con:
        row = con.execute("SELECT password_hash FROM users WHERE id = ?", (u["id"],)).fetchone()
        if not verify_password(old, row["password_hash"]):
            raise HTTPException(400, "Old password is wrong.")
        con.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                    (hash_password(new), u["id"]))
    return {"ok": True, "message": "Password changed."}


def public_user(u: dict):
    return {"id": u["id"], "name": u["name"], "mobile": u["mobile"],
            "status": u["status"], "is_admin": bool(u["is_admin"])}


# --------------------------------------------------------------- API: chat ---
@app.get("/api/chats")
async def api_list_chats(req: Request):
    u = require_user(req)
    with db() as con:
        rows = con.execute(
            "SELECT id, title, created_at FROM chats WHERE user_id = ? ORDER BY id DESC",
            (u["id"],)).fetchall()
    return {"ok": True, "chats": [dict(r) for r in rows]}


@app.post("/api/chats")
async def api_new_chat(req: Request):
    u = require_user(req)
    body = await req.json() if req.headers.get("content-type", "").startswith("application/json") else {}
    title = (body.get("title") or "New chat").strip()[:60] or "New chat"
    with db() as con:
        cur = con.execute(
            "INSERT INTO chats(user_id, title, created_at) VALUES(?,?,?)",
            (u["id"], title, utcnow()))
        cid = cur.lastrowid
    return {"ok": True, "chat": {"id": cid, "title": title}}


def own_chat(u, chat_id: int):
    with db() as con:
        row = con.execute("SELECT id, title FROM chats WHERE id = ? AND user_id = ?",
                          (chat_id, u["id"])).fetchone()
    if not row:
        raise HTTPException(404, "Chat not found.")
    return dict(row)


def writable_chat(u, chat_id: int):
    """Chat the user may rename/delete: their own, or any chat if admin."""
    with db() as con:
        if u["is_admin"]:
            row = con.execute("SELECT id, title FROM chats WHERE id = ?",
                              (chat_id,)).fetchone()
        else:
            row = con.execute("SELECT id, title FROM chats WHERE id = ? AND user_id = ?",
                              (chat_id, u["id"])).fetchone()
    if not row:
        raise HTTPException(404, "Chat not found.")
    return dict(row)


@app.patch("/api/chats/{chat_id}")
async def api_rename_chat(chat_id: int, req: Request):
    u = require_user(req)
    writable_chat(u, chat_id)
    body = await req.json()
    title = (body.get("title") or "").strip()[:60]
    if not title:
        raise HTTPException(400, "Please enter a chat name.")
    with db() as con:
        con.execute("UPDATE chats SET title = ? WHERE id = ?", (title, chat_id))
    return {"ok": True, "chat": {"id": chat_id, "title": title}}


@app.delete("/api/chats/{chat_id}")
async def api_delete_chat(chat_id: int, req: Request):
    u = require_user(req)
    writable_chat(u, chat_id)
    with db() as con:
        con.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
    return {"ok": True}


@app.get("/api/chats/{chat_id}/messages")
async def api_get_messages(chat_id: int, req: Request, after: int = 0):
    u = require_user(req)
    own_chat(u, chat_id)
    with db() as con:
        rows = con.execute(
            "SELECT id, role, text, delivered, created_at FROM messages"
            " WHERE chat_id = ? AND id > ? ORDER BY id ASC LIMIT 500",
            (chat_id, after)).fetchall()
    return {"ok": True, "messages": [dict(r) for r in rows]}


@app.post("/api/chats/{chat_id}/messages")
async def api_send_message(chat_id: int, req: Request):
    u = require_user(req)
    own_chat(u, chat_id)
    body = await req.json()
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "Cannot send an empty message.")
    if len(text) > 4000:
        raise HTTPException(400, "Message too long (4000 character limit).")
    local_id = uuid.uuid4().hex
    with db() as con:
        cur = con.execute(
            "INSERT INTO messages(chat_id, role, text, msg_local_id, delivered, created_at)"
            " VALUES(?,?,?,?,0,?)",
            (chat_id, "user", text, local_id, utcnow()))
        mid = cur.lastrowid
    # Hand off to the background worker. Locally: JSONL pipeline.
    # Hosted (Render): message stays in SQLite; the worker pulls it via
    # /api/worker/pending and posts the reply to /api/worker/reply.
    payload = {"channel": "site", "site_user_id": u["id"], "name": u["name"],
               "text": text, "ts": time.time(), "msg_local_id": local_id}
    if not HOSTED:
        try:
            with open(SITE_INBOX, "a", encoding="utf-8") as f:
                f.write(json.dumps(payload, ensure_ascii=False) + "\n")
        except Exception as e:
            print("[akando-site] inbox write failed:", e)
            raise HTTPException(500, "Could not queue the message, please try again.")
    return {"ok": True, "message": {"id": mid, "role": "user", "text": text,
                                    "delivered": 0, "msg_local_id": local_id}}


# -------------------------------------------------------------- API: worker ---
# Lets the background worker serve a HOSTED copy of this site (e.g. Render).
# Locally the JSONL pipeline is used instead; over the internet the worker
# polls these endpoints. Protected by WORKER_SECRET env var.
WORKER_SECRET = os.environ.get("WORKER_SECRET", "")


def require_worker(req: Request):
    if not WORKER_SECRET:
        raise HTTPException(403, "Worker API disabled (WORKER_SECRET not set).")
    got = req.headers.get("x-worker-secret", "")
    if not hmac.compare_digest(got, WORKER_SECRET):
        raise HTTPException(403, "Forbidden.")


@app.get("/api/worker/pending")
async def api_worker_pending(req: Request):
    """Undelivered student messages for the background worker to answer."""
    require_worker(req)
    with db() as con:
        rows = con.execute(
            "SELECT m.msg_local_id, m.text, m.created_at,"
            " u.id AS site_user_id, u.name"
            " FROM messages m JOIN chats c ON c.id = m.chat_id"
            " JOIN users u ON u.id = c.user_id"
            " WHERE m.role = 'user' AND m.delivered = 0 AND m.msg_local_id IS NOT NULL"
            " ORDER BY m.id ASC LIMIT 50").fetchall()
    return {"ok": True, "messages": [dict(r) for r in rows]}


@app.post("/api/worker/reply")
async def api_worker_reply(req: Request):
    """Accept one worker reply; idempotent on msg_local_id (same as JSONL path)."""
    require_worker(req)
    body = await req.json()
    local_id = body.get("msg_local_id") or ""
    text = (body.get("text") or "").strip()
    if not local_id or not text:
        raise HTTPException(400, "msg_local_id and text required.")
    with db() as con:
        umsg = con.execute(
            "SELECT id, chat_id FROM messages WHERE msg_local_id = ? AND role = 'user'",
            (local_id,)).fetchone()
        if not umsg:
            return {"ok": True, "unknown": True}
        dup = con.execute(
            "SELECT id FROM messages WHERE msg_local_id = ? AND role = 'assistant'",
            (local_id,)).fetchone()
        if dup:
            con.execute("UPDATE messages SET delivered = 1 WHERE id = ?", (umsg["id"],))
            return {"ok": True, "duplicate": True}
        con.execute(
            "INSERT INTO messages(chat_id, role, text, msg_local_id, delivered, created_at)"
            " VALUES(?,?,?,?,1,?)",
            (umsg["chat_id"], "assistant", text, local_id, utcnow()))
        con.execute("UPDATE messages SET delivered = 1 WHERE id = ?", (umsg["id"],))
    return {"ok": True}


# -------------------------------------------------------------- API: admin ---
@app.get("/api/admin/users")
async def api_admin_users(req: Request):
    require_admin(req)
    with db() as con:
        rows = con.execute(
            "SELECT id, name, mobile, status, is_admin, created_at FROM users"
            " ORDER BY created_at DESC").fetchall()
    return {"ok": True, "users": [dict(r) for r in rows]}


@app.post("/api/admin/users/{uid}/approve")
async def api_admin_approve(uid: int, req: Request):
    require_admin(req)
    with db() as con:
        con.execute("UPDATE users SET status = 'approved' WHERE id = ? AND is_admin = 0", (uid,))
    return {"ok": True}


@app.post("/api/admin/users/{uid}/reject")
async def api_admin_reject(uid: int, req: Request):
    require_admin(req)
    with db() as con:
        con.execute("UPDATE users SET status = 'rejected' WHERE id = ? AND is_admin = 0", (uid,))
        con.execute("DELETE FROM sessions WHERE user_id = ?", (uid,))
    return {"ok": True}


@app.delete("/api/admin/users/{uid}")
async def api_admin_remove_user(uid: int, req: Request):
    me = require_admin(req)
    if uid == me["id"]:
        raise HTTPException(400, "You cannot remove your own admin account.")
    with db() as con:
        row = con.execute("SELECT is_admin FROM users WHERE id = ?", (uid,)).fetchone()
        if not row:
            raise HTTPException(404, "User not found.")
        if row["is_admin"]:
            raise HTTPException(400, "You cannot remove another admin account.")
        con.execute("DELETE FROM users WHERE id = ?", (uid,))
    return {"ok": True}


# -------------------------------------------------------------- static UI ---
# Don't crash at startup if the static dir is missing from the deploy —
# create it (the UI won't load, but the API stays up for diagnosis).
os.makedirs(STATIC_DIR, exist_ok=True)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))
