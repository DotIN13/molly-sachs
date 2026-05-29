import asyncio
import datetime
import os
from typing import Any, List, Optional

import aiosqlite
import chromadb
from loguru import logger

DATA_DIR = os.path.join("..", "data")
SQLITE_PATH = os.path.join(DATA_DIR, "app.db")
CHROMA_PATH = os.path.join(DATA_DIR, "chroma.db")

os.makedirs(DATA_DIR, exist_ok=True)


# ──────────────────────────────────────────────
#  AppDB — async SQLite for all application data
# ──────────────────────────────────────────────

class AppDB:
    """Async SQLite database for conversations, messages, observations, and
    user-event metadata."""

    def __init__(self, path: str = SQLITE_PATH):
        self._path = path

    # ── lifecycle ─────────────────────────────

    async def init(self) -> None:
        """Create tables and enable WAL mode."""
        async with aiosqlite.connect(self._path) as db:
            await db.execute("PRAGMA journal_mode=WAL")
            await db.execute("PRAGMA busy_timeout=5000")
            await db.executescript("""
                CREATE TABLE IF NOT EXISTS user_events (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp   TEXT    NOT NULL,
                    activity_summary TEXT NOT NULL,
                    raw_transcripts  TEXT,
                    context     TEXT
                );
                CREATE TABLE IF NOT EXISTS conversations (
                    id          TEXT PRIMARY KEY,
                    title       TEXT    NOT NULL,
                    created_at  TEXT    NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id TEXT NOT NULL,
                    role            TEXT NOT NULL,
                    content         TEXT NOT NULL,
                    created_at      TEXT NOT NULL,
                    FOREIGN KEY (conversation_id)
                        REFERENCES conversations(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS observations (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    type        TEXT    NOT NULL,
                    image_path  TEXT    NOT NULL,
                    timestamp   TEXT    NOT NULL,
                    processed   INTEGER DEFAULT 0
                );
            """)

    # ── user events ───────────────────────────

    async def save_event(self, timestamp: str, summary: str,
                         transcripts: str, context: str) -> int:
        async with aiosqlite.connect(self._path) as db:
            await db.execute("PRAGMA journal_mode=WAL")
            cursor = await db.execute(
                "INSERT INTO user_events (timestamp, activity_summary, "
                "raw_transcripts, context) VALUES (?, ?, ?, ?)",
                (timestamp, summary, transcripts, context),
            )
            await db.commit()
            return cursor.lastrowid

    async def get_insights(self, limit: int = 15) -> List[dict]:
        async with aiosqlite.connect(self._path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT id, timestamp, activity_summary, raw_transcripts, "
                "context FROM user_events ORDER BY id DESC LIMIT ?",
                (limit,),
            )
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]

    # ── conversations ─────────────────────────

    async def create_conversation(self, conv_id: str, title: str) -> None:
        created = datetime.datetime.utcnow().isoformat()
        async with aiosqlite.connect(self._path) as db:
            await db.execute(
                "INSERT OR IGNORE INTO conversations (id, title, created_at) "
                "VALUES (?, ?, ?)",
                (conv_id, title, created),
            )
            await db.commit()

    async def get_conversations(self) -> List[dict]:
        async with aiosqlite.connect(self._path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT id, title, created_at FROM conversations "
                "ORDER BY created_at DESC",
            )
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]

    async def delete_conversation(self, conv_id: str) -> None:
        async with aiosqlite.connect(self._path) as db:
            await db.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
            await db.execute(
                "DELETE FROM messages WHERE conversation_id = ?", (conv_id,),
            )
            await db.commit()

    # ── messages ──────────────────────────────

    async def add_message(self, conv_id: str, role: str,
                          content: str) -> None:
        created = datetime.datetime.utcnow().isoformat()
        async with aiosqlite.connect(self._path) as db:
            title = f"Chat on {datetime.datetime.now().strftime('%b %d %I:%M%p')}"
            await db.execute(
                "INSERT OR IGNORE INTO conversations (id, title, created_at) "
                "VALUES (?, ?, ?)",
                (conv_id, title, created),
            )
            await db.execute(
                "INSERT INTO messages (conversation_id, role, content, "
                "created_at) VALUES (?, ?, ?, ?)",
                (conv_id, role, content, created),
            )
            if role == "user":
                cursor = await db.execute(
                    "SELECT title FROM conversations WHERE id = ?", (conv_id,),
                )
                row = await cursor.fetchone()
                if row and row[0].startswith("Chat on "):
                    excerpt = content[:40].strip()
                    if excerpt:
                        await db.execute(
                            "UPDATE conversations SET title = ? WHERE id = ?",
                            (excerpt, conv_id),
                        )
            await db.commit()

    async def get_messages(self, conv_id: str) -> List[dict]:
        async with aiosqlite.connect(self._path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT role, content FROM messages "
                "WHERE conversation_id = ? ORDER BY id ASC",
                (conv_id,),
            )
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]

    # ── observations ──────────────────────────

    async def save_observation(self, obs_type: str, image_path: str,
                               timestamp: str) -> int:
        async with aiosqlite.connect(self._path) as db:
            cursor = await db.execute(
                "INSERT INTO observations (type, image_path, timestamp, "
                "processed) VALUES (?, ?, ?, 0)",
                (obs_type, image_path, timestamp),
            )
            await db.commit()
            return cursor.lastrowid

    async def get_observations(self, obs_type: Optional[str] = None,
                               limit: int = 15) -> List[dict]:
        async with aiosqlite.connect(self._path) as db:
            db.row_factory = aiosqlite.Row
            if obs_type:
                cursor = await db.execute(
                    "SELECT id, type, image_path, timestamp, processed "
                    "FROM observations WHERE type = ? ORDER BY id DESC LIMIT ?",
                    (obs_type, limit),
                )
            else:
                cursor = await db.execute(
                    "SELECT id, type, image_path, timestamp, processed "
                    "FROM observations ORDER BY id DESC LIMIT ?",
                    (limit,),
                )
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]


# ──────────────────────────────────────────────
#  VectorDB — ChromaDB persistent client
# ──────────────────────────────────────────────

class VectorDB:
    """ChromaDB vector store backed by a persistent on-disk database."""

    def __init__(self, path: str = CHROMA_PATH):
        self._path = path
        self._client: Any = None
        self._collection: Any = None

    async def init(self) -> None:
        if self._client is not None:
            return

        logger.info("VectorDB: connecting persistent {}", self._path)
        self._client = chromadb.PersistentClient(path=self._path)

        try:
            self._collection = self._client.get_collection("events")
        except Exception:
            self._collection = self._client.create_collection("events")

        logger.info("VectorDB: ready ({} items)", self._collection.count())

    async def add(self, data: list) -> None:
        await self.init()

        ids = [str(item["id"]) for item in data]
        embeddings = [item["vector"] for item in data]
        metadatas = [{"timestamp": item["timestamp"],
                      "summary": item["summary"]} for item in data]

        self._collection.add(ids=ids, embeddings=embeddings, metadatas=metadatas)
        logger.info("VectorDB: added {} items", len(data))

    async def search(self, query: list, limit: int = 5) -> list:
        await self.init()

        results = self._collection.query(
            query_embeddings=[query],
            n_results=limit,
        )

        metadatas = results.get("metadatas", [[]])[0]
        return [dict(m) for m in metadatas] if metadatas else []


# ──────────────────────────────────────────────
#  Module-level singletons
# ──────────────────────────────────────────────

app = AppDB()
vector = VectorDB()


async def init():
    """Async initialisation (call once at startup)."""
    await app.init()
    await vector.init()


def default_conversation_title() -> str:
    return f"Chat on {datetime.datetime.now().strftime('%b %d %I:%M%p')}"
