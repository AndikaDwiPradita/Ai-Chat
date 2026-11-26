"""
Lapisan persistensi SQLite untuk Cosmic.

Menyimpan percakapan, pesan, dan folder ke backend/data/nexus.db
supaya riwayat tidak hilang saat ganti perangkat atau membersihkan cache browser.
"""

import json
import sqlite3
import threading
import time
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
DB_PATH = DATA_DIR / "nexus.db"

_lock = threading.RLock()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'Percakapan baru',
    model TEXT NOT NULL DEFAULT '',
    folder_id TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    title_manual INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    attachments TEXT NOT NULL DEFAULT '[]',
    usage TEXT,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, id);

CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
"""


def _connect():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    with _lock:
        with _connect() as conn:
            conn.executescript(_SCHEMA)


def _message_to_dict(row):
    try:
        attachments = json.loads(row["attachments"] or "[]")
    except (TypeError, ValueError):
        attachments = []

    if not isinstance(attachments, list):
        attachments = []

    usage = None
    if row["usage"]:
        try:
            usage = json.loads(row["usage"])
        except (TypeError, ValueError):
            usage = None

    return {
        "role": row["role"],
        "content": row["content"],
        "attachments": attachments,
        "usage": usage,
        "durationMs": row["duration_ms"],
        "createdAt": row["created_at"],
    }


def get_chats_with_messages():
    with _lock:
        with _connect() as conn:
            chat_rows = conn.execute(
                "SELECT * FROM chats ORDER BY pinned DESC, updated_at DESC"
            ).fetchall()

            result = []

            for chat in chat_rows:
                message_rows = conn.execute(
                    "SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC",
                    (chat["id"],),
                ).fetchall()

                result.append({
                    "id": chat["id"],
                    "title": chat["title"],
                    "model": chat["model"],
                    "folderId": chat["folder_id"],
                    "archived": bool(chat["archived"]),
                    "pinned": bool(chat["pinned"]),
                    "titleManual": bool(chat["title_manual"]),
                    "createdAt": chat["created_at"],
                    "updatedAt": chat["updated_at"],
                    "messages": [_message_to_dict(r) for r in message_rows],
                })

            return result


def get_folders():
    with _lock:
        with _connect() as conn:
            rows = conn.execute(
                "SELECT * FROM folders ORDER BY created_at ASC, name ASC"
            ).fetchall()

            return [
                {"id": row["id"], "name": row["name"]}
                for row in rows
            ]


def sync_state(conversations, folders):
    """
    Mengganti keadaan tersimpan dengan keadaan dari klien (last-write-wins).

    Dipanggil setelah frontend mendeteksi perubahan pada localStorage.
    Validasi bentuk data dilakukan di layer route sebelum masuk ke sini.
    """
    now = int(time.time() * 1000)
    incoming_ids = set()
    incoming_folder_ids = set()

    with _lock:
        with _connect() as conn:
            for chat in conversations:
                cid = str(chat.get("id") or "").strip()
                if not cid or len(cid) > 128:
                    continue

                incoming_ids.add(cid)

                folder_id = chat.get("folderId")
                if folder_id is not None:
                    folder_id = str(folder_id)[:128] or None

                conn.execute(
                    """
                    INSERT INTO chats
                        (id, title, model, folder_id, archived, pinned,
                         title_manual, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        title=excluded.title,
                        model=excluded.model,
                        folder_id=excluded.folder_id,
                        archived=excluded.archived,
                        pinned=excluded.pinned,
                        title_manual=excluded.title_manual,
                        updated_at=excluded.updated_at
                    """,
                    (
                        cid,
                        str(chat.get("title") or "Percakapan baru")[:200],
                        str(chat.get("model") or "")[:200],
                        folder_id,
                        1 if chat.get("archived") else 0,
                        1 if chat.get("pinned") else 0,
                        1 if chat.get("titleManual") else 0,
                        int(chat.get("createdAt") or now),
                        int(chat.get("updatedAt") or now),
                    ),
                )

                conn.execute("DELETE FROM messages WHERE chat_id = ?", (cid,))

                for message in chat.get("messages", []):
                    if message.get("role") not in ("user", "assistant", "system"):
                        continue

                    content = message.get("content")
                    if not isinstance(content, str):
                        content = "" if content is None else str(content)

                    attachments = message.get("attachments") or []
                    if not isinstance(attachments, list):
                        attachments = []

                    usage = message.get("usage")
                    duration = message.get("durationMs")

                    conn.execute(
                        """
                        INSERT INTO messages
                            (chat_id, role, content, attachments, usage,
                             duration_ms, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            cid,
                            message["role"],
                            content[:400_000],
                            json.dumps(attachments)[:64_000],
                            json.dumps(usage) if usage is not None else None,
                            int(duration) if duration is not None else None,
                            int(message.get("createdAt") or now),
                        ),
                    )

            existing = {
                row["id"]
                for row in conn.execute("SELECT id FROM chats").fetchall()
            }

            for stale in existing - incoming_ids:
                conn.execute("DELETE FROM chats WHERE id = ?", (stale,))

            for folder in folders:
                fid = str(folder.get("id") or "").strip()
                if not fid or len(fid) > 128:
                    continue

                incoming_folder_ids.add(fid)

                conn.execute(
                    """
                    INSERT INTO folders (id, name, created_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET name=excluded.name
                    """,
                    (fid, str(folder.get("name") or "Folder")[:60], now),
                )

            existing_folders = {
                row["id"]
                for row in conn.execute("SELECT id FROM folders").fetchall()
            }

            for stale in existing_folders - incoming_folder_ids:
                conn.execute(
                    "UPDATE chats SET folder_id = NULL WHERE folder_id = ?",
                    (stale,),
                )
                conn.execute("DELETE FROM folders WHERE id = ?", (stale,))
