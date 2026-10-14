"""Two-way sync between this local version and the web version (Firebase).

The local PC logs in with the same Firebase account (email + password) as the
web app and exchanges data through Firestore's REST API, so no extra packages
are needed.

How changes are found
  * Every document written by either side carries ``_mt``, a server timestamp
    of its last change. Each sync only asks for documents with ``_mt`` newer
    than the last one seen, which keeps Firestore reads (free quota) low.
  * Deletions are written as tombstones ``{_deleted: true}`` instead of real
    deletes so the other side can see them.
  * Local records carry ``rid`` (the cloud id) and ``dirty`` (change counter).
    Local deletions of synced records are kept in ``tombstones``.
  * Files: ``data/files`` is mirrored with the web app's file tree. ``file_map``
    remembers which local path corresponds to which cloud file.

Conflicts: when both sides changed the same record, the newer ``updated`` wins;
a deletion always wins.
"""
import base64
import json
import mimetypes
import os
import re
import secrets
import shutil
import string
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

from .db import TABLES

CHUNK = 700 * 1024           # must match web/store.js
MAX_FILE = 20 * 1024 * 1024  # must match web/api.js
INTERVAL = 30                # seconds between automatic syncs
COLLECTIONS = list(TABLES)   # tasks, events, notes, templates, sheets
CONFIG_JS = Path(__file__).resolve().parent.parent / "web" / "config.js"


class SyncError(Exception):
    pass


class OfflineError(SyncError):
    pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_firebase_config(path=None):
    """Read apiKey / projectId from web/config.js so both versions share it."""
    path = Path(path or os.environ.get("WORKSPACE_FIREBASE_CONFIG") or CONFIG_JS)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"(?m)^\s*//.*$", "", text)
    m = re.search(r"firebaseConfig\s*=\s*(\{.*?\}|null)", text, re.S)
    if not m or m.group(1) == "null":
        return None
    body = m.group(1)

    def field(name):
        f = re.search(r"""\b%s\s*:\s*['"]([^'"]+)['"]""" % name, body)
        return f.group(1) if f else None

    cfg = {"apiKey": field("apiKey"), "projectId": field("projectId"), "emulator": field("emulator")}
    return cfg if cfg["apiKey"] and cfg["projectId"] else None


def new_id():
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(20))


def enc(v):
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, bytes):
        return {"bytesValue": base64.b64encode(v).decode("ascii")}
    return {"stringValue": str(v)}


def dec(v):
    if not v or "nullValue" in v:
        return None
    if "stringValue" in v:
        return v["stringValue"]
    if "integerValue" in v:
        return int(v["integerValue"])
    if "doubleValue" in v:
        return v["doubleValue"]
    if "booleanValue" in v:
        return v["booleanValue"]
    if "timestampValue" in v:
        return v["timestampValue"]
    if "bytesValue" in v:
        return base64.b64decode(v["bytesValue"])
    return None


def ts_key(ts):
    """Normalise an RFC3339 timestamp so string comparison orders correctly."""
    m = re.match(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$", ts or "")
    if not m:
        return ts or ""
    return "%s.%sZ" % (m.group(1), (m.group(2) or "").ljust(9, "0")[:9])


def iso_mtime(st):
    return datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Firebase REST client
# ---------------------------------------------------------------------------

class FirebaseClient:
    def __init__(self, cfg):
        self.key = cfg["apiKey"]
        self.project = cfg["projectId"]
        emu = cfg.get("emulator")
        if emu:
            self.auth_base = "http://%s:9099/identitytoolkit.googleapis.com/v1" % emu
            self.token_url = "http://%s:9099/securetoken.googleapis.com/v1/token" % emu
            self.fs_base = "http://%s:8080/v1" % emu
            self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        else:
            self.auth_base = "https://identitytoolkit.googleapis.com/v1"
            self.token_url = "https://securetoken.googleapis.com/v1/token"
            self.fs_base = "https://firestore.googleapis.com/v1"
            self.opener = urllib.request.build_opener()
        self.id_token = None
        self.expires = 0
        self.uid = None
        self.refresh_token = None

    def request(self, method, url, body=None, form=False, auth=True):
        headers = {}
        data = None
        if body is not None:
            if form:
                data = urllib.parse.urlencode(body).encode()
                headers["Content-Type"] = "application/x-www-form-urlencoded"
            else:
                data = json.dumps(body).encode()
                headers["Content-Type"] = "application/json"
        if auth:
            headers["Authorization"] = "Bearer " + self.token()
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=60) as res:
                raw = res.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            try:
                err = json.loads(detail)
                msg = err.get("error", {}).get("message") or detail
            except ValueError:
                msg = detail
            if exc.code == 404 and method == "GET":
                return None
            raise SyncError("%s (%d)" % (msg[:200], exc.code))
        except (urllib.error.URLError, OSError) as exc:
            raise OfflineError("接続できません: %s" % getattr(exc, "reason", exc))
        return json.loads(raw) if raw else {}

    # -- auth --

    AUTH_ERRORS = {
        "INVALID_LOGIN_CREDENTIALS": "メールアドレスまたはパスワードが違います",
        "INVALID_PASSWORD": "メールアドレスまたはパスワードが違います",
        "EMAIL_NOT_FOUND": "アカウントが見つかりません",
        "USER_DISABLED": "このアカウントは無効です",
        "TOO_MANY_ATTEMPTS_TRY_LATER": "試行回数が多すぎます。しばらく待ってください",
    }

    def sign_in(self, email, password):
        try:
            res = self.request("POST", "%s/accounts:signInWithPassword?key=%s" % (self.auth_base, self.key),
                               {"email": email, "password": password, "returnSecureToken": True}, auth=False)
        except SyncError as exc:
            code = str(exc).split(" ")[0].split(":")[0]
            raise SyncError(self.AUTH_ERRORS.get(code, str(exc)))
        self.id_token = res["idToken"]
        self.refresh_token = res["refreshToken"]
        self.uid = res["localId"]
        self.expires = time.time() + int(res.get("expiresIn", 3600)) - 120
        return res

    def token(self):
        if self.id_token and time.time() < self.expires:
            return self.id_token
        if not self.refresh_token:
            raise SyncError("ログインが必要です")
        res = self.request("POST", "%s?key=%s" % (self.token_url, self.key),
                           {"grant_type": "refresh_token", "refresh_token": self.refresh_token},
                           form=True, auth=False)
        self.id_token = res["id_token"]
        self.refresh_token = res["refresh_token"]
        self.uid = res["user_id"]
        self.expires = time.time() + int(res.get("expires_in", 3600)) - 120
        return self.id_token

    # -- firestore --

    def doc_name(self, coll, doc_id):
        return "projects/%s/databases/(default)/documents/users/%s/%s/%s" % (
            self.project, self.uid, coll, doc_id)

    def changed_since(self, coll, since):
        """All documents of a collection whose _mt >= since (all if since is None)."""
        query = {"from": [{"collectionId": coll}]}
        if since:
            query["where"] = {"fieldFilter": {"field": {"fieldPath": "_mt"}, "op": "GREATER_THAN_OR_EQUAL",
                                              "value": {"timestampValue": since}}}
        url = "%s/projects/%s/databases/(default)/documents/users/%s:runQuery" % (
            self.fs_base, self.project, self.uid)
        res = self.request("POST", url, {"structuredQuery": query})
        docs = []
        for item in res or []:
            d = item.get("document")
            if d:
                docs.append((d["name"].rsplit("/", 1)[1], d.get("fields", {})))
        return docs

    def get(self, coll, doc_id):
        url = "%s/%s" % (self.fs_base, self.doc_name(coll, doc_id))
        res = self.request("GET", url)
        return res.get("fields", {}) if res else None

    def commit(self, writes):
        url = "%s/projects/%s/databases/(default)/documents:commit" % (self.fs_base, self.project)
        for i in range(0, len(writes), 200):
            self.request("POST", url, {"writes": writes[i:i + 200]})

    def write_doc(self, coll, doc_id, data, stamp=True):
        w = {"update": {"name": self.doc_name(coll, doc_id),
                        "fields": {k: enc(v) for k, v in data.items()}}}
        if stamp:
            w["updateTransforms"] = [{"fieldPath": "_mt", "setToServerValue": "REQUEST_TIME"}]
        return w

    def delete_doc(self, coll, doc_id):
        return {"delete": self.doc_name(coll, doc_id)}


# ---------------------------------------------------------------------------
# Sync engine
# ---------------------------------------------------------------------------

class Syncer:
    def __init__(self, ws, config_path=None):
        self.ws = ws
        self.db = ws.db
        self.config_path = config_path
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.client = None
        self.state = "off"
        self.error = ""
        self.last_sync = ""
        self.changes = 0         # bumped whenever remote data was applied locally
        self.skipped = []
        self.thread = None
        self.stopping = False

    # -- configuration / login --

    def firebase_config(self):
        return load_firebase_config(self.config_path)

    def account(self):
        return self.db.get_value("sync_account")

    def ensure_client(self):
        acc = self.account()
        cfg = self.firebase_config()
        if not acc or not cfg:
            return None
        if self.client is None or self.client.uid != acc["uid"]:
            self.client = FirebaseClient(cfg)
            self.client.uid = acc["uid"]
            self.client.refresh_token = acc["refresh_token"]
        return self.client

    def login(self, email, password):
        cfg = self.firebase_config()
        if not cfg:
            raise SyncError("web/config.js に Firebase の設定がありません")
        client = FirebaseClient(cfg)
        client.sign_in(email, password)
        with self.lock:
            prev = self.db.get_value("sync_bound_uid")
            if prev != client.uid:
                self.reset_state()
            self.db.set_value("sync_bound_uid", client.uid)
            self.db.set_value("sync_account", {"uid": client.uid, "email": email,
                                               "refresh_token": client.refresh_token})
            self.client = client
            self.error = ""
            self.state = "syncing"
        self.poke(0)
        return self.status()

    def logout(self):
        with self.lock:
            self.db.set_value("sync_account", None)
            self.client = None
            self.state = "off"
            self.error = ""

    def reset_state(self):
        """Forget all links to the cloud (e.g. a different account): local data
        is then merged into the account as new items on the next sync."""
        with self.db.connect() as conn:
            for t in COLLECTIONS:
                conn.execute("UPDATE %s SET rid = NULL, dirty = 1" % t)
            conn.execute("DELETE FROM tombstones")
            conn.execute("DELETE FROM file_map")
        self.db.set_value("sync_since", None)

    def save_token(self):
        acc = self.account()
        if acc and self.client and acc.get("refresh_token") != self.client.refresh_token:
            acc["refresh_token"] = self.client.refresh_token
            self.db.set_value("sync_account", acc)

    def status(self):
        acc = self.account()
        with self.db.connect() as conn:
            pending = sum(conn.execute("SELECT COUNT(*) FROM %s WHERE dirty > 0" % t).fetchone()[0]
                          for t in COLLECTIONS)
            pending += conn.execute("SELECT COUNT(*) FROM tombstones").fetchone()[0]
        return {"configured": bool(self.firebase_config()), "logged_in": bool(acc),
                "email": acc["email"] if acc else "", "state": self.state if acc else "off",
                "error": self.error, "last_sync": self.last_sync, "changes": self.changes,
                "pending": pending, "skipped": self.skipped}

    # -- background loop --

    def start(self):
        self.thread = threading.Thread(target=self.loop, daemon=True)
        self.thread.start()

    def poke(self, delay=2):
        """Request a sync soon (called after local edits)."""
        if delay:
            threading.Timer(delay, self.wake.set).start()
        else:
            self.wake.set()

    def loop(self):
        while not self.stopping:
            if self.account():
                self.sync_once()
            self.wake.wait(INTERVAL)
            self.wake.clear()

    def sync_once(self):
        with self.lock:
            client = self.ensure_client()
            if client is None:
                return
            self.state = "syncing"
            try:
                applied = self.pull(client)
                self.push(client)
                self.save_token()
                if applied:
                    self.changes += 1
                self.state = "synced"
                self.error = ""
                self.last_sync = datetime.now().isoformat(timespec="seconds")
            except OfflineError as exc:
                self.state = "offline"
                self.error = str(exc)
            except SyncError as exc:
                self.state = "error"
                self.error = str(exc)
            except Exception as exc:  # keep the loop alive
                self.state = "error"
                self.error = "同期エラー: %s" % exc

    # -- pull --------------------------------------------------------------

    def pull(self, client):
        since = self.db.get_value("sync_since")
        newest = since
        applied = 0
        for coll in COLLECTIONS + ["files"]:
            docs = client.changed_since(coll, since)
            for _, fields in docs:
                mt = fields.get("_mt", {}).get("timestampValue")
                if mt and (newest is None or ts_key(mt) > ts_key(newest)):
                    newest = ts_key(mt)
            if coll == "files":
                applied += self.apply_files(client, docs)
            else:
                applied += self.apply_records(coll, docs)
        if newest:
            self.db.set_value("sync_since", newest)
        return applied

    def apply_records(self, coll, docs):
        cols = TABLES[coll]
        applied = 0
        with self.db.connect() as conn:
            for rid, fields in docs:
                row = conn.execute("SELECT * FROM %s WHERE rid = ?" % coll, (rid,)).fetchone()
                if dec(fields.get("_deleted")):
                    if row:
                        conn.execute("DELETE FROM %s WHERE id = ?" % coll, (row["id"],))
                        applied += 1
                    conn.execute("DELETE FROM tombstones WHERE coll = ? AND rid = ?", (coll, rid))
                    continue
                if conn.execute("SELECT 1 FROM tombstones WHERE coll = ? AND rid = ?", (coll, rid)).fetchone():
                    continue  # deleted here; our tombstone will be pushed
                data = {}
                for col, typ in cols.items():
                    v = dec(fields.get(col))
                    if v is None:
                        v = None if col == "remind_min" else (0 if typ is int else "")
                    elif typ is int:
                        v = int(v)
                    data[col] = v
                if coll in ("tasks", "events", "templates", "sheets", "decks") and not str(data.get(
                        {"templates": "name", "sheets": "name", "decks": "name"}.get(coll, "title"), "")).strip():
                    continue  # incomplete document (e.g. edited on one side, deleted on the other)
                remote_updated = dec(fields.get("updated")) or ""
                data["created"] = dec(fields.get("created")) or remote_updated
                data["updated"] = remote_updated
                if row:
                    if row["dirty"] and (row["updated"] or "") > remote_updated:
                        continue  # local edit is newer; it will be pushed
                    same = all(row[c] == data[c] for c in data)
                    if same and not row["dirty"]:
                        continue
                    sets = ", ".join('"%s" = ?' % c for c in data)
                    conn.execute("UPDATE %s SET %s, dirty = 0 WHERE id = ?" % (coll, sets),
                                 list(data.values()) + [row["id"]])
                else:
                    keys = list(data) + ["rid", "dirty"]
                    conn.execute("INSERT INTO %s (%s) VALUES (%s)" % (
                        coll, ", ".join('"%s"' % k for k in keys), ", ".join("?" for _ in keys)),
                        list(data.values()) + [rid, 0])
                applied += 1
        return applied

    # files ---------------------------------------------------------------

    def file_map(self):
        with self.db.connect() as conn:
            return {r["rid"]: dict(r) for r in conn.execute("SELECT * FROM file_map")}

    def remap(self, old, new):
        """Update file_map after a local rename/move of `old` (and its children)."""
        with self.db.connect() as conn:
            for r in conn.execute("SELECT rid, path FROM file_map WHERE path = ? OR path LIKE ?",
                                  (old, old + "/%")).fetchall():
                path = new + r["path"][len(old):]
                conn.execute("UPDATE file_map SET path = ?, meta_dirty = ? WHERE rid = ?",
                             (path, 1 if r["path"] == old else 0, r["rid"]))

    def apply_files(self, client, docs):
        root = self.ws.files_root
        fmap = self.file_map()
        applied = 0
        updates = [(rid, f) for rid, f in docs if not dec(f.get("_deleted"))]
        deletes = [rid for rid, f in docs if dec(f.get("_deleted"))]

        def local_path(parent_rid):
            if not parent_rid:
                return ""
            entry = fmap.get(parent_rid)
            return entry["path"] if entry else None

        # Apply updates parents-first: repeat while progress is made.
        pending = updates
        while pending:
            rest = []
            for rid, f in pending:
                parent = dec(f.get("parent")) or ""
                ppath = local_path(parent)
                if ppath is None and any(r == parent for r, _ in pending):
                    rest.append((rid, f))
                    continue
                applied += self.apply_file(client, rid, f, ppath or "", fmap)
            if len(rest) == len(pending):
                for rid, f in rest:  # parent unknown: place at the top level
                    applied += self.apply_file(client, rid, f, "", fmap)
                break
            pending = rest

        for rid in deletes:
            entry = fmap.pop(rid, None)
            if not entry:
                continue
            target = root / entry["path"]
            if target.exists():
                self.ws.delete_file(entry["path"])
            with self.db.connect() as conn:
                conn.execute("DELETE FROM file_map WHERE path = ? OR path LIKE ?",
                             (entry["path"], entry["path"] + "/%"))
            fmap = self.file_map()
            applied += 1
        return applied

    def apply_file(self, client, rid, f, parent_path, fmap):
        root = self.ws.files_root
        name = self.ws.safe_name(dec(f.get("name")) or "無題")
        is_dir = bool(dec(f.get("dir")))
        desired = (parent_path + "/" + name).lstrip("/")
        entry = fmap.get(rid)
        if entry and (root / entry["path"]).exists():
            if entry["path"] == desired or entry["meta_dirty"]:
                return 0  # unchanged, or renamed/moved here and not pushed yet
            target = root / desired
            meta_dirty = 0
            if target.exists():
                target = self.ws.unique(target)
                meta_dirty = 1
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(root / entry["path"]), str(target))
            new_rel = self.ws.rel(target)
            self.remap(entry["path"], new_rel)
            with self.db.connect() as conn:
                conn.execute("UPDATE file_map SET meta_dirty = ? WHERE rid = ?", (meta_dirty, rid))
            fmap.clear()
            fmap.update(self.file_map())
            return 1
        target = root / desired
        (root / parent_path).mkdir(parents=True, exist_ok=True)
        meta_dirty = 0
        if is_dir:
            # A local folder with the same name that was never synced is adopted;
            # one already linked to another cloud folder is kept separate.
            taken = any(e["path"] == desired and e["rid"] != rid for e in fmap.values())
            if target.exists() and (taken or not target.is_dir()):
                target, meta_dirty = self.ws.unique(target), 1
            target.mkdir(parents=True, exist_ok=True)
        else:
            chunks = int(dec(f.get("chunks")) or 1)
            data = b""
            for i in range(chunks):
                cf = client.get("chunks", "%s_%d" % (rid, i))
                if cf is None:
                    return 0  # not uploaded yet; picked up again on a later full change
                data += dec(cf.get("data")) or b""
            if target.exists():
                target, meta_dirty = self.ws.unique(target), 1
            target.write_bytes(data)
        st = target.stat()
        with self.db.connect() as conn:
            conn.execute("DELETE FROM file_map WHERE rid = ?", (rid,))
            conn.execute("INSERT OR REPLACE INTO file_map (rid, path, dir, size, mtime_ns, chunks, meta_dirty) "
                         "VALUES (?, ?, ?, ?, ?, ?, ?)",
                         (rid, self.ws.rel(target), int(is_dir), 0 if is_dir else st.st_size,
                          0 if is_dir else st.st_mtime_ns, 0 if is_dir else int(dec(f.get("chunks")) or 1),
                          meta_dirty))
        fmap.clear()
        fmap.update(self.file_map())
        return 1

    # -- push --------------------------------------------------------------

    def push(self, client):
        writes, done = [], []
        with self.db.connect() as conn:
            for coll in COLLECTIONS:
                for row in conn.execute("SELECT * FROM %s WHERE dirty > 0" % coll).fetchall():
                    rid = row["rid"]
                    if not rid:
                        rid = new_id()
                        conn.execute("UPDATE %s SET rid = ? WHERE id = ?" % coll, (rid, row["id"]))
                    data = {c: row[c] for c in TABLES[coll]}
                    data["created"], data["updated"] = row["created"], row["updated"]
                    writes.append(client.write_doc(coll, rid, data))
                    done.append((coll, row["id"], row["dirty"]))
            tombs = conn.execute("SELECT coll, rid FROM tombstones").fetchall()
            for t in tombs:
                writes.append(client.write_doc(t["coll"], t["rid"], {"_deleted": True}))
        if writes:
            client.commit(writes)
        with self.db.connect() as conn:
            for coll, item_id, dirty in done:
                conn.execute("UPDATE %s SET dirty = 0 WHERE id = ? AND dirty = ?" % coll, (item_id, dirty))
            for t in tombs:
                conn.execute("DELETE FROM tombstones WHERE coll = ? AND rid = ?", (t["coll"], t["rid"]))
        self.push_files(client)

    def push_files(self, client):
        root = self.ws.files_root
        by_path = {e["path"]: e for e in self.file_map().values()}
        seen = set()
        skipped = []
        entries = []
        for p in root.rglob("*"):
            rel = self.ws.rel(p)
            if rel.split("/")[0] == ".trash" or any(part.startswith(".") for part in rel.split("/")):
                continue
            entries.append((rel.count("/"), rel, p))
        entries.sort()
        for _, rel, p in entries:
            st = p.stat()
            is_dir = p.is_dir()
            if not is_dir and st.st_size > MAX_FILE:
                skipped.append(rel)
                continue
            seen.add(rel)
            entry = by_path.get(rel)
            parent_rel = rel.rsplit("/", 1)[0] if "/" in rel else ""
            parent_rid = by_path[parent_rel]["rid"] if parent_rel and parent_rel in by_path else ""
            if parent_rel and not parent_rid:
                continue  # parent folder was skipped
            content_changed = not is_dir and (entry is None or entry["size"] != st.st_size
                                              or entry["mtime_ns"] != st.st_mtime_ns)
            if entry and not content_changed and not entry["meta_dirty"]:
                continue
            rid = entry["rid"] if entry else new_id()
            chunks = entry["chunks"] if entry else 0
            writes = []
            if content_changed:
                data = p.read_bytes()
                n = max(1, -(-len(data) // CHUNK))
                for i in range(n):
                    client.commit([client.write_doc("chunks", "%s_%d" % (rid, i),
                                                    {"file": rid, "i": i, "data": data[i * CHUNK:(i + 1) * CHUNK]},
                                                    stamp=False)])
                writes += [client.delete_doc("chunks", "%s_%d" % (rid, i)) for i in range(n, chunks)]
                chunks = n
            writes.append(client.write_doc("files", rid, {
                "name": p.name, "parent": parent_rid, "dir": int(is_dir),
                "size": 0 if is_dir else st.st_size,
                "type": "" if is_dir else (mimetypes.guess_type(p.name)[0] or ""),
                "chunks": 0 if is_dir else chunks, "modified": iso_mtime(st)}))
            client.commit(writes)
            with self.db.connect() as conn:
                conn.execute("INSERT OR REPLACE INTO file_map (rid, path, dir, size, mtime_ns, chunks, meta_dirty) "
                             "VALUES (?, ?, ?, ?, ?, ?, 0)",
                             (rid, rel, int(is_dir), 0 if is_dir else st.st_size,
                              0 if is_dir else st.st_mtime_ns, chunks))
            by_path[rel] = {"rid": rid, "path": rel, "size": st.st_size, "mtime_ns": st.st_mtime_ns,
                            "chunks": chunks, "meta_dirty": 0, "dir": int(is_dir)}
        # Mapped files that disappeared locally were deleted (or moved outside the app).
        gone = [e for path, e in by_path.items() if path not in seen and not any(
            path == s or path.startswith(s + "/") for s in skipped)]
        if gone:
            writes = []
            for e in gone:
                writes.append(client.write_doc("files", e["rid"], {"_deleted": True}))
                writes += [client.delete_doc("chunks", "%s_%d" % (e["rid"], i)) for i in range(e["chunks"])]
            client.commit(writes)
            with self.db.connect() as conn:
                conn.executemany("DELETE FROM file_map WHERE rid = ?", [(e["rid"],) for e in gone])
        self.skipped = skipped
