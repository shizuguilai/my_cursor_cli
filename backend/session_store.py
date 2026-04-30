"""
会话持久化存储（SQLite）
"""

import os
import sqlite3
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional


DB_PATH = os.path.join(os.path.dirname(__file__), "sessions.sqlite3")
_db_lock = threading.Lock()


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _db_lock:
        with _conn() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    workspace TEXT NOT NULL,
                    model TEXT NOT NULL,
                    name TEXT NOT NULL DEFAULT '新会话',
                    created_at TEXT NOT NULL,
                    completed_at TEXT,
                    result TEXT,
                    error TEXT
                )
                """
            )
            columns = conn.execute("PRAGMA table_info(sessions)").fetchall()
            column_names = {col["name"] for col in columns}
            if "name" not in column_names:
                conn.execute(
                    "ALTER TABLE sessions ADD COLUMN name TEXT NOT NULL DEFAULT '新会话'"
                )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    content TEXT NOT NULL,
                    snippet TEXT NOT NULL DEFAULT '',
                    elapsed INTEGER NOT NULL DEFAULT 0,
                    timestamp INTEGER NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES sessions(id)
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, id)"
            )


def upsert_session(session_id: str, workspace: str, model: str) -> None:
    now = datetime.now().isoformat()
    with _db_lock:
        with _conn() as conn:
            conn.execute(
                """
                INSERT INTO sessions (id, workspace, model, name, created_at)
                VALUES (?, ?, ?, '新会话', ?)
                ON CONFLICT(id) DO UPDATE SET
                    workspace = excluded.workspace,
                    model = excluded.model
                """,
                (session_id, workspace, model, now),
            )


def add_message(
    session_id: str,
    msg_type: str,
    content: str,
    snippet: str = "",
    elapsed: int = 0,
    timestamp: Optional[int] = None,
) -> None:
    ts = int(timestamp if timestamp is not None else datetime.now().timestamp() * 1000)
    with _db_lock:
        with _conn() as conn:
            recent_rows = conn.execute(
                """
                SELECT content
                FROM messages
                WHERE session_id = ?
                ORDER BY id DESC
                LIMIT 5
                """,
                (session_id,),
            ).fetchall()
            recent_contents = {row["content"] for row in recent_rows}
            print(
                (
                    session_id,
                    msg_type,
                    content[:30],
                    [row["content"][:30] for row in recent_rows],
                ),
                flush=True,
            )

            if content in recent_contents:
                return

            conn.execute(
                """
                INSERT INTO messages (session_id, type, content, snippet, elapsed, timestamp)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (session_id, msg_type, content, snippet, int(elapsed), ts),
            )


def mark_session_done(session_id: str, result: str) -> None:
    with _db_lock:
        with _conn() as conn:
            conn.execute(
                """
                UPDATE sessions
                SET completed_at = ?, result = ?, error = NULL
                WHERE id = ?
                """,
                (datetime.now().isoformat(), result[:500], session_id),
            )


def mark_session_error(session_id: str, error_msg: str) -> None:
    with _db_lock:
        with _conn() as conn:
            conn.execute(
                """
                UPDATE sessions
                SET error = ?
                WHERE id = ?
                """,
                (error_msg, session_id),
            )


def update_session_name(session_id: str, name: str) -> bool:
    trimmed = (name or "").strip()
    if not trimmed:
        return False
    with _db_lock:
        with _conn() as conn:
            result = conn.execute(
                """
                UPDATE sessions
                SET name = ?
                WHERE id = ?
                """,
                (trimmed[:50], session_id),
            )
    return result.rowcount > 0


def ensure_session_name(session_id: str, name: str) -> bool:
    trimmed = (name or "").strip()
    if not trimmed:
        return False
    with _db_lock:
        with _conn() as conn:
            result = conn.execute(
                """
                UPDATE sessions
                SET name = ?
                WHERE id = ?
                  AND (name IS NULL OR TRIM(name) = '' OR name = '新会话')
                """,
                (trimmed[:50], session_id),
            )
    return result.rowcount > 0


def list_sessions() -> List[Dict[str, Any]]:
    with _db_lock:
        with _conn() as conn:
            rows = conn.execute(
                """
                SELECT id, workspace, model, name, created_at, completed_at, result, error
                FROM sessions
                ORDER BY datetime(created_at) DESC
                """
            ).fetchall()
    return [dict(r) for r in rows]


def _merge_stream_fragments(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """合并连续的短 responding 碎片，减少历史消息气泡数量。"""
    merged: List[Dict[str, Any]] = []
    buffer: Optional[Dict[str, Any]] = None

    for msg in messages:
        is_short_responding = (
            msg["type"] == "responding" and len(msg["content"]) <= 20
        )

        if is_short_responding:
            if buffer is None:
                buffer = dict(msg)
                continue

            if buffer["type"] == msg["type"]:
                buffer["content"] += msg["content"]
                # 保留连续片段中最后一条的时间和耗时，便于反映最终状态
                buffer["timestamp"] = msg["timestamp"]
                buffer["elapsed"] = msg["elapsed"]
                continue

        if buffer is not None:
            merged.append(buffer)
            buffer = None

        merged.append(msg)

    if buffer is not None:
        merged.append(buffer)

    return merged


def get_session(session_id: str) -> Optional[Dict[str, Any]]:
    with _db_lock:
        with _conn() as conn:
            row = conn.execute(
                """
                SELECT id, workspace, model, name, created_at, completed_at, result, error
                FROM sessions
                WHERE id = ?
                """,
                (session_id,),
            ).fetchone()
            if row is None:
                return None
            msg_rows = conn.execute(
                """
                SELECT id, session_id, type, content, snippet, elapsed, timestamp
                FROM messages
                WHERE session_id = ?
                ORDER BY id ASC
                """,
                (session_id,),
            ).fetchall()

    session = dict(row)
    session_messages = [
        {
            "id": f"{m['session_id']}-{m['id']}",
            "session_id": m["session_id"],
            "type": m["type"],
            "content": m["content"],
            "snippet": m["snippet"],
            "elapsed": m["elapsed"],
            "timestamp": m["timestamp"],
        }
        for m in msg_rows
    ]
    session["messages"] = _merge_stream_fragments(session_messages)
    return session


def delete_session(session_id: str) -> bool:
    """删除会话及其关联消息，成功删除返回 True。"""
    with _db_lock:
        with _conn() as conn:
            msg_result = conn.execute(
                """
                DELETE FROM messages
                WHERE session_id = ?
                """,
                (session_id,),
            )
            sess_result = conn.execute(
                """
                DELETE FROM sessions
                WHERE id = ?
                """,
                (session_id,),
            )
    return sess_result.rowcount > 0 or msg_result.rowcount > 0
