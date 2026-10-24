/* 搜索 / 个人主页 / 通知 —— 三个视图共用一个页面 */

const $ = (id) => document.getElementById(id);

async function api(url, opts) {
  const res = await fetch(url, {
    headers: { "X-Requested-With": "fetch" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || "请求失败");
  return data;
}

function relTime(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Math.max(0, Date.now() - t) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

function empty(text) {
  const p = document.createElement("p");
  p.className = "sec-empty";
  p.textContent = text;
  return p;
}

function toast(text) {
  const el = $("toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("on"), 2200);
}

let me = null;

/* ---------------------------------------------------------------- 搜索 */

function renderSearch() {
  $("ex-title").textContent = "搜索";
  const tools = $("ex-tools");
  tools.textContent = "";

  const form = document.createElement("form");
  form.className = "sortbar";
  form.style.gap = "8px";

  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "搜照片、视频、音乐、帖子、用户…";
  input.style.cssText = "flex:1;font-family:var(--font);font-size:15px;padding:9px 14px;"
    + "border:1px solid var(--hairline);border-radius:var(--r-pill);background:var(--canvas);"
    + "color:var(--ink);outline:none;letter-spacing:-.2px";
  input.value = new URLSearchParams(location.search).get("q") || "";

  const go = document.createElement("button");
  go.type = "submit";
  go.className = "on";
  go.textContent = "搜索";

  form.append(input, go);
  form.onsubmit = (ev) => {
    ev.preventDefault();
    const q = input.value.trim();
    history.replaceState(null, "", `/search?q=${encodeURIComponent(q)}`);
    runSearch(q);
  };
  tools.appendChild(form);

  if (input.value) runSearch(input.value);
  else $("ex-body").appendChild(empty("输入关键词开始搜索"));
}

async function runSearch(q) {
  const box = $("ex-body");
  box.textContent = "";
  if (!q) return;

  const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
  const r = data.results || {};
  const total = Object.values(r).reduce((n, arr) => n + (arr ? arr.length : 0), 0);
  $("ex-sub").textContent = `「${q}」找到 ${total} 条`;

  if (!total) {
    box.appendChild(empty("没有找到相关内容"));
    return;
  }

  const groups = [
    ["照片", r.photos, "photo"],
    ["视频", r.videos, "video"],
    ["音乐", r.tracks, "track"],
    ["帖子", r.posts, "post"],
    ["文件夹", r.collections, "collection"],
    ["用户", r.users, "user"],
  ];

  groups.forEach(([label, items, kind]) => {
    if (!items || !items.length) return;
    const h = document.createElement("h2");
    h.style.cssText = "font-size:17px;font-weight:600;letter-spacing:-.2px;margin:22px 0 10px";
    h.textContent = `${label} ${items.length}`;
    box.appendChild(h);

    const ul = document.createElement("ul");
    ul.className = "sec-list card-list";

    items.forEach((it) => {
      const li = document.createElement("li");
      li.className = "sec-row";

      const a = document.createElement("a");
      a.style.cssText = "flex:1;min-width:0;text-decoration:none;color:inherit";
      a.href = kind === "user" ? `/u/${encodeURIComponent(it.username)}`
        : kind === "post" ? `/section?kind=forum&post=${it.id}`
        : kind === "collection" ? `/section?kind=${it.kind}&collection=${it.id}`
        : `/section?kind=${kind}&collection=${it.collection_id || ""}&open=${it.id}`;

      const strong = document.createElement("strong");
      strong.style.display = "inline";
      strong.textContent = kind === "user" ? it.username
        : kind === "post" ? it.body
        : kind === "collection" ? `📁 ${it.name}`
        : (it.title || `未命名（${String(it.filename).slice(0, 8)}…）`);
      a.appendChild(strong);

      const badge = document.createElement("span");
      badge.className = "chip-tag";
      badge.style.flex = "none";
      badge.textContent = label;

      li.append(a, badge);
      ul.appendChild(li);
    });

    box.appendChild(ul);
  });
}

/* ---------------------------------------------------------------- 个人主页 */

async function renderProfile(name) {
  $("ex-title").textContent = name;
  const box = $("ex-body");
  box.textContent = "";

  try {
    const data = await api(`/api/users/${encodeURIComponent(name)}`);
    const p = data.profile;

    $("ex-sub").textContent =
      `${p.posts.length} 条帖子 · 图 ${p.uploads.photo} · 视频 ${p.uploads.video} · 音乐 ${p.uploads.track}`;

    if (me && me.username !== p.username) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn ghost sm";
      btn.textContent = "关注";
      btn.onclick = async () => {
        try {
          const r = await api(`/api/follow/${encodeURIComponent(p.username)}`, { method: "POST" });
          btn.textContent = r.following ? "已关注" : "关注";
        } catch (e) { toast(e.message); }
      };
      $("ex-tools").textContent = "";
      $("ex-tools").appendChild(btn);
    }

    if (!p.posts.length) {
      box.appendChild(empty("还没发过帖子"));
      return;
    }

    const ul = document.createElement("ul");
    ul.className = "sec-list";
    p.posts.forEach((post) => {
      const li = document.createElement("li");
      li.className = "sec-row";
      li.style.alignItems = "flex-start";
      const div = document.createElement("div");
      div.className = "body";
      const head = document.createElement("div");
      head.style.cssText = "font-size:12px;color:var(--ink-48);margin-bottom:3px";
      head.textContent = relTime(post.created_at);
      const text = document.createElement("p");
      text.textContent = post.body;
      const acts = document.createElement("div");
      acts.className = "acts";
      acts.innerHTML = `<span class="act">♥ ${post.likes}</span>`
        + `<a class="act" href="/section?kind=forum&post=${post.id}">评论 ${post.comments}</a>`;
      div.append(head, text, acts);
      li.appendChild(div);
      ul.appendChild(li);
    });
    box.appendChild(ul);
  } catch (e) {
    box.appendChild(empty(e.message));
  }
}

/* ---------------------------------------------------------------- 通知 */

async function renderNotifications() {
  $("ex-title").textContent = "通知";
  const box = $("ex-body");
  box.textContent = "";
  $("ex-tools").textContent = "";

  try {
    const data = await api("/api/notifications");
    $("ex-sub").textContent = data.unread ? `${data.unread} 条未读` : "全部已读";

    const items = data.items || [];
    if (!items.length) {
      box.appendChild(empty("还没有通知"));
      return;
    }

    const ul = document.createElement("ul");
    ul.className = "sec-list card-list";
    items.forEach((n) => {
      const li = document.createElement("li");
      li.className = "sec-row";
      const a = document.createElement("a");
      a.href = n.link || "/";
      a.style.cssText = "flex:1;text-decoration:none;color:"
        + (n.seen ? "var(--ink-48)" : "var(--ink)");
      a.textContent = n.text;

      if (n.kind === "apply") {
        const m = /app=(\d+)/.exec(n.link || "");
        if (m) {
          a.href = "#";
          a.onclick = (ev) => {
            ev.preventDefault();
            openApplyDialog(Number(m[1]), n.text);
          };
          a.style.color = "var(--primary)";
        }
      }

      const when = document.createElement("span");
      when.style.cssText = "font-size:12px;color:var(--ink-48)";
      when.textContent = relTime(n.created_at);
      li.append(a, when);
      ul.appendChild(li);
    });
    box.appendChild(ul);

    await api("/api/notifications/seen", { method: "POST" });
  } catch (e) {
    box.appendChild(empty(e.message));
  }
}

/* ---------------------------------------------------------------- 我的收藏 */

async function renderFavorites() {
  $("ex-title").textContent = "我的收藏";
  const tools = $("ex-tools");
  tools.textContent = "";
  tools.appendChild(tabs("/favorites"));

  const box = $("ex-body");
  box.textContent = "";

  try {
    const data = await api("/api/favorites");
    const items = data.items || [];
    $("ex-sub").textContent = items.length ? `共 ${items.length} 条` : "";

    if (!items.length) {
      box.appendChild(empty("还没有收藏"));
      return;
    }

    // 按模块顺序：图片 → 视频 → 音乐 → 帖子
    const order = [["photo", "图片"], ["video", "视频"], ["track", "音乐"],
                   ["post", "帖子"]];
    order.forEach(([kind, label]) => {
      const group = items.filter((x) => x.kind === kind);
      if (!group.length) return;

      const h = document.createElement("h2");
      h.style.cssText = "font-size:17px;font-weight:600;letter-spacing:-.2px;"
        + "margin:22px 0 10px";
      h.textContent = `${label} ${group.length}`;
      box.appendChild(h);

      const ul = document.createElement("ul");
      ul.className = "sec-list card-list";

      group.forEach((it) => {
        const li = document.createElement("li");
        li.className = "sec-row";

        const a = document.createElement("a");
        a.style.cssText = "flex:1;min-width:0;text-decoration:none;color:var(--ink)";
        a.href = kind === "post"
          ? `/section?kind=forum&post=${it.id}`
          : `/section?kind=${kind}&open=${it.id}`;
        a.textContent = it.title || "未命名";

        const badge = document.createElement("span");
        badge.className = "chip-tag";
        badge.style.flex = "none";
        badge.textContent = label;

        li.append(a, badge);
        ul.appendChild(li);
      });

      box.appendChild(ul);
    });
  } catch (e) {
    box.appendChild(empty(e.message));
  }
}

function tabs(active) {
  const bar = document.createElement("div");
  bar.className = "sortbar";
  bar.style.marginBottom = "14px";
  [["/search", "搜索"], ["/feed", "关注流"], ["/following", "关注"],
   ["/favorites", "收藏"]].forEach(([href, label]) => {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    a.style.cssText = "border:1px solid var(--hairline);border-radius:var(--r-pill);"
      + "padding:5px 12px;font-size:12px;letter-spacing:-.12px;text-decoration:none;"
      + "color:var(--ink-80);"
      + (active === href ? "border-color:var(--primary);color:var(--primary);font-weight:600" : "");
    bar.appendChild(a);
  });
  return bar;
}

async function renderFeed() {
  $("ex-title").textContent = "关注流";
  const tools = $("ex-tools");
  tools.textContent = "";
  tools.appendChild(tabs("/feed"));
  const box = $("ex-body");
  box.textContent = "";

  try {
    const data = await api("/api/feed?limit=30");
    const items = data.items || [];
    $("ex-sub").textContent = items.length ? `最近 ${items.length} 条` : "";
    if (!items.length) {
      box.appendChild(empty("关注几个人，这里就会热闹起来"));
      return;
    }
    const ul = document.createElement("ul");
    ul.className = "sec-list";
    items.forEach((p) => {
      const li = document.createElement("li");
      li.className = "sec-row";
      li.style.alignItems = "flex-start";
      const div = document.createElement("div");
      div.className = "body";
      const head = document.createElement("div");
      head.style.cssText = "margin-bottom:3px";
      const who = document.createElement("strong");
      who.style.display = "inline";
      who.textContent = p.username;
      const when = document.createElement("span");
      when.textContent = ` · ${relTime(p.created_at)}`;
      head.append(who, when);
      const text = document.createElement("p");
      text.textContent = p.body;
      const acts = document.createElement("div");
      acts.className = "acts";
      acts.innerHTML = `<span class="act">♥ ${p.likes}</span>`
        + `<a class="act" href="/section?kind=forum&post=${p.id}">评论 ${p.comments}</a>`;
      div.append(head, text, acts);
      li.appendChild(div);
      ul.appendChild(li);
    });
    box.appendChild(ul);
  } catch (e) {
    box.appendChild(empty(e.message));
  }
}

async function renderFollowing() {
  $("ex-title").textContent = "关注";
  const tools = $("ex-tools");
  tools.textContent = "";
  tools.appendChild(tabs("/following"));
  const box = $("ex-body");
  box.textContent = "";

  try {
    const data = await api("/api/following");
    const following = data.following || [];
    const followers = data.followers || [];
    $("ex-sub").textContent = `关注 ${following.length} 人 · 被 ${followers.length} 人关注`;

    const section = (title, items, hint) => {
      const h = document.createElement("h2");
      h.style.cssText = "font-size:17px;font-weight:600;letter-spacing:-.2px;margin:22px 0 10px";
      h.textContent = `${title} ${items.length}`;
      box.appendChild(h);
      if (!items.length) {
        box.appendChild(empty(hint));
        return;
      }
      const ul = document.createElement("ul");
      ul.className = "sec-list";
      items.forEach((u) => {
        const li = document.createElement("li");
        li.className = "sec-row";
        const a = document.createElement("a");
        a.href = `/u/${encodeURIComponent(u.username)}`;
        a.textContent = u.username;
        a.style.cssText = "flex:1;text-decoration:none;color:var(--ink)";
        li.appendChild(a);
        ul.appendChild(li);
      });
      box.appendChild(ul);
    };

    section("我关注的", following, "还没关注任何人");
    section("关注我的", followers, "还没有人关注你");
  } catch (e) {
    box.appendChild(empty(e.message));
  }
}

async function renderTag(kind, name) {
  $("ex-title").textContent = `#${name}`;
  const tools = $("ex-tools");
  tools.textContent = "";
  tools.appendChild(tabs("/search"));
  const box = $("ex-body");
  box.textContent = "";

  try {
    const data = await api(`/api/tag?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`);
    const items = data.items || [];
    $("ex-sub").textContent = `${items.length} 条`;
    if (!items.length) {
      box.appendChild(empty("这个标签下面还没有内容"));
      return;
    }
    const ul = document.createElement("ul");
    ul.className = "sec-list";
    items.forEach((it) => {
      const li = document.createElement("li");
      li.className = "sec-row";
      const a = document.createElement("a");
      a.href = `/section?kind=${kind}&collection=${it.collection_id || ""}`;
      a.textContent = it.title || it.filename;
      a.style.cssText = "flex:1;text-decoration:none;color:var(--ink)";
      li.appendChild(a);
      ul.appendChild(li);
    });
    box.appendChild(ul);
  } catch (e) {
    box.appendChild(empty(e.message));
  }
}

/* ---------------------------------------------------------------- 启动 */

async function boot() {
  try {
    const d = await api("/api/me");
    me = d.user || null;
  } catch {
    me = null;
  }

  const path = location.pathname.replace(/\/+$/, "") || "/";

  if (path === "/notifications") return renderNotifications();
  if (path === "/favorites") return renderFavorites();
  if (path === "/feed") return renderFeed();
  if (path === "/following") return renderFollowing();
  if (path === "/tag") {
    const q = new URLSearchParams(location.search);
    return renderTag(q.get("kind") || "photo", q.get("name") || "");
  }
  if (path.startsWith("/u/")) {
    return renderProfile(decodeURIComponent(path.slice(3)));
  }
  return renderSearch();
}

boot();
