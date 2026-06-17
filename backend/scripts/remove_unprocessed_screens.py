#!/usr/bin/env python3
"""Remove unprocessed screen capture observations from the database and disk."""

import os
import sys
import sqlite3

_script_dir = os.path.dirname(os.path.abspath(__file__))
_backend_dir = os.path.dirname(_script_dir)

_data_base = os.environ.get("DATA_DIR", "").strip()
if _data_base:
    DATA_DIR = os.path.abspath(_data_base)
else:
    DATA_DIR = os.path.abspath(os.path.join(_backend_dir, "..", "data"))

SQLITE_PATH = os.path.join(DATA_DIR, "app.db")


def main() -> None:
    if not os.path.exists(SQLITE_PATH):
        print(f"Database not found: {SQLITE_PATH}")
        sys.exit(1)

    conn = sqlite3.connect(SQLITE_PATH)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        "SELECT id, image_path FROM observations WHERE processed = 0 AND type = 'screen'"
    ).fetchall()

    if not rows:
        print("No unprocessed screen captures found.")
        conn.close()
        return

    deleted_db = 0
    deleted_files = 0

    for row in rows:
        image_path = row["image_path"]

        artefact_abs = os.path.join(DATA_DIR, image_path)
        if os.path.exists(artefact_abs):
            os.remove(artefact_abs)
            deleted_files += 1

        entry_rel = image_path.replace("/artefacts/", "/entries/").rsplit(".", 1)[0] + ".json"
        entry_abs = os.path.join(DATA_DIR, entry_rel)
        if os.path.exists(entry_abs):
            os.remove(entry_abs)
            deleted_files += 1

        conn.execute("DELETE FROM observations WHERE id = ?", (row["id"],))
        deleted_db += 1

    conn.commit()
    conn.close()

    print(f"Removed {deleted_db} database rows and {deleted_files} disk files.")


if __name__ == "__main__":
    main()
