"""My Workspace - a single-user productivity suite that runs on your own PC.

Run:  python -m workspace            (then open http://127.0.0.1:8765)
"""
import argparse
import base64
import calendar
import csv
import hashlib
import io
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import threading
import webbrowser
import zipfile
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

from . import mail
from .db import Database

STATIC_DIR = Path(__file__).resolve().parent / "static"
CRUD_TABLES = ("tasks", "events", "notes", "templates", "sheets")
MAX_UPLOAD = 1024 * 1024 * 1024  # 1 GiB


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------------------
# Application logic (independent from HTTP so it can be tested directly)
# ---------------------------------------------------------------------------

class Workspace:
    def __init__(self, data_dir):
        self.data_dir = Path(data_dir).resolve()
        self.files_root = self.data_dir / "files"
        self.files_root.mkdir(parents=True, exist_ok=True)
        self.db = Database(self.data_dir / "workspace.db")
        self._lock = threading.Lock()

    # ---- tasks ----------------------------------------------------------

    def list_tasks(self, q):
        where, params = [], []
        status = q.get("status", "open")
        if status == "open":
            where.append("done = 0")
        elif status == "done":
            where.append("done = 1")
        if q.get("project"):
            where.append("project = ?")
            params.append(q["project"])
        if q.get("q"):
            where.append("(title LIKE ? OR notes LIKE ?)")
            params += ["%" + q["q"] + "%"] * 2
        order = "done ASC, CASE WHEN due = '' THEN 1 ELSE 0 END, due ASC, priority DESC, id DESC"
        return self.db.list("tasks", " AND ".join(where), params, order)

    def update_task(self, task_id, data):
        before = self.db.get("tasks", task_id)
        if before is None:
            raise ApiError(404, "not found")
        task = self.db.update("tasks", task_id, data)
        # Completing a repeating task schedules its next occurrence.
        if task and task["done"] and not before["done"] and task["repeat"]:
            nxt = next_due(task["due"] or date.today().isoformat(), task["repeat"])
            if nxt:
                self.db.create("tasks", {
                    "title": task["title"], "notes": task["notes"], "due": nxt,
                    "priority": task["priority"], "project": task["project"],
                    "repeat": task["repeat"]})
        return task

    def projects(self):
        rows = self.db.list("tasks", "project != ''", order="project")
        return sorted({r["project"] for r in rows})

    # ---- events ---------------------------------------------------------

    def list_events(self, q):
        start = q.get("from") or "0000"
        end = q.get("to") or "9999"
        # An event overlaps [from, to] when it starts before `to` and ends after `from`.
        return self.db.list(
            "events",
            "start <= ? AND (CASE WHEN \"end\" = '' THEN start ELSE \"end\" END) >= ?",
            (end + "T99", start), order="start ASC")

    # ---- notes ----------------------------------------------------------

    def list_notes(self, q):
        if q.get("q"):
            like = "%" + q["q"] + "%"
            return self.db.list("notes", "title LIKE ? OR body LIKE ? OR tags LIKE ?",
                                (like, like, like), order="pinned DESC, updated DESC")
        if q.get("tag"):
            return self.db.list("notes", "(',' || REPLACE(tags, ' ', '') || ',') LIKE ?",
                                ("%," + q["tag"] + ",%",), order="pinned DESC, updated DESC")
        return self.db.list("notes", order="pinned DESC, updated DESC")

    # ---- sheets ---------------------------------------------------------

    def sheet_csv(self, sheet_id):
        sheet = self.db.get("sheets", sheet_id)
        if not sheet:
            raise ApiError(404, "not found")
        buf = io.StringIO()
        csv.writer(buf).writerows(json.loads(sheet["data"] or "[]"))
        return sheet["name"], buf.getvalue()

    def import_csv(self, name, text):
        rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
        return self.db.create("sheets", {"name": name or "インポート",
                                         "data": json.dumps(rows, ensure_ascii=False)})

    # ---- files ----------------------------------------------------------

    def resolve(self, rel, must_exist=True):
        rel = (rel or "").replace("\\", "/").strip("/")
        target = (self.files_root / rel).resolve()
        if target != self.files_root and self.files_root not in target.parents:
            raise ApiError(400, "invalid path")
        if must_exist and not target.exists():
            raise ApiError(404, "not found")
        return target

    def rel(self, path):
        return path.relative_to(self.files_root).as_posix()

    def list_files(self, rel):
        folder = self.resolve(rel)
        if not folder.is_dir():
            raise ApiError(400, "not a folder")
        items = []
        for p in folder.iterdir():
            if p.name.startswith("."):
                continue
            st = p.stat()
            items.append({"name": p.name, "path": self.rel(p), "dir": p.is_dir(),
                          "size": st.st_size if p.is_file() else None,
                          "modified": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="minutes")})
        items.sort(key=lambda i: (not i["dir"], i["name"].lower()))
        return {"path": self.rel(folder) if folder != self.files_root else "", "items": items}

    def search_files(self, term, limit=50):
        term = term.lower()
        out = []
        for p in self.files_root.rglob("*"):
            if term in p.name.lower() and not p.name.startswith("."):
                out.append({"name": p.name, "path": self.rel(p), "dir": p.is_dir()})
                if len(out) >= limit:
                    break
        return out

    @staticmethod
    def safe_name(name):
        name = (name or "").replace("\\", "/").split("/")[-1].strip()
        name = re.sub(r'[\x00-\x1f<>:"|?*]', "_", name)
        if name in ("", ".", ".."):
            raise ApiError(400, "invalid name")
        return name

    @staticmethod
    def unique(path):
        if not path.exists():
            return path
        stem, suffix = path.stem, path.suffix
        i = 2
        while True:
            cand = path.with_name("%s (%d)%s" % (stem, i, suffix))
            if not cand.exists():
                return cand
            i += 1

    def save_upload(self, folder_rel, name, stream, length):
        folder = self.resolve(folder_rel)
        if not folder.is_dir():
            raise ApiError(400, "not a folder")
        with self._lock:
            target = self.unique(folder / self.safe_name(name))
            target.touch()
        remaining = length
        with open(target, "wb") as fh:
            while remaining > 0:
                chunk = stream.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                fh.write(chunk)
                remaining -= len(chunk)
        return {"path": self.rel(target)}

    def mkdir(self, folder_rel, name):
        target = self.resolve(folder_rel) / self.safe_name(name)
        if target.exists():
            raise ApiError(409, "同じ名前が既に存在します")
        target.mkdir()
        return {"path": self.rel(target)}

    def rename(self, rel, new_name):
        src = self.resolve(rel)
        if src == self.files_root:
            raise ApiError(400, "invalid path")
        dst = src.with_name(self.safe_name(new_name))
        if dst.exists():
            raise ApiError(409, "同じ名前が既に存在します")
        src.rename(dst)
        return {"path": self.rel(dst)}

    def move(self, rel, folder_rel):
        src = self.resolve(rel)
        folder = self.resolve(folder_rel)
        if src == self.files_root or not folder.is_dir():
            raise ApiError(400, "invalid path")
        if src.is_dir() and (folder == src or src in folder.parents):
            raise ApiError(400, "フォルダを自身の中には移動できません")
        dst = self.unique(folder / src.name)
        shutil.move(str(src), str(dst))
        return {"path": self.rel(dst)}

    def delete_file(self, rel):
        target = self.resolve(rel)
        if target == self.files_root:
            raise ApiError(400, "invalid path")
        # Deleted files go to .trash so mistakes can be recovered by hand.
        trash = self.files_root / ".trash"
        trash.mkdir(exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-")
        shutil.move(str(target), str(self.unique(trash / (stamp + target.name))))
        return {"ok": True}

    def organize(self, folder_rel):
        """Sort loose files in a folder into sub-folders by extension rules."""
        settings = self.db.get_settings()
        rules = settings.get("file_rules") or []
        prefix = settings.get("file_name_prefix_date")
        folder = self.resolve(folder_rel)
        moved = []
        for p in sorted(folder.iterdir()):
            if not p.is_file() or p.name.startswith("."):
                continue
            ext = p.suffix.lower().lstrip(".")
            dest_name = next((r["folder"] for r in rules
                              if ext in [e.lower().lstrip(".") for e in r.get("ext", [])]), None)
            if not dest_name:
                continue
            dest = folder / self.safe_name(dest_name)
            dest.mkdir(exist_ok=True)
            name = p.name
            if prefix and not re.match(r"^\d{4}-\d{2}-\d{2}_", name):
                stamp = datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m-%d_")
                name = stamp + name
            target = self.unique(dest / name)
            shutil.move(str(p), str(target))
            moved.append({"from": self.rel(p), "to": self.rel(target)})
        return {"moved": moved}

    # ---- dashboard / search / backup -------------------------------------

    def dashboard(self, today=None):
        today = today or date.today().isoformat()
        week = (date.fromisoformat(today) + timedelta(days=7)).isoformat()
        tasks = self.db.list("tasks", "done = 0 AND due != '' AND due <= ?", (today,),
                             order="due ASC, priority DESC")
        undated = self.db.list("tasks", "done = 0 AND due = '' AND priority >= 2",
                               order="id DESC", limit=10)
        upcoming_tasks = self.db.list("tasks", "done = 0 AND due > ? AND due <= ?",
                                      (today, week), order="due ASC")
        events_today = self.list_events({"from": today, "to": today})
        events_week = [e for e in self.list_events({"from": today, "to": week})
                       if e["start"][:10] > today]
        notes = self.db.list("notes", order="pinned DESC, updated DESC", limit=6)
        done_today = len(self.db.list("tasks", "done = 1 AND updated LIKE ?", (today + "%",)))
        return {"today": today, "tasks": tasks + undated, "upcoming_tasks": upcoming_tasks,
                "events_today": events_today, "events_week": events_week,
                "notes": notes, "done_today": done_today}

    def search(self, term):
        if not term.strip():
            return {}
        like = "%" + term + "%"
        return {
            "tasks": self.db.list("tasks", "title LIKE ? OR notes LIKE ?", (like, like), limit=20),
            "events": self.db.list("events", "title LIKE ? OR notes LIKE ? OR location LIKE ?",
                                   (like, like, like), order="start DESC", limit=20),
            "notes": self.db.list("notes", "title LIKE ? OR body LIKE ? OR tags LIKE ?",
                                  (like, like, like), order="updated DESC", limit=20),
            "sheets": self.db.list("sheets", "name LIKE ? OR data LIKE ?", (like, like), limit=20),
            "files": self.search_files(term, limit=20),
        }

    def backup(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            # Use SQLite's backup API so the copy is consistent.
            snap = self.data_dir / ".backup.db"
            with self.db.connect() as src:
                dst = sqlite3.connect(str(snap))
                src.backup(dst)
                dst.close()
            zf.write(snap, "workspace.db")
            snap.unlink()
            for p in self.files_root.rglob("*"):
                if p.is_file() and ".trash" not in p.relative_to(self.files_root).parts:
                    zf.write(p, "files/" + self.rel(p))
        return buf.getvalue()

    # ---- settings ---------------------------------------------------------

    def export_json(self):
        """Export everything in the format the web version imports."""
        prefix = {"tasks": "t", "events": "e", "notes": "n", "templates": "m", "sheets": "s"}
        out = {"format": "myworkspace", "version": 1, "exported": datetime.now().isoformat(timespec="seconds"),
               "collections": {}, "files": []}
        for table, p in prefix.items():
            out["collections"][table] = [dict(r, id="local-%s%d" % (p, r["id"])) for r in self.db.list(table)]
        s = self.db.get_settings()
        out["settings"] = {"file_rules": s["file_rules"], "file_name_prefix_date": s["file_name_prefix_date"]}
        fid = lambda rel: "local-f" + hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16] if rel else ""
        for p in sorted(self.files_root.rglob("*")):
            rel = self.rel(p)
            if rel.split("/")[0] == ".trash" or p.name.startswith("."):
                continue
            parent = rel.rsplit("/", 1)[0] if "/" in rel else ""
            rec = {"id": fid(rel), "name": p.name, "parent": fid(parent), "dir": p.is_dir(),
                   "modified": datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds")}
            if p.is_file():
                rec["size"] = p.stat().st_size
                rec["type"] = mimetypes.guess_type(p.name)[0] or ""
                rec["data"] = base64.b64encode(p.read_bytes()).decode("ascii")
            out["files"].append(rec)
        return out

    def public_settings(self):
        s = self.db.get_settings()
        s["mail"] = dict(s["mail"])
        s["mail"]["password_set"] = bool(s["mail"].get("password"))
        s["mail"]["password"] = ""
        return s

    def save_settings(self, data):
        current = self.db.get_settings()
        if "mail" in data:
            new_mail = dict(current["mail"])
            new_mail.update({k: v for k, v in data["mail"].items() if k != "password_set"})
            if not data["mail"].get("password"):
                new_mail["password"] = current["mail"].get("password", "")
            data["mail"] = new_mail
        self.db.save_settings(data)
        return self.public_settings()


def next_due(due, repeat):
    try:
        d = date.fromisoformat(due[:10])
    except ValueError:
        return None
    if repeat == "daily":
        return (d + timedelta(days=1)).isoformat()
    if repeat == "weekdays":
        d += timedelta(days=1)
        while d.weekday() >= 5:
            d += timedelta(days=1)
        return d.isoformat()
    if repeat == "weekly":
        return (d + timedelta(days=7)).isoformat()
    if repeat == "monthly":
        y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
        return date(y, m, min(d.day, calendar.monthrange(y, m)[1])).isoformat()
    if repeat == "yearly":
        try:
            return d.replace(year=d.year + 1).isoformat()
        except ValueError:
            return d.replace(year=d.year + 1, day=28).isoformat()
    return None


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------

def make_handler(ws, port):
    allowed_hosts = {"127.0.0.1:%d" % port, "localhost:%d" % port}

    class Handler(BaseHTTPRequestHandler):
        server_version = "MyWorkspace/1.0"

        def log_message(self, fmt, *args):
            if os.environ.get("WORKSPACE_DEBUG"):
                super().log_message(fmt, *args)

        # -- helpers --

        def send_json(self, obj, status=200):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def send_bytes(self, data, ctype, filename=None, inline=False):
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-Type-Options", "nosniff")
            if filename:
                disp = "inline" if inline else "attachment"
                self.send_header("Content-Disposition",
                                 "%s; filename*=UTF-8''%s" % (disp, quote(filename)))
            self.end_headers()
            self.wfile.write(data)

        def read_json(self):
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return {}
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                raise ApiError(400, "invalid JSON")
            if not isinstance(data, dict):
                raise ApiError(400, "invalid JSON")
            return data

        def guard(self):
            # Only answer requests addressed to localhost (blocks DNS rebinding).
            if self.headers.get("Host") not in allowed_hosts:
                raise ApiError(403, "forbidden host")

        def guard_write(self):
            # A custom header cannot be sent cross-site without a CORS preflight,
            # which this server never approves, so other websites cannot write.
            if self.headers.get("X-Workspace") != "1":
                raise ApiError(403, "missing X-Workspace header")

        def dispatch(self, method):
            try:
                self.guard()
                url = urlparse(self.path)
                q = {k: v[-1] for k, v in parse_qs(url.query).items()}
                if not url.path.startswith("/api/"):
                    if method != "GET":
                        raise ApiError(405, "method not allowed")
                    return self.serve_static(url.path)
                if method != "GET":
                    self.guard_write()
                parts = [p for p in url.path.split("/")[2:] if p]
                result = self.route(method, parts, q)
                if result is not None:
                    self.send_json(result)
            except ApiError as exc:
                self.send_json({"error": exc.message}, exc.status)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 400)
            except mail.MailError as exc:
                self.send_json({"error": str(exc)}, 502)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:  # pragma: no cover - last resort
                self.send_json({"error": "internal error: %s" % exc}, 500)

        def do_GET(self):
            self.dispatch("GET")

        def do_POST(self):
            self.dispatch("POST")

        def do_PUT(self):
            self.dispatch("PUT")

        def do_DELETE(self):
            self.dispatch("DELETE")

        def serve_static(self, path):
            name = "index.html" if path in ("/", "") else path.lstrip("/")
            target = (STATIC_DIR / name).resolve()
            if STATIC_DIR not in target.parents or not target.is_file():
                raise ApiError(404, "not found")
            ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            self.send_bytes(target.read_bytes(), ctype)

        # -- routing --

        def route(self, method, parts, q):
            head = parts[0] if parts else ""
            rest = parts[1:]

            if head in CRUD_TABLES:
                return self.route_crud(head, method, rest, q)
            if head == "dashboard" and method == "GET":
                return ws.dashboard(q.get("today"))
            if head == "projects" and method == "GET":
                return ws.projects()
            if head == "search" and method == "GET":
                return ws.search(q.get("q", ""))
            if head == "settings":
                if method == "GET":
                    return ws.public_settings()
                if method == "PUT":
                    return ws.save_settings(self.read_json())
            if head == "export" and method == "GET":
                body = json.dumps(ws.export_json(), ensure_ascii=False).encode()
                self.send_bytes(body, "application/json", "workspace-export.json")
                return None
            if head == "backup" and method == "GET":
                stamp = datetime.now().strftime("%Y%m%d-%H%M")
                self.send_bytes(ws.backup(), "application/zip",
                                "workspace-backup-%s.zip" % stamp)
                return None
            if head == "files":
                return self.route_files(method, rest, q)
            if head == "mail":
                return self.route_mail(method, rest, q)
            raise ApiError(404, "not found")

        def route_crud(self, table, method, rest, q):
            if table == "sheets" and rest[-1:] == ["csv"] and method == "GET":
                name, text = ws.sheet_csv(int(rest[0]))
                self.send_bytes(("﻿" + text).encode("utf-8"), "text/csv; charset=utf-8",
                                name + ".csv")
                return None
            if table == "sheets" and rest == ["import"] and method == "POST":
                data = self.read_json()
                return ws.import_csv(data.get("name", ""), data.get("csv", ""))
            if not rest:
                if method == "GET":
                    if table == "tasks":
                        return ws.list_tasks(q)
                    if table == "events":
                        return ws.list_events(q)
                    if table == "notes":
                        return ws.list_notes(q)
                    cols = "id, name, created, updated" if table == "sheets" else "*"
                    with ws.db.connect() as conn:
                        return [dict(r) for r in conn.execute(
                            "SELECT %s FROM %s ORDER BY updated DESC" % (cols, table))]
                if method == "POST":
                    return ws.db.create(table, self.read_json())
                raise ApiError(405, "method not allowed")
            if not rest[0].isdigit():
                raise ApiError(404, "not found")
            item_id = int(rest[0])
            if method == "GET":
                item = ws.db.get(table, item_id)
            elif method == "PUT":
                data = self.read_json()
                item = ws.update_task(item_id, data) if table == "tasks" else \
                    ws.db.update(table, item_id, data)
            elif method == "DELETE":
                item = {"ok": True} if ws.db.delete(table, item_id) else None
            else:
                raise ApiError(405, "method not allowed")
            if item is None:
                raise ApiError(404, "not found")
            return item

        def route_files(self, method, rest, q):
            action = rest[0] if rest else ""
            if method == "GET" and action == "":
                return ws.list_files(q.get("path", ""))
            if method == "GET" and action in ("download", "view"):
                target = ws.resolve(q.get("path", ""))
                if not target.is_file():
                    raise ApiError(400, "not a file")
                ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                # Never render active content (HTML/SVG) inline from the app origin.
                inline = action == "view" and ctype.split("/")[0] in ("image", "text", "audio", "video") \
                    and ctype not in ("image/svg+xml", "text/html")
                if not inline:
                    ctype = ctype if action == "download" else "application/octet-stream"
                elif ctype.startswith("text/"):
                    ctype += "; charset=utf-8"
                self.send_bytes(target.read_bytes(), ctype, target.name, inline=inline)
                return None
            if method == "POST" and action == "upload":
                length = int(self.headers.get("Content-Length") or 0)
                if length > MAX_UPLOAD:
                    raise ApiError(413, "file too large")
                return ws.save_upload(q.get("path", ""), q.get("name", ""), self.rfile, length)
            if method == "POST" and action == "mkdir":
                d = self.read_json()
                return ws.mkdir(d.get("path", ""), d.get("name", ""))
            if method == "POST" and action == "rename":
                d = self.read_json()
                return ws.rename(d.get("path", ""), d.get("name", ""))
            if method == "POST" and action == "move":
                d = self.read_json()
                return ws.move(d.get("path", ""), d.get("to", ""))
            if method == "POST" and action == "organize":
                return ws.organize(self.read_json().get("path", ""))
            if method == "DELETE" and action == "":
                return ws.delete_file(q.get("path", ""))
            raise ApiError(404, "not found")

        def route_mail(self, method, rest, q):
            cfg = ws.db.get_settings()["mail"]
            action = rest[0] if rest else ""
            if method == "GET" and action == "inbox":
                return mail.list_inbox(cfg, int(q.get("limit") or 30), q.get("unread") == "1")
            if method == "GET" and action == "message":
                return mail.read_message(cfg, q.get("uid", ""))
            if method == "POST" and action == "send":
                d = self.read_json()
                mail.send(cfg, d.get("to", ""), d.get("subject", ""), d.get("body", ""),
                          d.get("cc", ""), d.get("in_reply_to", ""))
                return {"ok": True}
            raise ApiError(404, "not found")

    return Handler


def default_data_dir():
    return Path(os.environ.get("WORKSPACE_DATA") or Path.cwd() / "data")


def main(argv=None):
    parser = argparse.ArgumentParser(description="My Workspace")
    parser.add_argument("--port", type=int, default=int(os.environ.get("WORKSPACE_PORT", 8765)))
    parser.add_argument("--data", default=str(default_data_dir()), help="data directory")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser")
    args = parser.parse_args(argv)

    ws = Workspace(args.data)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(ws, args.port))
    url = "http://127.0.0.1:%d/" % args.port
    print("My Workspace: %s  (data: %s)  Ctrl+C で終了" % (url, ws.data_dir))
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n終了しました")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
