/* Severus的神秘聚落 —— 首页脚本
   原则：所有用户数据一律走 textContent，绝不拼进 innerHTML。 */

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  folders: { photo: [], video: [], track: [] },
  photos: [],
  videos: [],
  tracks: [],
  posts: [],
  totals: { photos: 0, videos: 0, tracks: 0, posts: 0 },
  openFolders: { photo: [], video: [], track: [] },
  lbIndex: -1,
  playingId: null,
  page: 1,
  sort: "recent",
};

/* ---------------------------------------------------------------- 基础 */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "X-Requested-With": "fetch" },
    ...options,
  });
  let data = {};
  try { data = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败（${res.status}）`);
  }
  return data;
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("on"), 2200);
}

function relTime(iso) {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 172800) return "昨天";
  return new Date(t).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/* 头像底色只用规范里的中性阶：ink / ink-muted-80 / ink-muted-48。
   不引入第二个强调色。 */
const PALETTE = ["#1d1d1f", "#333333", "#7a7a7a"];

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

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ---------------------------------------------------------------- 导航与身份 */


/* 顶部通知：点开就是一个下拉列表，直接看到内容 */
async function toggleNoticePanel(anchor, dot) {
  const exist = document.getElementById("notice-modal");
  if (exist) { exist.remove(); return; }

  const mask = document.createElement("div");
  mask.id = "notice-modal";
  mask.className = "dialog-mask";

  const card = document.createElement("div");
  card.className = "dialog";
  card.style.maxWidth = "440px";

  const h = document.createElement("h3");
  h.textContent = "通知";

  const body = document.createElement("div");
  body.className = "nt-list";
  body.textContent = "读取中…";

  const acts = document.createElement("div");
  acts.className = "dialog-acts";

  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "btn solid sm";
  ok.textContent = "知道了";
  ok.onclick = () => mask.remove();

  acts.appendChild(ok);
  card.append(h, body, acts);
  mask.appendChild(card);
  mask.onclick = (ev) => { if (ev.target === mask) mask.remove(); };
  document.body.appendChild(mask);

  let data;
  try { data = await api("/api/notifications"); } catch (e) {
    body.textContent = e.message;
    return;
  }

  // 只弹未读的（有红点的那些）
  const items = (data.items || []).filter((n) => !n.seen);
  body.textContent = "";
  if (!items.length) {
    body.textContent = "没有新的通知";
    return;
  }

  items.slice(0, 8).forEach((n) => {
    const row = document.createElement("div");
    row.className = "nt-item" + (n.seen ? "" : " unread");

    const text = document.createElement("div");
    text.className = "nt-text";
    text.textContent = n.text;

    const when = document.createElement("div");
    when.className = "nt-time";
    when.textContent = relTime(n.created_at);

    row.append(text, when);
    body.appendChild(row);
  });

  if (dot) dot.remove();
  try { await api("/api/notifications/seen", { method: "POST" }); } catch { /* 忽略 */ }
}

function themeButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "navbtn";
  const dark = document.documentElement.dataset.theme === "dark";
  btn.textContent = dark ? "☀" : "☾";
  btn.title = dark ? "切到浅色" : "切到深色";
  btn.onclick = () => {
    const nowDark = document.documentElement.dataset.theme === "dark";
    if (nowDark) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = "dark";
    try { localStorage.setItem("sev.theme", nowDark ? "light" : "dark"); } catch { /* 忽略 */ }
    btn.textContent = nowDark ? "☾" : "☀";
  };
  return btn;
}

function renderNav(user) {
  const box = $("nav-right");
  box.textContent = "";

  const search = document.createElement("a");
  search.href = "/search";
  search.textContent = "搜索";
  box.appendChild(search);

  if (!user) {
    const a = document.createElement("a");
    a.href = "/login?next=/";
    a.className = "pill";
    a.textContent = "登录";
    box.append(a, themeButton());
    return;
  }

  // 后台入口只给管理员，普通用户看不到
  if (user.role === "admin") {
    const admin = document.createElement("a");
    admin.href = "/admin";
    admin.textContent = "后台";
    box.appendChild(admin);
  }

  const who = document.createElement("span");
  who.className = "who";
  const dot = document.createElement("i");
  who.appendChild(dot);
  who.appendChild(document.createTextNode(user.username));
  box.appendChild(who);

  if (user.role !== "admin") {
    const mine = document.createElement("a");
    mine.href = "/me";
    mine.textContent = "个人中心";
    box.appendChild(mine);
  }

  // 管理员不需要前台通知入口，通知在后台处理
  let dotRef = null;
  const bell = document.createElement("a");
  if (user.role !== "admin") {
    bell.href = "/notifications";
    bell.textContent = "通知";
    bell.style.position = "relative";
    box.appendChild(bell);
  }
  if (user.role !== "admin") {
    // 点「通知」→ 以往全部通知
    bell.onclick = null;

    api("/api/notifications/count").then((d) => {
      if (!d || !d.unread) return;

      const dot = document.createElement("i");
      dot.className = "dot";
      dotRef = dot;
      bell.appendChild(dot);

      // 未读的用弹窗提醒，每次会话只弹一次
      let shown = false;
      try { shown = sessionStorage.getItem("sev.noticeShown") === "1"; } catch { /* 忽略 */ }
      if (!shown) {
        try { sessionStorage.setItem("sev.noticeShown", "1"); } catch { /* 忽略 */ }
        toggleNoticePanel(bell, dot);
      }
    }).catch(() => {});
  }

  const out = document.createElement("a");
  out.href = "#";
  out.textContent = "退出";
  out.onclick = async (ev) => {
    ev.preventDefault();
    try {
      await api("/api/auth/logout", { method: "POST" });
      location.reload();
    } catch (e) { toast(e.message); }
  };
  box.append(out, themeButton());
}

function renderComposer(user) {
  const locked = $("composer-locked");
  const form = $("composer");
  if (user) {
    locked.hidden = true;
    form.hidden = false;
  } else {
    locked.hidden = false;
    form.hidden = true;
  }
}


/* 管理员通知：进站弹窗，用户点「知道了」才算读过 */
async function announceDialog() {
  if (!state.user) return;
  let data;
  try { data = await api("/api/notifications"); } catch { return; }

  const n = (data.items || []).find((x) => x.kind === "admin" && !x.seen);
  if (!n) return;
  if (document.getElementById("announce")) return;

  const mask = document.createElement("div");
  mask.id = "announce";
  mask.className = "dialog-mask";

  const card = document.createElement("div");
  card.className = "dialog";

  const h = document.createElement("h3");
  h.textContent = "管理员通知";

  const p = document.createElement("p");
  p.textContent = n.text;
  p.style.whiteSpace = "pre-wrap";

  const row = document.createElement("div");
  row.className = "dialog-acts";

  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "btn solid sm";
  ok.textContent = "知道了";
  ok.onclick = async () => {
    ok.disabled = true;
    try {
      await api(`/api/notifications/${n.id}/seen`, { method: "POST" });
    } catch { /* 忽略 */ }
    mask.remove();
  };

  row.appendChild(ok);
  card.append(h, p, row);
  mask.appendChild(card);
  document.body.appendChild(mask);
}

/* ---------------------------------------------------------------- 页脚 */

function renderFooter(user) {
  const links = [
    ["相册", "/section?kind=photo"],
    ["视频", "/section?kind=video"],
    ["音乐", "/section?kind=track"],
    ["论坛", "/section?kind=forum"],
  ];
  // 访客记录只给管理员看
  if (user && user.role === "admin") {
    links.push(["访客记录", "/section?kind=visitors"]);
  }
  if (user && user.role === "admin") links.push(["后台", "/admin"]);
  if (!user) links.push(["登录", "/login"]);

  const box = $("fcols");
  box.textContent = "";

  const row = document.createElement("div");
  row.className = "frow";
  links.forEach(([label, href]) => {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    row.appendChild(a);
  });
  box.appendChild(row);

  const legal = $("legal");
  legal.textContent = "";
  const left = document.createElement("span");
  left.textContent = "Copyright © 2026 Severus的神秘聚落. 保留所有权利。";
  const right = document.createElement("span");
  right.textContent = "本地部署 · 仅供局域网访问";
  legal.append(left, right);
}

/* ---------------------------------------------------------------- 文件夹 */

const UNIT = { photo: "张", video: "段", track: "首" };
const FOLDER_LIMIT = 2;          // 首页每个模块最多显示两个文件夹/歌单

function folderCard(kind, col) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "folder";
  btn.dataset.id = String(col.id);

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = col.name;

  const n = document.createElement("span");
  n.className = "n";
  n.textContent = `${col.count} ${UNIT[kind]}`;

  const chev = document.createElement("span");
  chev.className = "chev";
  chev.textContent = "›";

  btn.append(name, n, chev);
  btn.onclick = () => toggleFolder(kind, col, btn);
  return btn;
}

/* 点文件夹就地展开；照片和视频可以同时开两个，音乐只开一个 */
async function toggleFolder(kind, col, btn) {
  const panel = $(`${kind}-panel`);
  const open = state.openFolders[kind];
  const max = kind === "track" ? 1 : 2;

  const idx = open.indexOf(col.id);
  if (idx >= 0) open.splice(idx, 1);
  else {
    open.push(col.id);
    while (open.length > max) open.shift();
  }

  document.querySelectorAll(`#${kind}-folders .folder`).forEach((el) => {
    el.classList.toggle("on", open.includes(Number(el.dataset.id)));
  });

  if (!open.length) {
    panel.hidden = true;
    panel.textContent = "";
    alignForumHeight();
    return;
  }

  panel.hidden = false;
  panel.textContent = "";

  const hint = document.createElement("p");
  hint.className = "empty";
  hint.textContent = "加载中…";
  panel.appendChild(hint);

  try {
    const groups = await Promise.all(open.map(async (cid) => {
      const qs = `&collection=${cid}`;
      let url;
      if (kind === "photo") url = `/api/photos?limit=24&offset=0${qs}`;
      else if (kind === "video") url = `/api/videos?limit=24&offset=0${qs}`;
      else url = `/api/tracks?limit=40&offset=0${qs}`;
      const data = await api(url);
      return data.items || [];
    }));

    panel.textContent = "";
    groups.forEach((items, i) => {
      if (i) {
        const sep = document.createElement("div");
        sep.className = "folder-sep";
        panel.appendChild(sep);
      }
      renderFolderItems(kind, items, panel);
    });
  } catch (e) {
    panel.textContent = "";
    hint.textContent = e.message;
    panel.appendChild(hint);
  }

  alignForumHeight();
}


/* 首页内联列表里的收藏按钮 */
function homeFav(kind, it) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "fav";
  b.textContent = "♡";
  b.title = "收藏";
  b.onclick = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!state.user) { toast("登录后才能收藏"); return; }
    try {
      const d = await api(`/api/favorite/${kind}/${it.id}`, { method: "POST" });
      b.textContent = d.favorite ? "♥" : "♡";
      b.classList.toggle("on", !!d.favorite);
    } catch (e) { toast(e.message); }
  };
  return b;
}

function renderFolderItems(kind, items, panel) {
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "这里还没有内容";
    panel.appendChild(p);
    return;
  }

  if (kind === "photo") {
    const grid = document.createElement("div");
    grid.className = "grid";
    items.forEach((it, i) => {
      const tile = document.createElement("div");
      tile.className = "tile";
      const img = document.createElement("img");
      img.src = `/media/photos/${encodeURIComponent(it.filename)}`;
      img.alt = it.title || "照片";
      tile.appendChild(img);
      tile.onclick = () => { state.photos = items; openLightbox(i); };
      tile.appendChild(homeFav("photo", it));
      grid.appendChild(tile);
    });
    panel.appendChild(grid);
    return;
  }

  if (kind === "video") {
    const list = document.createElement("ul");
    list.className = "vlist";
    items.forEach((it) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "vrow";

      const poster = document.createElement("div");
      poster.className = "poster";
      const v = document.createElement("video");
      v.src = `/media/videos/${encodeURIComponent(it.filename)}#t=0.1`;
      v.preload = "metadata";
      v.muted = true;
      v.playsInline = true;
      poster.appendChild(v);

      const meta = document.createElement("div");
      meta.className = "meta";
      const s = document.createElement("strong");
      s.textContent = it.title || "未命名影像";
      const sp = document.createElement("span");
      sp.textContent = `${relTime(it.created_at)} · ${fmtSize(it.size)}`;
      meta.append(s, sp);

      b.append(poster, meta);
      b.onclick = () => openPlayer(it);
      li.append(b, homeFav("video", it));
      list.appendChild(li);
    });
    panel.appendChild(list);
    return;
  }

  const list = document.createElement("ul");
  list.className = "tlist";
  items.forEach((it) => {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "trow";
    row.dataset.id = String(it.id);

    const g = document.createElement("span");
    g.className = "glyph";
    g.textContent = "▶";

    const meta = document.createElement("span");
    meta.className = "meta";
    const s = document.createElement("strong");
    s.textContent = it.title || "未命名曲目";
    const sp = document.createElement("span");
    sp.textContent = `${relTime(it.created_at)} · ${fmtSize(it.size)}`;
    meta.append(s, sp);

    row.append(g, meta);
    row.onclick = () => {
      if (window.MiniPlayer) MiniPlayer.play(it, items);
    };
    row.appendChild(homeFav("track", it));

    if (state.user && state.user.role === "admin") {
      const pen = document.createElement("button");
      pen.type = "button";
      pen.className = "tact";
      pen.textContent = "✎";
      pen.title = "重命名";
      pen.onclick = async (ev) => {
        ev.stopPropagation();
        const name = prompt("新名字：", it.title || "");
        if (!name || !name.trim()) return;
        try {
          await api(`/api/admin/media/track/${it.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
            body: JSON.stringify({ title: name.trim() }),
          });
          it.title = name.trim();
          s.textContent = it.title;
          toast("已重命名");
        } catch (e2) { toast(e2.message); }
      };
      row.appendChild(pen);
    }

    li.appendChild(row);
    list.appendChild(li);
  });
  panel.appendChild(list);
}

async function loadFolders(kind) {
  const box = $(`${kind}-folders`);
  const empty = $(`${kind}-empty`);
  if (!box) return;

  const all = (state.folders[kind] || []);
  box.textContent = "";

  try {
    const data = await api(`/api/collections?kind=${kind}`);
    state.folders[kind] = data.items || [];
    const cnt = $(`${kind}-count`);
    if (cnt) {
      cnt.textContent = state.folders[kind].length ? String(state.folders[kind].length) : "";
    }

    const shown = state.folders[kind].slice(0, FOLDER_LIMIT);
    if (!shown.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    shown.forEach((col) => box.appendChild(folderCard(kind, col)));
  } catch (e) {
    empty.hidden = false;
    empty.textContent = e.message;
  }
}

/* ---------------------------------------------------------------- 置顶菜单 */

function closePinMenu() {
  const m = document.getElementById("pinmenu");
  if (m) m.remove();
}

function openPinMenu(kind, anchor) {
  closePinMenu();
  const list = state.folders[kind] || [];

  const menu = document.createElement("div");
  menu.className = "pinmenu";
  menu.id = "pinmenu";

  if (!list.length) {
    const b = document.createElement("button");
    b.type = "button";
    b.disabled = true;
    b.textContent = "还没有文件夹";
    menu.appendChild(b);
  }

  list.forEach((col) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = col.pinned ? "on" : "";
    b.appendChild(document.createTextNode(col.name));
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.textContent = col.pinned ? "✓" : "";
    b.appendChild(tick);

    b.onclick = async (ev) => {
      ev.stopPropagation();
      try {
        await api(`/api/admin/collections/${col.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
          body: JSON.stringify({ pinned: !col.pinned }),
        });
        closePinMenu();
        toast(col.pinned ? "已取消置顶" : `已置顶「${col.name}」`);
        await loadFolders(kind);
      } catch (e) {
        toast(e.message);
      }
    };
    menu.appendChild(b);
  });

  anchor.parentElement.appendChild(menu);
  setTimeout(() => document.addEventListener("click", closePinMenu, { once: true }), 0);
}

function initPinMenu(kind) {
  const btn = $(`${kind}-pin`);
  if (!btn) return;
  btn.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openPinMenu(kind, btn);
  };
}

function renderPhotos() {
  const grid = $("photo-grid");
  const empty = $("photo-empty");
  const more = $("photo-more");
  grid.textContent = "";

  if (!state.photos.length) {
    empty.hidden = false;
    more.hidden = true;
    return;
  }
  empty.hidden = true;

  state.photos.forEach((item, index) => {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.index = String(index);
    tile.title = item.title || "查看大图";

    const img = document.createElement("img");
    img.src = `/media/photos/${encodeURIComponent(item.filename)}`;
    img.alt = item.title || "照片";
    img.decoding = "async";
    tile.appendChild(img);

    tile.onclick = () => openLightbox(index);
    grid.appendChild(tile);
  });

  more.hidden = state.photos.length >= state.totals.photos;
}

async function loadPhotos(append = false) {
  const offset = append ? state.photos.length : 0;
  const data = await api(`/api/photos?limit=8&offset=${offset}`);
  state.photos = append ? state.photos.concat(data.items) : data.items;
  state.totals.photos = data.total;
  $("photo-count").textContent = data.total ? String(data.total) : "";
  renderPhotos();
}

/* ---------------------------------------------------------------- 灯箱 */

function openLightbox(index) {
  if (!state.photos.length) return;
  state.lbIndex = index;
  paintLightbox();
  $("lightbox").hidden = false;
  document.body.classList.add("locked-scroll");
}

function paintLightbox() {
  const item = state.photos[state.lbIndex];
  if (!item) return;
  const img = $("lb-img");
  img.src = `/media/photos/${encodeURIComponent(item.filename)}`;
  img.alt = item.title || "照片";
  $("lb-title").textContent = item.title || "";
  $("lb-cap").textContent = `${state.lbIndex + 1} / ${state.photos.length} · ${relTime(item.created_at)}`;
  const many = state.photos.length > 1;
  $("lb-prev").hidden = !many;
  $("lb-next").hidden = !many;
}

function stepLightbox(delta) {
  if (state.photos.length < 2) return;
  state.lbIndex = (state.lbIndex + delta + state.photos.length) % state.photos.length;
  paintLightbox();
}

function closeLightbox() {
  $("lightbox").hidden = true;
  $("lb-img").src = "";
  $("lb-img").style.transform = "";
  lbZoom = 1;
  document.body.classList.remove("locked-scroll");
}

/* ---------------------------------------------------------------- 视频 */

function renderVideos() {
  const list = $("video-list");
  const empty = $("video-empty");
  const more = $("video-more");
  list.textContent = "";

  if (!state.videos.length) {
    empty.hidden = false;
    more.hidden = true;
    return;
  }
  empty.hidden = true;

  state.videos.forEach((item) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vrow";

    const poster = document.createElement("div");
    poster.className = "poster";
    const vid = document.createElement("video");
    vid.src = `/media/videos/${encodeURIComponent(item.filename)}#t=0.1`;
    vid.preload = "metadata";
    vid.muted = true;
    vid.playsInline = true;
    poster.appendChild(vid);

    const meta = document.createElement("div");
    meta.className = "meta";
    const strong = document.createElement("strong");
    strong.textContent = item.title || "未命名影像";
    const span = document.createElement("span");
    span.textContent = `${relTime(item.created_at)} · ${fmtSize(item.size)}`;
    meta.appendChild(strong);
    meta.appendChild(span);

    btn.appendChild(poster);
    btn.appendChild(meta);
    btn.onclick = () => openPlayer(item);
    li.appendChild(btn);
    list.appendChild(li);
  });

  more.hidden = state.videos.length >= state.totals.videos;
}

async function loadVideos(append = false) {
  const offset = append ? state.videos.length : 0;
  const data = await api(`/api/videos?limit=6&offset=${offset}`);
  state.videos = append ? state.videos.concat(data.items) : data.items;
  state.totals.videos = data.total;
  $("video-count").textContent = data.total ? String(data.total) : "";
  renderVideos();
}

function openPlayer(item) {
  const video = $("pl-video");
  if (audioEl) { audioEl.pause(); state.playingId = null; renderTracks(); }
  video.src = `/media/videos/${encodeURIComponent(item.filename)}`;
  $("pl-title").textContent = item.title || "未命名影像";
  $("pl-cap").textContent = `${relTime(item.created_at)} · ${fmtSize(item.size)}`;
  $("player").hidden = false;
  document.body.classList.add("locked-scroll");
  video.play().catch(() => { /* 自动播放被拦截时由用户点播放 */ });
}

/* ---- 迷你播放条：离开分栏页回首页继续放 ---- */

const PLAYER_KEY = "sev.player";
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M7 4l13 8-13 8z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';

const player = { list: [], state: null, saveAt: 0 };

function readPlayer() {
  try { return JSON.parse(sessionStorage.getItem(PLAYER_KEY) || "null"); } catch { return null; }
}

function writePlayer(s) {
  try { sessionStorage.setItem(PLAYER_KEY, JSON.stringify(s)); } catch { /* 忽略 */ }
}

function playerIndex() {
  if (!player.state) return -1;
  return player.list.findIndex((t) => t.id === player.state.id);
}

function miniRender() {
  const bar = $("miniplayer");
  if (!bar) return;
  const st = player.state;
  if (!st) {
    bar.hidden = true;
    $("miniplaylist").hidden = true;
    return;
  }
  bar.hidden = false;
  $("mini-title").textContent = st.title || "未命名曲目";

  const i = playerIndex();
  $("mini-sub").textContent = player.list.length
    ? `${i >= 0 ? i + 1 : 1} / ${player.list.length}` : "";

  $("mini-toggle").innerHTML =
    (audioEl && !audioEl.paused) ? ICON_PAUSE : ICON_PLAY;

  const list = $("miniplaylist");
  if (!list.hidden) renderMiniList();
}

function renderMiniList() {
  const box = $("miniplaylist");
  box.textContent = "";
  player.list.forEach((t, i) => {
    const b = document.createElement("button");
    b.type = "button";
    if (player.state && t.id === player.state.id) b.className = "on";
    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = String(i + 1);
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = t.title || "未命名曲目";
    b.append(idx, nm);
    b.onclick = (ev) => { ev.stopPropagation(); playIndex(i); };
    box.appendChild(b);
  });
}

function playIndex(i) {
  const list = player.list;
  if (!list.length) return;
  const idx = ((i % list.length) + list.length) % list.length;
  const item = list[idx];
  const a = ensureAudio();

  player.state = {
    id: item.id, title: item.title, filename: item.filename,
    time: 0, playing: true, list,
  };
  a.src = `/media/tracks/${encodeURIComponent(item.filename)}`;
  a.play().then(miniRender).catch(() => toast("浏览器拦住了自动播放，点一下播放键"));
  writePlayer(player.state);
  miniRender();
}

function restorePlayer() {
  const st = readPlayer();
  if (!st || !st.filename) return;

  player.list = Array.isArray(st.list) ? st.list : [];
  player.state = st;

  const a = ensureAudio();
  a.src = `/media/tracks/${encodeURIComponent(st.filename)}`;
  a.addEventListener("loadedmetadata", () => {
    if (st.time) { try { a.currentTime = st.time; } catch { /* 忽略 */ } }
    if (st.playing) a.play().catch(() => { /* 等用户点 */ });
    miniRender();
  }, { once: true });
  miniRender();
}

function initMiniPlayer() {
  if (!$("miniplayer")) return;

  $("mini-toggle").onclick = () => {
    if (!player.state) return;
    const a = ensureAudio();
    if (a.paused) a.play().catch(() => {});
    else a.pause();
    miniRender();
  };
  $("mini-prev").onclick = () => { const i = playerIndex(); if (i >= 0) playIndex(i - 1); };
  $("mini-next").onclick = () => { const i = playerIndex(); if (i >= 0) playIndex(i + 1); };

  $("mini-list").onclick = (ev) => {
    ev.stopPropagation();
    const box = $("miniplaylist");
    box.hidden = !box.hidden;
    if (!box.hidden) renderMiniList();
  };
  $("miniplaylist").onclick = (ev) => ev.stopPropagation();
  document.addEventListener("click", () => { $("miniplaylist").hidden = true; });

  $("mini-close").onclick = () => {
    const a = ensureAudio();
    a.pause();
    a.removeAttribute("src");
    player.state = null;
    try { sessionStorage.removeItem(PLAYER_KEY); } catch { /* 忽略 */ }
    $("miniplaylist").hidden = true;
    miniRender();
  };
}

let lbZoom = 1;
let audioEl = null;

function ensureAudio() {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = "metadata";

    audioEl.addEventListener("ended", () => {
      const idx = playerIndex();
      if (player.list.length > 1) playIndex(idx + 1);
      else {
        if (player.state) { player.state.playing = false; writePlayer(player.state); }
        miniRender();
      }
    });
    audioEl.addEventListener("play", miniRender);
    audioEl.addEventListener("pause", () => {
      if (player.state) { player.state.playing = false; writePlayer(player.state); }
      miniRender();
    });
    audioEl.addEventListener("timeupdate", () => {
      if (!player.state) return;
      const now = Date.now();
      if (now - player.saveAt < 900) return;
      player.saveAt = now;
      player.state.time = audioEl.currentTime;
      player.state.playing = !audioEl.paused;
      writePlayer(player.state);
    });
  }
  return audioEl;
}

function renderTracks() {
  const list = $("track-list");
  const empty = $("track-empty");
  const more = $("track-more");
  if (!list) return;
  list.textContent = "";

  if (!state.tracks.length) {
    empty.hidden = false;
    more.hidden = true;
    return;
  }
  empty.hidden = true;

  state.tracks.forEach((item) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "trow" + (state.playingId === item.id ? " on" : "");

    const glyph = document.createElement("span");
    glyph.className = "glyph";
    glyph.textContent = state.playingId === item.id ? "❚❚" : "▶";

    const meta = document.createElement("span");
    meta.className = "meta";
    const strong = document.createElement("strong");
    strong.textContent = item.title || "未命名曲目";
    const sub = document.createElement("span");
    sub.textContent = `${relTime(item.created_at)} · ${fmtSize(item.size)}`;
    meta.appendChild(strong);
    meta.appendChild(sub);

    btn.appendChild(glyph);
    btn.appendChild(meta);
    btn.onclick = () => playTrack(item);
    li.appendChild(btn);
    list.appendChild(li);
  });

  more.hidden = state.tracks.length >= state.totals.tracks;
}

function playTrack(item) {
  const audio = ensureAudio();

  if (state.playingId === item.id) {
    audio.pause();
    state.playingId = null;
    renderTracks();
    return;
  }

  audio.src = `/media/tracks/${encodeURIComponent(item.filename)}`;
  audio.play().then(() => {
    state.playingId = item.id;
    renderTracks();
  }).catch(() => toast("这个格式浏览器可能不支持"));
}

async function loadTracks(append = false) {
  const offset = append ? state.tracks.length : 0;
  const data = await api(`/api/tracks?limit=8&offset=${offset}`);
  state.tracks = append ? state.tracks.concat(data.items) : data.items;
  state.totals.tracks = data.total;
  $("track-count").textContent = data.total ? String(data.total) : "";
  renderTracks();
}

function closePlayer() {
  const video = $("pl-video");
  video.pause();
  video.removeAttribute("src");
  video.load();
  $("player").hidden = true;
  document.body.classList.remove("locked-scroll");
}

/* ---------------------------------------------------------------- 论坛高度对齐 */

// 论坛卡片的下边界对齐到左列（相册+视频+音乐）的底部，
// 超出的部分在卡片内部滚动，不再把整页撑长。
function alignForumHeight() {
  const forum = $("forum");
  const left = document.querySelector(".col-left");
  if (!forum || !left) return;

  if (window.matchMedia("(max-width: 1080px)").matches) {
    forum.style.height = "";
    return;
  }
  const h = Math.round(left.getBoundingClientRect().height);
  if (h > 240) forum.style.height = `${h}px`;
}

/* ---------------------------------------------------------------- 论坛 */

const PAGE_SIZE = 10;

function postRow(item) {
  const li = document.createElement("li");
  li.className = "post";

  li.appendChild(avatar(item.username, item.avatar));

  const body = document.createElement("div");
  body.style.flex = "1";
  body.style.minWidth = "0";

  const who = document.createElement("div");
  who.className = "who";
  const name = document.createElement("strong");
  name.textContent = item.username;
  const when = document.createElement("span");
  when.textContent = relTime(item.created_at);
  who.append(name, when);

  const text = document.createElement("p");
  text.textContent = item.body;

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
    if (!state.user) { toast("登录后才能点赞"); return; }
    try {
      const data = await api(`/api/posts/${item.id}/like`, { method: "POST" });
      item.likes = data.likes;
      item.liked = data.liked ? 1 : 0;
      like.classList.toggle("on", !!item.liked);
      num.textContent = String(item.likes);
    } catch (e) { toast(e.message); }
  };

  const comment = document.createElement("a");
  comment.className = "act";
  comment.href = `/section?kind=forum&post=${item.id}`;
  comment.textContent = `评论 ${item.comments || 0}`;

  acts.append(like, comment);

  const fav = document.createElement("button");
  fav.type = "button";
  fav.className = "act";
  fav.textContent = "♡ 收藏";
  fav.onclick = async () => {
    if (!state.user) { toast("登录后才能收藏"); return; }
    try {
      const data = await api(`/api/favorite/post/${item.id}`, { method: "POST" });
      fav.textContent = data.favorite ? "♥ 已收藏" : "♡ 收藏";
      fav.classList.toggle("on", !!data.favorite);
    } catch (e) { toast(e.message); }
  };
  acts.appendChild(fav);

  // 删和改只给管理员
  const isAdmin = state.user && state.user.role === "admin";
  if (isAdmin) {
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
        text.textContent = item.body;
        toast("已修改");
      } catch (e) { toast(e.message); }
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
        toast("已删除");
      } catch (e) { toast(e.message); }
    };

    acts.append(edit, del);
  }
  body.append(who, text, acts);
  li.appendChild(body);
  return li;
}

function renderPosts() {
  const list = $("post-list");
  const empty = $("post-empty");
  list.textContent = "";

  if (!state.posts.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  state.posts.forEach((item) => list.appendChild(postRow(item)));
}

function renderPager() {
  const pager = $("post-pager");
  const total = state.totals.posts || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (pages <= 1) {
    pager.hidden = true;
    return;
  }
  pager.hidden = false;
  $("post-page").textContent = `${state.page} / ${pages}`;
  $("post-prev").disabled = state.page <= 1;
  $("post-next").disabled = state.page >= pages;
}

async function loadPosts(page = 1) {
  state.page = page;
  const sort = state.sort || "recent";
  const data = await api(
    `/api/posts?limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}&sort=${sort}`);
  state.posts = data.items;
  state.totals.posts = data.total;
  $("post-count").textContent = "";   // 论坛标题旁边不再显示数量
  renderPosts();
  renderPager();
  const scroll = $("post-scroll");
  if (scroll) scroll.scrollTop = 0;
}

function initForumControls() {
  document.querySelectorAll("#sortbar button").forEach((btn) => {
    btn.onclick = () => {
      state.sort = btn.dataset.sort;
      document.querySelectorAll("#sortbar button").forEach((b) => {
        b.classList.toggle("on", b === btn);
      });
      loadPosts(1).catch((e) => toast(e.message));
    };
  });

  $("post-prev").onclick = () => {
    if (state.page > 1) loadPosts(state.page - 1).catch((e) => toast(e.message));
  };
  $("post-next").onclick = () => {
    loadPosts(state.page + 1).catch((e) => toast(e.message));
  };
}

async function submitPost(ev) {
  ev.preventDefault();
  const box = $("post-body");
  const body = box.value.trim();
  if (!body) return;

  const btn = $("post-send");
  btn.disabled = true;
  try {
    await api("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: JSON.stringify({ body }),
    });
    box.value = "";
    toast("已发布");
    await loadPosts(1);
    loadActivity();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------- 访客记录 */

function renderActivity() {
  const list = $("activity-list");
  const empty = $("activity-empty");
  list.textContent = "";

  if (!state.activity || !state.activity.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  state.activity.forEach((item) => {
    const li = document.createElement("li");
    li.className = "guest";
    li.appendChild(avatar(item.username, item.avatar));

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = item.username;

    const badge = document.createElement("span");
    badge.className = `badge ${item.kind === "post" ? "post" : "login"}`;
    badge.textContent = item.kind === "post" ? "发帖" : "登录";

    const when = document.createElement("span");
    when.className = "when";
    when.textContent = relTime(item.created_at);

    li.appendChild(name);
    li.appendChild(badge);
    li.appendChild(when);
    list.appendChild(li);
  });
}

async function loadActivity() {
  try {
    const data = await api("/api/activity");
    state.activity = data.items;
    renderActivity();
  } catch { /* 静默失败，不影响主界面 */ }
}

/* ---------------------------------------------------------------- 滚动高亮 */

function initScrollSpy() {
  const links = [...document.querySelectorAll('.gnav .links a[href^="#"]')];
  if (!links.length || !("IntersectionObserver" in window)) return;

  const targets = [];
  links.forEach((a) => {
    const el = document.querySelector(a.getAttribute("href"));
    if (el) targets.push([el, a]);
  });
  if (!targets.length) return;

  const setActive = (link) => {
    links.forEach((a) => a.classList.toggle("on", a === link));
  };

  // 视口中线附近的那一块算「当前所在」
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const hit = targets.find(([el]) => el === entry.target);
      if (hit) setActive(hit[1]);
    });
  }, { rootMargin: "-45% 0px -45% 0px", threshold: 0 });

  targets.forEach(([el]) => observer.observe(el));
}

/* ---------------------------------------------------------------- 启动 */

async function boot() {
  // 导航与遮罩
  $("burger").onclick = () => $("nav").classList.toggle("open-links");
  initScrollSpy();
  $("lb-close").onclick = closeLightbox;
  $("lb-prev").onclick = () => stepLightbox(-1);
  $("lb-next").onclick = () => stepLightbox(1);
  $("lb-img").onclick = (ev) => { if (ev.target.id === "lb-img") stepLightbox(1); };

  // 灯箱：左右滑翻页、滚轮/双击缩放
  lbZoom = 1;
  const lb = $("lightbox");
  let sx = 0, sy = 0;
  lb.addEventListener("touchstart", (ev) => {
    const t = ev.changedTouches[0];
    sx = t.clientX; sy = t.clientY;
  }, { passive: true });
  lb.addEventListener("touchend", (ev) => {
    const t = ev.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      stepLightbox(dx > 0 ? -1 : 1);
    }
  }, { passive: true });

  $("lb-img").addEventListener("wheel", (ev) => {
    if ($("lightbox").hidden) return;
    ev.preventDefault();
    lbZoom = Math.min(3, Math.max(1, lbZoom - ev.deltaY * 0.0015));
    $("lb-img").style.transform = `scale(${lbZoom})`;
  }, { passive: false });

  $("lb-img").ondblclick = () => {
    lbZoom = lbZoom > 1 ? 1 : 2;
    $("lb-img").style.transform = `scale(${lbZoom})`;
  };
  $("pl-close").onclick = closePlayer;
  $("composer").onsubmit = submitPost;
  ["photo", "video", "track"].forEach(initPinMenu);
  initForumControls();
  announceDialog();
  if (window.MiniPlayer) MiniPlayer.restore();

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (!$("lightbox").hidden) closeLightbox();
      if (!$("player").hidden) closePlayer();
    }
    if (!$("lightbox").hidden) {
      if (ev.key === "ArrowLeft") stepLightbox(-1);
      if (ev.key === "ArrowRight") stepLightbox(1);
    }
  });

  try {
    const data = await api("/api/bootstrap");
    state.user = data.user;
    state.activity = data.activity;

    renderNav(state.user);
    renderComposer(state.user);
    renderFooter(state.user);
    renderActivity();

    if (state.user && state.user.role === "admin") {
      ["photo", "video", "track"].forEach((k) => {
        const b = $(`${k}-pin`);
        if (b) b.hidden = false;
      });
    }

    const s = data.stats;
    $("stats").textContent =
      `${s.photos} 张照片 · ${s.videos} 段影像 · ${s.posts} 条留言 · ${s.visits} 次到访`;
    $("user-count").textContent = String(s.members !== undefined ? s.members : s.users);
  } catch (e) {
    $("stats").textContent = "加载失败：" + e.message;
    renderFooter(null);
  }

  await Promise.allSettled([
    loadFolders("photo"), loadFolders("video"), loadFolders("track"), loadPosts(),
  ]);

  alignForumHeight();
  window.addEventListener("resize", () => {
    clearTimeout(alignForumHeight._t);
    alignForumHeight._t = setTimeout(alignForumHeight, 150);
  });

  // 深链接：?photo=<id> 直接打开某张照片，?video=<id> 直接播放，方便分享
  const params = new URLSearchParams(location.search);
  const wantPhoto = params.get("photo");
  const wantVideo = params.get("video");

  if (wantPhoto) {
    const index = state.photos.findIndex((p) => String(p.id) === String(wantPhoto));
    if (index >= 0) openLightbox(index);
  } else if (wantVideo) {
    const hit = state.videos.find((v) => String(v.id) === String(wantVideo));
    if (hit) openPlayer(hit);
  }
}

boot();
