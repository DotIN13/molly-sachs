import sqlite3
import os
import datetime
from typing import List

DB_DIR = "data"
SQLITE_PATH = os.path.join(DB_DIR, "app.db")

if not os.path.exists(DB_DIR):
    os.makedirs(DB_DIR)

def init_sqlite():
    conn = sqlite3.connect(SQLITE_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS user_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            activity_summary TEXT NOT NULL,
            raw_transcripts TEXT,
            context TEXT
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            image_path TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            processed INTEGER DEFAULT 0
        )
    """)
    conn.commit()
    conn.close()

# LanceDB disabled for stability testing
# import lancedb
# LANCE_PATH = os.path.join(DB_DIR, "lance.db")

# def init_lancedb():
#     db = lancedb.connect(LANCE_PATH)
#     if "events" not in db.table_names():
#         pass
#     return db

def save_event(timestamp: str, summary: str, transcripts: str, context: str, embedding: List[float]):
    conn = sqlite3.connect(SQLITE_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO user_events (timestamp, activity_summary, raw_transcripts, context) VALUES (?, ?, ?, ?)",
        (timestamp, summary, transcripts, context)
    )
    event_id = cursor.lastrowid
    conn.commit()
    conn.close()

    # LanceDB disabled for stability testing
    # try:
    #     db = lancedb.connect(LANCE_PATH)
    #     data = [{
    #         "id": event_id,
    #         "timestamp": timestamp,
    #         "summary": summary,
    #         "vector": embedding
    #     }]
    #     if "events" not in db.table_names():
    #         db.create_table("events", data=data)
    #     else:
    #         table = db.open_table("events")
    #         table.add(data)
    # except Exception as e:
    #     import logging
    #     logging.getLogger(__name__).error(f"LanceDB write failed (non-fatal): {e}")

    return event_id

def search_events(query_embedding: List[float], limit: int = 5):
    # LanceDB disabled for stability testing
    # db = lancedb.connect(LANCE_PATH)
    # if "events" not in db.table_names():
    #     return []
    # table = db.open_table("events")
    # results = table.search(query_embedding).limit(limit).to_list()
    # return results
    return []

def create_conversation(conv_id: str, title: str) -> None:
    conn = sqlite3.connect(SQLITE_PATH)
    cursor = conn.cursor()
    created_at = datetime.datetime.utcnow().isoformat()
    cursor.execute(
        "INSERT OR IGNORE INTO conversations (id, title, created_at) VALUES (?, ?, ?)",
        (conv_id, title, created_at)
    )
    conn.commit()
    conn.close()

def get_conversations() -> List[dict]:
    conn = sqlite3.connect(SQLITE_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT id, title, created_at FROM conversations ORDER BY created_at DESC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def default_conversation_title() -> str:
    return f"Chat on {datetime.datetime.now().strftime('%b %d %I:%M%p')}"

def add_message(conv_id: str, role: str, content: str) -> None:
    conn = sqlite3.connect(SQLITE_PATH)
    cursor = conn.cursor()
    created_at = datetime.datetime.utcnow().isoformat()
    cursor.execute(
        "INSERT OR IGNORE INTO conversations (id, title, created_at) VALUES (?, ?, ?)",
        (conv_id, default_conversation_title(), created_at)
    )
    cursor.execute(
        "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
        (conv_id, role, content, created_at)
    )
    if role == "user":
        cursor.execute("SELECT title FROM conversations WHERE id = ?", (conv_id,))
        row = cursor.fetchone()
        if row and row[0].startswith("Chat on "):
            excerpt = content[:40].strip()
            if excerpt:
                cursor.execute("UPDATE conversations SET title = ? WHERE id = ?", (excerpt, conv_id))
    conn.commit()
    conn.close()

def get_messages(conv_id: str) -> List[dict]:
    conn = sqlite3.connect(SQLITE_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC", (conv_id,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def delete_conversation(conv_id: str) -> None:
    conn = sqlite3.connect(SQLITE_PATH)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
    cursor.execute("DELETE FROM messages WHERE conversation_id = ?", (conv_id,))
    conn.commit()
    conn.close()

def save_observation(obs_type: str, image_path: str, timestamp: str) -> int:
    conn = sqlite3.connect(SQLITE_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO observations (type, image_path, timestamp, processed) VALUES (?, ?, ?, 0)",
        (obs_type, image_path, timestamp)
    )
    obs_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return obs_id

def get_observations(obs_type: str = None, limit: int = 15) -> List[dict]:
    conn = sqlite3.connect(SQLITE_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    if obs_type:
        cursor.execute(
            "SELECT id, type, image_path, timestamp, processed FROM observations WHERE type = ? ORDER BY id DESC LIMIT ?",
            (obs_type, limit)
        )
    else:
        cursor.execute(
            "SELECT id, type, image_path, timestamp, processed FROM observations ORDER BY id DESC LIMIT ?",
            (limit,)
        )
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_insights(limit: int = 15) -> List[dict]:
    conn = sqlite3.connect(SQLITE_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, timestamp, activity_summary, raw_transcripts, context FROM user_events ORDER BY id DESC LIMIT ?",
        (limit,)
    )
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

init_sqlite()
# init_lancedb()
