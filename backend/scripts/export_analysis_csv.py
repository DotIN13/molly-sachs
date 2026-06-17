#!/usr/bin/env python3
"""Export all analysis items (events, traits, skills, interests, preferences,
ownerships, relationships, weaknesses, goals) from the database to a CSV file.

Usage:
    python export_analysis_csv.py [output.csv]

If no output file is given, writes to analysis_export.csv in the data directory.
"""

import csv
import json
import os
import sys

_script_dir = os.path.dirname(os.path.abspath(__file__))
_backend_dir = os.path.dirname(_script_dir)

_data_base = os.environ.get("DATA_DIR", "").strip()
if _data_base:
    DATA_DIR = os.path.abspath(_data_base)
else:
    DATA_DIR = os.path.abspath(os.path.join(_backend_dir, "..", "data"))

SQLITE_PATH = os.path.join(DATA_DIR, "app.db")

CATEGORIES = [
    "events",
    "personalities",
    "skills",
    "interests",
    "preferences",
    "ownerships",
    "relationships",
    "weaknesses",
    "goals",
]

CSV_COLUMNS = [
    "event_id",
    "timestamp",
    "batch_summary",
    "category",
    "index",
    "content",
    "confidence",
    "lifespan",
    "evidence",
]


def _parse_evidence(evidence_val) -> str:
    """Normalise evidence into a compact string.

    - If it's already a JSON array like [{"text":"...","timestamp":"..."}, ...],
      extract the text entries joined by ' | '.
    - If it's a plain string, return it as-is.
    """
    if isinstance(evidence_val, list):
        texts = []
        for entry in evidence_val:
            if isinstance(entry, dict):
                t = entry.get("text", "")
                if t:
                    texts.append(t)
            elif isinstance(entry, str):
                texts.append(entry)
        return " | ".join(texts)
    if isinstance(evidence_val, str):
        return evidence_val
    return str(evidence_val)


def _extract_content_key(category: str) -> str:
    """Map plural category name to the singular content key used in JSON items."""
    singular_map = {
        "events": "event",
        "personalities": "personality",
        "skills": "skill",
        "interests": "interest",
        "preferences": "preference",
        "ownerships": "ownership",
        "relationships": "relationship",
        "weaknesses": "weakness",
        "goals": "goal",
    }
    return singular_map.get(category, category.rstrip("s"))


def main() -> None:
    if not os.path.exists(SQLITE_PATH):
        print(f"Database not found: {SQLITE_PATH}")
        sys.exit(1)

    output_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DATA_DIR, "analysis_export.csv")

    import sqlite3
    conn = sqlite3.connect(SQLITE_PATH)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        "SELECT id, timestamp, activity_summary, context, user_id "
        "FROM user_events ORDER BY id ASC"
    ).fetchall()

    if not rows:
        print("No user_events found in database.")
        conn.close()
        return

    lines_written = 0
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        writer.writeheader()

        for row in rows:
            event_id = row["id"]
            timestamp = row["timestamp"]
            summary = row["activity_summary"] or ""
            context_raw = row["context"]

            if not context_raw:
                continue

            try:
                analysis = json.loads(context_raw)
            except (json.JSONDecodeError, TypeError):
                print(f"  Skipping event {event_id}: invalid context JSON")
                continue

            for cat in CATEGORIES:
                items = analysis.get(cat, [])
                if not items:
                    continue
                content_key = _extract_content_key(cat)
                for idx, item in enumerate(items):
                    content = item.get(content_key, "").strip()
                    if not content:
                        continue
                    evidence = _parse_evidence(item.get("evidence", ""))
                    writer.writerow({
                        "event_id": event_id,
                        "timestamp": timestamp,
                        "batch_summary": summary,
                        "category": cat,
                        "index": idx,
                        "content": content,
                        "confidence": item.get("confidence", ""),
                        "lifespan": item.get("lifespan", ""),
                        "evidence": evidence,
                    })
                    lines_written += 1

    conn.close()
    print(f"Exported {lines_written} rows to {output_path}")


if __name__ == "__main__":
    main()
