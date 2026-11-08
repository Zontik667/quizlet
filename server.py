#!/usr/bin/env python3
"""Карточки: сервер на стандартной библиотеке Python + SQLite.
Никаких pip-пакетов не нужно. Запуск:  python server.py
"""
import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("QUIZ_DB", os.path.join(BASE, "quizcards.db"))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
MAX_BODY = 5 * 1024 * 1024  # 5 МБ

STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS modules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    module_id  INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    term       TEXT NOT NULL,
    definition TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_module ON cards(module_id, position);
"""


def connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def init_db():
    con = connect()
    try:
        con.executescript(SCHEMA)
        con.commit()
    finally:
        con.close()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def clean(s):
    return re.sub(r"\s+", " ", str(s)).strip()


def validate(payload):
    if not isinstance(payload, dict):
        raise ValueError("Неверный формат данных")
    title = clean(payload.get("title", ""))
    if not title:
        raise ValueError("Введите название модуля")
    if len(title) > 200:
        raise ValueError("Название слишком длинное (максимум 200 символов)")
    raw = payload.get("cards")
    if not isinstance(raw, list) or not raw:
        raise ValueError("Добавьте хотя бы одну карточку")
    cards = []
    for c in raw:
        if not isinstance(c, dict):
            continue
        term, definition = clean(c.get("term", "")), clean(c.get("definition", ""))
        if term and definition:
            cards.append((term, definition))
    if not cards:
        raise ValueError("Не найдено ни одной корректной карточки")
    return title, cards


def get_module(con, mid):
    m = con.execute("SELECT id, title, created_at, updated_at FROM modules WHERE id = ?", (mid,)).fetchone()
    if not m:
        return None
    rows = con.execute(
        "SELECT term, definition FROM cards WHERE module_id = ? ORDER BY position", (mid,)
    ).fetchall()
    d = dict(m)
    d["cards"] = [dict(r) for r in rows]
    return d


def insert_cards(con, mid, cards):
    con.executemany(
        "INSERT INTO cards (module_id, position, term, definition) VALUES (?, ?, ?, ?)",
        [(mid, i, t, d) for i, (t, d) in enumerate(cards)],
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "QuizCards/1.0"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    # ---------- helpers ----------
    def send_json(self, code, obj=None):
        data = b"" if obj is None else json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if data:
            self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("Слишком большой запрос")
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            raise ValueError("Некорректный JSON")

    def route_api(self, method):
        m = re.match(r"^/api/modules(?:/(\d+))?/?$", self.path.split("?")[0])
        if not m:
            return self.send_json(404, {"error": "Не найдено"})
        mid = int(m.group(1)) if m.group(1) else None
        con = connect()
        try:
            if method == "GET" and mid is None:
                rows = con.execute(
                    """SELECT m.id, m.title, m.updated_at, COUNT(c.id) AS cards_count
                       FROM modules m LEFT JOIN cards c ON c.module_id = m.id
                       GROUP BY m.id ORDER BY m.updated_at DESC, m.id DESC"""
                ).fetchall()
                return self.send_json(200, [dict(r) for r in rows])

            if method == "POST" and mid is None:
                title, cards = validate(self.read_json())
                ts = now()
                cur = con.execute(
                    "INSERT INTO modules (title, created_at, updated_at) VALUES (?, ?, ?)", (title, ts, ts)
                )
                new_id = cur.lastrowid
                insert_cards(con, new_id, cards)
                con.commit()
                return self.send_json(201, get_module(con, new_id))

            if mid is not None:
                if method == "GET":
                    mod = get_module(con, mid)
                    if not mod:
                        return self.send_json(404, {"error": "Модуль не найден"})
                    return self.send_json(200, mod)

                if method == "PUT":
                    if not get_module(con, mid):
                        return self.send_json(404, {"error": "Модуль не найден"})
                    title, cards = validate(self.read_json())
                    con.execute("UPDATE modules SET title = ?, updated_at = ? WHERE id = ?", (title, now(), mid))
                    con.execute("DELETE FROM cards WHERE module_id = ?", (mid,))
                    insert_cards(con, mid, cards)
                    con.commit()
                    return self.send_json(200, get_module(con, mid))

                if method == "DELETE":
                    cur = con.execute("DELETE FROM modules WHERE id = ?", (mid,))
                    con.commit()
                    if cur.rowcount == 0:
                        return self.send_json(404, {"error": "Модуль не найден"})
                    return self.send_json(204)

            return self.send_json(405, {"error": "Метод не поддерживается"})
        except ValueError as e:
            return self.send_json(400, {"error": str(e)})
        finally:
            con.close()

    # ---------- verbs ----------
    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/"):
            return self.route_api("GET")
        entry = STATIC.get(path)
        if not entry:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        fname, ctype = entry
        with open(os.path.join(BASE, fname), "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        self.route_api("POST")

    def do_PUT(self):
        self.route_api("PUT")

    def do_DELETE(self):
        self.route_api("DELETE")


if __name__ == "__main__":
    init_db()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Карточки запущены: http://{'localhost' if HOST == '127.0.0.1' else HOST}:{PORT}")
    print(f"База данных: {DB_PATH}")
    print("Остановить: Ctrl+C")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено.")
