import http.client
import io
import json
import socket
import tempfile
import threading
import unittest
import zipfile
from datetime import date, timedelta
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

from workspace.server import Workspace, make_handler, next_due


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ws = Workspace(self.tmp.name)
        self.port = free_port()
        self.server = ThreadingHTTPServer(("127.0.0.1", self.port), make_handler(self.ws, self.port))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def req(self, method, path, body=None, headers=None, raw=False):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        hdrs = {"X-Workspace": "1"}
        hdrs.update(headers or {})
        data = None
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
        conn.request(method, quote(path, safe="/?=&%:"), body=data, headers=hdrs)
        res = conn.getresponse()
        payload = res.read()
        conn.close()
        if raw:
            return res.status, payload, res
        return res.status, json.loads(payload or b"null")

    # ---- security guards ----

    def test_rejects_foreign_host(self):
        status, _ = self.req("GET", "/api/tasks", headers={"Host": "evil.example:%d" % self.port})
        self.assertEqual(status, 403)

    def test_write_requires_custom_header(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        conn.request("POST", "/api/tasks", body=b'{"title":"x"}')
        self.assertEqual(conn.getresponse().status, 403)
        conn.close()

    def test_serves_index(self):
        status, body, res = self.req("GET", "/", raw=True)
        self.assertEqual(status, 200)
        self.assertIn(b"My Workspace", body)
        status, _, _ = self.req("GET", "/../server.py", raw=True)
        self.assertEqual(status, 404)

    # ---- tasks ----

    def test_task_crud_and_repeat(self):
        status, task = self.req("POST", "/api/tasks", {"title": "日報", "due": "2026-01-31", "repeat": "monthly"})
        self.assertEqual(status, 200)
        self.assertEqual(task["title"], "日報")
        status, _ = self.req("PUT", "/api/tasks/%d" % task["id"], {"done": 1})
        self.assertEqual(status, 200)
        _, open_tasks = self.req("GET", "/api/tasks?status=open")
        self.assertEqual([t["due"] for t in open_tasks], ["2026-02-28"])
        status, _ = self.req("DELETE", "/api/tasks/%d" % task["id"])
        self.assertEqual(status, 200)
        status, _ = self.req("GET", "/api/tasks/%d" % task["id"])
        self.assertEqual(status, 404)

    def test_task_requires_title(self):
        status, body = self.req("POST", "/api/tasks", {"title": " "})
        self.assertEqual(status, 400)

    def test_next_due(self):
        self.assertEqual(next_due("2026-10-16", "weekdays"), "2026-10-19")  # Fri -> Mon
        self.assertEqual(next_due("2026-12-31", "monthly"), "2027-01-31")
        self.assertEqual(next_due("2028-02-29", "yearly"), "2029-02-28")
        self.assertIsNone(next_due("", "daily"))

    # ---- events / dashboard ----

    def test_events_range_and_dashboard(self):
        today = date.today().isoformat()
        self.req("POST", "/api/events", {"title": "会議", "start": today + "T10:00", "end": today + "T11:00"})
        self.req("POST", "/api/events", {"title": "出張", "start": "2026-03-01", "end": "2026-03-03", "all_day": 1})
        _, ev = self.req("GET", "/api/events?from=2026-03-02&to=2026-03-02")
        self.assertEqual([e["title"] for e in ev], ["出張"])
        self.req("POST", "/api/tasks", {"title": "期限切れ", "due": (date.today() - timedelta(days=1)).isoformat()})
        _, d = self.req("GET", "/api/dashboard?today=" + today)
        self.assertEqual([e["title"] for e in d["events_today"]], ["会議"])
        self.assertEqual([t["title"] for t in d["tasks"]], ["期限切れ"])

    # ---- notes / search ----

    def test_notes_and_search(self):
        self.req("POST", "/api/notes", {"title": "議事録", "body": "予算の件", "tags": "会議,重要"})
        _, notes = self.req("GET", "/api/notes?tag=重要")
        self.assertEqual(len(notes), 1)
        _, res = self.req("GET", "/api/search?q=%E4%BA%88%E7%AE%97")
        self.assertEqual(len(res["notes"]), 1)

    # ---- sheets ----

    def test_sheet_csv_roundtrip(self):
        _, sheet = self.req("POST", "/api/sheets/import", {"name": "売上", "csv": "﻿品目,金額\nA,100\n"})
        _, got = self.req("GET", "/api/sheets/%d" % sheet["id"])
        self.assertEqual(json.loads(got["data"]), [["品目", "金額"], ["A", "100"]])
        status, body, res = self.req("GET", "/api/sheets/%d/csv" % sheet["id"], raw=True)
        self.assertEqual(status, 200)
        self.assertEqual(body.decode("utf-8-sig").splitlines(), ["品目,金額", "A,100"])
        _, lst = self.req("GET", "/api/sheets")
        self.assertNotIn("data", lst[0])

    # ---- files ----

    def test_file_upload_list_and_traversal(self):
        status, r = self.req("POST", "/api/files/upload?path=&name=memo.txt", b"hello")
        self.assertEqual(status, 200)
        status, r2 = self.req("POST", "/api/files/upload?path=&name=memo.txt", b"again")
        self.assertEqual(r2["path"], "memo (2).txt")
        _, lst = self.req("GET", "/api/files?path=")
        self.assertEqual([i["name"] for i in lst["items"]], ["memo (2).txt", "memo.txt"])
        status, body, _ = self.req("GET", "/api/files/download?path=memo.txt", raw=True)
        self.assertEqual(body, b"hello")
        for bad in ("../workspace.db", "..%2Fworkspace.db", "/etc/passwd"):
            status, _ = self.req("GET", "/api/files/download?path=" + bad)
            self.assertIn(status, (400, 404), bad)
        status, r = self.req("POST", "/api/files/upload?path=&name=..%2F..%2Fx.txt", b"x")
        self.assertEqual(r["path"], "x.txt")

    def test_file_organize_rename_move_delete(self):
        root = Path(self.tmp.name) / "files"
        (root / "photo.JPG").write_bytes(b"1")
        (root / "report.pdf").write_bytes(b"2")
        (root / "unknown.xyz").write_bytes(b"3")
        _, r = self.req("POST", "/api/files/organize", {"path": ""})
        self.assertEqual(len(r["moved"]), 2)
        self.assertTrue(any(p.name.endswith("_photo.JPG") for p in (root / "画像").iterdir()))
        self.assertTrue((root / "unknown.xyz").exists())
        self.req("POST", "/api/files/mkdir", {"path": "", "name": "保管"})
        _, r = self.req("POST", "/api/files/move", {"path": "unknown.xyz", "to": "保管"})
        self.assertEqual(r["path"], "保管/unknown.xyz")
        status, _ = self.req("POST", "/api/files/move", {"path": "保管", "to": "保管"})
        self.assertEqual(status, 400)
        self.req("POST", "/api/files/rename", {"path": "保管/unknown.xyz", "name": "data.xyz"})
        self.req("DELETE", "/api/files?path=" + "%E4%BF%9D%E7%AE%A1/data.xyz")
        self.assertFalse((root / "保管" / "data.xyz").exists())
        self.assertEqual(len(list((root / ".trash").iterdir())), 1)
        status, _ = self.req("DELETE", "/api/files?path=")
        self.assertEqual(status, 400)

    # ---- settings / backup / mail ----

    def test_settings_hide_password(self):
        self.req("PUT", "/api/settings", {"mail": {"username": "me@example.com", "password": "secret"}})
        _, s = self.req("GET", "/api/settings")
        self.assertEqual(s["mail"]["password"], "")
        self.assertTrue(s["mail"]["password_set"])
        # Saving without a password keeps the stored one.
        self.req("PUT", "/api/settings", {"mail": {"from_name": "私"}})
        self.assertEqual(self.ws.db.get_settings()["mail"]["password"], "secret")

    def test_mail_not_configured(self):
        status, body = self.req("GET", "/api/mail/inbox")
        self.assertEqual(status, 502)
        self.assertIn("未入力", body["error"])

    def test_backup_zip(self):
        self.req("POST", "/api/notes", {"title": "x"})
        self.req("POST", "/api/files/upload?path=&name=a.txt", b"a")
        status, body, _ = self.req("GET", "/api/backup", raw=True)
        self.assertEqual(status, 200)
        names = zipfile.ZipFile(io.BytesIO(body)).namelist()
        self.assertIn("workspace.db", names)
        self.assertIn("files/a.txt", names)


    def test_export_for_web(self):
        self.req("POST", "/api/tasks", {"title": "移行"})
        self.req("POST", "/api/files/mkdir", {"path": "", "name": "書類"})
        self.req("POST", "/api/files/upload?path=%E6%9B%B8%E9%A1%9E&name=a.txt", b"abc")
        status, body, _ = self.req("GET", "/api/export", raw=True)
        data = json.loads(body)
        self.assertEqual(data["format"], "myworkspace")
        self.assertEqual(data["collections"]["tasks"][0]["title"], "移行")
        folder = next(f for f in data["files"] if f["dir"])
        f = next(f for f in data["files"] if not f["dir"])
        self.assertEqual(f["parent"], folder["id"])
        self.assertEqual(folder["parent"], "")
        self.assertEqual(f["data"], "YWJj")

if __name__ == "__main__":
    unittest.main()
