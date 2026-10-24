"""
鉴权：scrypt 口令哈希 + HMAC 签名的无状态会话 + 内存限流。

会话格式：  <uid>.<exp 秒级时间戳>.<签名的前 32 位十六进制>
服务端不存会话表，登出即删除 cookie；改密码后需要让旧会话失效可换 SECRET。
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import threading
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("SEVERUS_DATA") or (BASE / "data"))
SECRET_FILE = DATA / "secret.key"

SESSION_TTL = 12 * 3600          # 12 小时
SCRYPT = dict(n=2 ** 14, r=8, p=1, maxmem=64 * 1024 * 1024)

USERNAME_RE = re.compile(r"^[\w\u4e00-\u9fa5]{3,20}$")


def _secret() -> bytes:
    DATA.mkdir(parents=True, exist_ok=True)
    if SECRET_FILE.exists():
        return SECRET_FILE.read_bytes()
    key = secrets.token_bytes(32)
    SECRET_FILE.write_bytes(key)
    try:
        os.chmod(SECRET_FILE, 0o600)
    except OSError:
        pass
    return key


SECRET = _secret()


# ------------------------------------------------------------------ 口令

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, **SCRYPT)
    return f"scrypt${SCRYPT['n']}${SCRYPT['r']}${SCRYPT['p']}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt_hex, hash_hex = stored.split("$")
        if algo != "scrypt":
            return False
        dk = hashlib.scrypt(
            password.encode(),
            salt=bytes.fromhex(salt_hex),
            n=int(n), r=int(r), p=int(p), maxmem=64 * 1024 * 1024,
        )
        return hmac.compare_digest(dk.hex(), hash_hex)
    except (ValueError, TypeError):
        return False


def valid_username(name: str) -> bool:
    return bool(USERNAME_RE.match(name or ""))


# ------------------------------------------------------------------ 会话

def make_session(user_id: int) -> str:
    exp = int(time.time()) + SESSION_TTL
    payload = f"{user_id}.{exp}"
    sig = hmac.new(SECRET, payload.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{payload}.{sig}"


def read_session(token: str | None) -> int | None:
    if not token:
        return None
    parts = token.split(".")
    if len(parts) != 3:
        return None
    uid, exp, sig = parts
    payload = f"{uid}.{exp}"
    expect = hmac.new(SECRET, payload.encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(sig, expect):
        return None
    try:
        if int(exp) < time.time():
            return None
        return int(uid)
    except ValueError:
        return None


# ------------------------------------------------------------------ 限流

class RateLimiter:
    """按 IP 的滑动窗口限流，进程内存态，重启清零。"""

    def __init__(self) -> None:
        self._hits: dict[tuple[str, str], list[float]] = {}
        self._lock = threading.Lock()

    def allow(self, bucket: str, key: str, limit: int, window: float) -> bool:
        now = time.time()
        with self._lock:
            items = self._hits.setdefault((bucket, key), [])
            items[:] = [t for t in items if now - t < window]
            if len(items) >= limit:
                return False
            items.append(now)
            return True

    def sweep(self) -> None:
        now = time.time()
        with self._lock:
            for k in list(self._hits):
                self._hits[k] = [t for t in self._hits[k] if now - t < 3600]
                if not self._hits[k]:
                    del self._hits[k]


limiter = RateLimiter()
