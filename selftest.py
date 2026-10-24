"""
端到端自检：起一个真服务，把所有接口走一遍。

用法：
    python selftest.py

它会：
  1. 在临时目录里创建独立的数据目录（不碰你的 data/）
  2. 启动 server.py
  3. 依次验证：页面、注册、登录、发帖、访客记录、上传、Range 分段、
     鉴权拒绝、CSRF 拒绝、删除、改密码
  4. 关闭服务并清理临时目录
"""

from __future__ import annotations

import http.cookiejar
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

BASE = Path(__file__).resolve().parent
PORT = 8091
ROOT = f"http://127.0.0.1:{PORT}"

passed = 0
failed = 0


def check(name: str, ok: bool, detail: str = ""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  \033[32m✓\033[0m {name}")
    else:
        failed += 1
        print(f"  \033[31m✗\033[0m {name}  {detail}")


def request(opener, path, data=None, headers=None, method=None, raw=False):
    url = ROOT + path
    hdrs = {"X-Requested-With": "fetch"}
    if headers:
        hdrs.update(headers)
    body = None
    if data is not None:
        body = data if isinstance(data, bytes) else json.dumps(data).encode()
        if not isinstance(data, bytes):
            hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        with opener.open(req, timeout=20) as resp:
            payload = resp.read()
            if raw:
                return resp.status, payload, dict(resp.headers)
            try:
                return resp.status, json.loads(payload), dict(resp.headers)
            except json.JSONDecodeError:
                return resp.status, payload, dict(resp.headers)
    except urllib.error.HTTPError as e:
        payload = e.read()
        if raw:
            return e.code, payload, dict(e.headers)
        try:
            return e.code, json.loads(payload), dict(e.headers)
        except json.JSONDecodeError:
            return e.code, payload, dict(e.headers)


def new_opener():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def opener_no_redirect():
    """用来验证重定向本身，不让 urllib 自己跟过去。"""
    return urllib.request.build_opener(_NoRedirect)


def tiny_png() -> bytes:
    """1×1 透明 PNG，用来测上传。"""
    import base64
    return base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
        "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
    )


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="severus-test-"))
    env = dict(os.environ, SEVERUS_DATA=str(tmp), PYTHONIOENCODING="utf-8")

    proc = subprocess.Popen(
        [sys.executable, "server.py", "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=str(BASE), env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding="utf-8", errors="replace",
    )

    try:
        # 等服务起来
        opener0 = new_opener()
        ready = False
        for _ in range(60):
            try:
                status, _, _ = request(opener0, "/api/me", raw=True)
                if status == 200:
                    ready = True
                    break
            except Exception:
                pass
            time.sleep(0.2)
        if not ready:
            print("服务没有起来，输出如下：")
            print(proc.stdout.read() if proc.stdout else "")
            return 1

        print("\n[1] 页面与静态资源")
        status, body, _ = request(opener0, "/", raw=True)
        check("GET / 返回 HTML", status == 200 and b"Severus" in body, f"status={status}")
        status, body, hdrs = request(opener0, "/static/css/app.css", raw=True)
        check("CSS 可访问", status == 200 and b"--primary" in body)
        status, body, _ = request(opener0, "/login", raw=True)
        check("GET /login 返回 HTML", status == 200 and "登录".encode() in body)
        status, body, _ = request(opener0, "/section?kind=photo", raw=True)
        check("分栏页可达", status == 200 and b"sec-title" in body, f"status={status}")
        status, _, hdrs = request(opener_no_redirect(), "/admin", raw=True)
        check("未登录访问 /admin 被重定向",
              status in (301, 302) and "/login" in hdrs.get("Location", ""),
              f"status={status} loc={hdrs.get('Location')}")
        status, _, _ = request(opener0, "/no-such-page", raw=True)
        check("404 正常返回", status == 404)

        print("\n[2] 注册 / 登录 / 身份")
        alice = new_opener()
        status, data, _ = request(alice, "/api/auth/register",
                                  {"username": "alice", "password": "secret123"})
        check("注册 alice", status == 200 and data.get("ok"), str(data))
        status, data, _ = request(alice, "/api/me")
        check("会话生效", data.get("user", {}).get("username") == "alice")
        status, data, _ = request(alice, "/api/auth/register",
                                  {"username": "alice", "password": "secret123"})
        check("重名注册被拒", status == 409, str(status))
        status, data, _ = request(alice, "/api/auth/register",
                                  {"username": "ab", "password": "secret123"})
        check("过短用户名被拒", status == 400, str(status))
        status, data, _ = request(alice, "/api/auth/register",
                                  {"username": "ALICE", "password": "secret123"})
        check("大小写不同也算重名", status == 409, str(status))
        status, data, _ = request(alice, "/api/auth/register",
                                  {"username": "Alice", "password": "secret123"})
        check("混合大小写也算重名", status == 409, str(status))

        bad = new_opener()
        status, data, _ = request(bad, "/api/auth/login",
                                  {"username": "alice", "password": "wrong"})
        check("错误密码被拒", status == 401, str(status))

        print("\n[3] 发帖与访客记录")
        status, data, _ = request(opener0, "/api/activity")
        alice_events = [i for i in data.get("items", []) if i["username"] == "alice"]
        check("注册后出现在访客记录", len(alice_events) == 1 and alice_events[0]["kind"] == "login",
              str(alice_events))

        status, data, _ = request(alice, "/api/posts", {"body": "聚落的第一条留言"})
        check("登录后可发帖", status == 200 and data.get("ok"), str(data))
        status, data, _ = request(alice, "/api/posts")
        check("帖子列表可见", len(data.get("items", [])) == 1)

        status, data, _ = request(opener0, "/api/activity")
        alice_events = [i for i in data.get("items", []) if i["username"] == "alice"]
        check("十分钟内同一人只显示一次", len(alice_events) == 1, str(alice_events))
        check("去重后保留最新一条（发帖）",
              alice_events and alice_events[0]["kind"] == "post", str(alice_events))

        anon = new_opener()
        status, data, _ = request(anon, "/api/posts", {"body": "匿名发言"})
        check("未登录发帖被拒", status == 401, str(status))

        print("\n[4] CSRF 与限流")
        status, data, _ = request(anon, "/api/posts", {"body": "x"},
                                  headers={"X-Requested-With": ""}, method="POST")
        check("缺少自定义头被拒", status == 403, str(status))

        print("\n[5] 管理员与上传")
        admin_pw = None
        admin_file = tmp / "ADMIN.txt"
        if admin_file.exists():
            m = re.search(r"密\s*码：\s*(\S+)", admin_file.read_text(encoding="utf-8"))
            admin_pw = m.group(1) if m else None
        check("ADMIN.txt 已生成", admin_pw is not None, str(admin_file))

        admin = new_opener()
        status, data, _ = request(admin, "/api/auth/login",
                                  {"username": "admin", "password": admin_pw})
        check("管理员登录", status == 200 and data.get("user", {}).get("role") == "admin", str(data))

        status, data, _ = request(new_opener(), "/api/auth/login",
                                  {"username": "ADMIN", "password": admin_pw})
        check("用户名不区分大小写", status == 200, str(status))

        status, data, _ = request(opener0, "/api/activity")
        names = [i["username"] for i in data.get("items", [])]
        check("管理员不出现在访客记录", "admin" not in names, str(names))

        png = tiny_png()
        status, data, _ = request(
            admin, "/api/admin/upload/photo?title=%E6%B5%8B%E8%AF%95",
            png, headers={"Content-Type": "application/octet-stream"})
        check("上传 PNG 成功", status == 201 and data.get("ok"), str(data)[:200])
        fname = data.get("item", {}).get("filename")

        status, data, _ = request(admin, "/api/admin/upload/photo",
                                  b"this is not an image",
                                  headers={"Content-Type": "application/octet-stream"})
        check("伪造图片被拒", status == 415, str(status))

        status, data, _ = request(anon, "/api/admin/upload/photo", png,
                                  headers={"Content-Type": "application/octet-stream"})
        check("普通用户不能上传", status in (401, 403), str(status))

        print("\n[6] 媒体服务与 Range")
        status, body, hdrs = request(opener0, f"/media/photos/{fname}", raw=True)
        check("媒体可访问", status == 200 and body[:4] == b"\x89PNG", f"status={status}")
        check("Content-Type 正确", hdrs.get("Content-Type") == "image/png",
              str(hdrs.get("Content-Type")))
        check("支持 Range", hdrs.get("Accept-Ranges") == "bytes")

        status, body, hdrs = request(opener0, f"/media/photos/{fname}",
                                     headers={"Range": "bytes=0-3"}, raw=True)
        check("Range 返回 206", status == 206, f"status={status}")
        check("Content-Range 正确",
              hdrs.get("Content-Range", "").startswith("bytes 0-3/"), str(hdrs.get("Content-Range")))
        check("分段字节正确", body == png[:4], str(body[:8]))

        status, _, _ = request(opener0, "/media/photos/../secret.key", raw=True)
        check("路径穿越被挡", status in (400, 404), str(status))

        print("\n[7] 删除与改密")
        photo_id = data_id = None
        status, data, _ = request(opener0, "/api/photos")
        if data.get("items"):
            photo_id = data["items"][0]["id"]
        status, data, _ = request(admin, f"/api/admin/media/photo/{photo_id}",
                                  method="DELETE")
        check("管理员删除照片", status == 200 and data.get("ok"), str(data))
        status, data, _ = request(opener0, "/api/photos")
        check("照片已从列表移除", len(data.get("items", [])) == 0)

        status, data, _ = request(alice, "/api/auth/password",
                                  {"old": "secret123", "new": "newsecret456"})
        check("修改密码", status == 200 and data.get("ok"), str(data))
        fresh = new_opener()
        status, data, _ = request(fresh, "/api/auth/login",
                                  {"username": "alice", "password": "newsecret456"})
        check("新密码可登录", status == 200, str(status))
        status, data, _ = request(fresh, "/api/auth/login",
                                  {"username": "alice", "password": "secret123"})
        check("旧密码已失效", status == 401, str(status))

        print("\n[8] 封禁")
        status, data, _ = request(admin, "/api/admin/users")
        alice_id = next((u["id"] for u in data["items"] if u["username"] == "alice"), None)
        status, data, _ = request(admin, "/api/admin/ban", {"id": alice_id, "banned": True})
        check("封禁用户", status == 200, str(data))
        blocked = new_opener()
        status, data, _ = request(blocked, "/api/auth/login",
                                  {"username": "alice", "password": "newsecret456"})
        check("封禁后无法登录", status == 403, str(status))

        print("\n[9] 后台增强")
        ids = []
        for i in range(2):
            status, data, _ = request(
                admin, f"/api/admin/upload/photo?title=img{i}", png,
                headers={"Content-Type": "application/octet-stream"})
            ids.append(data["item"]["id"])
        check("准备两张图", len(ids) == 2, str(ids))

        status, data, _ = request(admin, f"/api/admin/media/photo/{ids[0]}",
                                  {"title": "改过的标题"}, method="PATCH")
        check("就地修改标题", status == 200, str(data))
        status, data, _ = request(opener0, "/api/photos")
        check("标题已生效", any(i["title"] == "改过的标题" for i in data["items"]),
              str([i["title"] for i in data["items"]]))

        status, data, _ = request(admin, f"/api/admin/media/photo/{ids[0]}",
                                  {"pinned": True}, method="PATCH")
        check("设置为置顶", status == 200, str(data))
        status, data, _ = request(opener0, "/api/photos")
        first = data["items"][0]
        check("置顶照片排最前", first["id"] == ids[0] and first.get("pinned") == 1,
              str(first))

        status, data, _ = request(admin, "/api/admin/media/bulk-delete",
                                  {"kind": "photo", "ids": ids})
        check("批量删除", status == 200 and data.get("deleted") == 2, str(data))
        status, data, _ = request(opener0, "/api/photos")
        check("批量删除后清空", len(data.get("items", [])) == 0)

        status, data, _ = request(admin, "/api/admin/storage")
        check("存储统计", status == 200 and "used" in data and "disk_free" in data,
              str(data)[:100])

        status, data, _ = request(admin, "/api/admin/trend")
        check("近 7 日趋势", status == 200 and len(data.get("items", [])) == 7,
              str(data)[:80])

        status, data, _ = request(admin, "/api/admin/audit")
        actions = [i["action"] for i in data.get("items", [])]
        check("操作日志有记录", "上传照片" in actions and "批量删除" in actions,
              str(actions[:6]))

        status, data, _ = request(opener0, "/api/posts?q=%E7%95%99%E8%A8%80")
        check("帖子按内容搜索", len(data.get("items", [])) == 1, str(data))
        status, data, _ = request(opener0, "/api/posts?q=zzzz")
        check("搜索无结果返回空", len(data.get("items", [])) == 0)
        status, data, _ = request(opener0, "/api/posts?user=alice")
        check("帖子按作者筛选", len(data.get("items", [])) == 1, str(data))
        status, data, _ = request(opener0, "/api/posts?since=1")
        check("帖子按时间筛选", len(data.get("items", [])) == 1, str(data))
        status, data, _ = request(admin, "/api/admin/users?q=ali")
        check("用户搜索", len(data.get("items", [])) == 1
              and data["items"][0]["username"] == "alice", str(data))

        print("\n[10] 音乐模块")
        mp3 = b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\x00" * 4096
        status, data, _ = request(
            admin, "/api/admin/upload/track?title=%E5%A4%9C%E6%9B%B2", mp3,
            headers={"Content-Type": "application/octet-stream"})
        check("上传音乐", status == 201 and data.get("ok"), str(data)[:160])

        track = data.get("item", {})
        status, data, _ = request(opener0, "/api/tracks")
        check("音乐列表可见", len(data.get("items", [])) == 1, str(data))

        status, body, hdrs = request(
            opener0, f"/media/tracks/{track.get('filename')}", raw=True)
        check("音乐可访问且类型正确",
              status == 200 and hdrs.get("Content-Type") == "audio/mpeg",
              f"{status} {hdrs.get('Content-Type')}")

        status, body, hdrs = request(
            opener0, f"/media/tracks/{track.get('filename')}",
            headers={"Range": "bytes=0-2"}, raw=True)
        check("音乐支持 Range", status == 206 and body == b"ID3",
              f"{status} {body[:4]}")

        status, data, _ = request(
            admin, "/api/admin/upload/track", b"not audio at all",
            headers={"Content-Type": "application/octet-stream"})
        check("伪造音频被拒", status == 415, str(status))

        status, data, _ = request(admin, "/api/admin/media/track/%d" % track["id"],
                                  method="DELETE")
        check("删除音乐", status == 200 and data.get("ok"), str(data))
        status, data, _ = request(opener0, "/api/tracks")
        check("删除后曲库为空", len(data.get("items", [])) == 0)

        print("\n[11] 文件夹 / 歌单")
        status, data, _ = request(admin, "/api/admin/collections",
                                  {"kind": "photo", "name": "山里"})
        check("新建文件夹", status == 201 and data.get("id"), str(data))
        cid = data.get("id")

        status, data, _ = request(
            admin, f"/api/admin/upload/photo?title=%E9%9B%BE&collection={cid}", png,
            headers={"Content-Type": "application/octet-stream"})
        check("上传到指定文件夹", status == 201, str(data)[:120])

        status, data, _ = request(opener0, f"/api/photos?collection={cid}")
        items = data.get("items", [])
        check("按文件夹过滤", len(items) == 1 and items[0].get("collection_id") == cid,
              str(data)[:160])

        status, data, _ = request(opener0, "/api/collections?kind=photo")
        cols = data.get("items", [])
        check("文件夹带封面和计数",
              any(c["id"] == cid and c["count"] == 1 and c["cover"] for c in cols),
              str(cols)[:200])

        status, data, _ = request(admin, f"/api/admin/collections/{cid}",
                                  {"name": "山里改名"}, method="PATCH")
        check("文件夹改名", status == 200, str(data))

        status, data, _ = request(admin, "/api/admin/collections",
                                  {"kind": "photo", "name": "海边"})
        cid2 = data.get("id")
        request(admin, f"/api/admin/collections/{cid}", {"pinned": True}, method="PATCH")
        request(admin, f"/api/admin/collections/{cid2}", {"pinned": True}, method="PATCH")
        status, data, _ = request(opener0, "/api/collections?kind=photo")
        pinned = [c for c in data.get("items", []) if c.get("pinned")]
        check("同一类型只保留一个置顶",
              len(pinned) == 1 and pinned[0]["id"] == cid2, str(pinned))

        status, data, _ = request(admin, f"/api/admin/collections/{cid}", method="DELETE")
        check("删除文件夹", status == 200, str(data))
        status, data, _ = request(opener0, "/api/collections?kind=photo")
        names = [c["name"] for c in data.get("items", [])]
        check("删除后内容移到未分类", "未分类" in names, str(names))

        print("\n[12] 点赞 / 评论 / 排序 / 拖动移动")
        status, data, _ = request(opener0, "/api/posts?q=%E7%95%99%E8%A8%80")
        pid = data["items"][0]["id"]

        status, data, _ = request(admin, f"/api/posts/{pid}/like", method="POST")
        check("点赞", status == 200 and data.get("likes") == 1 and data.get("liked"),
              str(data))

        status, data, _ = request(admin, f"/api/posts/{pid}/like", method="POST")
        check("再点一次取消点赞", status == 200 and data.get("likes") == 0, str(data))

        status, data, _ = request(admin, f"/api/posts/{pid}/comment",
                                  {"body": "说得好"})
        check("发表评论", status == 201, str(data)[:80])

        status, data, _ = request(opener0, f"/api/posts/{pid}/comments")
        bodies = [c["body"] for c in data.get("items", [])]
        check("评论可见", "说得好" in bodies, str(bodies))

        status, data, _ = request(opener0, f"/api/posts/{pid}/like", method="POST")
        check("未登录不能点赞", status == 401, str(status))

        request(admin, f"/api/posts/{pid}/like", method="POST")
        status, data, _ = request(opener0, "/api/posts?sort=likes")
        check("按最多赞排序可用", status == 200 and isinstance(data.get("items"), list),
              str(data)[:60])

        status, data, _ = request(opener0, "/api/collections?kind=photo")
        target = data["items"][0]["id"]
        status, data, _ = request(admin, "/api/admin/upload/photo", png,
                                  headers={"Content-Type": "application/octet-stream"})
        mid = data["item"]["id"]
        status, data, _ = request(admin, f"/api/admin/media/photo/{mid}",
                                  {"collection_id": target}, method="PATCH")
        check("拖动移动媒体", status == 200, str(data))
        status, data, _ = request(opener0, f"/api/photos?collection={target}&limit=60")
        check("移动后归属正确",
              any(i["id"] == mid and i["collection_id"] == target
                  for i in data.get("items", [])), str(data)[:120])

        # 歌曲置顶
        mp3b = b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\x00" * 2048
        tids = []
        for i in range(2):
            status, data, _ = request(
                admin, f"/api/admin/upload/track?title=t{i}", mp3b,
                headers={"Content-Type": "application/octet-stream"})
            tids.append(data["item"]["id"])
        status, data, _ = request(admin, f"/api/admin/media/track/{tids[1]}",
                                  {"pinned": True}, method="PATCH")
        check("歌曲置顶", status == 200, str(data))
        status, data, _ = request(opener0, "/api/tracks")
        first = data["items"][0]
        check("置顶歌曲排最前",
              first["id"] == tids[1] and first.get("pinned") == 1, str(first))

        print("\n[13] 分片上传 / 歌单打包")
        half = len(png) // 2
        uid = uuid.uuid4().hex
        status, data, _ = request(
            admin, f"/api/admin/upload/chunk?kind=photo&id={uid}&offset=0"
                   f"&total={len(png)}&title=%E5%88%86%E7%89%87",
            png[:half], headers={"Content-Type": "application/octet-stream"})
        check("第一片被接收", status == 200 and data.get("received") == half, str(data))

        status, data, _ = request(
            admin, f"/api/admin/upload/chunk?kind=photo&id={uid}&offset={half}"
                   f"&total={len(png)}&title=%E5%88%86%E7%89%87",
            png[half:], headers={"Content-Type": "application/octet-stream"})
        check("最后一片入库", status == 201 and data.get("item"), str(data)[:120])

        status, data, _ = request(opener0, "/api/photos?limit=60")
        check("分片上传结果可查",
              any(i["title"] == "分片" for i in data.get("items", [])),
              str([i["title"] for i in data["items"]][:6]))

        status, data, _ = request(opener0, "/api/collections?kind=track")
        withtracks = [c for c in data.get("items", []) if c["count"] > 0]
        if withtracks:
            cid0 = withtracks[0]["id"]
            status, body, hdrs = request(
                opener0, f"/api/collections/{cid0}/download", raw=True)
            check("歌单一键打包下载",
                  status == 200 and body[:2] == b"PK"
                  and hdrs.get("Content-Type") == "application/zip",
                  f"{status} {hdrs.get('Content-Type')} {body[:4]}")
        else:
            check("歌单一键打包下载", False, "没有可下载的歌单")

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    total = passed + failed
    color = "\033[32m" if failed == 0 else "\033[31m"
    print(f"{color}通过 {passed}/{total}\033[0m")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
