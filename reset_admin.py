"""
重置或检查管理员密码。

用法：
    python reset_admin.py                  # 生成一个新的随机密码
    python reset_admin.py 我的新密码        # 指定密码
    python reset_admin.py --check 某个密码  # 只验证，不修改

重置后密码会同时写进 data/ADMIN.txt。
"""

from __future__ import annotations

import secrets
import sys

import auth
import store

ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"   # 去掉 0O1lI 这些容易看错的字符
ADMIN_FILE = store.DATA / "ADMIN.txt"


def random_password() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(12))


def current_admin():
    with store.connect() as c:
        row = c.execute(
            "SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1"
        ).fetchone()
        return dict(row) if row else None


def write_admin_file(username: str, password: str) -> None:
    store.DATA.mkdir(parents=True, exist_ok=True)
    ADMIN_FILE.write_text(
        "==============================================\n"
        " 管理员账号\n"
        f"   用户名： {username}（登录时不区分大小写）\n"
        f"   密  码： {password}\n"
        " 登录后可在后台修改密码；此文件可删除。\n"
        "==============================================\n",
        encoding="utf-8",
    )


def main() -> int:
    store.init()
    args = sys.argv[1:]

    # ---- 只验证
    if args and args[0] == "--check":
        if len(args) < 2:
            print("用法：python reset_admin.py --check <密码>")
            return 1
        admin = current_admin()
        if not admin:
            print("数据库里没有管理员账号。直接运行 python reset_admin.py 会新建一个。")
            return 1
        ok = auth.verify_password(args[1], admin["password"])
        print(f"用户名： {admin['username']}")
        print("密码正确 ✅" if ok else "密码不正确 ❌")
        return 0 if ok else 2

    # ---- 制定新密码
    if args:
        new_password = args[0]
        if len(new_password) < 6:
            print("密码至少 6 位")
            return 1
    else:
        new_password = random_password()

    admin = current_admin()
    if not admin:
        store.create_user("admin", auth.hash_password(new_password), "admin")
        write_admin_file("admin", new_password)
        print("没有找到管理员账号，已新建。")
        print(f"  用户名： admin")
        print(f"  密  码： {new_password}")
        return 0

    store.update_password(admin["id"], auth.hash_password(new_password))
    write_admin_file(admin["username"], new_password)
    print(f"已重置 {admin['username']} 的密码")
    print(f"  密  码： {new_password}")
    print("  已写入 data/ADMIN.txt")
    print("  登录后请到「后台 → 用户 → 修改我的密码」改成自己的。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
