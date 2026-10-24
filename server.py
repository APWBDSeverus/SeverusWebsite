"""
Severus的神秘聚落 —— 零依赖 HTTP 服务。

只用标准库：http.server / sqlite3 / hashlib / hmac / json。

上传不用 multipart：前端直接把文件字节当请求体发，元数据走 query string。
这样避免了 3.13 移除 cgi 模块后手写 multipart 的麻烦，
而且可以边收边写盘，500MB 的视频不会撑爆内存。

启动：
    python server.py                     # 只听本机 127.0.0.1:8080
    python server.py --host 0.0.0.0      # 允许局域网访问
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import mimetypes
import re
import secrets
import socket
import sys
import time
import traceback
import zipfile
from datetime import datetime
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

import auth
import store

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"

COOKIE_NAME = "sid"
PHOTO_MAX = 10 * 1024 * 1024            # 10 MB
VIDEO_MAX = int(1.5 * 1024 * 1024 * 1024)   # 1.5 GB
TRACK_MAX = 50 * 1024 * 1024            # 50 MB
JSON_MAX = 256 * 1024
POST_MAX = 500                          # 帖子字数
CHUNK = 1024 * 1024

LIMITS = {"photo": PHOTO_MAX, "video": VIDEO_MAX, "track": TRACK_MAX}

mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("video/webm", ".webm")
mimetypes.add_type("image/svg+xml", ".svg")

SEG_MIME = {"jpg": "image/jpeg", "png": "image/png", "gif": "image/gif",
            "webp": "image/webp", "mp4": "video/mp4", "webm": "video/webm",
            "mp3": "audio/mpeg", "m4a": "audio/mp4", "wav": "audio/wav",
            "ogg": "audio/ogg", "flac": "audio/flac"}

MEDIA_ROOTS = {"photos": store.PHOTO_DIR, "videos": store.VIDEO_DIR,
               "tracks": store.TRACK_DIR, "posters": store.POSTER_DIR,
               "avatars": store.AVATAR_DIR}


# ------------------------------------------------------------------ 工具

def sniff_ext(path: Path, kind: str) -> str | None:
    """读文件头判断真实类型，不信任扩展名和 Content-Type。"""
    with path.open("rb") as f:
        head = f.read(32)
    if kind == "photo":
        if head[:3] == b"\xff\xd8\xff":
            return "jpg"
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            return "png"
        if head[:6] in (b"GIF87a", b"GIF89a"):
            return "gif"
        if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            return "webp"
    elif kind == "video":
        if head[4:8] == b"ftyp":
            return "mp4"
        if head[:4] == b"\x1aE\xdf\xa3":
            return "webm"
    else:                                     # track
        if head[:3] == b"ID3":
            return "mp3"
        if len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0:
            return "mp3"                      # 无 ID3 标签的裸 MP3 帧
        if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
            return "wav"
        if head[:4] == b"OggS":
            return "ogg"
        if head[:4] == b"fLaC":
            return "flac"
        if head[4:8] == b"ftyp":
            return "m4a"
    return None


def parse_range(header: str | None, size: int):
    if not header or not header.startswith("bytes="):
        return None
    spec = header[6:].split(",")[0].strip()
    if "-" not in spec:
        return None
    left, right = spec.split("-", 1)
    try:
        if left == "":
            n = int(right)
            if n <= 0:
                return None
            start = max(0, size - n)
            end = size - 1
        else:
            start = int(left)
            end = int(right) if right else size - 1
    except ValueError:
        return None
    if start >= size or start > end:
        return None
    return start, min(end, size - 1)


def lan_addresses() -> list[str]:
    out = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in out:
                out.append(ip)
    except OSError:
        pass
    return out


# ------------------------------------------------------------------ 处理

class Handler(BaseHTTPRequestHandler):
    server_version = "Severus/1.0"
    protocol_version = "HTTP/1.0"          # 关掉 keep-alive，避免未读完请求体导致连接错位
    _user_cache = object()

    # -------------------------------------------------------------- 基础响应

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s  %s\n" % (self.address_string(), fmt % args))

    def send_bytes(self, body: bytes, ctype: str, status: int = 200,
                   cache: str = "no-store", extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, obj, status: int = 200, extra: dict | None = None):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_bytes(body, "application/json; charset=utf-8", status, extra=extra)

    def fail(self, status: int, message: str, **kw):
        self.send_json({"ok": False, "error": message, **kw}, status)

    def redirect(self, location: str, status: int = 302):
        self.send_response(status)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -------------------------------------------------------------- 请求上下文

    def cookie_token(self) -> str | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        jar = SimpleCookie()
        try:
            jar.load(raw)
        except Exception:
            return None
        return jar[COOKIE_NAME].value if COOKIE_NAME in jar else None

    def current_user(self):
        if self._user_cache is not Handler._user_cache:
            return self._user_cache
        uid = auth.read_session(self.cookie_token())
        user = None
        if uid is not None:
            u = store.get_user(uid)
            if u and not u["banned"]:
                user = {"id": u["id"], "username": u["username"], "role": u["role"],
                        "avatar": u.get("avatar")}
        self._user_cache = user
        return user

    def client_ip(self) -> str:
        return self.client_address[0] if self.client_address else "?"

    def require_user(self):
        user = self.current_user()
        if not user:
            self.fail(401, "请先登录")
        return user

    def require_staff(self):
        """管理员或版主：能删内容、处理举报，但改不了系统设置。"""
        user = self.current_user()
        if not user:
            self.fail(401, "请先登录")
            return None
        if user["role"] not in ("admin", "mod"):
            self.fail(403, "需要管理员或版主权限")
            return None
        return user

    def require_admin(self):
        user = self.current_user()
        if not user:
            self.fail(401, "请先登录")
            return None
        if user["role"] != "admin":
            self.fail(403, "需要管理员权限")
            return None
        return user

    def read_json(self, limit: int = JSON_MAX) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > limit:
            raise ValueError("请求体过大")
        raw = self.rfile.read(length)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def csrf_ok(self) -> bool:
        """只要不是我们自己的 JS 发的，就拒绝。
        浏览器跨站表单无法设置自定义请求头，形成天然 CSRF 防护。"""
        return self.headers.get("X-Requested-With") == "fetch"

    # -------------------------------------------------------------- 路由

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self._user_cache = Handler._user_cache
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        try:
            if path.startswith("/api/"):
                return self.route_api_get(path, parse_qs(parsed.query))
            if path.startswith("/media/"):
                return self.serve_media(path[len("/media/"):])
            if path == "/" or path == "/index.html":
                return self.serve_page("index.html")
            if path == "/login":
                return self.serve_page("login.html")
            if path == "/section":
                return self.serve_page("section.html")
            if path in ("/search", "/notifications", "/favorites", "/feed", "/following", "/tag", "/me") or path.startswith("/u/"):
                if path == "/me":
                    return self.serve_page("me.html")
                return self.serve_page("explore.html")
            if path == "/admin":
                user = self.current_user()
                if not user or user["role"] not in ("admin", "mod"):
                    return self.redirect("/login?next=/admin")
                return self.serve_page("admin.html")
            if path.startswith("/static/"):
                return self.serve_static(path[len("/static/"):])
            if path == "/favicon.ico":
                return self.send_bytes(b"", "image/x-icon", 204)
            if path.startswith("/api/"):
                return self.fail(404, "接口不存在")
            # 其它路径给一个像样的 404 页面
            page = (STATIC / "404.html")
            if page.is_file():
                self.send_bytes(page.read_bytes(), "text/html; charset=utf-8", 404,
                                cache="no-store")
                return
            return self.fail(404, "页面不存在")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            try:
                self.fail(500, "服务器内部错误")
            except Exception:
                pass

    def do_POST(self):
        self._user_cache = Handler._user_cache
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        try:
            if path == "/api/admin/upload/photo":
                return self.api_upload("photo", parse_qs(parsed.query))
            if path == "/api/admin/upload/video":
                return self.api_upload("video", parse_qs(parsed.query))
            if path == "/api/admin/upload/track":
                return self.api_upload("track", parse_qs(parsed.query))
            if path == "/api/admin/upload/chunk":
                return self.api_upload_chunk(parse_qs(parsed.query))

            segs_a = [s for s in path.strip("/").split("/") if s]

            if (len(segs_a) == 6 and segs_a[:3] == ["api", "admin", "trash"]
                    and segs_a[5] == "restore" and segs_a[4].isdigit()):
                if not self.require_admin():
                    return
                return self.send_json(
                    {"ok": bool(store.restore_media(segs_a[3], int(segs_a[4])))})

            if len(segs_a) == 6 and segs_a[:4] == ["api", "admin", "media", "video"] \
                    and segs_a[5] == "poster":
                return self.api_upload_poster(int(segs_a[4]))

            if len(segs_a) == 5 and segs_a[:3] == ["api", "admin", "media"] \
                    and segs_a[4] == "order":
                if not self.require_admin():
                    return
                data = self.read_json()
                ids = [int(i) for i in data.get("ids", []) if str(i).isdigit()]
                return self.send_json({"ok": True,
                                       "count": store.set_sort_orders(segs_a[3], ids)})

            if path == "/api/my/avatar":
                user = self.require_user()
                if not user:
                    return
                if not self.csrf_ok():
                    return self.fail(403, "非法请求来源")
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > 4 * 1024 * 1024:
                    return self.fail(413, "头像不能超过 4MB")
                store.AVATAR_DIR.mkdir(parents=True, exist_ok=True)
                tmp = store.TMP_DIR / f"av-{secrets.token_hex(8)}.bin"
                store.TMP_DIR.mkdir(parents=True, exist_ok=True)
                with tmp.open("wb") as fh:
                    left = length
                    while left > 0:
                        chunk = self.rfile.read(min(CHUNK, left))
                        if not chunk:
                            break
                        fh.write(chunk)
                        left -= len(chunk)
                ext = sniff_ext(tmp, "photo")
                if not ext:
                    tmp.unlink(missing_ok=True)
                    return self.fail(415, "头像格式不支持")
                name = f"{secrets.token_hex(16)}.{ext}"
                tmp.replace(store.AVATAR_DIR / name)
                store.set_avatar(user["id"], name)
                return self.send_json({"ok": True, "avatar": name}, 201)

            if path == "/api/my/collections":
                user = self.require_user()
                if not user:
                    return
                data = self.read_json()
                kind = str(data.get("kind", "")).strip()
                name = str(data.get("name", "")).strip()[:40]
                if kind not in ("photo", "video", "track"):
                    return self.fail(400, "类型错误")
                if not name:
                    return self.fail(400, "文件夹名不能为空")
                cid = store.create_collection(kind, name)
                return self.send_json({"ok": True, "id": cid, "name": name}, 201)

            if (len(segs_a) == 6 and segs_a[:3] == ["api", "my", "trash"]
                    and segs_a[5] == "restore" and segs_a[4].isdigit()):
                user = self.require_user()
                if not user:
                    return
                if store.media_owner(segs_a[3], int(segs_a[4])) != user["id"]:
                    return self.fail(403, "只能恢复自己上传的")
                return self.send_json(
                    {"ok": bool(store.restore_media(segs_a[3], int(segs_a[4])))})

            if path == "/api/admin/notify":
                return self.api_notify()

            if path == "/api/apply":
                return self.api_apply()

            if path == "/api/reports":
                return self.api_report()

            if (len(segs_a) == 4 and segs_a[:2] == ["api", "notifications"]
                    and segs_a[3] == "seen" and segs_a[2].isdigit()):
                user = self.require_user()
                if not user:
                    return
                return self.send_json(
                    {"ok": store.mark_one_seen(int(segs_a[2]), user["id"])})

            if path == "/api/notifications/seen":
                user = self.require_user()
                if not user:
                    return
                store.mark_notifications_seen(user["id"])
                return self.send_json({"ok": True})

            if len(segs_a) == 3 and segs_a[:2] == ["api", "follow"]:
                user = self.require_user()
                if not user:
                    return
                target = store.find_user(unquote(segs_a[2]))
                if not target:
                    return self.fail(404, "没有这个用户")
                return self.send_json(
                    {"ok": True, "following": store.follow(user["id"], target["id"])})

            if (len(segs_a) == 4 and segs_a[:2] == ["api", "favorite"]
                    and segs_a[3].isdigit()):
                user = self.require_user()
                if not user:
                    return
                on = store.toggle_favorite(user["id"], segs_a[2], int(segs_a[3]))
                return self.send_json({"ok": True, "favorite": on})

            if (len(segs_a) == 5 and segs_a[:3] == ["api", "admin", "applications"]
                    and segs_a[4] in ("approve", "reject")):
                user = self.require_admin()
                if not user:
                    return
                return self.api_application_decision(int(segs_a[3]), segs_a[4], user)

            if (len(segs_a) == 5 and segs_a[:3] == ["api", "admin", "reports"]
                    and segs_a[4] == "resolve"):
                user = self.require_staff()
                if not user:
                    return
                ok = store.resolve_report(int(segs_a[3]))
                return self.send_json({"ok": bool(ok)})

            if (len(segs_a) == 5 and segs_a[:3] == ["api", "staff", "tags"]):
                user = self.require_staff()
                if not user:
                    return
                data = self.read_json()
                names = data.get("tags", [])
                return self.send_json({
                    "ok": True,
                    "tags": store.set_tags(segs_a[3], int(segs_a[4]), names),
                })

            if path == "/api/admin/settings":
                user = self.require_admin()
                if not user:
                    return
                data = self.read_json()
                for key in ("allow_register", "invite_code", "site_note",
                            "apply_mode", "quota_bytes", "daily_files"):
                    if key in data:
                        store.set_setting(key, str(data[key]))
                store.add_audit(user["id"], "修改设置", "系统设置")
                return self.send_json({"ok": True, "settings": store.all_settings()})
            if path.startswith("/api/"):
                if not self.csrf_ok():
                    return self.fail(403, "非法请求来源")
                return self.route_api_post(path, parse_qs(parsed.query))
            return self.fail(404, "接口不存在")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except ValueError as exc:
            return self.fail(400, str(exc))
        except Exception:
            traceback.print_exc()
            try:
                self.fail(500, "服务器内部错误")
            except Exception:
                pass

    def do_DELETE(self):
        self._user_cache = Handler._user_cache
        path = unquote(urlparse(self.path).path)
        try:
            if not self.csrf_ok():
                return self.fail(403, "非法请求来源")
            segs = [s for s in path.strip("/").split("/") if s]
            # /api/admin/collections/{id}
            if len(segs) == 4 and segs[:3] == ["api", "admin", "collections"]:
                user = self.require_admin()
                if not user:
                    return
                if not segs[3].isdigit():
                    return self.fail(400, "id 错误")
                if store.delete_collection(int(segs[3])):
                    store.add_audit(user["id"], "删除文件夹", f"#{segs[3]}")
                    return self.send_json({"ok": True})
                return self.fail(400, "这个文件夹不能删")
            # /api/my/trash/{kind}/{id} —— 彻底删除自己的
            if (len(segs) == 5 and segs[:3] == ["api", "my", "trash"]
                    and segs[4].isdigit()):
                user = self.require_user()
                if not user:
                    return
                kind, item_id = segs[3], int(segs[4])
                if store.media_owner(kind, item_id) != user["id"]:
                    return self.fail(403, "只能删自己上传的")
                filename = store.purge_media(kind, item_id)
                if filename is None:
                    return self.fail(404, "记录不存在")
                try:
                    (store.media_dir(kind) / filename).unlink(missing_ok=True)
                except OSError:
                    pass
                return self.send_json({"ok": True})

            # /api/my/media/{kind}/{id} —— 移入回收站
            if (len(segs) == 5 and segs[:3] == ["api", "my", "media"]
                    and segs[4].isdigit()):
                user = self.require_user()
                if not user:
                    return
                kind, item_id = segs[3], int(segs[4])
                if store.media_owner(kind, item_id) != user["id"]:
                    return self.fail(403, "只能删自己上传的")
                if store.delete_media(kind, item_id) is None:
                    return self.fail(404, "记录不存在")
                return self.send_json({"ok": True})

            # /api/posts/{id} —— 只有管理员能删
            if len(segs) == 3 and segs[:2] == ["api", "posts"] and segs[2].isdigit():
                user = self.require_admin()
                if not user:
                    return
                pid = int(segs[2])
                if store.get_post_owner(pid) is None:
                    return self.fail(404, "帖子不存在")
                store.soft_delete_post(pid)
                store.add_audit(user["id"], "删除帖子", f"#{pid}")
                return self.send_json({"ok": True})

            # /api/admin/trash/{kind}/{id} —— 彻底删除
            if (len(segs) == 5 and segs[:3] == ["api", "admin", "trash"]
                    and segs[4].isdigit()):
                user = self.require_admin()
                if not user:
                    return
                filename = store.purge_media(segs[3], int(segs[4]))
                if filename is None:
                    return self.fail(404, "记录不存在")
                folder = store.media_dir(segs[3])
                try:
                    (folder / filename).unlink(missing_ok=True)
                except OSError:
                    pass
                store.add_audit(user["id"], "彻底删除", f"#{segs[4]} {filename}")
                return self.send_json({"ok": True})

            # /api/admin/media/{kind}/{id}
            if len(segs) == 5 and segs[:3] == ["api", "admin", "media"]:
                user = self.require_admin()
                if not user:
                    return
                kind, item_id = segs[3], segs[4]
                if kind not in ("photo", "video", "track"):
                    return self.fail(400, "类型错误")
                if not item_id.isdigit():
                    return self.fail(400, "id 错误")
                filename = store.delete_media(kind, int(item_id))
                if filename is None:
                    return self.fail(404, "记录不存在")
                store.add_audit(user["id"], "移入回收站",
                                f"#{item_id} {filename}")
                return self.send_json({"ok": True, "deleted": int(item_id)})
            return self.fail(404, "接口不存在")
        except Exception:
            traceback.print_exc()
            try:
                self.fail(500, "服务器内部错误")
            except Exception:
                pass

    def do_PATCH(self):
        self._user_cache = Handler._user_cache
        path = unquote(urlparse(self.path).path)
        try:
            if not self.csrf_ok():
                return self.fail(403, "非法请求来源")

            if path == "/api/admin/settings":
                user = self.require_admin()
                if not user:
                    return
                data = self.read_json()
                for key in ("allow_register", "invite_code", "site_note",
                            "apply_mode", "quota_bytes", "daily_files"):
                    if key in data:
                        store.set_setting(key, str(data[key]))
                store.add_audit(user["id"], "修改设置", "系统设置")
                return self.send_json({"ok": True, "settings": store.all_settings()})
            segs = [s for s in path.strip("/").split("/") if s]

            # /api/my/media/{kind}/{id} —— 改自己上传的
            if (len(segs) == 5 and segs[:3] == ["api", "my", "media"]
                    and segs[4].isdigit()):
                user = self.require_user()
                if not user:
                    return
                kind, item_id = segs[3], int(segs[4])
                if kind not in ("photo", "video", "track"):
                    return self.fail(400, "类型错误")
                if store.media_owner(kind, item_id) != user["id"]:
                    return self.fail(403, "只能改自己上传的")
                data = self.read_json()
                if "title" in data:
                    store.update_media_title(kind, item_id,
                                             str(data["title"]).strip()[:120])
                if "collection_id" in data:
                    raw = data["collection_id"]
                    cid = int(raw) if str(raw).isdigit() else None
                    store.set_media_collection(kind, item_id, cid)
                return self.send_json({"ok": True})

            # /api/posts/{id} —— 只有管理员能改
            if len(segs) == 3 and segs[:2] == ["api", "posts"] and segs[2].isdigit():
                user = self.require_admin()
                if not user:
                    return
                pid = int(segs[2])
                if store.get_post_owner(pid) is None:
                    return self.fail(404, "帖子不存在")
                body = str(self.read_json().get("body", "")).strip()
                if not body:
                    return self.fail(400, "内容不能为空")
                if len(body) > 500:
                    return self.fail(400, "内容不能超过 500 字")
                store.update_post(pid, body)
                return self.send_json({"ok": True, "body": body})

            # /api/admin/collections/{id}
            if len(segs) == 4 and segs[:3] == ["api", "admin", "collections"]:
                user = self.require_admin()
                if not user:
                    return
                if not segs[3].isdigit():
                    return self.fail(400, "id 错误")
                cid = int(segs[3])
                data = self.read_json()
                changed: list[str] = []
                if "name" in data:
                    name = str(data["name"]).strip()[:40]
                    if not name:
                        return self.fail(400, "名字不能为空")
                    if store.rename_collection(cid, name):
                        changed.append(f"改名「{name}」")
                if "pinned" in data:
                    ok = (store.pin_collection(cid) if data["pinned"]
                          else store.unpin_collection(cid))
                    if ok:
                        changed.append("置顶" if data["pinned"] else "取消置顶")
                if not changed:
                    return self.fail(404, "文件夹不存在")
                store.add_audit(user["id"], "修改文件夹", "；".join(changed))
                return self.send_json({"ok": True})
            # /api/admin/media/{kind}/{id}
            if len(segs) == 5 and segs[:3] == ["api", "admin", "media"]:
                user = self.require_admin()
                if not user:
                    return
                kind, raw_id = segs[3], segs[4]
                if kind not in ("photo", "video", "track") or not raw_id.isdigit():
                    return self.fail(400, "参数错误")
                data = self.read_json()
                item_id = int(raw_id)
                changed: list[str] = []

                if "title" in data:
                    title = str(data["title"]).strip()[:120]
                    if store.update_media_title(kind, item_id, title):
                        changed.append(f"标题改为「{title or '空'}」")

                if "pinned" in data:
                    if kind == "photo":
                        ok = store.set_pinned(item_id, bool(data["pinned"]))
                    elif kind == "track":
                        ok = store.set_track_pinned(item_id, bool(data["pinned"]))
                    else:
                        return self.fail(400, "只有照片和音乐可以置顶")
                    if ok:
                        changed.append("置顶" if data["pinned"] else "取消置顶")

                if "collection_id" in data:
                    raw = data["collection_id"]
                    cid = int(raw) if str(raw).isdigit() else None
                    if cid is not None:
                        col = store.get_collection(cid)
                        if not col or col["kind"] != kind:
                            return self.fail(400, "文件夹类型不匹配")
                    if store.set_media_collection(kind, item_id, cid):
                        changed.append("移入文件夹")

                if not changed:
                    return self.fail(404, "记录不存在")
                store.add_audit(user["id"], "修改媒体",
                                f"#{item_id} " + "；".join(changed))
                return self.send_json({"ok": True})
            return self.fail(404, "接口不存在")
        except ValueError as exc:
            return self.fail(400, str(exc))
        except Exception:
            traceback.print_exc()
            try:
                self.fail(500, "服务器内部错误")
            except Exception:
                pass

    # -------------------------------------------------------------- API: GET

    def route_api_get(self, path: str, qs: dict):
        if path == "/api/bootstrap":
            return self.send_json({
                "ok": True,
                "user": self.current_user(),
                "stats": store.stats(),
                "activity": store.recent_activity(10),
                "limits": {"photo": PHOTO_MAX, "video": VIDEO_MAX,
                           "track": TRACK_MAX, "post": POST_MAX},
            })
        if path == "/api/me":
            return self.send_json({
                "ok": True,
                "user": self.current_user(),
                "apply_mode": store.get_setting("apply_mode"),
                "allow_register": store.get_setting("allow_register"),
            })
        if path == "/api/photos":
            cid = self.collection_qs(qs)
            return self.send_json({
                "ok": True,
                "items": store.list_media("photo", self.limit(qs), self.offset(qs), cid),
                "total": store.count_media("photo", cid),
            })
        if path == "/api/videos":
            cid = self.collection_qs(qs)
            return self.send_json({
                "ok": True,
                "items": store.list_media("video", self.limit(qs), self.offset(qs), cid),
                "total": store.count_media("video", cid),
            })
        if path == "/api/tracks":
            cid = self.collection_qs(qs)
            return self.send_json({
                "ok": True,
                "items": store.list_media("track", self.limit(qs), self.offset(qs), cid),
                "total": store.count_media("track", cid),
            })
        if path == "/api/notifications/count":
            user = self.require_user()
            if not user:
                return
            return self.send_json({"ok": True, "unread": store.unread_count(user["id"])})

        if path == "/api/notifications":
            user = self.require_user()
            if not user:
                return
            return self.send_json({
                "ok": True,
                "items": store.list_notifications(user["id"]),
                "unread": store.unread_count(user["id"]),
            })

        if path == "/api/following":
            user = self.require_user()
            if not user:
                return
            return self.send_json({
                "ok": True,
                "following": store.following_list(user["id"]),
                "followers": store.followed_by_list(user["id"]),
            })
        if path == "/api/feed":
            user = self.require_user()
            if not user:
                return
            return self.send_json({
                "ok": True,
                "items": store.feed_posts(user["id"], self.limit(qs, 10), self.offset(qs)),
            })

        if path == "/api/favorites":
            user = self.require_user()
            if not user:
                return
            return self.send_json({"ok": True, "items": store.list_favorites(user["id"])})

        if path == "/api/tags":
            kind = (qs.get("kind", ["photo"])[0] or "photo").strip()
            if kind not in ("photo", "video", "track"):
                return self.fail(400, "类型错误")
            return self.send_json({"ok": True, "items": store.list_tags(kind)})

        if path == "/api/tag":
            kind = (qs.get("kind", ["photo"])[0] or "photo").strip()
            name = (qs.get("name", [""])[0] or "").strip()
            if not name:
                return self.fail(400, "缺少标签名")
            return self.send_json({"ok": True, "items": store.items_by_tag(kind, name)})

        if path == "/api/admin/applications":
            if not self.require_admin():
                return
            status = (qs.get("status", ["pending"])[0] or "pending").strip()
            return self.send_json({"ok": True, "items": store.list_applications(status)})

        if path == "/api/admin/reports":
            if not self.require_staff():
                return
            status = (qs.get("status", ["open"])[0] or "open").strip()
            return self.send_json({"ok": True, "items": store.list_reports(status)})

        if path == "/api/search":
            q = (qs.get("q", [""])[0] or "").strip()
            if not q:
                return self.send_json({"ok": True, "q": "", "results": {}})
            return self.send_json({"ok": True, "q": q, "results": store.search_all(q)})

        segs_u = [s for s in path.strip("/").split("/") if s]
        if len(segs_u) == 3 and segs_u[:2] == ["api", "users"]:
            prof = store.user_profile(unquote(segs_u[2]))
            if not prof:
                return self.fail(404, "没有这个用户")
            return self.send_json({"ok": True, "profile": prof})

        if path == "/api/admin/trash":
            if not self.require_admin():
                return
            return self.send_json({"ok": True, "items": store.list_trash()})

        if path == "/api/admin/settings":
            if not self.require_admin():
                return
            return self.send_json({"ok": True, "settings": store.all_settings()})

        if path == "/api/admin/backup":
            if not self.require_admin():
                return
            return self.api_backup()

        if path == "/robots.txt":
            return self.send_bytes(
                b"User-agent: *\nDisallow: /admin\nDisallow: /api/\n",
                "text/plain; charset=utf-8", cache="public, max-age=3600")

        if path == "/api/my/downloads":
            user = self.require_user()
            if not user:
                return
            return self.send_json({"ok": True,
                                   "items": store.list_downloads(user["id"])})

        segs_d = [s for s in path.strip("/").split("/") if s]
        if (len(segs_d) == 4 and segs_d[:2] == ["api", "download"]
                and segs_d[3].isdigit()):
            user = self.require_user()
            if not user:
                return
            kind = segs_d[2]
            if kind not in ("photo", "video", "track"):
                return self.fail(400, "类型错误")
            info = store.media_filename(kind, int(segs_d[3]))
            if not info:
                return self.fail(404, "文件不存在")
            store.record_download(user["id"], kind, int(segs_d[3]))
            folder = {"photo": "photos", "video": "videos", "track": "tracks"}[kind]
            title = (info.get("title") or "file").strip() or "file"
            ext = Path(info["filename"]).suffix
            shown = title if title.endswith(ext) else title + ext
            return self.redirect(
                f"/media/{folder}/{quote(info['filename'])}"
                f"?dl=1&name={quote(shown)}")

        if path == "/api/my/uploads":
            user = self.require_user()
            if not user:
                return
            kind = (qs.get("kind", ["photo"])[0] or "photo").strip()
            if kind not in ("photo", "video", "track"):
                return self.fail(400, "类型错误")
            return self.send_json({"ok": True,
                                   "items": store.list_my_media(kind, user["id"])})

        if path == "/api/my/trash":
            user = self.require_user()
            if not user:
                return
            return self.send_json({"ok": True, "items": store.my_trash(user["id"])})

        if path == "/api/collections":
            kind = (qs.get("kind", [""])[0] or "").strip()
            if kind not in ("photo", "video", "track"):
                return self.fail(400, "kind 错误")
            try:
                lim = int(qs.get("limit", ["0"])[0]) or None
            except (TypeError, ValueError):
                lim = None
            return self.send_json({"ok": True, "items": store.list_collections(kind, lim)})

        # /api/collections/{id}/download —— 歌单打包下载
        segs = [s for s in path.strip("/").split("/") if s]
        if (len(segs) == 4 and segs[:2] == ["api", "collections"]
                and segs[3] == "download" and segs[2].isdigit()):
            col = store.get_collection(int(segs[2]))
            if not col or col["kind"] != "track":
                return self.fail(404, "歌单不存在")
            items = store.list_media("track", 500, 0, col["id"])
            if not items:
                return self.fail(400, "这个歌单还是空的")

            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for i, it in enumerate(items, 1):
                    src = store.TRACK_DIR / it["filename"]
                    if not src.is_file():
                        continue
                    safe = "".join(c for c in (it["title"] or "track")
                                   if c not in '\\/:*?"<>|').strip() or "track"
                    zf.write(src, arcname=f"{i:02d} {safe}{src.suffix}")

            payload = buf.getvalue()
            name = f"{col['name']}.zip"
            self.send_bytes(
                payload, "application/zip",
                cache="no-store",
                extra={"Content-Disposition":
                       f"attachment; filename*=UTF-8''{quote(name)}"},
            )
            return

        # /api/posts/{id}/comments
        segs = [s for s in path.strip("/").split("/") if s]
        if (len(segs) == 4 and segs[:2] == ["api", "posts"]
                and segs[3] == "comments" and segs[2].isdigit()):
            pid = int(segs[2])
            post = store.get_post(pid)
            if not post:
                return self.fail(404, "帖子不存在")
            return self.send_json({
                "ok": True,
                "post": post,
                "items": store.list_comments(pid),
            })
        if path == "/api/posts":
            q = (qs.get("q", [""])[0] or "").strip() or None
            who = (qs.get("user", [""])[0] or "").strip() or None
            try:
                since = int(qs.get("since", ["0"])[0]) or None
            except (TypeError, ValueError):
                since = None
            sort = (qs.get("sort", ["recent"])[0] or "recent").strip()
            if sort not in ("recent", "likes", "comments"):
                sort = "recent"
            me = self.current_user()
            return self.send_json({
                "ok": True,
                "items": store.list_posts(self.limit(qs, 10), self.offset(qs),
                                          q, who, since, sort,
                                          me["id"] if me else 0),
                "total": store.count_posts(q, who, since),
            })
        if path == "/api/activity":
            return self.send_json({"ok": True, "items": store.recent_activity(10)})
        if path == "/api/admin/users":
            if not self.require_admin():
                return
            q = (qs.get("q", [""])[0] or "").strip() or None
            return self.send_json({"ok": True, "items": store.list_users(q)})
        if path == "/api/admin/activity":
            if not self.require_admin():
                return
            return self.send_json({"ok": True, "items": store.admin_activity(40)})
        if path == "/api/admin/audit":
            if not self.require_admin():
                return
            return self.send_json({"ok": True, "items": store.list_audit(60)})
        if path == "/api/admin/storage":
            if not self.require_admin():
                return
            return self.send_json({"ok": True, **store.storage_usage()})
        if path == "/api/admin/trend":
            if not self.require_admin():
                return
            return self.send_json({"ok": True, "items": store.activity_trend(7)})
        return self.fail(404, "接口不存在")

    @staticmethod
    def limit(qs: dict, default: int = 24) -> int:
        try:
            return max(1, min(60, int(qs.get("limit", [default])[0])))
        except (TypeError, ValueError):
            return default

    @staticmethod
    def offset(qs: dict) -> int:
        try:
            return max(0, int(qs.get("offset", [0])[0]))
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def collection_qs(qs: dict) -> int | None:
        raw = (qs.get("collection", [""])[0] or "").strip()
        if not raw:
            return None
        try:
            return int(raw)
        except ValueError:
            return None

    # -------------------------------------------------------------- API: POST

    def route_api_post(self, path: str, qs: dict):
        if path == "/api/auth/register":
            return self.api_register()
        if path == "/api/auth/login":
            return self.api_login()
        if path == "/api/auth/logout":
            return self.api_logout()
        if path == "/api/auth/password":
            return self.api_password()
        if path == "/api/posts":
            return self.api_create_post()
        if path == "/api/admin/ban":
            return self.api_ban()
        if path == "/api/admin/media/bulk-delete":
            return self.api_bulk_delete()
        if path == "/api/admin/collections":
            return self.api_create_collection()
        segs = [s for s in path.strip("/").split("/") if s]
        # /api/posts/{id}/like | /comment
        if len(segs) == 4 and segs[:2] == ["api", "posts"] and segs[2].isdigit():
            if segs[3] == "like":
                return self.api_like(int(segs[2]))
            if segs[3] == "comment":
                return self.api_comment(int(segs[2]))
        # /api/admin/posts/{id}/delete
        if len(segs) == 5 and segs[:3] == ["api", "admin", "posts"] and segs[4] == "delete":
            user = self.require_admin()
            if not user:
                return
            if not segs[3].isdigit():
                return self.fail(400, "id 错误")
            if store.delete_post(int(segs[3])):
                store.add_audit(user["id"], "删除帖子", f"#{segs[3]}")
                return self.send_json({"ok": True})
            return self.fail(404, "帖子不存在")
        return self.fail(404, "接口不存在")

    def api_create_collection(self):
        user = self.require_admin()
        if not user:
            return
        data = self.read_json()
        kind = data.get("kind")
        name = str(data.get("name", "")).strip()[:40]
        if kind not in ("photo", "video", "track"):
            return self.fail(400, "类型错误")
        if not name:
            return self.fail(400, "名字不能为空")
        cid = store.create_collection(kind, name)
        store.add_audit(user["id"], "新建文件夹", f"{store.NOUN[kind]} / {name}")
        return self.send_json({"ok": True, "id": cid, "name": name}, 201)

    def api_bulk_delete(self):
        user = self.require_admin()
        if not user:
            return
        data = self.read_json()
        kind = data.get("kind")
        if kind not in ("photo", "video", "track"):
            return self.fail(400, "类型错误")
        try:
            ids = [int(i) for i in data.get("ids", [])]
        except (TypeError, ValueError):
            return self.fail(400, "id 列表错误")
        if not ids:
            return self.fail(400, "没有选中任何条目")
        if len(ids) > 200:
            return self.fail(400, "一次最多删 200 个")

        names = store.delete_media_many(kind, ids)
        folder = store.media_dir(kind)
        for name in names:
            try:
                (folder / name).unlink(missing_ok=True)
            except OSError:
                pass
        label = store.NOUN[kind]
        store.add_audit(user["id"], "批量删除", f"{len(names)} 个{label}")
        return self.send_json({"ok": True, "deleted": len(names)})

    # -------------------------------------------------------------- 账号

    def set_session_cookie(self, user_id: int):
        token = auth.make_session(user_id)
        self._extra_cookie = (
            f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; "
            f"Max-Age={auth.SESSION_TTL}"
        )

    def api_register(self):
        if not auth.limiter.allow("register", self.client_ip(), 5, 600):
            return self.fail(429, "注册太频繁，请稍后再试")
        data = self.read_json()
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        if not auth.valid_username(username):
            return self.fail(400, "用户名需 3–20 位，仅限字母、数字、下划线或中文")
        if len(password) < 6:
            return self.fail(400, "密码至少 6 位")
        if len(password) > 128:
            return self.fail(400, "密码太长")
        if store.get_setting("allow_register") != "1":
            return self.fail(403, "本站暂时关闭了注册，请联系管理员")
        invite = store.get_setting("invite_code").strip()
        if invite and str(data.get("invite", "")).strip() != invite:
            return self.fail(403, "邀请码不对")
        if store.find_user(username):
            return self.fail(409, "这个用户名已经被占用（不区分大小写）")
        try:
            uid = store.create_user(username, auth.hash_password(password), "user")
        except ValueError:
            return self.fail(409, "这个用户名已经被占用（不区分大小写）")
        store.add_activity(uid, "login", "首次注册")
        self.set_session_cookie(uid)
        self.send_json({"ok": True, "user": {"id": uid, "username": username, "role": "user"}},
                       extra={"Set-Cookie": self._extra_cookie})

    def api_login(self):
        if not auth.limiter.allow("login", self.client_ip(), 10, 300):
            return self.fail(429, "尝试次数过多，请 5 分钟后再试")
        data = self.read_json()
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        user = store.find_user(username)
        if not user or not auth.verify_password(password, user["password"]):
            return self.fail(401, "用户名或密码错误")
        if user["banned"]:
            return self.fail(403, "该账号已被封禁")
        self.set_session_cookie(user["id"])
        store.add_activity(user["id"], "login", "")
        self.send_json({"ok": True,
                        "user": {"id": user["id"], "username": user["username"],
                                 "role": user["role"]}},
                       extra={"Set-Cookie": self._extra_cookie})

    def api_logout(self):
        self.send_json({"ok": True},
                       extra={"Set-Cookie": f"{COOKIE_NAME}=; Path=/; Max-Age=0"})

    def api_reset(self):
        """忘记密码：凭用户名直接重置。管理员账号不允许走这条路。"""
        if not auth.limiter.allow("reset", self.client_ip(), 5, 600):
            return self.fail(429, "重置太频繁，请稍后再试")
        data = self.read_json()
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        user = store.find_user(username)
        if not user:
            return self.fail(404, "没有这个用户名")
        if user["role"] == "admin":
            return self.fail(403, "管理员密码请在服务器上用 reset_admin.py 重置")
        if len(password) < 6:
            return self.fail(400, "新密码至少 6 位")
        store.update_password(user["id"], auth.hash_password(password))
        store.add_audit(user["id"], "自助重置密码", "忘记密码")
        return self.send_json({"ok": True})

    def api_password(self):
        user = self.require_user()
        if not user:
            return
        data = self.read_json()
        old = str(data.get("old", ""))
        new = str(data.get("new", ""))
        row = store.get_user(user["id"])
        if not row or not auth.verify_password(old, row["password"]):
            return self.fail(400, "原密码不正确")
        if len(new) < 6:
            return self.fail(400, "新密码至少 6 位")
        if len(new) > 128:
            return self.fail(400, "密码太长")
        store.update_password(user["id"], auth.hash_password(new))
        store.add_audit(user["id"], "修改密码", "自己")
        return self.send_json({"ok": True})

    def api_ban(self):
        user = self.require_admin()
        if not user:
            return
        data = self.read_json()
        try:
            uid = int(data.get("id"))
        except (TypeError, ValueError):
            return self.fail(400, "id 错误")
        target = store.get_user(uid)
        if not target:
            return self.fail(404, "用户不存在")
        if target["role"] == "admin":
            return self.fail(400, "不能封禁管理员")
        store.set_banned(uid, bool(data.get("banned")))
        store.add_audit(user["id"], "封禁" if data.get("banned") else "解封",
                        target["username"])
        return self.send_json({"ok": True})

    def api_like(self, post_id: int):
        user = self.require_user()
        if not user:
            return
        if not store.get_post(post_id):
            return self.fail(404, "帖子不存在")
        liked, total = store.toggle_like(post_id, user["id"])
        if liked:
            owner = store.get_post_owner(post_id)
            if owner and owner != user["id"]:
                store.notify(owner, "like", f"{user['username']} 赞了你的帖子",
                             f"/section?kind=forum&post={post_id}")
        return self.send_json({"ok": True, "liked": liked, "likes": total})

    def api_comment(self, post_id: int):
        user = self.require_user()
        if not user:
            return
        if not store.get_post(post_id):
            return self.fail(404, "帖子不存在")
        if not auth.limiter.allow("comment", f"u{user['id']}", 5, 60):
            return self.fail(429, "评论太快了，休息一下")

        data = self.read_json()
        body = str(data.get("body", "")).strip()
        if not body:
            return self.fail(400, "评论不能为空")
        if len(body) > 300:
            return self.fail(400, "评论不能超过 300 字")

        cid = store.add_comment(post_id, user["id"], body)
        owner = store.get_post_owner(post_id)
        if owner and owner != user["id"]:
            store.notify(owner, "comment", f"{user['username']} 评论了你的帖子",
                         f"/section?kind=forum&post={post_id}")
        return self.send_json({
            "ok": True,
            "item": {"id": cid, "body": body, "username": user["username"],
                     "created_at": store.now()},
        }, 201)

    # -------------------------------------------------------------- 论坛

    def api_create_post(self):
        user = self.require_user()
        if not user:
            return
        if not auth.limiter.allow("post", f"u{user['id']}", 1, 20):
            return self.fail(429, "发言太快了，20 秒后再来")
        data = self.read_json()
        body = str(data.get("body", "")).strip()
        if not body:
            return self.fail(400, "内容不能为空")
        if len(body) > POST_MAX:
            return self.fail(400, f"内容不能超过 {POST_MAX} 字")
        pid = store.add_post(user["id"], body)
        store.add_activity(user["id"], "post", body[:40])
        item = {"id": pid, "body": body, "username": user["username"],
                "created_at": store.now()}
        self.send_json({"ok": True, "item": item})

    # -------------------------------------------------------------- 上传

    def api_upload(self, kind: str, qs: dict):
        user = self.require_admin()
        if not user:
            return
        if not self.csrf_ok():
            return self.fail(403, "非法请求来源")

        limit = LIMITS[kind]
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.fail(400, "Content-Length 无效")

        if length <= 0:
            return self.fail(400, "没有收到文件数据")
        if length > limit:
            self.close_connection = True
            return self.fail(413, f"文件超过上限（{limit // 1024 // 1024} MB）",
                             limit=limit)

        title = str(qs.get("title", [""])[0])[:120]
        folder = store.media_dir(kind)

        raw_cid = (qs.get("collection", [""])[0] or "").strip()
        cid = int(raw_cid) if raw_cid.isdigit() else None
        cid = store.ensure_collection(kind, cid)
        tmp = folder / f".incoming-{secrets.token_hex(8)}"

        remaining = length
        try:
            with tmp.open("wb") as fh:
                while remaining > 0:
                    chunk = self.rfile.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    fh.write(chunk)
                    remaining -= len(chunk)
            if remaining != 0:
                return self.fail(400, "上传中断")

            ext = sniff_ext(tmp, kind)
            if not ext:
                return self.fail(415, "文件类型不被支持，或扩展名与实际内容不符")

            filename = f"{secrets.token_hex(16)}.{ext}"
            final = folder / filename
            tmp.replace(final)
            item_id = store.add_media(kind, filename, title, length, user["id"], cid)
            store.add_audit(user["id"], "上传" + store.NOUN[kind],
                            f"{filename} {title}".strip())
            return self.send_json({
                "ok": True,
                "item": {"id": item_id, "filename": filename, "title": title,
                         "size": length, "created_at": store.now()},
            }, 201)
        finally:
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass

    def api_upload_chunk(self, qs: dict):
        """分片上传：按 offset 续写临时文件，最后一片到达时校验并入库。"""
        user = self.require_user()
        if not user:
            return
        if not self.csrf_ok():
            return self.fail(403, "非法请求来源")

        kind = (qs.get("kind", [""])[0] or "").strip()
        if kind not in LIMITS:
            return self.fail(400, "类型错误")

        uid = (qs.get("id", [""])[0] or "").strip()
        if not re.fullmatch(r"[0-9a-f]{16,64}", uid):
            return self.fail(400, "上传 id 无效")

        try:
            offset = int(qs.get("offset", ["0"])[0])
            total = int(qs.get("total", ["0"])[0])
        except ValueError:
            return self.fail(400, "参数错误")

        limit = LIMITS[kind]
        if total <= 0 or total > limit:
            self.close_connection = True
            return self.fail(413, f"文件超过上限（{limit // 1024 // 1024} MB）",
                             limit=limit)
        if offset < 0 or offset > total:
            return self.fail(400, "偏移量无效")

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.fail(400, "Content-Length 无效")
        if length <= 0 or offset + length > total:
            return self.fail(400, "分片长度不对")

        store.TMP_DIR.mkdir(parents=True, exist_ok=True)
        part = store.TMP_DIR / f"{uid}.part"

        # 配额只在第一片检查，管理员不限
        if offset == 0 and user["role"] != "admin":
            quota = int(store.get_setting("quota_bytes") or 0)
            if quota and store.user_usage(user["id"]) + total > quota:
                return self.fail(403, "存储配额不够了，找管理员加点空间")
            daily = int(store.get_setting("daily_files") or 0)
            if daily:
                used, _ = store.today_uploads(user["id"])
                if used >= daily:
                    return self.fail(403, f"今天已经传了 {used} 个，明天再来")

        try:
            with part.open("wb" if offset == 0 else "r+b") as fh:
                fh.seek(offset)
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(CHUNK, remaining))
                    if not chunk:
                        return self.fail(400, "上传中断")
                    fh.write(chunk)
                    remaining -= len(chunk)
        except OSError as exc:
            return self.fail(500, f"写临时文件失败：{exc}")

        received = offset + length
        if received < total:
            return self.send_json({"ok": True, "received": received})

        ext = sniff_ext(part, kind)
        if not ext:
            part.unlink(missing_ok=True)
            return self.fail(415, "文件类型不被支持，或扩展名与实际内容不符")

        # 秒传：内容一样的文件只存一份
        digest = hashlib.sha256()
        with part.open("rb") as fh:
            for block in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(block)
        same = (store.find_by_hash(kind, digest.hexdigest())
                if store.get_setting("dedupe") == "1" else None)
        if same:
            part.unlink(missing_ok=True)
            return self.send_json({"ok": True, "item": same, "dup": True}, 201)

        folder = store.media_dir(kind)
        filename = f"{secrets.token_hex(16)}.{ext}"
        part.replace(folder / filename)

        title = str(qs.get("title", [""])[0])[:120].strip()
        if not title:
            raw_name = str(qs.get("name", [""])[0] or "").strip()
            title = raw_name.rsplit(".", 1)[0][:120] if raw_name else ""
        raw_cid = (qs.get("collection", [""])[0] or "").strip()
        cid = int(raw_cid) if raw_cid.isdigit() else None
        cid = store.ensure_collection(kind, cid)

        item_id = store.add_media(kind, filename, title, total, user["id"], cid,
                                  sha256=digest.hexdigest())
        store.add_audit(user["id"], "上传" + store.NOUN[kind],
                        f"{filename} {title}".strip())
        return self.send_json({
            "ok": True,
            "item": {"id": item_id, "filename": filename, "title": title,
                     "size": total, "created_at": store.now()},
        }, 201)

    def api_notify(self):
        """管理员给全部用户或某个人发通知。"""
        user = self.require_admin()
        if not user:
            return
        data = self.read_json()
        text = str(data.get("text", "")).strip()[:200]
        target = str(data.get("to", "all")).strip()
        if not text:
            return self.fail(400, "通知内容不能为空")

        names = data.get("users")
        if target == "all" or (not names and target == "all"):
            ids = store.all_user_ids()
        elif isinstance(names, list) and names:
            ids = []
            for raw in names[:500]:
                one = store.find_user(str(raw))
                if one and not one.get("banned"):
                    ids.append(one["id"])
            if not ids:
                return self.fail(404, "选中的用户不存在")
        else:
            one = store.find_user(target)
            if not one:
                return self.fail(404, "没有这个用户")
            ids = [one["id"]]

        for uid in ids:
            if uid == user["id"]:
                continue          # 自己发的不弹自己的红点
            store.notify(uid, "admin", text, "/notifications")
        store.add_audit(user["id"], "发送通知", f"{target}：{text[:40]}")
        return self.send_json({"ok": True, "sent": len(ids)}, 201)

    def api_apply(self):
        """申请制注册：不直接建号，先排队等管理员批。"""
        if not auth.limiter.allow("apply", self.client_ip(), 5, 600):
            return self.fail(429, "提交太频繁，请稍后再试")
        data = self.read_json()
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        note = str(data.get("note", "")).strip()[:200]

        if not auth.valid_username(username):
            return self.fail(400, "用户名需 3–20 位，仅限字母、数字、下划线或中文")
        if len(password) < 6:
            return self.fail(400, "密码至少 6 位")
        if store.find_user(username):
            return self.fail(409, "这个用户名已经被占用了")

        app_id = store.apply_join(username, auth.hash_password(password), note)
        for admin_id in store.admin_ids():
            store.notify(admin_id, "apply", f"{username} 申请加入聚落", f"/admin?app={app_id}")
        return self.send_json({"ok": True, "id": app_id}, 201)

    def api_application_decision(self, app_id: int, action: str, staff: dict):
        app_row = store.get_application(app_id)
        if not app_row or app_row["status"] != "pending":
            return self.fail(404, "申请不存在或已处理")

        if action == "reject":
            store.mark_application(app_id, "rejected")
            store.add_audit(staff["id"], "拒绝申请", app_row["username"])
            return self.send_json({"ok": True})

        try:
            uid = store.create_user(app_row["username"], app_row["password_hash"], "user")
        except ValueError:
            return self.fail(409, "用户名已被占用")
        store.mark_application(app_id, "approved")
        store.notify(uid, "welcome", "你的加入申请通过了，欢迎", "/")
        store.add_audit(staff["id"], "通过申请", app_row["username"])
        return self.send_json({"ok": True, "user_id": uid})

    def api_report(self):
        user = self.current_user()
        data = self.read_json()
        kind = str(data.get("kind", "")).strip()
        item_id = data.get("id")
        reason = str(data.get("reason", "")).strip()[:200]
        if kind not in ("post", "photo", "video", "track", "comment"):
            return self.fail(400, "举报对象类型错误")
        if not str(item_id).isdigit():
            return self.fail(400, "举报对象错误")
        if not auth.limiter.allow("report", self.client_ip(), 10, 600):
            return self.fail(429, "举报太频繁")

        store.add_report(kind, int(item_id), reason, user["id"] if user else None)
        return self.send_json({"ok": True}, 201)

    def api_backup(self):
        """把整个 data 目录打成 zip 发出去（数据库 + 全部媒体）。"""
        store.TMP_DIR.mkdir(parents=True, exist_ok=True)
        tmp = store.TMP_DIR / f"backup-{secrets.token_hex(6)}.zip"
        try:
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as zf:
                for f in sorted(store.DATA.rglob("*")):
                    if not f.is_file() or store.TMP_DIR in f.parents:
                        continue
                    zf.write(f, arcname=str(f.relative_to(store.DATA)))

            size = tmp.stat().st_size
            name = f"severus-backup-{datetime.now():%Y%m%d-%H%M}.zip"
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            self.send_header(
                "Content-Disposition",
                f"attachment; filename*=UTF-8''{quote(name)}")
            self.end_headers()
            with tmp.open("rb") as fh:
                while True:
                    chunk = fh.read(256 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        finally:
            tmp.unlink(missing_ok=True)

    def api_upload_poster(self, video_id: int):
        user = self.require_admin()
        if not user:
            return
        if not self.csrf_ok():
            return self.fail(403, "非法请求来源")

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 8 * 1024 * 1024:
            return self.fail(413, "封面图太大")

        store.POSTER_DIR.mkdir(parents=True, exist_ok=True)
        tmp = store.TMP_DIR / f"poster-{secrets.token_hex(8)}.bin"
        store.TMP_DIR.mkdir(parents=True, exist_ok=True)
        with tmp.open("wb") as fh:
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(CHUNK, remaining))
                if not chunk:
                    break
                fh.write(chunk)
                remaining -= len(chunk)

        ext = sniff_ext(tmp, "photo")
        if not ext:
            tmp.unlink(missing_ok=True)
            return self.fail(415, "封面格式不支持")

        name = f"{secrets.token_hex(16)}.{ext}"
        tmp.replace(store.POSTER_DIR / name)
        store.set_video_poster(video_id, name)
        return self.send_json({"ok": True, "poster": name}, 201)

    # -------------------------------------------------------------- 媒体与静态

    def serve_media(self, rel: str):
        parts = rel.split("/")
        if len(parts) != 2:
            return self.fail(404, "文件不存在")
        folder_name, name = parts
        if folder_name not in MEDIA_ROOTS or not name:
            return self.fail(404, "文件不存在")
        if "/" in name or "\\" in name or name.startswith("."):
            return self.fail(400, "非法路径")

        base = MEDIA_ROOTS[folder_name]
        path = (base / name).resolve()
        if base.resolve() not in path.parents or not path.is_file():
            return self.fail(404, "文件不存在")

        size = path.stat().st_size
        ext = path.suffix.lstrip(".").lower()
        ctype = SEG_MIME.get(ext, "application/octet-stream")
        rng = parse_range(self.headers.get("Range"), size)

        if rng is None:
            start, end, status = 0, size - 1, 200
        else:
            start, end, status = rng[0], rng[1], 206

        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.send_header("X-Content-Type-Options", "nosniff")

        dl_qs = parse_qs(urlparse(self.path).query)
        if dl_qs.get("dl"):
            shown = (dl_qs.get("name", [""])[0] or name) or name
            self.send_header(
                "Content-Disposition",
                f"attachment; filename*=UTF-8''{quote(shown)}")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()

        if self.command == "HEAD":
            return
        with path.open("rb") as fh:
            fh.seek(start)
            left = length
            while left > 0:
                chunk = fh.read(min(256 * 1024, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def serve_static(self, rel: str):
        if not rel:
            return self.fail(404, "文件不存在")
        target = (STATIC / rel).resolve()
        if STATIC.resolve() not in target.parents or not target.is_file():
            return self.fail(404, "文件不存在")
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        body = target.read_bytes()
        self.send_bytes(body, ctype if not ctype.startswith("text/") else ctype + "; charset=utf-8",
                        cache="no-cache")

    def serve_page(self, name: str):
        path = STATIC / name
        if not path.is_file():
            return self.fail(404, "页面不存在")
        body = path.read_bytes()
        self.send_bytes(body, "text/html; charset=utf-8", cache="no-store")


# ------------------------------------------------------------------ 启动

def ensure_admin() -> None:
    if store.admin_exists():
        return
    # 用不含歧义字符的字母表：没有 0/O、1/l/I，抄写不会看错
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    password = "".join(secrets.choice(alphabet) for _ in range(12))
    store.create_user("admin", auth.hash_password(password), "admin")
    info = (
        "==============================================\n"
        " 初始管理员账号已创建\n"
        f"   用户名： admin（登录时不区分大小写）\n"
        f"   密  码： {password}\n"
        " 登录后可在后台修改密码；此文件可删除。\n"
        " 密码也可用 python reset_admin.py 重置。\n"
        "==============================================\n"
    )
    (store.DATA / "ADMIN.txt").write_text(info, encoding="utf-8")
    print(info, flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description="Severus的神秘聚落")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    args = ap.parse_args()

    store.init()
    ensure_admin()

    # 清掉一天前没传完的残片
    try:
        for stale in store.TMP_DIR.glob("*.part"):
            try:
                if time.time() - stale.stat().st_mtime > 86400:
                    stale.unlink()
            except OSError:
                pass
    except OSError:
        pass

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True

    print()
    print("  Severus的神秘聚落 已启动")
    print(f"  本机：   http://127.0.0.1:{args.port}")
    if args.host == "0.0.0.0":
        for ip in lan_addresses():
            print(f"  局域网： http://{ip}:{args.port}")
    print(f"  数据：   {store.DATA}")
    print("  按 Ctrl+C 停止")
    print()
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止")
        httpd.shutdown()


if __name__ == "__main__":
    main()
