"""
数据层：SQLite 封装。

设计要点：
  - 每个请求独立开连接（ThreadingHTTPServer 多线程，sqlite 连接不能跨线程共享）
  - WAL 模式，读写不互相阻塞
  - 时间一律存 UTC ISO8601，前端负责转本地时区
"""

from __future__ import annotations

import os
import shutil
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("SEVERUS_DATA") or (BASE / "data"))
MEDIA = DATA / "media"
PHOTO_DIR = MEDIA / "photos"
VIDEO_DIR = MEDIA / "videos"
TRACK_DIR = MEDIA / "tracks"
POSTER_DIR = MEDIA / "posters"
AVATAR_DIR = MEDIA / "avatars"
TMP_DIR = DATA / "tmp"
DB_PATH = DATA / "severus.db"

# kind -> 表名 / 目录 / 中文名
TABLES = {"photo": "photos", "video": "videos", "track": "tracks"}
DIRS = {"photo": PHOTO_DIR, "video": VIDEO_DIR, "track": TRACK_DIR}
NOUN = {"photo": "照片", "video": "视频", "track": "音乐"}


def media_dir(kind: str) -> Path:
    return DIRS[kind]

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL UNIQUE,
    password   TEXT    NOT NULL,
    role       TEXT    NOT NULL DEFAULT 'user',
    banned     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT    NOT NULL,
    title       TEXT    NOT NULL DEFAULT '',
    size        INTEGER NOT NULL DEFAULT 0,
    uploader_id INTEGER,
    pinned      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT    NOT NULL,
    title       TEXT    NOT NULL DEFAULT '',
    size        INTEGER NOT NULL DEFAULT 0,
    uploader_id INTEGER,
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT    NOT NULL,
    title       TEXT    NOT NULL DEFAULT '',
    size        INTEGER NOT NULL DEFAULT 0,
    uploader_id INTEGER,
    pinned      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    pinned     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    body       TEXT    NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    kind       TEXT    NOT NULL,
    detail     TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS post_likes (
    post_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    created_at TEXT    NOT NULL,
    PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS post_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    body       TEXT    NOT NULL,
    created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS downloads (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    kind       TEXT    NOT NULL,
    item_id    INTEGER NOT NULL,
    created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    note          TEXT    NOT NULL DEFAULT '',
    status        TEXT    NOT NULL DEFAULT 'pending',
    created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    target_kind TEXT    NOT NULL,
    target_id   INTEGER NOT NULL,
    reason      TEXT    NOT NULL DEFAULT '',
    reporter_id INTEGER,
    status      TEXT    NOT NULL DEFAULT 'open',
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    kind       TEXT    NOT NULL,
    text       TEXT    NOT NULL,
    link       TEXT    NOT NULL DEFAULT '',
    seen       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL,
    followee_id INTEGER NOT NULL,
    created_at  TEXT    NOT NULL,
    PRIMARY KEY (follower_id, followee_id)
);

CREATE TABLE IF NOT EXISTS favorites (
    user_id    INTEGER NOT NULL,
    kind       TEXT    NOT NULL,
    item_id    INTEGER NOT NULL,
    created_at TEXT    NOT NULL,
    PRIMARY KEY (user_id, kind, item_id)
);

CREATE TABLE IF NOT EXISTS tags (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT    NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS item_tags (
    tag_id  INTEGER NOT NULL,
    kind    TEXT    NOT NULL,
    item_id INTEGER NOT NULL,
    PRIMARY KEY (tag_id, kind, item_id)
);

CREATE TABLE IF NOT EXISTS audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    action     TEXT    NOT NULL,
    detail     TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_time    ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_time ON activity(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_time    ON audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_col_kind      ON collections(kind, pinned DESC, id);
CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_notif_user    ON notifications(user_id, seen, id DESC);
CREATE INDEX IF NOT EXISTS idx_reports_state ON reports(status, id DESC);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ensure_column(conn, table: str, column: str, decl: str) -> None:
    """老库升级用：缺列就补，已有就跳过。"""
    cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def init() -> None:
    for d in (DATA, MEDIA, PHOTO_DIR, VIDEO_DIR, TRACK_DIR, POSTER_DIR,
              AVATAR_DIR, TMP_DIR):
        d.mkdir(parents=True, exist_ok=True)
    with connect() as c:
        c.executescript(SCHEMA)
        _ensure_column(c, "photos", "pinned", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(c, "tracks", "pinned", "INTEGER NOT NULL DEFAULT 0")
        for table in ("photos", "videos", "tracks"):
            _ensure_column(c, table, "collection_id", "INTEGER")
            _ensure_column(c, table, "deleted_at", "TEXT")
            _ensure_column(c, table, "sha256", "TEXT")
            _ensure_column(c, table, "sort_order", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(c, "videos", "poster", "TEXT")
        _ensure_column(c, "post_comments", "parent_id", "INTEGER")
        _ensure_column(c, "users", "avatar", "TEXT")
        # 用户名不区分大小写地唯一：Alice 和 alice 视为同一个名字
        try:
            c.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name_ci"
                " ON users(username COLLATE NOCASE)"
            )
        except sqlite3.IntegrityError:
            print(
                "警告：已有仅大小写不同的重名用户，无法建立唯一索引。\n"
                "      请在后台处理重复账号后再启动。",
                flush=True,
            )


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# ------------------------------------------------------------------ 用户

def create_user(username: str, password_hash: str, role: str = "user") -> int:
    try:
        with connect() as c:
            cur = c.execute(
                "INSERT INTO users (username, password, role, created_at) VALUES (?,?,?,?)",
                (username, password_hash, role, now()),
            )
            return int(cur.lastrowid)
    except sqlite3.IntegrityError as exc:
        raise ValueError("用户名已存在") from exc


def find_user(username: str):
    """按用户名查用户，不区分大小写。"""
    with connect() as c:
        row = c.execute(
            "SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username,)
        ).fetchone()
        return dict(row) if row else None


def get_user(user_id: int):
    with connect() as c:
        row = c.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None


def list_users(q: str | None = None):
    with connect() as c:
        if q:
            rows = c.execute(
                "SELECT id, username, role, banned, created_at FROM users"
                " WHERE username LIKE ? COLLATE NOCASE ORDER BY id", (f"%{q}%",)
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT id, username, role, banned, created_at FROM users ORDER BY id"
            ).fetchall()
        return [dict(r) for r in rows]


def set_banned(user_id: int, banned: bool) -> None:
    with connect() as c:
        c.execute("UPDATE users SET banned = ? WHERE id = ?", (1 if banned else 0, user_id))


def update_password(user_id: int, password_hash: str) -> None:
    with connect() as c:
        c.execute("UPDATE users SET password = ? WHERE id = ?", (password_hash, user_id))


def count_users() -> int:
    with connect() as c:
        return c.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def admin_exists() -> bool:
    with connect() as c:
        return (
            c.execute("SELECT 1 FROM users WHERE role='admin' LIMIT 1").fetchone()
            is not None
        )


# ------------------------------------------------------------------ 媒体

def add_media(kind: str, filename: str, title: str, size: int, uploader: int,
              collection_id: int | None = None, sha256: str | None = None,
              poster: str | None = None) -> int:
    table = TABLES[kind]
    with connect() as c:
        if table == "videos":
            cur = c.execute(
                "INSERT INTO videos (filename, title, size, uploader_id,"
                " collection_id, sha256, poster, created_at)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (filename, title, size, uploader, collection_id, sha256, poster, now()),
            )
        else:
            cur = c.execute(
                f"INSERT INTO {table} (filename, title, size, uploader_id,"
                " collection_id, sha256, created_at) VALUES (?,?,?,?,?,?,?)",
                (filename, title, size, uploader, collection_id, sha256, now()),
            )
        return int(cur.lastrowid)


def list_media(kind: str, limit: int = 60, offset: int = 0,
               collection_id: int | None = None):
    table = TABLES[kind]
    tag_sub = ("(SELECT GROUP_CONCAT(t.name, ',') FROM item_tags it"
               " JOIN tags t ON t.id = it.tag_id"
               f" WHERE it.kind = ? AND it.item_id = {table}.id) AS tags")
    if table in ("photos", "tracks"):
        cols = (f"id, filename, title, size, pinned, collection_id, created_at, {tag_sub}")
        order = "pinned DESC, sort_order DESC, created_at DESC, id DESC"
    else:
        cols = f"id, filename, title, size, collection_id, created_at, poster, {tag_sub}"
        order = "sort_order DESC, created_at DESC, id DESC"

    where, args = " WHERE deleted_at IS NULL", []
    if collection_id is not None:
        where += " AND collection_id = ?"
        args.append(collection_id)

    with connect() as c:
        rows = c.execute(
            f"SELECT {cols} FROM {table}{where} ORDER BY {order} LIMIT ? OFFSET ?",
            (kind, *args, limit, offset),
        ).fetchall()
        return [dict(r) for r in rows]


def count_media(kind: str, collection_id: int | None = None) -> int:
    table = TABLES[kind]
    where, args = " WHERE deleted_at IS NULL", []
    if collection_id is not None:
        where += " AND collection_id = ?"
        args.append(collection_id)
    with connect() as c:
        return c.execute(
            f"SELECT COUNT(*) FROM {table}{where}", args
        ).fetchone()[0]


def find_by_hash(kind: str, digest: str):
    """秒传：同样的文件已经存在就直接复用。"""
    table = TABLES[kind]
    with connect() as c:
        row = c.execute(
            f"SELECT id, filename, title, size, created_at FROM {table}"
            " WHERE sha256 = ? AND deleted_at IS NULL LIMIT 1", (digest,)
        ).fetchone()
        return dict(row) if row else None


def delete_media(kind: str, item_id: int) -> str | None:
    """软删除：进回收站，30 天后才真正清掉。"""
    table = TABLES[kind]
    with connect() as c:
        row = c.execute(
            f"SELECT filename FROM {table} WHERE id = ?", (item_id,)
        ).fetchone()
        if row is None:
            return None
        c.execute(f"UPDATE {table} SET deleted_at = ? WHERE id = ?",
                  (now(), item_id))
        return row["filename"]


def delete_media_many(kind: str, ids: list[int]) -> list[str]:
    table = TABLES[kind]
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    with connect() as c:
        rows = c.execute(
            f"SELECT filename FROM {table} WHERE id IN ({marks})", ids
        ).fetchall()
        names = [r["filename"] for r in rows]
        c.execute(
            f"UPDATE {table} SET deleted_at = ? WHERE id IN ({marks})",
            (now(), *ids),
        )
        return names


def list_trash():
    out = []
    with connect() as c:
        for kind, table in TABLES.items():
            rows = c.execute(
                f"SELECT id, filename, title, size, deleted_at FROM {table}"
                " WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 100"
            ).fetchall()
            for r in rows:
                d = dict(r)
                d["kind"] = kind
                out.append(d)
    out.sort(key=lambda x: x["deleted_at"] or "", reverse=True)
    return out


def restore_media(kind: str, item_id: int) -> bool:
    with connect() as c:
        cur = c.execute(
            f"UPDATE {TABLES[kind]} SET deleted_at = NULL WHERE id = ?", (item_id,)
        )
        return cur.rowcount > 0


def purge_media(kind: str, item_id: int) -> str | None:
    """彻底删除，返回要删的磁盘文件名（以及封面）。"""
    table = TABLES[kind]
    with connect() as c:
        row = c.execute(
            f"SELECT filename{', poster' if table == 'videos' else ''}"
            f" FROM {table} WHERE id = ?", (item_id,)
        ).fetchone()
        if row is None:
            return None
        c.execute(f"DELETE FROM {table} WHERE id = ?", (item_id,))
        return dict(row).get("filename")


def purge_expired(days: int = 30) -> list[tuple[str, str]]:
    """清掉回收站里超过 days 天的东西，返回 [(kind, filename)]。"""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(
        timespec="seconds")
    gone: list[tuple[str, str]] = []
    with connect() as c:
        for kind, table in TABLES.items():
            rows = c.execute(
                f"SELECT id, filename FROM {table}"
                " WHERE deleted_at IS NOT NULL AND deleted_at < ?", (cutoff,)
            ).fetchall()
            for r in rows:
                c.execute(f"DELETE FROM {table} WHERE id = ?", (r["id"],))
                gone.append((kind, r["filename"]))
    return gone


def set_sort_orders(kind: str, ids: list[int]) -> int:
    """按传入顺序重排：后面的是新的，sort_order 递减。"""
    table = TABLES[kind]
    with connect() as c:
        total = len(ids)
        for i, item_id in enumerate(ids):
            c.execute(f"UPDATE {table} SET sort_order = ? WHERE id = ?",
                      (total - i, item_id))
    return total


def set_video_poster(video_id: int, poster: str) -> bool:
    with connect() as c:
        cur = c.execute("UPDATE videos SET poster = ? WHERE id = ?",
                        (poster, video_id))
        return cur.rowcount > 0


def update_media_title(kind: str, item_id: int, title: str) -> bool:
    table = TABLES[kind]
    with connect() as c:
        cur = c.execute(
            f"UPDATE {table} SET title = ? WHERE id = ?", (title, item_id)
        )
        return cur.rowcount > 0


def set_pinned(item_id: int, pinned: bool) -> bool:
    with connect() as c:
        cur = c.execute(
            "UPDATE photos SET pinned = ? WHERE id = ?", (1 if pinned else 0, item_id)
        )
        return cur.rowcount > 0


def set_track_pinned(item_id: int, pinned: bool) -> bool:
    with connect() as c:
        cur = c.execute(
            "UPDATE tracks SET pinned = ? WHERE id = ?", (1 if pinned else 0, item_id)
        )
        return cur.rowcount > 0


# ------------------------------------------------------------------ 论坛

def add_post(user_id: int, body: str) -> int:
    with connect() as c:
        cur = c.execute(
            "INSERT INTO posts (user_id, body, created_at) VALUES (?,?,?)",
            (user_id, body, now()),
        )
        return int(cur.lastrowid)


def _post_filter(q: str | None, user: str | None, since_days: int | None):
    where = ["p.deleted = 0"]
    args: list = []
    if q:
        where.append("p.body LIKE ?")
        args.append(f"%{q}%")
    if user:
        where.append("u.username = ? COLLATE NOCASE")
        args.append(user)
    if since_days:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=since_days)).isoformat(
            timespec="seconds")
        where.append("p.created_at >= ?")
        args.append(cutoff)
    return " AND ".join(where), args


POST_SORTS = {
    "recent": "p.created_at DESC, p.id DESC",
    "likes": "likes DESC, p.created_at DESC, p.id DESC",
    "comments": "comments DESC, p.created_at DESC, p.id DESC",
}


def list_posts(limit: int = 30, offset: int = 0, q: str | None = None,
               user: str | None = None, since_days: int | None = None,
               sort: str = "recent", viewer_id: int = 0):
    clause, args = _post_filter(q, user, since_days)
    order = POST_SORTS.get(sort, POST_SORTS["recent"])
    with connect() as c:
        rows = c.execute(
            "SELECT p.id, p.body, p.created_at, u.username, u.avatar,"
            " (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS likes,"
            " (SELECT COUNT(*) FROM post_comments cm WHERE cm.post_id = p.id) AS comments,"
            " (SELECT COUNT(*) FROM post_likes l3 WHERE l3.post_id = p.id"
            "   AND l3.user_id = ?) AS liked"
            " FROM posts p JOIN users u ON u.id = p.user_id"
            f" WHERE {clause}"
            f" ORDER BY {order} LIMIT ? OFFSET ?",
            (viewer_id, *args, limit, offset),
        ).fetchall()
        return [dict(r) for r in rows]


def get_post(post_id: int):
    with connect() as c:
        row = c.execute(
            "SELECT p.id, p.body, p.created_at, u.username, u.avatar FROM posts p"
            " JOIN users u ON u.id = p.user_id"
            " WHERE p.id = ? AND p.deleted = 0", (post_id,)
        ).fetchone()
        return dict(row) if row else None


def toggle_like(post_id: int, user_id: int) -> tuple[bool, int]:
    """一人一票；再点一次取消。返回 (现在是否已赞, 总赞数)。"""
    with connect() as c:
        row = c.execute(
            "SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?",
            (post_id, user_id),
        ).fetchone()
        if row:
            c.execute("DELETE FROM post_likes WHERE post_id = ? AND user_id = ?",
                      (post_id, user_id))
            liked = False
        else:
            c.execute(
                "INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?,?,?)",
                (post_id, user_id, now()),
            )
            liked = True
        n = c.execute(
            "SELECT COUNT(*) FROM post_likes WHERE post_id = ?", (post_id,)
        ).fetchone()[0]
        return liked, int(n)


def like_count(post_id: int) -> int:
    with connect() as c:
        return c.execute(
            "SELECT COUNT(*) FROM post_likes WHERE post_id = ?", (post_id,)
        ).fetchone()[0]


def add_comment(post_id: int, user_id: int, body: str,
                parent_id: int | None = None) -> int:
    with connect() as c:
        cur = c.execute(
            "INSERT INTO post_comments (post_id, user_id, body, parent_id, created_at)"
            " VALUES (?,?,?,?,?)",
            (post_id, user_id, body, parent_id, now()),
        )
        return int(cur.lastrowid)


def list_comments(post_id: int, limit: int = 200):
    with connect() as c:
        rows = c.execute(
            "SELECT c.id, c.body, c.parent_id, c.created_at, u.username, u.avatar"
            " FROM post_comments c JOIN users u ON u.id = c.user_id"
            " WHERE c.post_id = ?"
            " ORDER BY c.created_at ASC, c.id ASC LIMIT ?",
            (post_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def comment_count(post_id: int) -> int:
    with connect() as c:
        return c.execute(
            "SELECT COUNT(*) FROM post_comments WHERE post_id = ?", (post_id,)
        ).fetchone()[0]


def count_posts(q: str | None = None, user: str | None = None,
                since_days: int | None = None) -> int:
    clause, args = _post_filter(q, user, since_days)
    with connect() as c:
        return c.execute(
            "SELECT COUNT(*) FROM posts p JOIN users u ON u.id = p.user_id"
            f" WHERE {clause}", args
        ).fetchone()[0]


def delete_post(post_id: int) -> bool:
    with connect() as c:
        cur = c.execute("UPDATE posts SET deleted = 1 WHERE id = ?", (post_id,))
        return cur.rowcount > 0


# ------------------------------------------------------------------ 访客记录

def add_activity(user_id: int, kind: str, detail: str = "") -> None:
    with connect() as c:
        c.execute(
            "INSERT INTO activity (user_id, kind, detail, created_at) VALUES (?,?,?,?)",
            (user_id, kind, detail, now()),
        )


ACTIVITY_WINDOW_MIN = 10     # 同一用户在这么多分钟内只记一次


def recent_activity(limit: int = 10):
    """
    访客记录：按时间倒序，一个人只保留最新一条，最多 limit 条，管理员不出现。
    """
    with connect() as c:
        rows = c.execute(
            "SELECT a.id, a.kind, a.detail, a.created_at, u.username, u.avatar, u.role"
            " FROM activity a JOIN users u ON u.id = a.user_id"
            " ORDER BY a.created_at DESC, a.id DESC LIMIT ?",
            (limit * 8,),
        ).fetchall()

    out: list[dict] = []
    seen: set[str] = set()
    for row in rows:
        if row["role"] == "admin":
            continue
        if row["username"] in seen:
            continue
        seen.add(row["username"])
        out.append({
            "id": row["id"], "kind": row["kind"], "detail": row["detail"],
            "created_at": row["created_at"], "username": row["username"],
        })
        if len(out) >= limit:
            break
    return out


def admin_activity(limit: int = 40):
    """管理视角：全量活动，包含管理员自己，不去重。"""
    with connect() as c:
        rows = c.execute(
            "SELECT a.id, a.kind, a.detail, a.created_at, u.username, u.avatar, u.role"
            " FROM activity a JOIN users u ON u.id = a.user_id"
            " ORDER BY a.created_at DESC, a.id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


# ------------------------------------------------------------------ 操作日志

def add_audit(user_id: int, action: str, detail: str = "") -> None:
    with connect() as c:
        c.execute(
            "INSERT INTO audit (user_id, action, detail, created_at) VALUES (?,?,?,?)",
            (user_id, action, detail, now()),
        )


def list_audit(limit: int = 60):
    with connect() as c:
        rows = c.execute(
            "SELECT a.id, a.action, a.detail, a.created_at, u.username"
            " FROM audit a JOIN users u ON u.id = a.user_id"
            " ORDER BY a.created_at DESC, a.id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


# ------------------------------------------------------------------ 存储占用

def _dir_size(path: Path) -> tuple[int, int]:
    total = 0
    count = 0
    for f in path.rglob("*"):
        try:
            if f.is_file():
                total += f.stat().st_size
                count += 1
        except OSError:
            continue
    return total, count


def activity_trend(days: int = 7):
    """最近 N 天的访问量，按天聚合，缺的补 0。"""
    today = datetime.now(timezone.utc).date()
    with connect() as c:
        rows = c.execute(
            "SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n"
            " FROM activity GROUP BY d"
        ).fetchall()
    counts = {r["d"]: r["n"] for r in rows}
    out = []
    for i in range(days - 1, -1, -1):
        day = (today - timedelta(days=i)).isoformat()
        out.append({"date": day, "count": counts.get(day, 0)})
    return out


def storage_usage() -> dict:
    photos_bytes, photos_n = _dir_size(PHOTO_DIR)
    videos_bytes, videos_n = _dir_size(VIDEO_DIR)
    db_bytes = DB_PATH.stat().st_size if DB_PATH.exists() else 0
    try:
        du = shutil.disk_usage(str(DATA))
        free, total = du.free, du.total
    except OSError:
        free, total = 0, 0
    return {
        "path": str(DATA),
        "photos": {"bytes": photos_bytes, "count": photos_n},
        "videos": {"bytes": videos_bytes, "count": videos_n},
        "db": {"bytes": db_bytes},
        "used": photos_bytes + videos_bytes + db_bytes,
        "disk_free": free,
        "disk_total": total,
    }


# ------------------------------------------------------------------ 文件夹 / 歌单

def _default_collection(conn, kind: str) -> int:
    row = conn.execute(
        "SELECT id FROM collections WHERE kind = ? AND name = '未分类'", (kind,)
    ).fetchone()
    if row:
        return int(row["id"])
    cur = conn.execute(
        "INSERT INTO collections (kind, name, created_at) VALUES (?,?,?)",
        (kind, "未分类", now()),
    )
    return int(cur.lastrowid)


def list_collections(kind: str, limit: int | None = None):
    table = TABLES[kind]
    cover_col = "COALESCE(m.poster, m.filename)" if table == "videos" else "m.filename"
    sql = (
        "SELECT c.id, c.name, c.pinned,"
        f" (SELECT COUNT(*) FROM {table} m WHERE m.collection_id = c.id"
        "  AND m.deleted_at IS NULL) AS count,"
        f" (SELECT {cover_col} FROM {table} m WHERE m.collection_id = c.id"
        "  AND m.deleted_at IS NULL ORDER BY m.id ASC LIMIT 1) AS cover,"
        f" (SELECT m.title FROM {table} m WHERE m.collection_id = c.id"
        "  AND m.deleted_at IS NULL ORDER BY m.id ASC LIMIT 1) AS cover_title"
        " FROM collections c WHERE c.kind = ?"
        " ORDER BY c.pinned DESC, c.id ASC"
    )
    args: list = [kind]
    if limit:
        sql += " LIMIT ?"
        args.append(limit)
    with connect() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def get_collection(cid: int):
    with connect() as c:
        row = c.execute("SELECT * FROM collections WHERE id = ?", (cid,)).fetchone()
        return dict(row) if row else None


def create_collection(kind: str, name: str) -> int:
    with connect() as c:
        cur = c.execute(
            "INSERT INTO collections (kind, name, created_at) VALUES (?,?,?)",
            (kind, name, now()),
        )
        return int(cur.lastrowid)


def rename_collection(cid: int, name: str) -> bool:
    with connect() as c:
        cur = c.execute("UPDATE collections SET name = ? WHERE id = ?", (name, cid))
        return cur.rowcount > 0


def pin_collection(cid: int) -> bool:
    """同一个 kind 只保留一个置顶。"""
    with connect() as c:
        row = c.execute("SELECT kind FROM collections WHERE id = ?", (cid,)).fetchone()
        if row is None:
            return False
        c.execute("UPDATE collections SET pinned = 0 WHERE kind = ?", (row["kind"],))
        c.execute("UPDATE collections SET pinned = 1 WHERE id = ?", (cid,))
        return True


def unpin_collection(cid: int) -> bool:
    with connect() as c:
        cur = c.execute("UPDATE collections SET pinned = 0 WHERE id = ?", (cid,))
        return cur.rowcount > 0


def delete_collection(cid: int) -> bool:
    """删文件夹，里面的内容移到「未分类」，不删文件。"""
    with connect() as c:
        row = c.execute("SELECT kind FROM collections WHERE id = ?", (cid,)).fetchone()
        if row is None:
            return False
        kind = row["kind"]
        default_id = _default_collection(c, kind)
        if default_id == cid:
            return False                      # 「未分类」本身不许删
        c.execute(
            f"UPDATE {TABLES[kind]} SET collection_id = ? WHERE collection_id = ?",
            (default_id, cid),
        )
        c.execute("DELETE FROM collections WHERE id = ?", (cid,))
        return True


def set_media_collection(kind: str, item_id: int, cid: int | None) -> bool:
    with connect() as c:
        cur = c.execute(
            f"UPDATE {TABLES[kind]} SET collection_id = ? WHERE id = ?", (cid, item_id)
        )
        return cur.rowcount > 0


def ensure_collection(kind: str, cid: int | None) -> int:
    """上传时没指定文件夹就落到「未分类」。"""
    with connect() as c:
        if cid:
            row = c.execute(
                "SELECT id FROM collections WHERE id = ? AND kind = ?", (cid, kind)
            ).fetchone()
            if row:
                return int(row["id"])
        return _default_collection(c, kind)


def stats() -> dict:
    with connect() as c:
        photos = c.execute("SELECT COUNT(*) FROM photos WHERE deleted_at IS NULL").fetchone()[0]
        videos = c.execute("SELECT COUNT(*) FROM videos WHERE deleted_at IS NULL").fetchone()[0]
        tracks = c.execute("SELECT COUNT(*) FROM tracks WHERE deleted_at IS NULL").fetchone()[0]
        posts = c.execute("SELECT COUNT(*) FROM posts WHERE deleted=0").fetchone()[0]
        users = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        members = c.execute(
            "SELECT COUNT(*) FROM users WHERE role != 'admin' AND banned = 0"
        ).fetchone()[0]
        visits = c.execute("SELECT COUNT(*) FROM activity").fetchone()[0]
        trash = sum(c.execute(
            f"SELECT COUNT(*) FROM {t} WHERE deleted_at IS NOT NULL"
        ).fetchone()[0] for t in TABLES.values())
    return {"photos": photos, "videos": videos, "tracks": tracks, "posts": posts,
            "users": users, "members": members, "visits": visits, "trash": trash}


# ---------------------------------------------------------------- 设置

DEFAULT_SETTINGS = {"allow_register": "1", "invite_code": "", "site_note": "",
                    "quota_bytes": "5368709120", "daily_files": "20", "dedupe": "1",
                    "apply_mode": "0"}


def get_setting(key: str) -> str:
    with connect() as c:
        row = c.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    if row is not None:
        return row["value"]
    return DEFAULT_SETTINGS.get(key, "")


def set_setting(key: str, value: str) -> None:
    with connect() as c:
        c.execute(
            "INSERT INTO settings (key, value) VALUES (?,?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def all_settings() -> dict:
    out = dict(DEFAULT_SETTINGS)
    with connect() as c:
        for row in c.execute("SELECT key, value FROM settings").fetchall():
            out[row["key"]] = row["value"]
    return out


# ---------------------------------------------------------------- 全站搜索

def search_all(q: str, limit: int = 20) -> dict:
    like = f"%{q}%"
    out: dict[str, list] = {"photos": [], "videos": [], "tracks": [], "posts": [], "users": []}
    with connect() as c:
        plural = {"photo": "photos", "video": "videos", "track": "tracks"}
        for kind, table in TABLES.items():
            rows = c.execute(
                f"SELECT id, filename, title, created_at, collection_id FROM {table}"
                " WHERE deleted_at IS NULL AND title LIKE ?"
                " ORDER BY created_at DESC LIMIT ?", (like, limit)
            ).fetchall()
            out[plural[kind]] = [dict(r) for r in rows]

        out["posts"] = [dict(r) for r in c.execute(
            "SELECT p.id, p.body, p.created_at, u.username, u.avatar FROM posts p"
            " JOIN users u ON u.id = p.user_id"
            " WHERE p.deleted = 0 AND p.body LIKE ?"
            " ORDER BY p.created_at DESC LIMIT ?", (like, limit)
        ).fetchall()]

        out["users"] = [dict(r) for r in c.execute(
            "SELECT id, username, role, created_at, banned FROM users"
            " WHERE username LIKE ? ORDER BY username LIMIT ?", (like, limit)
        ).fetchall()]

        out["collections"] = [dict(r) for r in c.execute(
            "SELECT id, kind, name FROM collections WHERE name LIKE ?"
            " ORDER BY id DESC LIMIT ?", (like, limit)
        ).fetchall()]
    return out


# ---------------------------------------------------------------- 个人主页

def user_profile(name: str):
    with connect() as c:
        row = c.execute(
            "SELECT id, username, role, created_at, banned FROM users"
            " WHERE username = ? COLLATE NOCASE", (name,)
        ).fetchone()
        if row is None:
            return None
        uid = row["id"]
        posts = [dict(r) for r in c.execute(
            "SELECT p.id, p.body, p.created_at,"
            " (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS likes,"
            " (SELECT COUNT(*) FROM post_comments cm WHERE cm.post_id = p.id) AS comments"
            " FROM posts p WHERE p.user_id = ? AND p.deleted = 0"
            " ORDER BY p.created_at DESC, p.id DESC LIMIT 50", (uid,)
        ).fetchall()]
        uploads = {}
        for kind, table in TABLES.items():
            uploads[kind] = c.execute(
                f"SELECT COUNT(*) FROM {table} WHERE uploader_id = ?"
                " AND deleted_at IS NULL", (uid,)
            ).fetchone()[0]
        likes_given = c.execute(
            "SELECT COUNT(*) FROM post_likes WHERE user_id = ?", (uid,)
        ).fetchone()[0]

    profile = dict(row)
    profile["posts"] = posts
    profile["uploads"] = uploads
    profile["likes_given"] = likes_given
    return profile


# ---------------------------------------------------------------- 帖子编辑

def update_post(post_id: int, body: str) -> bool:
    with connect() as c:
        cur = c.execute("UPDATE posts SET body = ? WHERE id = ? AND deleted = 0",
                        (body, post_id))
        return cur.rowcount > 0


def soft_delete_post(post_id: int) -> bool:
    with connect() as c:
        cur = c.execute("UPDATE posts SET deleted = 1 WHERE id = ?", (post_id,))
        return cur.rowcount > 0


def get_post_owner(post_id: int):
    with connect() as c:
        row = c.execute("SELECT user_id FROM posts WHERE id = ?", (post_id,)).fetchone()
        return row["user_id"] if row else None

# ---------------------------------------------------------------- 申请制注册

def apply_join(username: str, password_hash: str, note: str) -> int:
    with connect() as c:
        cur = c.execute(
            "INSERT INTO applications (username, password_hash, note, created_at)"
            " VALUES (?,?,?,?)", (username, password_hash, note, now()))
        return int(cur.lastrowid)


def list_applications(status: str = "pending"):
    with connect() as c:
        rows = c.execute(
            "SELECT id, username, note, status, created_at FROM applications"
            " WHERE status = ? ORDER BY id DESC LIMIT 100", (status,)
        ).fetchall()
        return [dict(r) for r in rows]


def get_application(app_id: int):
    with connect() as c:
        row = c.execute("SELECT * FROM applications WHERE id = ?", (app_id,)).fetchone()
        return dict(row) if row else None


def mark_application(app_id: int, status: str) -> None:
    with connect() as c:
        c.execute("UPDATE applications SET status = ? WHERE id = ?", (status, app_id))


# ---------------------------------------------------------------- 举报

def add_report(kind: str, item_id: int, reason: str, reporter_id: int | None) -> int:
    with connect() as c:
        cur = c.execute(
            "INSERT INTO reports (target_kind, target_id, reason, reporter_id, created_at)"
            " VALUES (?,?,?,?,?)", (kind, item_id, reason, reporter_id, now()))
        return int(cur.lastrowid)


def list_reports(status: str = "open"):
    with connect() as c:
        rows = c.execute(
            "SELECT r.id, r.target_kind, r.target_id, r.reason, r.created_at,"
            " u.username AS reporter FROM reports r"
            " LEFT JOIN users u ON u.id = r.reporter_id"
            " WHERE r.status = ? ORDER BY r.id DESC LIMIT 100", (status,)
        ).fetchall()
        return [dict(r) for r in rows]


def resolve_report(report_id: int, status: str = "done") -> bool:
    with connect() as c:
        cur = c.execute("UPDATE reports SET status = ? WHERE id = ?", (status, report_id))
        return cur.rowcount > 0


# ---------------------------------------------------------------- 通知

def notify(user_id: int, kind: str, text: str, link: str = "") -> None:
    with connect() as c:
        c.execute(
            "INSERT INTO notifications (user_id, kind, text, link, created_at)"
            " VALUES (?,?,?,?,?)", (user_id, kind, text, link, now()))


def list_notifications(user_id: int, limit: int = 50):
    with connect() as c:
        rows = c.execute(
            "SELECT id, kind, text, link, seen, created_at FROM notifications"
            " WHERE user_id = ? ORDER BY id DESC LIMIT ?", (user_id, limit)
        ).fetchall()
        return [dict(r) for r in rows]


def unread_count(user_id: int) -> int:
    with connect() as c:
        return c.execute(
            "SELECT COUNT(*) FROM notifications WHERE user_id = ? AND seen = 0",
            (user_id,)).fetchone()[0]


def mark_notifications_seen(user_id: int) -> None:
    with connect() as c:
        c.execute("UPDATE notifications SET seen = 1 WHERE user_id = ?", (user_id,))


# ---------------------------------------------------------------- 配额

def user_usage(user_id: int) -> int:
    total = 0
    with connect() as c:
        for table in TABLES.values():
            total += c.execute(
                f"SELECT COALESCE(SUM(size),0) FROM {table}"
                " WHERE uploader_id = ? AND deleted_at IS NULL", (user_id,)
            ).fetchone()[0]
    return int(total)


def today_uploads(user_id: int) -> int:
    """今天上传了几个文件、几段视频。"""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    total = 0
    videos = 0
    with connect() as c:
        for kind, table in TABLES.items():
            n = c.execute(
                f"SELECT COUNT(*) FROM {table}"
                " WHERE uploader_id = ? AND created_at >= ?", (user_id, today)
            ).fetchone()[0]
            total += n
            if kind == "video":
                videos = n
    return total, videos


# ---------------------------------------------------------------- 关注

def follow(follower: int, followee: int) -> bool:
    if follower == followee:
        return False
    with connect() as c:
        c.execute(
            "INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at)"
            " VALUES (?,?,?)", (follower, followee, now()))
        return True


def unfollow(follower: int, followee: int) -> bool:
    with connect() as c:
        cur = c.execute(
            "DELETE FROM follows WHERE follower_id = ? AND followee_id = ?",
            (follower, followee))
        return cur.rowcount > 0


def is_following(follower: int, followee: int) -> bool:
    with connect() as c:
        return c.execute(
            "SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?",
            (follower, followee)).fetchone() is not None


def follow_counts(user_id: int) -> tuple[int, int]:
    with connect() as c:
        a = c.execute("SELECT COUNT(*) FROM follows WHERE follower_id = ?",
                      (user_id,)).fetchone()[0]
        b = c.execute("SELECT COUNT(*) FROM follows WHERE followee_id = ?",
                      (user_id,)).fetchone()[0]
    return int(a), int(b)


def feed_posts(user_id: int, limit: int = 10, offset: int = 0):
    with connect() as c:
        rows = c.execute(
            "SELECT p.id, p.body, p.created_at, u.username, u.avatar,"
            " (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS likes,"
            " (SELECT COUNT(*) FROM post_comments cm WHERE cm.post_id = p.id) AS comments,"
            " (SELECT COUNT(*) FROM post_likes l3 WHERE l3.post_id = p.id"
            "   AND l3.user_id = ?) AS liked"
            " FROM posts p JOIN users u ON u.id = p.user_id"
            " WHERE p.deleted = 0 AND (p.user_id = ? OR p.user_id IN"
            "   (SELECT followee_id FROM follows WHERE follower_id = ?))"
            " ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?",
            (user_id, user_id, user_id, limit, offset)
        ).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------- 收藏

def toggle_favorite(user_id: int, kind: str, item_id: int) -> bool:
    """返回 True 表示现在已收藏。"""
    with connect() as c:
        row = c.execute(
            "SELECT 1 FROM favorites WHERE user_id = ? AND kind = ? AND item_id = ?",
            (user_id, kind, item_id)).fetchone()
        if row:
            c.execute(
                "DELETE FROM favorites WHERE user_id = ? AND kind = ? AND item_id = ?",
                (user_id, kind, item_id))
            return False
        c.execute(
            "INSERT INTO favorites (user_id, kind, item_id, created_at)"
            " VALUES (?,?,?,?)", (user_id, kind, item_id, now()))
        return True


def list_favorites(user_id: int, kind: str | None = None):
    sql = ("SELECT kind, item_id, created_at FROM favorites"
           " WHERE user_id = ?")
    args: list = [user_id]
    if kind:
        sql += " AND kind = ?"
        args.append(kind)
    sql += " ORDER BY created_at DESC LIMIT 300"

    with connect() as c:
        rows = c.execute(sql, args).fetchall()

        out = []
        for r in rows:
            k = r["kind"]
            if k == "post":
                item = c.execute(
                    "SELECT id, body AS title, created_at FROM posts"
                    " WHERE id = ? AND deleted = 0", (r["item_id"],)
                ).fetchone()
            else:
                table = TABLES.get(k)
                if not table:
                    continue
                extra = ", poster" if table == "videos" else ""
                item = c.execute(
                    f"SELECT id, filename, title, created_at{extra} FROM {table}"
                    " WHERE id = ? AND deleted_at IS NULL", (r["item_id"],)
                ).fetchone()
            if item:
                d = dict(item)
                d["kind"] = k
                out.append(d)
    return out


def set_tags(kind: str, item_id: int, names: list[str]) -> list[str]:
    clean: list[str] = []
    for raw in names:
        name = str(raw).strip()[:20]
        if name and name not in clean:
            clean.append(name)

    with connect() as c:
        c.execute("DELETE FROM item_tags WHERE kind = ? AND item_id = ?", (kind, item_id))
        for name in clean:
            c.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (name,))
            row = c.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()
            c.execute(
                "INSERT OR IGNORE INTO item_tags (tag_id, kind, item_id) VALUES (?,?,?)",
                (row["id"], kind, item_id))
    return clean


def item_tags(kind: str, item_id: int) -> list[str]:
    with connect() as c:
        rows = c.execute(
            "SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id"
            " WHERE it.kind = ? AND it.item_id = ? ORDER BY t.name", (kind, item_id)
        ).fetchall()
    return [r["name"] for r in rows]


def list_tags(kind: str = "photo"):
    with connect() as c:
        rows = c.execute(
            "SELECT t.name, COUNT(*) AS n FROM item_tags it"
            " JOIN tags t ON t.id = it.tag_id WHERE it.kind = ?"
            " GROUP BY t.name ORDER BY n DESC, t.name LIMIT 60", (kind,)
        ).fetchall()
    return [dict(r) for r in rows]


def items_by_tag(kind: str, name: str, limit: int = 60):
    table = TABLES.get(kind)
    if not table:
        return []
    with connect() as c:
        rows = c.execute(
            f"SELECT m.id, m.filename, m.title, m.created_at, m.collection_id"
            f" FROM {table} m JOIN item_tags it ON it.item_id = m.id AND it.kind = ?"
            " JOIN tags t ON t.id = it.tag_id"
            " WHERE t.name = ? AND m.deleted_at IS NULL"
            " ORDER BY m.created_at DESC, m.id DESC LIMIT ?", (kind, name, limit)
        ).fetchall()
    return [dict(r) for r in rows]

def following_list(user_id: int):
    """我关注了谁。"""
    with connect() as c:
        rows = c.execute(
            "SELECT u.id, u.username, f.created_at FROM follows f"
            " JOIN users u ON u.id = f.followee_id"
            " WHERE f.follower_id = ? ORDER BY f.created_at DESC LIMIT 200",
            (user_id,)).fetchall()
    return [dict(r) for r in rows]


def followed_by_list(user_id: int):
    with connect() as c:
        rows = c.execute(
            "SELECT u.id, u.username, f.created_at FROM follows f"
            " JOIN users u ON u.id = f.follower_id"
            " WHERE f.followee_id = ? ORDER BY f.created_at DESC LIMIT 200",
            (user_id,)).fetchall()
    return [dict(r) for r in rows]
def admin_ids():
    with connect() as c:
        return [r["id"] for r in c.execute(
            "SELECT id FROM users WHERE role = 'admin'").fetchall()]


def all_user_ids():
    """能收通知的人：没被封禁的成员（管理员由调用方跳过）。"""
    with connect() as c:
        return [r["id"] for r in c.execute(
            "SELECT id FROM users WHERE banned = 0").fetchall()]

# ---------------------------------------------------------------- 个人中心

def list_my_media(kind: str, user_id: int, limit: int = 200):
    table = TABLES[kind]
    with connect() as c:
        rows = c.execute(
            f"SELECT id, filename, title, size, collection_id, created_at"
            f" FROM {table} WHERE uploader_id = ? AND deleted_at IS NULL"
            " ORDER BY created_at DESC, id DESC LIMIT ?", (user_id, limit)
        ).fetchall()
    return [dict(r) for r in rows]


def my_trash(user_id: int):
    out = []
    with connect() as c:
        for kind, table in TABLES.items():
            cols = "id, filename, title, deleted_at"
            if table == "videos":
                cols += ", poster"
            for r in c.execute(
                f"SELECT {cols} FROM {table}"
                " WHERE uploader_id = ? AND deleted_at IS NOT NULL"
                " ORDER BY deleted_at DESC LIMIT 100", (user_id,)
            ).fetchall():
                d = dict(r)
                d["kind"] = kind
                out.append(d)
    out.sort(key=lambda x: x["deleted_at"] or "", reverse=True)
    return out


def media_owner(kind: str, item_id: int):
    table = TABLES.get(kind)
    if not table:
        return None
    with connect() as c:
        row = c.execute(f"SELECT uploader_id FROM {table} WHERE id = ?",
                        (item_id,)).fetchone()
    return row["uploader_id"] if row else None


def record_download(user_id: int, kind: str, item_id: int) -> None:
    with connect() as c:
        c.execute("DELETE FROM downloads WHERE user_id = ? AND kind = ? AND item_id = ?",
                  (user_id, kind, item_id))
        c.execute(
            "INSERT INTO downloads (user_id, kind, item_id, created_at)"
            " VALUES (?,?,?,?)", (user_id, kind, item_id, now()))


def list_downloads(user_id: int, limit: int = 200):
    with connect() as c:
        rows = c.execute(
            "SELECT kind, item_id, created_at FROM downloads"
            " WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit)).fetchall()

        out = []
        for r in rows:
            table = TABLES.get(r["kind"])
            if not table:
                continue
            extra = ", poster" if table == "videos" else ""
            item = c.execute(
                f"SELECT id, filename, title, created_at{extra} FROM {table}"
                " WHERE id = ? AND deleted_at IS NULL", (r["item_id"],)
            ).fetchone()
            if item:
                d = dict(item)
                d["kind"] = r["kind"]
                d["downloaded_at"] = r["created_at"]
                out.append(d)
    return out


def media_filename(kind: str, item_id: int):
    table = TABLES.get(kind)
    if not table:
        return None
    with connect() as c:
        row = c.execute(
            f"SELECT filename, title FROM {table}"
            " WHERE id = ? AND deleted_at IS NULL", (item_id,)).fetchone()
    return dict(row) if row else None


def mark_one_seen(notif_id: int, user_id: int) -> bool:
    with connect() as c:
        cur = c.execute(
            "UPDATE notifications SET seen = 1 WHERE id = ? AND user_id = ?",
            (notif_id, user_id))
        return cur.rowcount > 0


def set_avatar(user_id: int, filename: str) -> bool:
    with connect() as c:
        cur = c.execute("UPDATE users SET avatar = ? WHERE id = ?",
                        (filename, user_id))
        return cur.rowcount > 0
