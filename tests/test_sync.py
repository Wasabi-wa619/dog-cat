"""Sync tests against the Firebase emulator.

Run the emulator first (project id demo-ws), e.g.:
    firebase emulators:start --only auth,firestore --project demo-ws
The tests are skipped when it is not running.
"""
import json
import tempfile
import unittest
import urllib.request
from pathlib import Path

from workspace import sync
from workspace.server import Workspace

EMU = "127.0.0.1"
PROJECT = "demo-ws"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def emulator_running():
    try:
        OPENER.open("http://%s:9099/" % EMU, timeout=1)
        return True
    except urllib.error.HTTPError:
        return True
    except OSError:
        return False


def call(method, url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"}, method=method)
    with OPENER.open(req, timeout=10) as res:
        raw = res.read()
    return json.loads(raw) if raw else {}


@unittest.skipUnless(emulator_running(), "Firebase emulator not running")
class SyncTest(unittest.TestCase):
    def setUp(self):
        call("DELETE", "http://%s:9099/emulator/v1/projects/%s/accounts" % (EMU, PROJECT))
        call("DELETE", "http://%s:8080/emulator/v1/projects/%s/databases/(default)/documents" % (EMU, PROJECT))
        self.tmp = tempfile.TemporaryDirectory()
        cfg = Path(self.tmp.name) / "config.js"
        cfg.write_text("export const firebaseConfig = { apiKey: 'demo-key', projectId: '%s', emulator: '%s' };"
                       % (PROJECT, EMU))
        self.cfg = sync.load_firebase_config(cfg)
        # "web" side: a second client logged into the same account
        self.web = sync.FirebaseClient(self.cfg)
        res = call("POST", "http://%s:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=x" % EMU,
                   {"email": "me@example.com", "password": "secret123", "returnSecureToken": True})
        self.web.id_token, self.web.uid = res["idToken"], res["localId"]
        self.web.refresh_token, self.web.expires = res["refreshToken"], 9e18
        self.ws = Workspace(Path(self.tmp.name) / "data")
        self.ws.syncer.config_path = cfg
        self.ws.syncer.login("me@example.com", "secret123")
        self.sync()

    def tearDown(self):
        self.tmp.cleanup()

    def sync(self):
        self.ws.syncer.sync_once()
        st = self.ws.syncer.status()
        self.assertEqual(st["state"], "synced", st["error"])

    def remote(self, coll):
        return {rid: {k: sync.dec(v) for k, v in f.items()} for rid, f in self.web.changed_since(coll, None)}

    def web_write(self, coll, rid, data):
        self.web.commit([self.web.write_doc(coll, rid, data)])

    def test_login_errors(self):
        s = Workspace(Path(self.tmp.name) / "d2").syncer
        s.config_path = self.ws.syncer.config_path
        with self.assertRaises(sync.SyncError) as cm:
            s.login("me@example.com", "wrong-password")
        self.assertIn("パスワード", str(cm.exception))

    def test_records_both_ways(self):
        task = self.ws.db.create("tasks", {"title": "ローカルのタスク", "due": "2026-10-20"})
        note = self.ws.db.create("notes", {"title": "メモ", "body": "本文"})
        self.sync()
        tasks = self.remote("tasks")
        self.assertEqual([t["title"] for t in tasks.values()], ["ローカルのタスク"])
        rid = next(iter(tasks))

        # The web app edits the task, adds an event and deletes the note.
        t = dict(tasks[rid])
        t.pop("_mt")
        t.update(done=1, updated="2099-01-01T00:00:00")
        self.web_write("tasks", rid, t)
        self.web_write("events", "ev1", {"title": "会議", "start": "2026-10-21T10:00", "end": "", "all_day": 0,
                                          "location": "", "notes": "", "remind_min": None,
                                          "created": "2026-10-14T00:00:00", "updated": "2026-10-14T00:00:00"})
        note_rid = self.ws.db.get("notes", note["id"])["rid"]
        self.web_write("notes", note_rid, {"_deleted": True})
        self.sync()
        self.assertEqual(self.ws.db.get("tasks", task["id"])["done"], 1)
        self.assertEqual([e["title"] for e in self.ws.db.list("events")], ["会議"])
        self.assertIsNone(self.ws.db.get("notes", note["id"]))
        self.assertEqual(self.ws.syncer.status()["pending"], 0)

        # Local delete becomes a tombstone in the cloud.
        self.ws.db.delete("tasks", task["id"])
        self.sync()
        self.assertTrue(self.remote("tasks")[rid]["_deleted"])

    def test_conflict_newer_wins(self):
        task = self.ws.db.create("tasks", {"title": "元"})
        self.sync()
        rid = self.ws.db.get("tasks", task["id"])["rid"]
        # web edits with an older timestamp; local edits afterwards (newer)
        self.web_write("tasks", rid, {"title": "Web", "notes": "", "due": "", "priority": 1, "project": "",
                                      "done": 0, "repeat": "", "created": "2000-01-01T00:00:00",
                                      "updated": "2000-01-01T00:00:00"})
        self.ws.db.update("tasks", task["id"], {"title": "ローカル"})
        self.sync()
        self.assertEqual(self.ws.db.get("tasks", task["id"])["title"], "ローカル")
        self.assertEqual(self.remote("tasks")[rid]["title"], "ローカル")

    def test_files_both_ways(self):
        root = self.ws.files_root
        (root / "書類").mkdir()
        (root / "書類" / "a.txt").write_bytes(b"hello")
        big = bytes(range(256)) * 6000  # ~1.5MB -> 3 chunks
        (root / "big.bin").write_bytes(big)
        (root / "huge.bin").write_bytes(b"\0" * (sync.MAX_FILE + 1))
        self.sync()
        files = {f["name"]: (rid, f) for rid, f in self.remote("files").items()}
        self.assertEqual(sorted(files), ["a.txt", "big.bin", "書類"])
        self.assertEqual(files["a.txt"][1]["parent"], files["書類"][0])
        self.assertEqual(files["big.bin"][1]["chunks"], 3)
        self.assertEqual(self.ws.syncer.status()["skipped"], ["huge.bin"])

        # Rename locally keeps the same cloud id.
        self.ws.rename("書類", "資料")
        self.sync()
        folder_rid = files["書類"][0]
        self.assertEqual(self.remote("files")[folder_rid]["name"], "資料")

        # Web uploads a file into the folder and moves a.txt to the top level.
        self.web.commit([self.web.write_doc("chunks", "w1_0", {"file": "w1", "i": 0, "data": b"from web"},
                                            stamp=False)])
        self.web_write("files", "w1", {"name": "web.txt", "parent": folder_rid, "dir": 0, "size": 8,
                                       "type": "text/plain", "chunks": 1, "modified": "2026-10-14T00:00:00"})
        a = dict(self.remote("files")[files["a.txt"][0]])
        a.pop("_mt")
        a["parent"] = ""
        self.web_write("files", files["a.txt"][0], a)
        self.sync()
        self.assertEqual((root / "資料" / "web.txt").read_bytes(), b"from web")
        self.assertEqual((root / "a.txt").read_bytes(), b"hello")
        self.assertFalse((root / "資料" / "a.txt").exists())

        # Web deletes big.bin; local deletes web.txt.
        self.web_write("files", files["big.bin"][0], {"_deleted": True})
        self.ws.delete_file("資料/web.txt")
        self.sync()
        self.assertFalse((root / "big.bin").exists())
        self.assertTrue(self.remote("files")["w1"]["_deleted"])
        self.assertEqual(self.ws.syncer.status()["pending"], 0)

    def test_other_account_merges_local_data(self):
        self.ws.db.create("tasks", {"title": "共通"})
        self.sync()
        call("POST", "http://%s:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=x" % EMU,
             {"email": "other@example.com", "password": "secret123", "returnSecureToken": True})
        self.ws.syncer.login("other@example.com", "secret123")
        self.sync()
        other = sync.FirebaseClient(self.cfg)
        other.sign_in("other@example.com", "secret123")
        titles = [sync.dec(f["title"]) for _, f in other.changed_since("tasks", None)]
        self.assertEqual(titles, ["共通"])


if __name__ == "__main__":
    unittest.main()
