"""SQLite storage for My Workspace.

All data lives in a single file (``data/workspace.db``) so that backups are a
plain file copy.
"""
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    due TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 1,
    project TEXT NOT NULL DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0,
    repeat TEXT NOT NULL DEFAULT '',
    created TEXT NOT NULL,
    updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    start TEXT NOT NULL,
    "end" TEXT NOT NULL DEFAULT '',
    all_day INTEGER NOT NULL DEFAULT 0,
    location TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    remind_min INTEGER,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    created TEXT NOT NULL,
    updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sheets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '[]',
    created TEXT NOT NULL,
    updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created TEXT NOT NULL,
    updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Sync bookkeeping (see sync.py)
CREATE TABLE IF NOT EXISTS tombstones (
    coll TEXT NOT NULL,
    rid TEXT NOT NULL,
    PRIMARY KEY (coll, rid)
);
CREATE TABLE IF NOT EXISTS file_map (
    rid TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    dir INTEGER NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    mtime_ns INTEGER NOT NULL DEFAULT 0,
    chunks INTEGER NOT NULL DEFAULT 0,
    meta_dirty INTEGER NOT NULL DEFAULT 0
);
"""

# Writable columns per table, with the type each value is coerced to.
TABLES = {
    "tasks": {"title": str, "notes": str, "due": str, "priority": int,
              "project": str, "done": int, "repeat": str},
    "events": {"title": str, "start": str, "end": str, "all_day": int,
               "location": str, "notes": str, "remind_min": int},
    "notes": {"title": str, "body": str, "tags": str, "pinned": int},
    "templates": {"name": str, "subject": str, "body": str},
    "sheets": {"name": str, "data": str},
    "decks": {"name": str, "data": str},
}

DEFAULT_SETTINGS = {
    "mail": {
        "imap_host": "", "imap_port": 993,
        "smtp_host": "", "smtp_port": 465, "smtp_security": "ssl",
        "username": "", "password": "", "from_name": "",
    },
    "file_rules": [
        {"folder": "画像", "ext": ["jpg", "jpeg", "png", "gif", "webp", "heic", "svg"]},
        {"folder": "PDF", "ext": ["pdf"]},
        {"folder": "文書", "ext": ["doc", "docx", "txt", "md", "rtf", "odt", "pages"]},
        {"folder": "表計算", "ext": ["xls", "xlsx", "csv", "ods", "numbers"]},
        {"folder": "スライド", "ext": ["ppt", "pptx", "key", "odp"]},
        {"folder": "圧縮", "ext": ["zip", "7z", "rar", "tar", "gz"]},
    ],
    "file_name_prefix_date": True,
}


def now():
    return datetime.now().isoformat(timespec="seconds")


def _quote(col):
    return '"%s"' % col


class Database:
    def __init__(self, path):
        self.path = str(path)
        with self.connect() as conn:
            conn.executescript(SCHEMA)
            # Sync columns: rid = id of the record in the cloud, dirty = local
            # change counter (0 = in sync). Added to databases created earlier.
            for table in TABLES:
                cols = {r["name"] for r in conn.execute("PRAGMA table_info(%s)" % table)}
                if "rid" not in cols:
                    conn.execute("ALTER TABLE %s ADD COLUMN rid TEXT" % table)
                    conn.execute("ALTER TABLE %s ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1" % table)
                conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS %s_rid ON %s(rid)" % (table, table))

    @contextmanager
    def connect(self):
        """Connection that commits on success and is always closed."""
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    # ---- generic CRUD -------------------------------------------------

    @staticmethod
    def _clean(table, data, partial):
        cols = TABLES[table]
        out = {}
        for col, typ in cols.items():
            if col not in data:
                continue
            val = data[col]
            if val is None or val == "":
                out[col] = None if typ is int and col == "remind_min" else (0 if typ is int else "")
            else:
                try:
                    out[col] = typ(val)
                except (TypeError, ValueError):
                    raise ValueError("invalid value for %s" % col)
        if not partial:
            required = {"tasks": "title", "events": "title", "templates": "name",
                        "sheets": "name", "decks": "name"}.get(table)
            if required and not str(out.get(required, "")).strip():
                raise ValueError("%s is required" % required)
        return out

    def list(self, table, where="", params=(), order="id DESC", limit=None):
        sql = "SELECT * FROM %s" % table
        if where:
            sql += " WHERE " + where
        sql += " ORDER BY " + order
        if limit:
            sql += " LIMIT %d" % int(limit)
        with self.connect() as conn:
            return [dict(r) for r in conn.execute(sql, params)]

    def get(self, table, item_id):
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM %s WHERE id = ?" % table, (item_id,)).fetchone()
        return dict(row) if row else None

    def create(self, table, data):
        values = self._clean(table, data, partial=False)
        values["created"] = values["updated"] = now()
        cols = list(values)
        sql = "INSERT INTO %s (%s) VALUES (%s)" % (
            table, ", ".join(_quote(c) for c in cols), ", ".join("?" for _ in cols))
        with self.connect() as conn:
            cur = conn.execute(sql, [values[c] for c in cols])
            new_id = cur.lastrowid
        return self.get(table, new_id)

    def update(self, table, item_id, data):
        values = self._clean(table, data, partial=True)
        if not values:
            return self.get(table, item_id)
        values["updated"] = now()
        sets = ", ".join("%s = ?" % _quote(c) for c in values) + ", dirty = dirty + 1"
        with self.connect() as conn:
            cur = conn.execute("UPDATE %s SET %s WHERE id = ?" % (table, sets),
                               list(values.values()) + [item_id])
            if cur.rowcount == 0:
                return None
        return self.get(table, item_id)

    def delete(self, table, item_id):
        with self.connect() as conn:
            row = conn.execute("SELECT rid FROM %s WHERE id = ?" % table, (item_id,)).fetchone()
            if row is None:
                return False
            if row["rid"]:
                conn.execute("INSERT OR IGNORE INTO tombstones (coll, rid) VALUES (?, ?)", (table, row["rid"]))
            conn.execute("DELETE FROM %s WHERE id = ?" % table, (item_id,))
            return True

    # ---- settings -----------------------------------------------------

    def get_value(self, key, default=None):
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def set_value(self, key, value):
        with self.connect() as conn:
            if value is None:
                conn.execute("DELETE FROM settings WHERE key = ?", (key,))
            else:
                conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                             (key, json.dumps(value, ensure_ascii=False)))

    def get_settings(self):
        settings = json.loads(json.dumps(DEFAULT_SETTINGS))
        with self.connect() as conn:
            for row in conn.execute("SELECT key, value FROM settings"):
                if row["key"] in DEFAULT_SETTINGS:
                    settings[row["key"]] = json.loads(row["value"])
        for key, default in DEFAULT_SETTINGS.items():
            if isinstance(default, dict):
                merged = dict(default)
                merged.update(settings.get(key) or {})
                settings[key] = merged
        return settings

    def save_settings(self, data):
        with self.connect() as conn:
            for key, value in data.items():
                if key not in DEFAULT_SETTINGS:
                    continue
                conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                             (key, json.dumps(value, ensure_ascii=False)))
