import asyncio
import json
import os
import datetime
from datetime import timezone as tz
import secrets

import aiosqlite
from loguru import logger

from config import SQLITE_PATH

# ──────────────────────────────────────────────
#  AppDB — SQLite data store
# ──────────────────────────────────────────────

class AppDB:
    """Async SQLite database for users, conversations, messages, observations,
    and AI-generated events."""

    def __init__(self, path: str = SQLITE_PATH):
        self._path = path
        self._conn: aiosqlite.Connection | None = None
        self._write_lock = asyncio.Lock()

    async def init(self) -> None:
        """Create tables, enable WAL mode, run migrations."""
        os.makedirs(os.path.dirname(self._path), exist_ok=True)
        self._conn = await aiosqlite.connect(self._path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA busy_timeout=5000")
        await self._conn.execute("PRAGMA foreign_keys=ON")
        await self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL DEFAULT 'Default User',
                settings    TEXT NOT NULL DEFAULT '{}',
                created_at  TEXT NOT NULL,
                email       TEXT UNIQUE,
                password_hash TEXT,
                email_verified INTEGER DEFAULT 0,
                verification_code TEXT,
                verification_expires TEXT,
                updated_at  TEXT
            );
            CREATE TABLE IF NOT EXISTS user_events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp   TEXT    NOT NULL,
                activity_summary TEXT NOT NULL,
                raw_transcripts  TEXT,
                context     TEXT,
                user_id     TEXT REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS conversations (
                id          TEXT PRIMARY KEY,
                title       TEXT    NOT NULL,
                created_at  TEXT    NOT NULL,
                user_id     TEXT REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS messages (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                role            TEXT NOT NULL,
                content         TEXT NOT NULL,
                created_at      TEXT NOT NULL,
                user_id         TEXT REFERENCES users(id),
                FOREIGN KEY (conversation_id)
                    REFERENCES conversations(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS observations (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                type        TEXT    NOT NULL,
                image_path  TEXT    NOT NULL,
                timestamp   TEXT    NOT NULL,
                processed   INTEGER DEFAULT 0,
                user_id     TEXT REFERENCES users(id)
            );
        """)
        await self._conn.commit()

        # Run column migrations for existing tables that may lack new columns
        await self._migrate_columns()

    async def close(self) -> None:
        """Close the persistent database connection."""
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    async def _migrate_columns(self) -> None:
        """Add missing columns to existing tables (safe idempotent migrations)."""
        migrations = [
            ("users",     "email",                "TEXT UNIQUE"),
            ("users",     "password_hash",        "TEXT"),
            ("users",     "email_verified",       "INTEGER DEFAULT 0"),
            ("users",     "verification_code",    "TEXT"),
            ("users",     "verification_expires", "TEXT"),
            ("users",     "updated_at",           "TEXT"),
            ("conversations", "user_id",          "TEXT REFERENCES users(id)"),
            ("messages",      "user_id",          "TEXT REFERENCES users(id)"),
            ("observations",  "user_id",          "TEXT REFERENCES users(id)"),
            ("user_events",   "user_id",          "TEXT REFERENCES users(id)"),
            ("user_events",   "proactive_tip",     "TEXT"),
        ]
        assert self._conn is not None
        for table, column, col_type in migrations:
            cursor = await self._conn.execute(f"PRAGMA table_info({table})")
            existing = {row[1] for row in await cursor.fetchall()}
            if column not in existing:
                try:
                    await self._conn.execute(
                        f"ALTER TABLE {table} ADD COLUMN {column} {col_type}"
                    )
                    logger.info("Migration: added {}.{} ({})", table, column, col_type)
                except Exception as e:
                    logger.warning("Migration skip {}.{}: {}", table, column, e)
        await self._conn.commit()

    # ── users ────────────────────────────────

    async def create_user(self, email: str, password_hash: str,
                          name: str | None = None, timezone: str = "") -> dict:
        user_id = secrets.token_hex(16)
        now = datetime.datetime.now(tz.utc).isoformat()
        display_name = name or email.split("@")[0]
        initial_settings = json.dumps({"timezone": timezone}) if timezone else "{}"
        async with self._write_lock:
            await self._conn.execute(
                "INSERT INTO users (id, name, settings, created_at, email, "
                "password_hash, email_verified, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
                (user_id, display_name, initial_settings, now, email, password_hash, now),
            )
            await self._conn.commit()
        return {"id": user_id, "name": display_name, "email": email,
                "email_verified": False}

    async def get_user_by_email(self, email: str) -> dict | None:
        cursor = await self._conn.execute(
            "SELECT * FROM users WHERE email = ?", (email,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def get_user_by_id(self, user_id: str) -> dict | None:
        cursor = await self._conn.execute(
            "SELECT * FROM users WHERE id = ?", (user_id,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def set_verification_code(self, user_id: str, code: str,
                                    expires: str) -> None:
        async with self._write_lock:
            await self._conn.execute(
                "UPDATE users SET verification_code = ?, "
                "verification_expires = ? WHERE id = ?",
                (code, expires, user_id),
            )
            await self._conn.commit()

    async def verify_user_email(self, user_id: str) -> None:
        async with self._write_lock:
            await self._conn.execute(
                "UPDATE users SET email_verified = 1, "
                "verification_code = NULL, verification_expires = NULL, "
                "updated_at = ? WHERE id = ?",
                (datetime.datetime.now(tz.utc).isoformat(), user_id),
            )
            await self._conn.commit()

    async def delete_user(self, user_id: str) -> None:
        async with self._write_lock:
            await self._conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
            await self._conn.commit()

    async def update_user_password(self, user_id: str,
                                   password_hash: str) -> None:
        async with self._write_lock:
            await self._conn.execute(
                "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
                (password_hash, datetime.datetime.now(tz.utc).isoformat(), user_id),
            )
            await self._conn.commit()

    async def get_user_settings(self, user_id: str) -> dict:
        cursor = await self._conn.execute(
            "SELECT settings FROM users WHERE id = ?", (user_id,),
        )
        row = await cursor.fetchone()
        if row and row["settings"]:
            return json.loads(row["settings"])
        return {}

    async def save_user_settings(self, user_id: str,
                                 settings_text: str) -> None:
        async with self._write_lock:
            await self._conn.execute(
                "UPDATE users SET settings = ?, updated_at = ? WHERE id = ?",
                (settings_text, datetime.datetime.now(tz.utc).isoformat(), user_id),
            )
            await self._conn.commit()

    # ── user events ───────────────────────────

    async def save_event(self, user_id: str, timestamp: str, summary: str,
                         transcripts: str, context: str) -> int:
        async with self._write_lock:
            cursor = await self._conn.execute(
                "INSERT INTO user_events (timestamp, activity_summary, "
                "raw_transcripts, context, user_id) VALUES (?, ?, ?, ?, ?)",
                (timestamp, summary, transcripts, context, user_id),
            )
            await self._conn.commit()
            return cursor.lastrowid

    async def update_event_proactive_tip(self, event_id: int, tip_json: str) -> None:
        async with self._write_lock:
            await self._conn.execute(
                "UPDATE user_events SET proactive_tip = ? WHERE id = ?",
                (tip_json, event_id),
            )
            await self._conn.commit()

    async def get_insights(self, user_id: str,
                           limit: int = 15,
                           offset: int = 0) -> tuple[list[dict], int]:
        count_cursor = await self._conn.execute(
            "SELECT COUNT(*) FROM user_events WHERE user_id = ?",
            (user_id,),
        )
        total = (await count_cursor.fetchone())[0]
        cursor = await self._conn.execute(
            "SELECT id, timestamp, activity_summary, raw_transcripts, "
            "context, proactive_tip FROM user_events WHERE user_id = ? "
            "ORDER BY id DESC LIMIT ? OFFSET ?",
            (user_id, limit, offset),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows], total

    async def get_proactive_tips(self, user_id: str, limit: int = 50,
                                  offset: int = 0) -> tuple[list[dict], int]:
        cursor = await self._conn.execute(
            "SELECT COUNT(*) FROM user_events WHERE user_id = ? "
            "AND proactive_tip IS NOT NULL",
            (user_id,),
        )
        total = (await cursor.fetchone())[0]

        cursor = await self._conn.execute(
            "SELECT id, timestamp, activity_summary, proactive_tip "
            "FROM user_events WHERE user_id = ? AND proactive_tip IS NOT NULL "
            "ORDER BY id DESC LIMIT ? OFFSET ?",
            (user_id, limit, offset),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows], total

    # ── conversations ─────────────────────────

    async def create_conversation(self, conv_id: str, title: str,
                                  user_id: str) -> None:
        created = datetime.datetime.now(tz.utc).isoformat()
        async with self._write_lock:
            await self._conn.execute(
                "INSERT OR IGNORE INTO conversations (id, title, created_at, "
                "user_id) VALUES (?, ?, ?, ?)",
                (conv_id, title, created, user_id),
            )
            await self._conn.commit()

    async def get_conversations(self, user_id: str) -> list[dict]:
        cursor = await self._conn.execute(
            "SELECT id, title, created_at FROM conversations "
            "WHERE user_id = ? ORDER BY created_at DESC",
            (user_id,),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def delete_conversation(self, conv_id: str, user_id: str) -> bool:
        """Delete a conversation owned by user_id. Returns True if deleted."""
        async with self._write_lock:
            cursor = await self._conn.execute(
                "DELETE FROM conversations WHERE id = ? AND user_id = ?",
                (conv_id, user_id),
            )
            if cursor.rowcount == 0:
                return False
            await self._conn.execute(
                "DELETE FROM messages WHERE conversation_id = ?", (conv_id,),
            )
            await self._conn.commit()
            return True

    async def verify_conversation_owner(self, conv_id: str,
                                        user_id: str) -> bool:
        cursor = await self._conn.execute(
            "SELECT 1 FROM conversations WHERE id = ? AND user_id = ?",
            (conv_id, user_id),
        )
        return await cursor.fetchone() is not None

    # ── messages ──────────────────────────────

    async def add_message(self, conv_id: str, role: str,
                          content: str, user_id: str) -> None:
        created = datetime.datetime.now(tz.utc).isoformat()
        async with self._write_lock:
            title = f"Chat on {datetime.datetime.now().strftime('%b %d %I:%M%p')}"
            await self._conn.execute(
                "INSERT OR IGNORE INTO conversations (id, title, created_at, "
                "user_id) VALUES (?, ?, ?, ?)",
                (conv_id, title, created, user_id),
            )
            await self._conn.execute(
                "INSERT INTO messages (conversation_id, role, content, "
                "created_at, user_id) VALUES (?, ?, ?, ?, ?)",
                (conv_id, role, content, created, user_id),
            )
            if role == "user":
                cursor = await self._conn.execute(
                    "SELECT title FROM conversations WHERE id = ?", (conv_id,),
                )
                row = await cursor.fetchone()
                if row and row[0].startswith("Chat on "):
                    excerpt = content[:40].strip()
                    if excerpt:
                        await self._conn.execute(
                            "UPDATE conversations SET title = ? WHERE id = ?",
                            (excerpt, conv_id),
                        )
            await self._conn.commit()

    async def get_messages(self, conv_id: str, user_id: str) -> list[dict]:
        cursor = await self._conn.execute(
            "SELECT role, content FROM messages "
            "WHERE conversation_id = ? AND user_id = ? "
            "ORDER BY id ASC",
            (conv_id, user_id),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    # ── observations ──────────────────────────

    async def save_observation(self, obs_type: str, image_path: str,
                               timestamp: str, user_id: str) -> int:
        async with self._write_lock:
            cursor = await self._conn.execute(
                "INSERT INTO observations (type, image_path, timestamp, "
                "processed, user_id) VALUES (?, ?, ?, 0, ?)",
                (obs_type, image_path, timestamp, user_id),
            )
            await self._conn.commit()
            return cursor.lastrowid

    async def get_unprocessed_observations(self,
                                           user_id: str | None = None
                                           ) -> list[dict]:
        if user_id:
            cursor = await self._conn.execute(
                "SELECT id, type, image_path, timestamp "
                "FROM observations WHERE processed = 0 AND user_id = ? "
                "ORDER BY id ASC",
                (user_id,),
            )
        else:
            cursor = await self._conn.execute(
                "SELECT id, type, image_path, timestamp "
                "FROM observations WHERE processed = 0 "
                "ORDER BY id ASC",
            )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def get_observations(self, user_id: str,
                                obs_type: str | None = None,
                                limit: int = 15,
                                offset: int = 0) -> tuple[list[dict], int]:
        if obs_type:
            count_cursor = await self._conn.execute(
                "SELECT COUNT(*) FROM observations WHERE user_id = ? AND type = ?",
                (user_id, obs_type),
            )
            cursor = await self._conn.execute(
                "SELECT id, type, image_path, timestamp, processed "
                "FROM observations WHERE user_id = ? AND type = ? "
                "ORDER BY id DESC LIMIT ? OFFSET ?",
                (user_id, obs_type, limit, offset),
            )
        else:
            count_cursor = await self._conn.execute(
                "SELECT COUNT(*) FROM observations WHERE user_id = ?",
                (user_id,),
            )
            cursor = await self._conn.execute(
                "SELECT id, type, image_path, timestamp, processed "
                "FROM observations WHERE user_id = ? "
                "ORDER BY id DESC LIMIT ? OFFSET ?",
                (user_id, limit, offset),
            )
        total = (await count_cursor.fetchone())[0]
        rows = await cursor.fetchall()
        return [dict(r) for r in rows], total

    async def mark_observations_processed(self, image_paths: list) -> None:
        if not image_paths:
            return
        async with self._write_lock:
            placeholders = ",".join(["?" for _ in image_paths])
            await self._conn.execute(
                "UPDATE observations SET processed = 1 "
                f"WHERE image_path IN ({placeholders})",
                image_paths,
            )
            await self._conn.commit()

    async def verify_observation_owner(self, image_path: str,
                                       user_id: str) -> bool:
        cursor = await self._conn.execute(
            "SELECT 1 FROM observations WHERE user_id = ? AND image_path = ?",
            (user_id, image_path),
        )
        return await cursor.fetchone() is not None


# ──────────────────────────────────────────────
#  Module-level singletons
# ──────────────────────────────────────────────

app = AppDB()


async def init():
    """Async initialisation (call once at startup)."""
    await app.init()


def default_conversation_title() -> str:
    return f"Chat on {datetime.datetime.now().strftime('%b %d %I:%M%p')}"
