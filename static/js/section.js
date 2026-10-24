/* 分栏页：/section?kind=photo|video|track|forum|visitors[&collection=ID]
   不带 collection 就显示文件夹（歌单）列表，带了就显示该文件夹里的内容。 */

const $ = (id) => document.getElementById(id);

const SVG_HEAD = 'class="mod-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
  photo: `<svg ${SVG_HEAD}><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.6" cy="10" r="1.4"/><path d="M3.8 17.4l4.6-4.6a2 2 0 0 1 2.8 0l4.4 4.4"/><path d="M15.4 14.6l1.4-1.4a2 2 0 0 1 2.8 0l1.6 1.6"/></svg>`,
  video: `<svg ${SVG_HEAD}><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10.4 9.4l4.6 2.6-4.6 2.6z"/></svg>`,
  track: `<svg ${SVG_HEAD}><path d="M9.2 17.2V6.4l8-1.7v10.6"/><circle cx="6.7" cy="17.8" r="2.5"/><circle cx="14.7" cy="16" r="2.5"/></svg>`,
  forum: `<svg ${SVG_HEAD}><path d="M20 11.5c0 3.6-3.6 6.5-8 6.5-1 0-2-.1-2.9-.4L4 20l1.2-3.6C4.4 15.1 4 13.4 4 11.5 4 7.9 7.6 5 12 5s8 2.9 8 6.5z"/></svg>`,
  visitors: `<svg ${SVG_HEAD}><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c0-3.3 3.1-6 7-6s7 2.7 7 6"/></svg>`,
};

const CONFIG = {
  photo: { title: "相册", unit: "张", api: "/api/photos?limit=200", folder: "文件夹" },
  video: { title: "视频", unit: "段", api: "/api/videos?limit=200", folder: "文件夹" },
  track: { title: "音乐", unit: "首", api: "/api/tracks?limit=200", folder: "歌单" },
  forum: { title: "论坛", unit: "条", api: "/api/posts?limit=200" },
  visitors: { title: "访客记录", unit: "次", api: "/api/activity" },
};

const PALETTE = ["#1d1d1f", "#333333", "#7a7a7a"];

function api(path, opts) {
  const options = { ...(opts || {}) };
  options.headers = { "X-Requested-With": "fetch", ...(options.headers || {}) };

  return fetch(path, options)
    .then((r) => r.json())
    .then((d) => {
      if (d.ok === false) throw new Error(d.error || "请求失败");
      return d;
    });
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function relTime(iso) {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const d = (Date.now() - t) / 1000;
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  if (d < 172800) return "昨天";
  return new Date(t).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function avatarColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 10007;
  return PALETTE[h % PALETTE.length];
}

function avatar(name, file) {
  if (file) {
    const el = document.createElement("div");
    el.className = "av av-img";
    const img = document.createElement("img");
    img.src = `/media/avatars/${encodeURIComponent(file)}`;
    img.alt = name;
    el.appendChild(img);
    return el;
  }
  const el = document.createElement("div");
  el.className = "avatar";
  el.style.background = avatarColor(name);
  el.textContent = [...String(name)][0] || "?";
  return el;
}

function empty(text) {
  const p = document.createElement("p");
  p.className = "sec-empty";
  p.textContent = text;
  return p;
}

/* ---------------------------------------------------------------- 视频遮罩 */

function openVideo(item) {
  const v = $("pl-video");
  v.src = `/media/videos/${encodeURIComponent(item.filename)}`;
  $("pl-title").textContent = item.title || "未命名影像";
  $("pl-cap").textContent = `${relTime(item.created_at)} · ${fmtSize(item.size)}`;
  $("pl").hidden = false;
  document.body.classList.add("locked-scroll");
  v.play().catch(() => {});
}

function closeVideo() {
  const v = $("pl-video");
  v.pause();
  v.removeAttribute("src");
  v.load();
  $("pl").hidden = true;
  document.body.classList.remove("locked-scroll");
}

/* ---------------------------------------------------------------- 文件夹 */

function folderCard(kind, col) {
  const a = document.createElement("a");
  a.className = "folder sec-folder";
  a.href = `/section?kind=${kind}&collection=${col.id}`;

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = col.name;

  const chev = document.createElement("span");
  chev.className = "chev";
  chev.textContent = "›";

  a.append(name, chev);
  return a;
}

/* ---------------------------------------------------------------- 内容渲染 */

let audioEl = null;
let playingId = null;

/* 照片灯箱：带关闭按钮，左右翻页 */
let lbItems = [];
let lbIndex = 0;

function openPhoto(items, index) {
  lbItems = items || [];
  lbIndex = Math.max(0, index || 0);

  let box = document.getElementById("pbox");
  if (!box) {
    box = document.createElement("div");
    box.id = "pbox";
    box.className = "overlay";
    box.hidden = true;
    box.innerHTML =
      '<div class="bar"><span class="title" id="pb-title"></span>'
      + '<button class="chip" id="pb-close" aria-label="关闭">✕</button></div>'
      + '<div class="stage"><img id="pb-img" alt=""></div>'
      + '<div class="caption" id="pb-cap"></div>';
    document.body.appendChild(box);

    document.getElementById("pb-close").onclick = closePhoto;
    box.onclick = (ev) => { if (ev.target === box) closePhoto(); };
    document.getElementById("pb-img").onclick = (ev) => {
      ev.stopPropagation();
      stepPhoto(1);
    };
    document.addEventListener("keydown", (ev) => {
      if (box.hidden) return;
      if (ev.key === "Escape") closePhoto();
      if (ev.key === "ArrowLeft") stepPhoto(-1);
      if (ev.key === "ArrowRight") stepPhoto(1);
    });
  }

  paintPhoto();
  box.hidden = false;
  document.body.classList.add("locked-scroll");
}

function paintPhoto() {
  const it = lbItems[lbIndex];
  if (!it) return;
  document.getElementById("pb-img").src =
    `/media/photos/${encodeURIComponent(it.filename)}`;
  document.getElementById("pb-title").textContent = it.title || "照片";
  document.getElementById("pb-cap").textContent =
    lbItems.length > 1 ? `${lbIndex + 1} / ${lbItems.length}` : "";
}

function stepPhoto(delta) {
  if (lbItems.length < 2) return;
  lbIndex = ((lbIndex + delta) % lbItems.length + lbItems.length) % lbItems.length;
  paintPhoto();
}

function closePhoto() {
  const box = document.getElementById("pbox");
  if (box) box.hidden = true;
  const img = document.getElementById("pb-img");
  if (img) img.src = "";
  document.body.classList.remove("locked-scroll");
}

function renameBtn(kind, it) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "fav";
  b.style.right = "8px";
  b.style.top = "42px";
  b.textContent = "✎";
  b.title = "改名";
  b.onclick = async (ev) => {
    ev.stopPropagation();
    const name = prompt("新名字：", it.title || "");
    if (!name || !name.trim()) return;
    try {
      await api(`/api/admin/media/${kind}/${it.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
        body: JSON.stringify({ title: name.trim() }),
      });
      it.title = name.trim();
      say("已改名");
    } catch (e) { say(e.message); }
  };
  return b;
}

function favBtn(kind, it) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "fav";
  b.textContent = "♡";
  b.title = "收藏";
  b.onclick = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!sectionMe) { say("登录后才能收藏"); return; }
    try {
      const d = await api(`/api/favorite/${kind}/${it.id}`, { method: "POST" });
      b.textContent = d.favorite ? "♥" : "♡";
      b.classList.toggle("on", !!d.favorite);
    } catch (e) { say(e.message); }
  };
  return b;
}

function tagChips(kind, it) {
  const wrap = document.createElement("div");
  wrap.className = "chips";
  const tags = String(it.tags || "").split(",").filter(Boolean);
  tags.forEach((t) => {
    const a = document.createElement("a");
    a.className = "chip-tag";
    a.href = `/tag?kind=${kind}&name=${encodeURIComponent(t)}`;
    a.textContent = `#${t}`;
    wrap.appendChild(a);
  });
  return wrap;
}

/* 管理员可以拖着换顺序 */
function enableDragSort(container, kind) {
  if (!sectionMe || sectionMe.role !== "admin") return;
  let dragId = null;
  container.querySelectorAll("[data-mid]").forEach((el) => {
    el.draggable = true;
    el.ondragstart = (ev) => {
      dragId = el.dataset.mid;
      ev.dataTransfer.effectAllowed = "move";
    };
    el.ondragover = (ev) => ev.preventDefault();
    el.ondrop = async (ev) => {
      ev.preventDefault();
      if (!dragId || dragId === el.dataset.mid) return;
      const dragged = container.querySelector(`[data-mid="${dragId}"]`);
      if (!dragged) return;
      container.insertBefore(dragged, el);
      const ids = Array.from(container.querySelectorAll("[data-mid]"))
        .map((n) => Number(n.dataset.mid));
      try {
        await api(`/api/admin/media/${kind}/order`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
          body: JSON.stringify({ ids }),
        });
        say("顺序已保存");
      } catch (e) { say(e.message); }
    };
  });
}

function renderPhotos(items, box) {
  const grid = document.createElement("div");
  grid.className = "sec-grid";
  items.forEach((it) => {
    const cell = document.createElement("div");
    cell.className = "sec-cell";
    cell.dataset.mid = it.id;

    const a = document.createElement("button");
    a.type = "button";
    a.className = "sec-tile";
    a.style.padding = "0";
    a.style.border = "0";
    a.style.cursor = "zoom-in";
    a.title = it.title || "查看大图";
    const img = document.createElement("img");
    img.src = `/media/photos/${encodeURIComponent(it.filename)}`;
    img.alt = it.title || "照片";
    img.loading = "lazy";
    a.appendChild(img);
    a.onclick = () => openPhoto(items, items.indexOf(it));

    cell.append(a, favBtn("photo", it), tagChips("photo", it));
    if (sectionMe && sectionMe.role === "admin") cell.appendChild(renameBtn("photo", it));
    grid.appendChild(cell);
  });
  enableDragSort(grid, "photo");
  box.appendChild(grid);
}

function renderVideos(items, box) {
  const grid = document.createElement("div");
  grid.className = "sec-grid";
  items.forEach((it) => {
    const cell = document.createElement("div");
    cell.className = "sec-cell";
    cell.dataset.mid = it.id;

    const a = document.createElement("button");
    a.type = "button";
    a.className = "sec-tile";
    a.style.padding = "0";
    a.style.border = "0";
    a.style.cursor = "pointer";
    a.title = it.title || "播放";

    const vid = document.createElement("video");
    vid.src = `/media/videos/${encodeURIComponent(it.filename)}#t=0.1`;
    vid.preload = "metadata";
    vid.muted = true;
    vid.playsInline = true;
    a.appendChild(vid);

    a.onclick = () => openVideo(it);
    cell.append(a, favBtn("video", it), tagChips("video", it));
    if (sectionMe && sectionMe.role === "admin") cell.appendChild(renameBtn("video", it));
    grid.appendChild(cell);
  });
  enableDragSort(grid, "video");
  box.appendChild(grid);
}

let trackBox = null;
let trackItems = [];
let trackCid = null;
let sectionMe = null;

function savePlayerState(item, items, time = 0, playing = true) {
  try {
    sessionStorage.setItem("sev.player", JSON.stringify({
      id: item.id, title: item.title, filename: item.filename,
      time, playing,
      list: items.map((t) => ({ id: t.id, title: t.title, filename: t.filename })),
    }));
  } catch { /* 忽略 */ }
}

function startTrack(item, items, paint) {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.addEventListener("ended", () => {
      const idx = items.findIndex((t) => t.id === playingId);
      if (idx >= 0 && idx + 1 < items.length) startTrack(items[idx + 1], items, paint);
      else { playingId = null; paint(); }
    });
  }
  audioEl.src = `/media/tracks/${encodeURIComponent(item.filename)}`;
  audioEl.play().then(() => {
    playingId = item.id;
    savePlayerState(item, items, 0, true);
    paint();
  }).catch(() => { say("这个格式浏览器可能不支持"); });
}

async function refreshTracks() {
  if (!trackBox) return;
  const qs = trackCid ? `&collection=${trackCid}` : "";
  const data = await api(`/api/tracks?limit=200${qs}`);
  trackItems = data.items || [];
  trackBox.textContent = "";
  renderTracks(trackItems, trackBox);
}

function trackRow(item, items, paint) {
  const row = document.createElement("div");
  row.className = "trow";
  row.dataset.id = String(item.id);

  const glyph = document.createElement("span");
  glyph.className = "glyph";
  glyph.textContent = "▶";

  const meta = document.createElement("span");
  meta.className = "meta";
  const strong = document.createElement("strong");
  strong.textContent = item.title || "未命名曲目";
  const sub = document.createElement("span");
  sub.textContent = `${relTime(item.created_at)} · ${fmtSize(item.size)}`;
  meta.append(strong, sub);

  // 管理员可以直接改歌名
  if (sectionMe && sectionMe.role === "admin") {
    const pen = document.createElement("button");
    pen.type = "button";
    pen.className = "tact";
    pen.textContent = "✎";
    pen.title = "重命名";
    pen.onclick = async (ev) => {
      ev.stopPropagation();
      const name = prompt("新名字：", item.title || "");
      if (!name || !name.trim()) return;
      try {
        await api(`/api/admin/media/track/${item.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
          body: JSON.stringify({ title: name.trim() }),
        });
        item.title = name.trim();
        strong.textContent = item.title;
        say("已重命名");
      } catch (e) { say(e.message); }
    };
    row.appendChild(pen);
  }

  const dl = document.createElement("a");
  dl.className = "tact";
  dl.href = `/api/download/track/${item.id}`;
  dl.title = "下载";
  dl.textContent = "⤓";
  dl.onclick = (ev) => ev.stopPropagation();

  meta.appendChild(tagChips("track", item));
  row.append(glyph, meta, dl, favBtn("track", item));

  if (sectionMe && sectionMe.role === "admin") {
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "tact" + (item.pinned ? " on" : "");
    pin.title = item.pinned ? "取消置顶" : "置顶这首";
    pin.textContent = "★";
    pin.onclick = async (ev) => {
      ev.stopPropagation();
      try {
        await api(`/api/admin/media/track/${item.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
          body: JSON.stringify({ pinned: !item.pinned }),
        });
        await refreshTracks();
        say(item.pinned ? "已取消置顶" : "已置顶");
      } catch (e) { say(e.message); }
    };
    row.appendChild(pin);
  }

  row.onclick = () => {
    if (window.MiniPlayer) MiniPlayer.play(item, items);
    playingId = item.id;
    paint();
  };

  return row;
}

function renderTracks(items, box) {
  trackBox = box;
  trackItems = items;

  const card = document.createElement("div");
  card.className = "playlist-card";
  const list = document.createElement("ul");
  list.className = "tlist";

  const paint = () => {
    list.querySelectorAll(".trow").forEach((row) => {
      const on = row.dataset.id === String(playingId);
      row.classList.toggle("on", on);
      row.querySelector(".glyph").textContent = on ? "❚❚" : "▶";
    });
  };

  items.forEach((it) => {
    const li = trackRow(it, items, paint);
    li.dataset.mid = it.id;
    list.appendChild(li);
  });
  enableDragSort(list, "track");
  card.appendChild(list);
  box.appendChild(card);
}

function renderForum(items, box) {
  const list = document.createElement("ul");
  list.className = "sec-list";
  items.forEach((it) => {
    const li = document.createElement("li");
    li.className = "sec-row";

    const body = document.createElement("div");
    body.className = "body";
    const head = document.createElement("div");
    head.style.marginBottom = "2px";
    const strong = document.createElement("strong");
    strong.textContent = it.username;
    const span = document.createElement("span");
    span.textContent = ` · ${relTime(it.created_at)}`;
    head.append(strong, span);
    const p = document.createElement("p");
    p.textContent = it.body;
    body.append(head, p);

    li.append(avatar(it.username, it.avatar), body);
    list.appendChild(li);
  });
  box.appendChild(list);
}

function renderVisitors(items, box) {
  const list = document.createElement("ul");
  list.className = "sec-list";
  if (items.length > 10) list.classList.add("scrolly");
  items.forEach((it) => {
    const li = document.createElement("li");
    li.className = "sec-row";

    const body = document.createElement("div");
    body.className = "body";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;flex-wrap:wrap;gap:6px";
    const strong = document.createElement("strong");
    strong.style.display = "inline";
    strong.textContent = it.username;
    const badge = document.createElement("span");
    badge.className = `badge ${it.kind === "post" ? "post" : "login"}`;
    badge.textContent = it.kind === "post" ? "发帖" : "登录";
    const span = document.createElement("span");
    span.textContent = relTime(it.created_at);
    head.append(strong, badge, span);
    body.appendChild(head);

    if (it.detail) {
      const p = document.createElement("p");
      p.textContent = it.detail;
      body.appendChild(p);
    }

    li.append(avatar(it.username, it.avatar), body);
    list.appendChild(li);
  });
  box.appendChild(list);
}

/* ---------------------------------------------------------------- 论坛 */

const POST_PAGE = 20;
const forumState = { page: 1, sort: "recent", viewer: null };

function postCard(item) {
  const li = document.createElement("li");
  li.className = "sec-row";
  li.style.alignItems = "flex-start";

  const body = document.createElement("div");
  body.className = "body";

  const head = document.createElement("div");
  head.style.marginBottom = "4px";
  const strong = document.createElement("strong");
  strong.style.display = "inline";
  strong.textContent = item.username;
  const when = document.createElement("span");
  when.textContent = ` · ${relTime(item.created_at)}`;
  head.append(strong, when);

  const p = document.createElement("p");
  p.textContent = item.body;

  const acts = document.createElement("div");
  acts.className = "acts";

  const like = document.createElement("button");
  like.type = "button";
  like.className = "act" + (item.liked ? " on" : "");
  like.innerHTML = '<span class="heart">♥</span>';
  const num = document.createElement("span");
  num.className = "num";
  num.textContent = String(item.likes || 0);
  like.appendChild(num);
  like.onclick = async () => {
    if (!forumState.viewer) { say("登录后才能点赞"); return; }
    try {
      const data = await api(`/api/posts/${item.id}/like`, { method: "POST" });
      item.likes = data.likes;
      like.classList.toggle("on", !!data.liked);
      num.textContent = String(data.likes);
    } catch (e) { say(e.message); }
  };

  const comment = document.createElement("a");
  comment.className = "act";
  comment.href = `?kind=forum&post=${item.id}`;
  comment.textContent = `评论 ${item.comments || 0}`;

  acts.append(like, comment);

  // 删和改只给管理员
  if (sectionMe && sectionMe.role === "admin") {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "act";
    edit.textContent = "✎ 改";
    edit.onclick = async () => {
      const next = prompt("改一下内容：", item.body);
      if (!next || !next.trim() || next === item.body) return;
      try {
        await api(`/api/posts/${item.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
          body: JSON.stringify({ body: next.trim() }),
        });
        item.body = next.trim();
        p.textContent = item.body;
      } catch (e) { say(e.message); }
    };

    const del = document.createElement("button");
    del.type = "button";
    del.className = "act";
    del.textContent = "✕ 删";
    del.onclick = async () => {
      if (!confirm("删掉这条帖子？")) return;
      try {
        await api(`/api/posts/${item.id}`, { method: "DELETE" });
        li.remove();
      } catch (e) { say(e.message); }
    };

    acts.append(edit, del);
  }
  body.append(head, p, acts);

  li.append(avatar(item.username, item.avatar), body);
  return li;
}

function say(text) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(say._t);
  say._t = setTimeout(() => el.classList.remove("on"), 2200);
}

async function showForumList(box) {
  $("sec-title").textContent = "论坛";
  document.title = "论坛 — Severus的神秘聚落";

  const tools = $("sec-tools");
  tools.textContent = "";

  const bar = document.createElement("div");
  bar.className = "sortbar";
  [["recent", "最新"], ["likes", "最多赞"], ["comments", "最多评论"]]
    .forEach(([key, label]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.sort = key;
      b.className = forumState.sort === key ? "on" : "";
      b.textContent = label;
      b.onclick = () => { forumState.sort = key; forumState.page = 1; showForumList($("sec-body")); };
      bar.appendChild(b);
    });
  tools.appendChild(bar);

  const body = $("sec-body");
  body.textContent = "";
  box = body;
  box.textContent = "";

  // 发帖框（和首页的一致）
  if (forumState.viewer) {
    const form = document.createElement("form");
    form.style.cssText = "display:flex;flex-direction:column;gap:10px;margin-bottom:16px";

    const ta = document.createElement("textarea");
    ta.maxLength = 500;
    ta.placeholder = "说点什么…";
    ta.style.cssText = "font-family:var(--font);font-size:15px;color:var(--ink);"
      + "background:var(--canvas);border:1px solid rgba(0,0,0,.12);border-radius:11px;"
      + "padding:11px 15px;resize:vertical;min-height:64px;line-height:1.45;"
      + "outline:none;letter-spacing:-.2px";

    const btn = document.createElement("button");
    btn.type = "submit";
    btn.className = "btn solid sm";
    btn.textContent = "发布";
    btn.style.alignSelf = "flex-end";

    form.append(ta, btn);
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      btn.disabled = true;
      try {
        await api("/api/posts", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
          body: JSON.stringify({ body: text }),
        });
        ta.value = "";
        say("已发布");
        showForumList($("sec-body"));
      } catch (e) {
        say(e.message);
      } finally {
        btn.disabled = false;
      }
    };
    box.appendChild(form);
  } else {
    const p = document.createElement("p");
    p.className = "sec-empty";
    p.style.padding = "14px 0";
    p.innerHTML = '登录后才能发言 · <a href="/login?next=/section?kind=forum">去登录</a>';
    box.appendChild(p);
  }

  const data = await api(
    `/api/posts?limit=${POST_PAGE}&offset=${(forumState.page - 1) * POST_PAGE}`
    + `&sort=${forumState.sort}`);

  const items = data.items || [];
  $("sec-sub").textContent = `共 ${data.total} 条`;

  if (!items.length) {
    box.appendChild(empty("还没有帖子"));
    return;
  }

  const list = document.createElement("ul");
  list.className = "sec-list";
  items.forEach((it) => list.appendChild(postCard(it)));
  box.appendChild(list);

  const pages = Math.max(1, Math.ceil(data.total / POST_PAGE));
  if (pages > 1) {
    const pager = document.createElement("div");
    pager.className = "pager";
    const prev = document.createElement("button");
    prev.type = "button";
    prev.textContent = "‹";
    prev.disabled = forumState.page <= 1;
    prev.onclick = () => { forumState.page -= 1; showForumList($("sec-body")); };
    const mid = document.createElement("span");
    mid.textContent = `${forumState.page} / ${pages}`;
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "›";
    next.disabled = forumState.page >= pages;
    next.onclick = () => { forumState.page += 1; showForumList($("sec-body")); };
    pager.append(prev, mid, next);
    box.appendChild(pager);
  }
}

async function showPost(postId, box) {
  $("sec-tools").textContent = "";

  const data = await api(`/api/posts/${postId}/comments`);
  const post = data.post;
  const comments = data.items || [];

  $("sec-title").textContent = "帖子";
  $("sec-sub").textContent = `${comments.length} 条评论`;

  const back = document.createElement("a");
  back.className = "sec-back";
  back.href = "?kind=forum";
  back.textContent = "‹ 返回论坛";
  box.appendChild(back);

  // 正文
  const head = document.createElement("div");
  head.className = "post-detail";
  const who = document.createElement("div");
  who.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:12px";
  who.append(avatar(post.username, post.avatar));
  const name = document.createElement("strong");
  name.style.cssText = "font-size:15px;font-weight:600;letter-spacing:-.2px";
  name.textContent = post.username;
  const when = document.createElement("span");
  when.style.cssText = "font-size:12px;color:var(--ink-48)";
  when.textContent = relTime(post.created_at);
  who.append(name, when);

  const bodyEl = document.createElement("p");
  bodyEl.style.cssText = "font-size:17px;line-height:1.47;color:var(--ink);white-space:pre-wrap;word-break:break-word";
  bodyEl.textContent = post.body;

  head.append(who, bodyEl);
  box.appendChild(head);

  // 评论标题
  const h = document.createElement("h2");
  h.style.cssText = "font-size:17px;font-weight:600;letter-spacing:-.2px;margin:26px 0 10px";
  h.textContent = `评论 ${comments.length}`;
  box.appendChild(h);

  if (!comments.length) {
    box.appendChild(empty("还没有评论"));
  } else {
    const list = document.createElement("ul");
    list.className = "sec-list";
    comments.forEach((c) => {
      const li = document.createElement("li");
      li.className = "sec-row";
      li.style.alignItems = "flex-start";
      const b = document.createElement("div");
      b.className = "body";
      const hd = document.createElement("div");
      hd.style.marginBottom = "2px";
      const s = document.createElement("strong");
      s.style.display = "inline";
      s.textContent = c.username;
      const t = document.createElement("span");
      t.textContent = ` · ${relTime(c.created_at)}`;
      hd.append(s, t);
      const p = document.createElement("p");
      p.textContent = c.body;
      b.append(hd, p);
      li.append(avatar(c.username, c.avatar), b);
      list.appendChild(li);
    });
    box.appendChild(list);
  }

  // 评论输入
  if (!forumState.viewer) {
    const hint = document.createElement("p");
    hint.className = "sec-empty";
    hint.innerHTML = '登录后才能评论 · <a href="/login?next=/section?kind=forum">去登录</a>';
    box.appendChild(hint);
    return;
  }

  const form = document.createElement("form");
  form.style.cssText = "margin-top:20px;display:flex;flex-direction:column;gap:10px";
  const ta = document.createElement("textarea");
  ta.maxLength = 300;
  ta.placeholder = "写评论…";
  ta.style.cssText = "font-family:var(--font);font-size:15px;color:var(--ink);"
    + "background:var(--canvas);border:1px solid rgba(0,0,0,.12);border-radius:11px;"
    + "padding:11px 15px;resize:none;height:76px;line-height:1.45;outline:none;letter-spacing:-.2px";
  const btn = document.createElement("button");
  btn.type = "submit";
  btn.className = "btn solid sm";
  btn.textContent = "发表评论";
  btn.style.alignSelf = "flex-end";

  form.append(ta, btn);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    btn.disabled = true;
    try {
      await api(`/api/posts/${postId}/comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
        body: JSON.stringify({ body: text }),
      });
      say("已发表");
      showPost(postId, $("sec-body"));
    } catch (e) {
      say(e.message);
      btn.disabled = false;
    }
  };
  box.appendChild(form);
}

function renderNav(user) {
  const box = $("nav-right");
  box.textContent = "";
  const a = document.createElement("a");
  if (user) {
    a.href = user.role === "admin" ? "/admin" : "/";
    a.textContent = user.username;
  } else {
    a.href = "/login?next=/";
    a.className = "pill";
    a.textContent = "登录";
  }
  box.appendChild(a);

  if (user && user.role !== "admin") {
    const me = document.createElement("a");
    me.href = "/me";
    me.textContent = "个人中心";
    box.appendChild(me);
  }

  const theme = document.createElement("button");
  theme.type = "button";
  theme.className = "navbtn";
  const dark = document.documentElement.dataset.theme === "dark";
  theme.textContent = dark ? "☀" : "☾";
  theme.title = dark ? "切到浅色" : "切到深色";
  theme.onclick = () => {
    const nowDark = document.documentElement.dataset.theme === "dark";
    if (nowDark) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = "dark";
    try { localStorage.setItem("sev.theme", nowDark ? "light" : "dark"); } catch { /* 忽略 */ }
    theme.textContent = nowDark ? "☾" : "☀";
  };
  box.appendChild(theme);
}

async function main() {
  $("burger").onclick = () => document.querySelector(".gnav").classList.toggle("open-links");
  $("pl-close").onclick = closeVideo;
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("pl").hidden) closeVideo();
  });

  const params = new URLSearchParams(location.search);
  const kind = (params.get("kind") || "photo").toLowerCase();
  const cid = params.get("collection");
  const conf = CONFIG[kind];

  if (!conf) {
    $("sec-title").textContent = "页面不存在";
    return;
  }

  $("sec-icon").innerHTML = ICONS[kind] || "";

  try {
    const me = await api("/api/me");
    renderNav(me.user);
    forumState.viewer = me.user ? me.user.username : null;
    sectionMe = me.user || null;
  } catch {
    renderNav(null);
  }

  if (window.MiniPlayer) MiniPlayer.restore();

  if (kind === "forum") {
    const postId = params.get("post");
    const target = $("sec-body");
    if (postId) return showPost(postId, target);
    return showForumList(target);
  }

  const box = $("sec-body");
  const folderWord = conf.folder;

  try {
    // 带 collection：显示某个文件夹里的内容
    if (cid) {
      const cols = await api(`/api/collections?kind=${kind}`);
      const col = (cols.items || []).find((c) => String(c.id) === String(cid));

      $("sec-title").textContent = col ? col.name : conf.title;
      document.title = `${col ? col.name : conf.title} — Severus的神秘聚落`;

      // 管理员可以直接改这个文件夹/歌单的名字
      if (col && sectionMe && sectionMe.role === "admin") {
        const pen = document.createElement("button");
        pen.type = "button";
        pen.className = "sec-pen";
        pen.textContent = "✎";
        pen.title = "重命名";
        pen.onclick = async () => {
          const name = prompt(`把「${col.name}」改成：`, col.name);
          if (!name || !name.trim() || name.trim() === col.name) return;
          try {
            await api(`/api/admin/collections/${col.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
              body: JSON.stringify({ name: name.trim() }),
            });
            col.name = name.trim();
            $("sec-title").textContent = col.name;
            say("已改名");
          } catch (e) { say(e.message); }
        };
        $("sec-title").appendChild(pen);
      }

      const back = document.createElement("a");
      back.className = "sec-back";
      back.href = `/section?kind=${kind}`;
      back.textContent = `‹ 所有${folderWord}`;

      // 歌单收窄成一张卡片，照片/视频保持通栏网格
      let target = box;
      if (kind === "track") {
        const narrow = document.createElement("div");
        narrow.className = "sec-narrow";
        box.appendChild(narrow);
        target = narrow;
      }
      const headRow = document.createElement("div");
      headRow.className = "sec-headrow";
      headRow.appendChild(back);

      // 歌单打包下载，排在整行最右边
      if (kind === "track") {
        const zip = document.createElement("a");
        zip.className = "btn ghost sm";
        zip.href = `/api/collections/${cid}/download`;
        zip.textContent = "下载全部";
        headRow.appendChild(zip);
      }
      target.appendChild(headRow);

      const data = await api(`${conf.api}&collection=${cid}`);
      const items = data.items || [];
      $("sec-sub").textContent = `共 ${data.total !== undefined ? data.total : items.length} ${conf.unit}`;

      if (!items.length) {
        target.appendChild(empty("这个文件夹还是空的"));
        return;
      }

      if (kind === "photo") renderPhotos(items, box);
      else if (kind === "video") renderVideos(items, box);
      else {
        trackCid = Number(cid);
        renderTracks(items, target);
      }

      // 从搜索结果点进来时，直接打开那一条
      const openId = params.get("open");
      if (openId) {
        const idx = items.findIndex((x) => String(x.id) === openId);
        if (idx >= 0) {
          setTimeout(() => {
            if (kind === "photo") openPhoto(items, idx);
            else if (kind === "video") openVideo(items[idx]);
            else if (window.MiniPlayer) MiniPlayer.play(items[idx], items);
          }, 80);
        }
      }
      return;
    }

    // 不带 collection：媒体类显示文件夹，论坛/访客直接显示内容
    if (conf.folder) {
      $("sec-title").textContent = conf.title;
      document.title = `${conf.title} — Severus的神秘聚落`;

      const data = await api(`/api/collections?kind=${kind}`);
      const cols = data.items || [];
      $("sec-sub").textContent = `共 ${cols.length} 个${folderWord}`;

      if (!cols.length) {
        box.appendChild(empty(`还没有${folderWord}`));
        return;
      }

      const grid = document.createElement("div");
      grid.className = "sec-folders";
      cols.forEach((c) => grid.appendChild(folderCard(kind, c, conf.unit)));
      box.appendChild(grid);
      return;
    }

    $("sec-title").textContent = conf.title;
    document.title = `${conf.title} — Severus的神秘聚落`;

    const data = await api(conf.api);
    const items = data.items || [];
    $("sec-sub").textContent = data.total !== undefined
      ? `共 ${data.total} ${conf.unit}`
      : `最近 ${items.length} 条`;

    if (!items.length) {
      box.appendChild(empty("还没有内容"));
      return;
    }

    renderVisitors(items, box);
  } catch (e) {
    box.appendChild(empty(e.message));
  }
}

main();
