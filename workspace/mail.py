"""Minimal IMAP/SMTP client used by the mail module."""
import email
import imaplib
import re
import smtplib
import ssl
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.utils import formataddr, parsedate_to_datetime


class MailError(Exception):
    pass


def _require(cfg, *keys):
    missing = [k for k in keys if not cfg.get(k)]
    if missing:
        raise MailError("メール設定が未入力です: " + ", ".join(missing))


def _decode(value):
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def _date(value):
    try:
        return parsedate_to_datetime(value).isoformat(timespec="minutes")
    except Exception:
        return value or ""


def _imap(cfg):
    _require(cfg, "imap_host", "username", "password")
    try:
        conn = imaplib.IMAP4_SSL(cfg["imap_host"], int(cfg.get("imap_port") or 993),
                                 ssl_context=ssl.create_default_context(), timeout=20)
        conn.login(cfg["username"], cfg["password"])
    except (imaplib.IMAP4.error, OSError) as exc:
        raise MailError("IMAP接続に失敗しました: %s" % exc)
    return conn


def _html_to_text(html):
    html = re.sub(r"(?is)<(script|style).*?</\1>", "", html)
    html = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", html)
    text = re.sub(r"<[^>]+>", "", html)
    for ent, ch in (("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"),
                    ("&quot;", '"'), ("&#39;", "'"), ("&amp;", "&")):
        text = text.replace(ent, ch)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _body_text(msg):
    plain, html = None, None
    parts = msg.walk() if msg.is_multipart() else [msg]
    for part in parts:
        if part.get_content_maintype() == "multipart":
            continue
        if part.get("Content-Disposition", "").lower().startswith("attachment"):
            continue
        ctype = part.get_content_type()
        if ctype not in ("text/plain", "text/html"):
            continue
        payload = part.get_payload(decode=True) or b""
        charset = part.get_content_charset() or "utf-8"
        try:
            text = payload.decode(charset, errors="replace")
        except LookupError:
            text = payload.decode("utf-8", errors="replace")
        if ctype == "text/plain" and plain is None:
            plain = text
        elif ctype == "text/html" and html is None:
            html = text
    if plain is not None:
        return plain
    return _html_to_text(html) if html else ""


def _attachments(msg):
    names = []
    for part in msg.walk():
        filename = part.get_filename()
        if filename:
            names.append(_decode(filename))
    return names


def list_inbox(cfg, limit=30, unread_only=False):
    conn = _imap(cfg)
    try:
        conn.select("INBOX", readonly=True)
        typ, data = conn.uid("search", None, "UNSEEN" if unread_only else "ALL")
        uids = data[0].split() if typ == "OK" and data and data[0] else []
        uids = uids[-int(limit):][::-1]
        messages = []
        if uids:
            typ, data = conn.uid("fetch", b",".join(uids),
                                 "(FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
            for item in data:
                if not isinstance(item, tuple):
                    continue
                meta = item[0].decode(errors="replace")
                uid = re.search(r"UID (\d+)", meta)
                hdr = email.message_from_bytes(item[1])
                messages.append({
                    "uid": uid.group(1) if uid else "",
                    "from": _decode(hdr.get("From")),
                    "subject": _decode(hdr.get("Subject")) or "(件名なし)",
                    "date": _date(hdr.get("Date")),
                    "unread": "\\Seen" not in meta,
                })
        messages.sort(key=lambda m: int(m["uid"] or 0), reverse=True)
        return messages
    finally:
        try:
            conn.logout()
        except Exception:
            pass


def read_message(cfg, uid):
    if not str(uid).isdigit():
        raise MailError("invalid uid")
    conn = _imap(cfg)
    try:
        conn.select("INBOX")
        typ, data = conn.uid("fetch", str(uid), "(RFC822)")
        raw = next((d[1] for d in data or [] if isinstance(d, tuple)), None)
        if typ != "OK" or raw is None:
            raise MailError("メールが見つかりません")
        msg = email.message_from_bytes(raw)
        return {
            "uid": str(uid),
            "from": _decode(msg.get("From")),
            "to": _decode(msg.get("To")),
            "cc": _decode(msg.get("Cc")),
            "subject": _decode(msg.get("Subject")),
            "date": _date(msg.get("Date")),
            "message_id": msg.get("Message-ID", ""),
            "body": _body_text(msg),
            "attachments": _attachments(msg),
        }
    finally:
        try:
            conn.logout()
        except Exception:
            pass


def send(cfg, to, subject, body, cc="", in_reply_to=""):
    _require(cfg, "smtp_host", "username", "password")
    if not to.strip():
        raise MailError("宛先を入力してください")
    msg = EmailMessage()
    msg["From"] = formataddr((cfg.get("from_name") or "", cfg["username"]))
    msg["To"] = to
    if cc.strip():
        msg["Cc"] = cc
    msg["Subject"] = subject
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = in_reply_to
    msg.set_content(body)
    host, port = cfg["smtp_host"], int(cfg.get("smtp_port") or 465)
    ctx = ssl.create_default_context()
    try:
        if cfg.get("smtp_security") == "starttls":
            server = smtplib.SMTP(host, port, timeout=20)
            server.starttls(context=ctx)
        else:
            server = smtplib.SMTP_SSL(host, port, context=ctx, timeout=20)
        with server:
            server.login(cfg["username"], cfg["password"])
            server.send_message(msg)
    except (smtplib.SMTPException, OSError) as exc:
        raise MailError("送信に失敗しました: %s" % exc)
