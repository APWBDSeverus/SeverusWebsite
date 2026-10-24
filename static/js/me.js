/* 个人中心：上传、收藏、下载、回收站、账号 */

const $ = (id) => document.getElementById(id);
const UNIT = { photo: "张", video: "段", track: "首", post: "条" };
const LABEL = { photo: "图片", video: "视频", track: "音乐", post: "帖子" };
const CHUNK = 8 * 1024 * 1024;
const TABS = [
  ["photo", "图片"], ["video", "视频"], ["track", "音乐"],
  ["favorites", "收藏"], ["downloads", "下载"], ["trash", "回收站"], ["account", "账号"],
];

let me = null;
let viewerPushed = false;
let renderSeq = 0;

async function api(url, opts) {
  const options = { ...(opts || {}) };
  options.headers = { "X-Requested-With": "fetch", ...(options.headers || {}) };
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || "请求失败");
  return data;
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("on"), 2200);
}

function fmtSize(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = (Date.now() - t) / 1000;
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

function emptyBox(text) {
  const p = document.createElement("p");
  p.className = "sec-empty";
  p.textContent = text;
  return p;
}


/* 缩略图：图片直接显示，视频用封面帧，音乐用音符块 */
function thumb(kind, it) {
  const box = document.createElement("div");
  box.className = "me-thumb";

  if (kind === "photo" && it.filename) {
    const img = document.createElement("img");
    img.src = `/media/photos/${encodeURIComponent(it.filename)}`;
    img.alt = it.title || "";
    img.loading = "lazy";
    box.appendChild(img);
  } else if (kind === "video" && it.filename) {
    if (it.poster) {
      const img = document.createElement("img");
      img.src = `/media/posters/${encodeURIComponent(it.poster)}`;
      img.alt = it.title || "";
      img.loading = "lazy";
      box.appendChild(img);
    } else {
      const v = document.createElement("video");
      v.src = `/media/videos/${encodeURIComponent(it.filename)}#t=0.1`;
      v.preload = "metadata";
      v.muted = true;
      v.playsInline = true;
      box.appendChild(v);
    }
  } else if (kind === "track") {
    box.textContent = "♪";
    box.classList.add("dark");
  } else {
    box.textContent = "帖";
    box.classList.add("dark");
  }
  return box;
}



/* 通用：给一条记录加查看按钮（照片/视频才有） */
function viewButton(kind, it) {
  if (kind !== "photo" && kind !== "video") return null;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn ghost sm";
  b.textContent = "查看";
  b.onclick = () => openViewer(kind, it);
  return b;
}

/* 查看器：带关闭按钮，Esc 也能关 */
function openViewer(kind, it) {
  let box = document.getElementById("me-viewer");

  if (!box) {
    box = document.createElement("div");
    box.id = "me-viewer";
    box.className = "overlay";
    box.hidden = true;
    box.innerHTML =
      '<div class="bar"><span class="title" id="mv-title"></span>'
      + '<button class="chip" id="mv-close" aria-label="关闭">✕</button></div>'
      + '<div class="stage" id="mv-stage"></div>'
      + '<div class="caption" id="mv-cap"></div>';
    document.body.appendChild(box);

    document.getElementById("mv-close").onclick = () => closeViewer();
    box.onclick = (ev) => { if (ev.target === box) closeViewer(); };
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !box.hidden) closeViewer();
    });
  }

  const stage = document.getElementById("mv-stage");
  stage.textContent = "";

  if (kind === "photo") {
    const img = document.createElement("img");
    img.src = `/media/photos/${encodeURIComponent(it.filename)}`;
    img.alt = it.title || "";
    stage.appendChild(img);
  } else if (kind === "video") {
    const v = document.createElement("video");
    v.src = `/media/videos/${encodeURIComponent(it.filename)}`;
    v.controls = true;
    v.playsInline = true;
    v.autoplay = true;
    stage.appendChild(v);
  }

  document.getElementById("mv-title").textContent = it.title || "未命名";
  document.getElementById("mv-cap").textContent = "";
  box.hidden = false;
  document.body.classList.add("locked-scroll");
  if (!viewerPushed) {
    viewerPushed = true;
    try { history.pushState({ viewer: 1 }, ""); } catch { /* 忽略 */ }
  }
}

function closeViewer(fromPop) {
  if (!fromPop && viewerPushed) {
    viewerPushed = false;
    try { history.back(); } catch { /* 忽略 */ }
  }
  const box = document.getElementById("me-viewer");
  if (!box) return;
  const stage = document.getElementById("mv-stage");
  const v = stage.querySelector("video");
  if (v) { v.pause(); v.removeAttribute("src"); }
  stage.textContent = "";
  box.hidden = true;
  document.body.classList.remove("locked-scroll");
}

function card() {
  const div = document.createElement("div");
  div.className = "card-list";
  return div;
}

function heading(text) {
  const h = document.createElement("h2");
  h.style.cssText = "font-size:17px;font-weight:600;letter-spacing:-.2px;margin:24px 0 10px";
  h.textContent = text;
  return h;
}

/* ---------------------------------------------------------------- 上传 */

async function uploadFile(kind, file, cid, onProgress) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const uid = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const total = file.size;
  let offset = 0;

  while (offset < total) {
    const end = Math.min(offset + CHUNK, total);
    const url = `/api/admin/upload/chunk?kind=${kind}&id=${uid}`
      + `&offset=${offset}&total=${total}`
      + `&title=${encodeURIComponent(file.name.replace(/\.[^.]+$/, ""))}`
      + `&collection=${encodeURIComponent(cid || "")}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Requested-With": "fetch" },
      body: file.slice(offset, end),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || "上传失败");

    offset = end;
    if (onProgress) onProgress(Math.round((offset / total) * 100));
  }
}

/* ---------------------------------------------------------------- 框架 */

function renderTabs(active) {
  const bar = $("me-tabs");
  bar.textContent = "";
  TABS.forEach(([key, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.className = active === key ? "on" : "";
    b.onclick = () => {
      const target = `#${key}`;
      if (location.hash === target) show(key);   // 地址没变，手动渲染
      else location.hash = target;               // 交给 hashchange
    };
    bar.appendChild(b);
  });
}

/* ---------------------------------------------------------------- 媒体 */

async function showMedia(kind) {
  const seq = ++renderSeq;
  renderTabs(kind);
  $("me-title").textContent = LABEL[kind];
  $("me-sub").textContent = `${me.username} · 只能改和删自己上传的`;

  const tools = $("me-tools");
  tools.textContent = "";
  const body = $("me-body");
  body.textContent = "";

  let folders = [];
  try {
    const d = await api(`/api/collections?kind=${kind}`);
    if (seq !== renderSeq) return;
    folders = d.items || [];
  } catch { /* 忽略 */ }

  const bar = document.createElement("div");
  bar.className = "sortbar";
  bar.style.flexWrap = "wrap";

  const sel = document.createElement("select");
  sel.style.cssText = "font-family:var(--font);font-size:13px;padding:6px 10px;"
    + "border:1px solid var(--hairline);border-radius:var(--r-pill);"
    + "background:var(--canvas);color:var(--ink)";
  folders.forEach((f) => {
    const o = document.createElement("option");
    o.value = String(f.id);
    o.textContent = f.name;
    sel.appendChild(o);
  });

  const pick = document.createElement("input");
  pick.type = "file";
  pick.multiple = true;
  pick.accept = kind === "photo" ? "image/*" : kind === "video" ? "video/*" : "audio/*";
  pick.hidden = true;

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "on";
  addBtn.textContent = "上传文件";
  addBtn.onclick = () => pick.click();

  bar.append(sel, addBtn);
  tools.appendChild(bar);

  const prog = document.createElement("p");
  prog.className = "hint";
  prog.style.margin = "6px 0 0";
  tools.appendChild(prog);

  pick.onchange = async () => {
    const files = [...(pick.files || [])];
    pick.value = "";
    for (const file of files) {
      prog.textContent = `${file.name} 上传中… 0%`;
      try {
        await uploadFile(kind, file, sel.value, (pct) => {
          prog.textContent = `${file.name} 上传中… ${pct}%`;
        });
        prog.textContent = `${file.name} 完成`;
      } catch (e) {
        prog.textContent = `${file.name} 失败：${e.message}`;
      }
    }
    showMedia(kind);
  };

  let items = [];
  try {
    const d = await api(`/api/my/uploads?kind=${kind}`);
    if (seq !== renderSeq) return;
    items = d.items || [];
  } catch (e) {
    if (seq !== renderSeq) return;
    body.appendChild(emptyBox(e.message));
    return;
  }

  body.appendChild(heading(`我上传的 ${items.length} ${UNIT[kind]}`));
  if (!items.length) {
    body.appendChild(emptyBox("还没上传过东西"));
    return;
  }

  const box = card();
  const ul = document.createElement("ul");
  ul.className = "sec-list";

  items.forEach((it) => {
    const li = document.createElement("li");
    li.className = "sec-row";

    const meta = document.createElement("div");
    meta.className = "body";
    const strong = document.createElement("strong");
    strong.textContent = it.title || "未命名";
    const sub = document.createElement("div");
    sub.style.cssText = "font-size:12px;color:var(--ink-48);margin-top:2px";
    sub.textContent = `${relTime(it.created_at)} · ${fmtSize(it.size)}`;
    meta.append(strong, sub);

    let view = null;
    if (kind === "photo" || kind === "video") {
      view = document.createElement("button");
      view.type = "button";
      view.className = "btn ghost sm";
      view.textContent = "查看";
      view.onclick = () => openViewer(kind, it);
    }

    const ren = document.createElement("button");
    ren.type = "button";
    ren.className = "btn ghost sm";
    ren.textContent = "改名";
    ren.onclick = async () => {
      const name = prompt("新名字：", it.title || "");
      if (!name || !name.trim()) return;
      try {
        await api(`/api/my/media/${kind}/${it.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: name.trim() }),
        });
        it.title = name.trim();
        strong.textContent = it.title;
        toast("已改名");
      } catch (e) { toast(e.message); }
    };

    const dl = document.createElement("a");
    dl.className = "btn ghost sm";
    dl.href = `/api/download/${kind}/${it.id}`;
    dl.textContent = "下载";

    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn ghost sm";
    del.textContent = "删除";
    del.onclick = async () => {
      if (!confirm("移入回收站？")) return;
      try {
        await api(`/api/my/media/${kind}/${it.id}`, { method: "DELETE" });
        li.remove();
        toast("已移入回收站");
      } catch (e) { toast(e.message); }
    };

    li.append(thumb(kind, it), meta, ...(view ? [view] : []), ren, dl, del);
    ul.appendChild(li);
  });

  box.appendChild(ul);
  body.appendChild(box);
}

/* ---------------------------------------------------------------- 收藏 / 下载 */

async function showList(kind, title, urlFn, timeField) {
  const seq = ++renderSeq;
  renderTabs(kind);
  $("me-title").textContent = title;
  $("me-sub").textContent = me.username;
  $("me-tools").textContent = "";

  const body = $("me-body");
  body.textContent = "";

  let items = [];
  try {
    const d = await api(urlFn);
    if (seq !== renderSeq) return;
    items = d.items || [];
  } catch (e) {
    body.appendChild(emptyBox(e.message));
    return;
  }

  if (!items.length) {
    body.appendChild(emptyBox(kind === "favorites" ? "还没有收藏" : "还没有下载记录"));
    return;
  }

  // 按模块顺序分组
  ["photo", "video", "track", "post"].forEach((k) => {
    const group = items.filter((x) => x.kind === k);
    if (!group.length) return;

    body.appendChild(heading(`${LABEL[k]} ${group.length}`));

    const box = card();
    const ul = document.createElement("ul");
    ul.className = "sec-list";

    group.forEach((it) => {
      const li = document.createElement("li");
      li.className = "sec-row";

      const a = document.createElement("a");
      a.style.cssText = "flex:1;min-width:0;text-decoration:none;color:var(--ink)";
      a.href = k === "post" ? `/section?kind=forum&post=${it.id}`
        : `/section?kind=${k}&open=${it.id}`;
      a.textContent = it.title || "未命名";

      const when = document.createElement("span");
      when.style.cssText = "font-size:12px;color:var(--ink-48);flex:none";
      when.textContent = relTime(it[timeField]);

      li.append(thumb(k, it), a);
      const vb = viewButton(k, it);
      if (vb) li.appendChild(vb);
      li.appendChild(when);
      ul.appendChild(li);
    });

    box.appendChild(ul);
    body.appendChild(box);
  });
}

/* ---------------------------------------------------------------- 回收站 */

async function showTrash() {
  const seq = ++renderSeq;
  renderTabs("trash");
  $("me-title").textContent = "回收站";
  $("me-sub").textContent = "30 天后自动清理";
  $("me-tools").textContent = "";

  const body = $("me-body");
  body.textContent = "";

  try {
    const d = await api("/api/my/trash");
    if (seq !== renderSeq) return;
    const items = d.items || [];
    if (!items.length) {
      body.appendChild(emptyBox("回收站是空的"));
      return;
    }

    const box = card();
    const ul = document.createElement("ul");
    ul.className = "sec-list";

    items.forEach((it) => {
      const li = document.createElement("li");
      li.className = "sec-row";

      const meta = document.createElement("div");
      meta.className = "body";
      const strong = document.createElement("strong");
      strong.textContent = it.title || "未命名";
      const sub = document.createElement("div");
      sub.style.cssText = "font-size:12px;color:var(--ink-48);margin-top:2px";
      sub.textContent = `${LABEL[it.kind]} · ${relTime(it.deleted_at)}删除`;
      meta.append(strong, sub);

      const back = document.createElement("button");
      back.type = "button";
      back.className = "btn ghost sm";
      back.textContent = "恢复";
      back.onclick = async () => {
        try {
          await api(`/api/my/trash/${it.kind}/${it.id}/restore`, { method: "POST" });
          li.remove();
          toast("已恢复");
        } catch (e) { toast(e.message); }
      };

      const gone = document.createElement("button");
      gone.type = "button";
      gone.className = "btn ghost sm";
      gone.textContent = "彻底删除";
      gone.onclick = async () => {
        if (!confirm("彻底删除后无法恢复，确定？")) return;
        try {
          await api(`/api/my/trash/${it.kind}/${it.id}`, { method: "DELETE" });
          li.remove();
          toast("已彻底删除");
        } catch (e) { toast(e.message); }
      };

      li.append(thumb(it.kind, it), meta);
      const vb = viewButton(it.kind, it);
      if (vb) li.appendChild(vb);
      li.append(back, gone);
      ul.appendChild(li);
    });

    box.appendChild(ul);
    body.appendChild(box);
  } catch (e) {
    body.appendChild(emptyBox(e.message));
  }
}

/* ---------------------------------------------------------------- 账号 */

async function uploadAvatar(file) {
  const res = await fetch("/api/my/avatar", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Requested-With": "fetch" },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || "上传失败");
  return data.avatar;
}

function avatarBlock() {
  const box = card();
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:center;gap:16px;padding:16px 0";

  const pic = document.createElement("div");
  pic.style.cssText = "width:72px;height:72px;border-radius:50%;overflow:hidden;"
    + "background:var(--parchment);display:flex;align-items:center;"
    + "justify-content:center;font-size:24px;color:var(--ink-48);flex:none";
  const paint = (name) => {
    pic.textContent = "";
    if (name) {
      const img = document.createElement("img");
      img.src = `/media/avatars/${encodeURIComponent(name)}`;
      img.style.cssText = "width:100%;height:100%;object-fit:cover";
      pic.appendChild(img);
    } else {
      pic.textContent = me.username.slice(0, 1).toUpperCase();
    }
  };
  paint(me.avatar);

  const right = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = me.username;
  name.style.cssText = "display:block;font-size:17px;margin-bottom:8px";

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.hidden = true;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn ghost sm";
  btn.textContent = "上传头像";
  btn.onclick = () => input.click();

  input.onchange = async () => {
    const f = (input.files || [])[0];
    input.value = "";
    if (!f) return;
    btn.disabled = true;
    try {
      const name2 = await uploadAvatar(f);
      me.avatar = name2;
      paint(name2);
      toast("头像已更新");
    } catch (e) {
      toast(e.message);
    } finally {
      btn.disabled = false;
    }
  };

  right.append(name, btn, input);
  wrap.append(pic, right);
  box.appendChild(wrap);
  return box;
}

function showAccount() {
  renderTabs("account");
  $("me-title").textContent = "账号";
  $("me-sub").textContent = me.username;
  $("me-tools").textContent = "";

  const body = $("me-body");
  body.textContent = "";

  body.appendChild(heading("头像"));
  body.appendChild(avatarBlock());

  body.appendChild(heading("修改密码"));

  const box = card();
  const form = document.createElement("form");
  form.style.cssText = "display:flex;flex-direction:column;gap:12px;padding:14px 0";

  const mk = (label, id, type) => {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const l = document.createElement("label");
    l.textContent = label;
    l.htmlFor = id;
    const i = document.createElement("input");
    i.id = id;
    i.type = type;
    i.autocomplete = type === "password" ? "new-password" : "username";
    wrap.append(l, i);
    return wrap;
  };

  const oldF = mk("原密码", "pw-old", "password");
  const newF = mk("新密码（至少 6 位）", "pw-new", "password");
  const btn = document.createElement("button");
  btn.type = "submit";
  btn.className = "btn solid sm";
  btn.textContent = "保存新密码";
  btn.style.alignSelf = "flex-start";

  form.append(oldF, newF, btn);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const old = $("pw-old").value;
    const nw = $("pw-new").value;
    if (nw.length < 6) { toast("新密码至少 6 位"); return; }
    btn.disabled = true;
    try {
      await api("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old, new: nw }),
      });
      $("pw-old").value = "";
      $("pw-new").value = "";
      toast("密码已修改");
    } catch (e) {
      toast(e.message);
    } finally {
      btn.disabled = false;
    }
  };

  box.appendChild(form);
  body.appendChild(box);
}

/* ---------------------------------------------------------------- 启动 */

function show(view) {
  if (view === "trash") return showTrash();
  if (view === "account") return showAccount();
  if (view === "favorites") {
    return showList("favorites", "我的收藏", "/api/favorites", "created_at");
  }
  if (view === "downloads") {
    return showList("downloads", "下载记录", "/api/my/downloads", "downloaded_at");
  }
  return showMedia(view);
}

async function boot() {
  try {
    const d = await api("/api/me");
    me = d.user;
  } catch { me = null; }

  if (!me) {
    $("me-body").appendChild(emptyBox("登录后才能进个人中心"));
    return;
  }

  $("me-sub").textContent = me.username;

  const render = () => {
    const view = (location.hash || "#photo").slice(1);
    const ok = TABS.some(([k]) => k === view);
    show(ok ? view : "photo");
  };

  render();
  window.addEventListener("hashchange", render);
  window.addEventListener("popstate", () => {
    const v = document.getElementById("me-viewer");
    if (v && !v.hidden) {
      viewerPushed = false;
      closeViewer(true);
      return;
    }
    render();
  });
}

boot();
