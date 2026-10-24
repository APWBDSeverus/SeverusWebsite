/* 后台脚本 */

const $ = (id) => document.getElementById(id);
const state = {
  limits: { photo: 10 * 1024 * 1024, video: 500 * 1024 * 1024, track: 50 * 1024 * 1024 },
  me: null,
  tab: "overview",
  items: { photo: [], video: [], track: [] },
  sel: { photo: new Set(), video: new Set(), track: new Set() },
  collections: { photo: [], video: [], track: [] },
  filter: { photo: null, video: null, track: null },
  forum: { q: "", user: "", since: 0 },
  userQ: "",
};

const TITLES = {
  overview: "概览", photo: "图片", video: "视频", track: "音乐",
  forum: "论坛", users: "用户", activity: "活动",
  trash: "回收站", settings: "设置",
  applications: "申请", reports: "举报", notify: "发送通知",
};

const ENDPOINT = { photo: "photos", video: "videos", track: "tracks" };
const UNIT = { photo: "张", video: "段", track: "首" };

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("on"), 2400);
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "X-Requested-With": "fetch" }, ...options });
  let data = {};
  try { data = await res.json(); } catch { /* 忽略 */ }
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

const jsonHeaders = { "Content-Type": "application/json", "X-Requested-With": "fetch" };

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function relTime(iso) {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const d = (Date.now() - t) / 1000;
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return new Date(t).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function emptyLine(text) {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  return p;
}

function table(headers) {
  const el = document.createElement("table");
  const thead = document.createElement("thead");
  const tr = document.createElement("tr");
  headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    tr.appendChild(th);
  });
  thead.appendChild(tr);
  el.appendChild(thead);
  const tbody = document.createElement("tbody");
  el.appendChild(tbody);
  return { el, tbody };
}

/* ---------------------------------------------------------------- 导航 */

function setTab(name) {
  state.tab = name;
  document.querySelectorAll("#admin-nav button").forEach((b) => {
    b.classList.toggle("on", b.dataset.tab === name);
  });
  document.querySelectorAll("[data-panel]").forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });
  $("page-title").textContent = TITLES[name] || "后台";

  // 申请这一栏的标题与摘要居中
  const head = document.querySelector(".admin-head");
  const CENTERED = new Set([
    "applications", "notify", "forum", "trash",
    "users", "reports", "activity", "settings",
  ]);
  if (head) head.classList.toggle("center", CENTERED.has(name));

  if (name === "overview") loadOverview();
  if (name === "forum") loadForum();
  if (name === "users") loadUsers();
  if (name === "activity") { initActTabs(); loadAudit(); loadActivity(); }
  if (name === "trash") loadTrash();
  if (name === "settings") loadSettings();
  if (name === "applications") loadApplications();
  if (name === "reports") loadReports();
  if (name === "notify") initNotify();
}

/* ---------------------------------------------------------------- 申请 */

const REPORT_LABEL = {
  post: "帖子", photo: "图片", video: "视频", track: "音乐", comment: "评论",
};

async function loadApplications() {
  const box = $("apps-box");
  box.textContent = "读取中…";
  try {
    const data = await api("/api/admin/applications");
    box.textContent = "";
    const items = data.items || [];
    if (!items.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "没有待审批的申请";
      box.appendChild(p);
      return;
    }

    items.forEach((it) => {
      const row = document.createElement("div");
      row.className = "trash-row";

      const meta = document.createElement("div");
      meta.className = "meta";
      const strong = document.createElement("strong");
      strong.textContent = it.username;
      const sub = document.createElement("span");
      sub.textContent = it.note || "没写留言";
      meta.append(strong, sub);

      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "btn solid sm";
      ok.textContent = "通过";
      ok.onclick = () => decide(it.id, "approve");

      const no = document.createElement("button");
      no.type = "button";
      no.className = "btn ghost sm";
      no.textContent = "拒绝";
      no.onclick = () => decide(it.id, "reject");

      row.append(meta, ok, no);
      box.appendChild(row);
    });
  } catch (e) {
    box.textContent = e.message;
  }
}

async function decide(appId, action) {
  try {
    await api(`/api/admin/applications/${appId}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: "{}",
    });
    toast(action === "approve" ? "已通过" : "已拒绝");
    loadApplications();
  } catch (e) {
    toast(e.message);
  }
}

/* ---------------------------------------------------------------- 举报 */

async function loadReports() {
  const box = $("reports-box");
  box.textContent = "读取中…";
  try {
    const data = await api("/api/admin/reports");
    box.textContent = "";
    const items = data.items || [];
    if (!items.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "没有待处理的举报";
      box.appendChild(p);
      return;
    }

    items.forEach((it) => {
      const row = document.createElement("div");
      row.className = "trash-row";

      const meta = document.createElement("div");
      meta.className = "meta";
      const strong = document.createElement("strong");
      strong.textContent = `${REPORT_LABEL[it.target_kind] || it.target_kind} #${it.target_id}`;
      const sub = document.createElement("span");
      sub.textContent = `${it.reporter || "匿名"} · ${it.reason || "没写理由"}`;
      meta.append(strong, sub);

      const done = document.createElement("button");
      done.type = "button";
      done.className = "btn ghost sm";
      done.textContent = "已处理";
      done.onclick = async () => {
        try {
          await api(`/api/admin/reports/${it.id}/resolve`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
            body: "{}",
          });
          loadReports();
        } catch (e) { toast(e.message); }
      };

      row.append(meta, done);
      box.appendChild(row);
    });
  } catch (e) {
    box.textContent = e.message;
  }
}

/* ---------------------------------------------------------------- 回收站 */

const KIND_LABEL = { photo: "图片", video: "视频", track: "音乐" };

async function loadTrash() {
  const box = $("trash-box");
  box.textContent = "读取中…";
  try {
    const data = await api("/api/admin/trash");
    box.textContent = "";
    const items = data.items || [];
    if (!items.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "回收站是空的";
      box.appendChild(p);
      return;
    }

    items.forEach((it) => {
      const row = document.createElement("div");
      row.className = "trow trash-row";

      const meta = document.createElement("span");
      meta.className = "meta";
      const strong = document.createElement("strong");
      strong.textContent = it.title || it.filename;
      const sub = document.createElement("span");
      sub.textContent = `${KIND_LABEL[it.kind] || it.kind} · ${relTime(it.deleted_at)}删除`;
      meta.append(strong, sub);

      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "btn ghost sm";
      restore.textContent = "恢复";
      restore.onclick = () => trashAction(`/api/admin/trash/${it.kind}/${it.id}/restore`, {});

      const purge = document.createElement("button");
      purge.type = "button";
      purge.className = "btn danger sm";
      purge.textContent = "彻底删除";
      purge.onclick = () => {
        if (!confirm("彻底删除后无法恢复，确定吗？")) return;
        trashAction(`/api/admin/trash/${it.kind}/${it.id}`, { method: "DELETE" });
      };

      row.append(meta, restore, purge);
      box.appendChild(row);
    });
  } catch (e) {
    box.textContent = e.message;
  }
}

async function trashAction(url, opts) {
  try {
    await api(url, {
      method: opts.method || "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: opts.method === "DELETE" ? undefined : "{}",
    });
    toast("已处理");
    loadTrash();
    loadOverview();
  } catch (e) {
    toast(e.message);
  }
}

/* ---------------------------------------------------------------- 设置 */

async function loadSettings() {
  try {
    const data = await api("/api/admin/settings");
    const s = data.settings;
    $("set-register").checked = s.allow_register === "1";
    $("set-apply").checked = s.apply_mode === "1";
    $("set-invite").value = s.invite_code || "";
    $("set-quota").value = s.quota_bytes ? Math.round(Number(s.quota_bytes) / 1073741824) : 0;
    $("set-daily").value = s.daily_files || 0;
  } catch (e) {
    toast(e.message);
  }
}

async function saveSettings() {
  try {
    const gb = Number($("set-quota").value || 0);
    await api("/api/admin/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: JSON.stringify({
        allow_register: $("set-register").checked ? "1" : "0",
        apply_mode: $("set-apply").checked ? "1" : "0",
        invite_code: $("set-invite").value.trim(),
        quota_bytes: String(Math.max(0, Math.round(gb * 1073741824))),
        daily_files: String(Math.max(0, Number($("set-daily").value || 0))),
      }),
    });
    toast("已保存");
  } catch (e) {
    toast(e.message);
  }
}

/* ---------------------------------------------------------------- 概览 */

async function loadOverview() {
  try {
    const data = await api("/api/bootstrap");
    const s = data.stats;
    state.stats = s;
    $("page-sub").textContent =
      `${s.photos} 张照片 · ${s.videos} 段影像 · ${s.posts} 条帖子 · ${s.members} 位成员`;

    const cards = [
      ["照片", s.photos, "张"], ["影像", s.videos, "段"],
      ["帖子", s.posts, "条"], ["成员", s.members, "位"], ["到访", s.visits, "次"],
    ];
    const box = $("stats-grid");
    box.textContent = "";
    cards.forEach(([label, value, unit]) => {
      const el = document.createElement("div");
      el.className = "stat";
      const k = document.createElement("div");
      k.className = "k";
      k.textContent = label;
      const v = document.createElement("div");
      v.className = "v";
      v.textContent = String(value);
      const u = document.createElement("span");
      u.className = "u";
      u.textContent = unit;
      v.appendChild(u);
      el.append(k, v);
      box.appendChild(el);
    });
  } catch (e) {
    $("page-sub").textContent = e.message;
  }

  renderQuick();
  await Promise.allSettled([loadStorage(), loadTrend()]);
  renderSys();
  await renderActivityInto("recent-box", 18);
}

function renderQuick() {
  const box = $("quick-box");
  box.textContent = "";
  const items = [
    ["上传照片", "photo", "solid"],
    ["上传视频", "video", "ghost"],
    ["上传音乐", "track", "ghost"],
    ["论坛管理", "forum", "ghost"],
    ["用户管理", "users", "ghost"],
  ];
  items.forEach(([label, tab, style]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `btn ${style} sm btn-block`;
    b.textContent = label;
    b.onclick = () => setTab(tab);
    box.appendChild(b);
  });
}

async function loadTrend() {
  const box = $("trend-box");
  box.textContent = "";
  try {
    const data = await api("/api/admin/trend");
    const items = data.items || [];
    if (!items.length) { box.appendChild(emptyLine("还没有数据")); return; }

    const max = Math.max(1, ...items.map((i) => i.count));
    const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
    const wrap = document.createElement("div");
    wrap.className = "trend";

    items.forEach((it) => {
      const tb = document.createElement("div");
      tb.className = "tb";

      const n = document.createElement("span");
      n.className = "n";
      n.textContent = String(it.count);

      const col = document.createElement("div");
      col.className = "col";
      const bar = document.createElement("i");
      bar.style.height = it.count ? `${Math.max(6, Math.round((it.count / max) * 100))}%` : "0";
      col.appendChild(bar);

      const d = document.createElement("span");
      d.className = "d";
      const day = new Date(`${it.date}T00:00:00Z`);
      d.textContent = WEEK[day.getUTCDay()];

      tb.append(n, col, d);
      wrap.appendChild(tb);
    });

    box.appendChild(wrap);
  } catch (e) {
    box.appendChild(emptyLine(e.message));
  }
}

function renderSys() {
  const box = $("sys-box");
  box.textContent = "";
  const s = state.storage;
  const st = state.stats;

  const rows = [
    ["数据目录", s ? s.path : "—", true],
    ["数据库", s ? fmtSize(s.db.bytes) : "—", false],
    ["磁盘剩余", s ? `${fmtSize(s.disk_free)} / ${fmtSize(s.disk_total)}` : "—", false],
    ["内容", st ? `${st.photos} 图 · ${st.videos} 视频` : "—", false],
  ];

  rows.forEach(([k, v, isPath]) => {
    const row = document.createElement("div");
    const key = document.createElement("span");
    key.textContent = k;
    const val = document.createElement("b");
    val.textContent = v;
    if (isPath) {
      val.className = "path";
      val.title = v;
    }
    row.append(key, val);
    box.appendChild(row);
  });
}

async function loadStorage() {
  const box = $("storage-box");
  box.textContent = "";
  try {
    const s = await api("/api/admin/storage");
    state.storage = s;
    const parts = [
      ["p", "照片", s.photos.bytes, `${s.photos.count} 个`],
      ["v", "视频", s.videos.bytes, `${s.videos.count} 个`],
      ["d", "数据库", s.db.bytes, ""],
    ];
    const total = s.used || 1;

    const bar = document.createElement("div");
    bar.className = "sbar";
    parts.forEach(([cls, , bytes]) => {
      const seg = document.createElement("i");
      seg.className = cls;
      seg.style.width = `${(bytes / total) * 100}%`;
      bar.appendChild(seg);
    });

    const legend = document.createElement("div");
    legend.className = "slegend";
    parts.forEach(([cls, name, bytes, extra]) => {
      const item = document.createElement("span");
      const dot = document.createElement("i");
      dot.className = `dot ${cls}`;
      const b = document.createElement("b");
      b.textContent = fmtSize(bytes);
      item.append(dot, document.createTextNode(`${name} `), b);
      if (extra) item.append(document.createTextNode(` ${extra}`));
      legend.appendChild(item);
    });

    const disk = document.createElement("div");
    disk.className = "slegend";
    const b1 = document.createElement("b");
    b1.textContent = fmtSize(s.used);
    disk.append(document.createTextNode("合计 "), b1,
      document.createTextNode(` · 磁盘剩余 ${fmtSize(s.disk_free)} / ${fmtSize(s.disk_total)}`));

    box.append(bar, legend, disk);
  } catch (e) {
    box.appendChild(emptyLine(e.message));
  }
}

async function renderActivityInto(boxId, limit) {
  const box = $(boxId);
  box.textContent = "";
  try {
    const data = await api("/api/admin/activity");
    const items = data.items.slice(0, limit);
    if (!items.length) { box.appendChild(emptyLine("还没有活动记录")); return; }

    const { el, tbody } = table(["用户", "行为", "内容", "时间"]);
    items.forEach((it) => {
      const tr = document.createElement("tr");
      const tdUser = document.createElement("td");
      tdUser.textContent = it.username;
      if (it.role === "admin") {
        const tag = document.createElement("span");
        tag.className = "badge login";
        tag.style.marginLeft = "6px";
        tag.textContent = "管理员";
        tdUser.appendChild(tag);
      }
      const tdKind = document.createElement("td");
      tdKind.textContent = it.kind === "post" ? "发帖" : "登录";
      const tdDetail = document.createElement("td");
      tdDetail.textContent = it.detail || "—";
      const tdTime = document.createElement("td");
      tdTime.textContent = relTime(it.created_at);
      tr.append(tdUser, tdKind, tdDetail, tdTime);
      tbody.appendChild(tr);
    });
    box.appendChild(el);
  } catch (e) {
    box.appendChild(emptyLine(e.message));
  }
}

async function loadActivity() {
  await renderActivityInto("activity-box", 40);
}


function initActTabs() {
  const bar = $("act-tabs");
  const view = $("act-view");
  if (!bar || !view || bar.dataset.wired) return;
  bar.dataset.wired = "1";

  const buttons = Array.from(bar.querySelectorAll("button"));

  const go = (i) => {
    view.scrollTo({ left: i * view.clientWidth, behavior: "smooth" });
    buttons.forEach((b, k) => b.classList.toggle("on", k === i));
  };

  buttons.forEach((b, i) => { b.onclick = () => go(i); });

  view.addEventListener("scroll", () => {
    const i = Math.round(view.scrollLeft / Math.max(1, view.clientWidth));
    buttons.forEach((b, k) => b.classList.toggle("on", k === i));
  }, { passive: true });

  go(0);
}

async function loadAudit() {
  const box = $("audit-box");
  box.textContent = "";
  try {
    const data = await api("/api/admin/audit");
    if (!data.items.length) { box.appendChild(emptyLine("还没有操作记录")); return; }
    const { el, tbody } = table(["时间", "管理员", "操作", "详情"]);
    data.items.forEach((it) => {
      const tr = document.createElement("tr");
      const tdTime = document.createElement("td");
      tdTime.textContent = relTime(it.created_at);
      const tdUser = document.createElement("td");
      tdUser.textContent = it.username;
      const tdAct = document.createElement("td");
      tdAct.textContent = it.action;
      const tdDetail = document.createElement("td");
      tdDetail.textContent = it.detail || "—";
      tr.append(tdTime, tdUser, tdAct, tdDetail);
      tbody.appendChild(tr);
    });
    box.appendChild(el);
  } catch (e) {
    box.appendChild(emptyLine(e.message));
  }
}

/* ---------------------------------------------------------------- 文件夹 */

const FOLDER_WORD = { photo: "文件夹", video: "文件夹", track: "歌单" };

async function loadCollections(kind) {
  try {
    const data = await api(`/api/collections?kind=${kind}`);
    state.collections[kind] = data.items || [];
  } catch {
    state.collections[kind] = [];
  }
  renderFolders(kind);
  fillTarget(kind);
}

function fillTarget(kind) {
  const sel = $(`${kind}-target`);
  if (!sel) return;
  const keep = sel.value;
  sel.textContent = "";
  state.collections[kind].forEach((c) => {
    const o = document.createElement("option");
    o.value = String(c.id);
    o.textContent = c.name;
    sel.appendChild(o);
  });
  if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function renderFolders(kind) {
  const bar = $(`${kind}-fbar`);
  if (!bar) return;
  bar.textContent = "";

  const all = document.createElement("div");
  all.className = "fchip" + (state.filter[kind] === null ? " on" : "");
  all.textContent = "全部";
  all.onclick = () => {
    state.filter[kind] = null;
    loadMedia(kind);
    renderFolders(kind);
  };
  bar.appendChild(all);

  state.collections[kind].forEach((c) => {
    const chip = document.createElement("div");
    chip.className = "fchip" + (state.filter[kind] === c.id ? " on" : "");

    const name = document.createElement("span");
    name.textContent = c.name;
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = String(c.count);

    const edit = document.createElement("span");
    edit.className = "x";
    edit.textContent = "✎";
    edit.title = "改名";
    edit.onclick = (ev) => { ev.stopPropagation(); renameFolder(kind, c); };

    const del = document.createElement("span");
    del.className = "x";
    del.textContent = "✕";
    del.title = "删除（内容移到未分类）";
    del.onclick = (ev) => { ev.stopPropagation(); deleteFolder(kind, c); };

    chip.append(name, n, edit, del);
    chip.onclick = () => {
      state.filter[kind] = state.filter[kind] === c.id ? null : c.id;
      loadMedia(kind);
      renderFolders(kind);
    };

    // 拖到这里 = 移入这个文件夹
    chip.ondragover = (ev) => {
      ev.preventDefault();
      chip.style.borderColor = "var(--primary)";
    };
    chip.ondragleave = () => { chip.style.borderColor = ""; };
    chip.ondrop = async (ev) => {
      ev.preventDefault();
      chip.style.borderColor = "";
      let payload = null;
      try {
        payload = JSON.parse(ev.dataTransfer.getData("text/plain"));
      } catch { return; }
      if (!payload || payload.kind !== kind) {
        toast("类型不一致，拖错了");
        return;
      }
      try {
        await api(`/api/admin/media/${kind}/${payload.id}`, {
          method: "PATCH", headers: jsonHeaders,
          body: JSON.stringify({ collection_id: c.id }),
        });
        toast(`已移入「${c.name}」`);
        await loadMedia(kind);
        await loadCollections(kind);
      } catch (e) {
        toast(e.message);
      }
    };

    bar.appendChild(chip);
  });

  const add = document.createElement("button");
  add.type = "button";
  add.className = "fchip";
  add.textContent = "+ 新建";
  add.onclick = () => createFolder(kind);
  bar.appendChild(add);
}

async function createFolder(kind) {
  const name = prompt(`新建${FOLDER_WORD[kind]}的名字：`);
  if (!name || !name.trim()) return;
  try {
    const data = await api("/api/admin/collections", {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ kind, name: name.trim() }),
    });
    state.filter[kind] = data.id;
    await loadCollections(kind);
    await loadMedia(kind);
    toast(`已新建「${data.name}」`);
  } catch (e) { toast(e.message); }
}

async function renameFolder(kind, c) {
  const name = prompt(`把「${c.name}」改成：`, c.name);
  if (!name || !name.trim() || name.trim() === c.name) return;
  try {
    await api(`/api/admin/collections/${c.id}`, {
      method: "PATCH", headers: jsonHeaders,
      body: JSON.stringify({ name: name.trim() }),
    });
    await loadCollections(kind);
    toast("已改名");
  } catch (e) { toast(e.message); }
}

async function deleteFolder(kind, c) {
  if (!confirm(`删除${FOLDER_WORD[kind]}「${c.name}」？里面的内容会移到「未分类」，文件不会删。`)) return;
  try {
    await api(`/api/admin/collections/${c.id}`, { method: "DELETE" });
    if (state.filter[kind] === c.id) state.filter[kind] = null;
    await loadCollections(kind);
    await loadMedia(kind);
    toast("已删除");
  } catch (e) { toast(e.message); }
}

/* ---------------------------------------------------------------- 上传 */

function initDrop(kind) {
  const drop = $(`${kind}-drop`);
  const input = $(`${kind}-input`);

  drop.onclick = () => input.click();
  input.onchange = () => {
    const files = [...(input.files || [])];
    if (files.length) enqueue(kind, files);
    input.value = "";
  };

  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); }));
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hot"); }));
  drop.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) enqueue(kind, files);
  });
}

async function enqueue(kind, files) {
  const title = $(`${kind}-title`).value.trim();
  const queue = $(`${kind}-queue`);

  for (const file of files) {
    const limit = kind === "photo" ? state.limits.photo
    : kind === "video" ? state.limits.video
    : state.limits.track;
    const row = document.createElement("div");
    row.className = "qrow";

    const name = document.createElement("span");
    name.className = "qname";
    name.textContent = file.name;

    const bar = document.createElement("span");
    bar.className = "qbar";
    const fill = document.createElement("i");
    bar.appendChild(fill);

    const st = document.createElement("span");
    st.className = "qst";
    st.textContent = fmtSize(file.size);
    row.append(name, bar, st);
    queue.appendChild(row);

    if (file.size > limit) {
      row.classList.add("err");
      st.textContent = `超过 ${fmtSize(limit)}`;
      continue;
    }

    try {
      let send = file;
      if (kind === "photo") send = await compressImage(file);
      if (send !== file) name.textContent = `${file.name} → ${fmtSize(send.size)}`;

      const data = await uploadOne(kind, send, title, fill, st);

      if (kind === "video" && data && data.item) {
        st.textContent = "封面…";
        const poster = await grabPoster(file);
        if (poster) await uploadPoster(data.item.id, poster);
      }

      row.classList.add("done");
      st.textContent = data && data.dup ? "已存在" : "完成";
    } catch (e) {
      row.classList.add("err");
      st.textContent = "失败";
      toast(`${file.name}：${e.message}`);
    }
  }

  loadMedia(kind);
  loadCollections(kind);
  loadOverview();
}

/* 上传前先把图片缩到 1600px 并重编码 —— 顺带把 EXIF（含 GPS）剥掉 */
async function compressImage(file, maxEdge = 1600, quality = 0.85) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1 && file.size < 900 * 1024) return file;   // 本来就小，不折腾

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close && bitmap.close();

    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg",
                    { type: "image/jpeg" });
  } catch {
    return file;      // 解不开就原样上传，不阻断
  }
}

/* 从视频抽一帧当封面 */
async function grabPoster(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    v.src = url;

    const done = (blob) => { URL.revokeObjectURL(url); resolve(blob); };

    v.onloadeddata = () => { try { v.currentTime = Math.min(1, v.duration * 0.1); } catch { done(null); } };
    v.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = Math.min(960, v.videoWidth || 960);
        canvas.height = Math.round(canvas.width * (v.videoHeight / v.videoWidth)) || 540;
        canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((b) => done(b), "image/jpeg", 0.8);
      } catch { done(null); }
    };
    v.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
  });
}

async function uploadPoster(videoId, blob) {
  try {
    await fetch(`/api/admin/media/video/${videoId}/poster`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Requested-With": "fetch" },
      body: blob,
    });
  } catch { /* 封面失败不影响视频 */ }
}

const CHUNK_SIZE = 8 * 1024 * 1024;   // 每片 8MB

function uploadOne(kind, file, title, fill, st) {
  const target = $(`${kind}-target`);
  const cid = target && target.value ? target.value : "";

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const uid = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

  const total = file.size;
  let offset = 0;

  return new Promise((resolve, reject) => {
    const sendNext = () => {
      if (offset >= total) { resolve({ ok: true }); return; }

      const end = Math.min(offset + CHUNK_SIZE, total);
      const url = `/api/admin/upload/chunk?kind=${kind}&id=${uid}`
        + `&offset=${offset}&total=${total}`
        + `&title=${encodeURIComponent(title)}`
        + `&collection=${encodeURIComponent(cid)}`
        + `&name=${encodeURIComponent(file.name)}`;

      const xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      xhr.setRequestHeader("X-Requested-With", "fetch");
      xhr.setRequestHeader("Content-Type", "application/octet-stream");

      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* 忽略 */ }
        if (xhr.status < 200 || xhr.status >= 300 || data.ok === false) {
          reject(new Error(data.error || `HTTP ${xhr.status}`));
          return;
        }
        offset = end;
        const pct = Math.round((offset / total) * 100);
        fill.style.width = `${pct}%`;
        st.textContent = `${pct}%`;
        if (offset >= total) resolve(data);
        else sendNext();
      };
      xhr.onerror = () => reject(new Error("网络中断，可重试"));
      xhr.send(file.slice(offset, end));
    };

    sendNext();
  });
}

/* ---------------------------------------------------------------- 媒体 */

function mediaTile(item, kind) {
  const box = document.createElement("div");
  box.className = "u";
  if (state.sel[kind].has(item.id)) box.classList.add("picked");

  // 可以拖到文件夹里，也可以拖到别的格子上换顺序
  box.dataset.mid = item.id;
  box.draggable = true;
  box.ondragstart = (ev) => {
    ev.dataTransfer.setData("text/plain", JSON.stringify({ kind, id: item.id }));
    ev.dataTransfer.effectAllowed = "move";
  };

  box.ondragover = (ev) => { ev.preventDefault(); };
  box.ondrop = async (ev) => {
    ev.preventDefault();
    let payload = null;
    try { payload = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
    if (!payload || payload.kind !== kind || payload.id === item.id) return;

    const grid = box.parentElement;
    const dragged = grid.querySelector(`[data-mid="${payload.id}"]`);
    if (!dragged) return;
    grid.insertBefore(dragged, box);

    const ids = Array.from(grid.querySelectorAll("[data-mid]"))
      .map((el) => Number(el.dataset.mid));
    try {
      await api(`/api/admin/media/${kind}/order`, {
        method: "POST", headers: jsonHeaders,
        body: JSON.stringify({ ids }),
      });
    } catch (e) { toast(e.message); }
  };

  // 选择框
  const pick = document.createElement("label");
  pick.className = "pick";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = state.sel[kind].has(item.id);
  cb.onchange = () => {
    if (cb.checked) state.sel[kind].add(item.id);
    else state.sel[kind].delete(item.id);
    box.classList.toggle("picked", cb.checked);
    renderBulk(kind);
  };
  pick.appendChild(cb);
  box.appendChild(pick);

  // 预览
  if (kind === "photo") {
    const img = document.createElement("img");
    img.src = `/media/photos/${encodeURIComponent(item.filename)}`;
    img.alt = item.title || "";
    box.appendChild(img);
  } else if (kind === "video") {
    const vid = document.createElement("video");
    vid.src = `/media/videos/${encodeURIComponent(item.filename)}#t=0.1`;
    vid.preload = "metadata";
    vid.muted = true;
    vid.playsInline = true;
    box.appendChild(vid);
  } else {
    const icon = document.createElement("div");
    icon.className = "aicon";
    icon.textContent = "♪";
    box.appendChild(icon);
  }

  // 置顶（只有照片）
  if (kind === "photo") {
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "btn-pin" + (item.pinned ? " on" : "");
    pin.textContent = "★";
    pin.title = item.pinned ? "取消置顶" : "置顶到相册第一张";
    pin.onclick = async () => {
      try {
        await api(`/api/admin/media/photo/${item.id}`, {
          method: "PATCH", headers: jsonHeaders,
          body: JSON.stringify({ pinned: !item.pinned }),
        });
        toast(item.pinned ? "已取消置顶" : "已置顶");
        loadMedia("photo");
      } catch (e) { toast(e.message); }
    };
    box.appendChild(pin);
  }

  // 标签
  const tagBtn = document.createElement("button");
  tagBtn.type = "button";
  tagBtn.textContent = "#";
  tagBtn.title = "设置标签";
  tagBtn.onclick = async (ev) => {
    ev.stopPropagation();
    const raw = prompt("标签（用逗号分隔）：", "");
    if (raw === null) return;
    const tags = raw.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
    try {
      await api(`/api/staff/tags/${kind}/${item.id}`, {
        method: "POST", headers: jsonHeaders,
        body: JSON.stringify({ tags }),
      });
      toast(tags.length ? `标签：${tags.join(" / ")}` : "标签已清空");
    } catch (e) { toast(e.message); }
  };
  box.appendChild(tagBtn);

  // 改名
  const ren = document.createElement("button");
  ren.type = "button";
  ren.textContent = "✎";
  ren.title = "改名";
  ren.onclick = async (ev) => {
    ev.stopPropagation();
    const name = prompt("新名字：", item.title || "");
    if (name === null) return;
    const title = name.trim();
    try {
      await api(`/api/admin/media/${kind}/${item.id}`, {
        method: "PATCH", headers: jsonHeaders,
        body: JSON.stringify({ title }),
      });
      item.title = title;
      cap.textContent = title || "未命名";
      toast(title ? `已改名：${title}` : "已清空名字");
    } catch (e) { toast(e.message); }
  };
  box.appendChild(ren);

  // 删除
  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "✕";
  del.title = "删除";
  del.onclick = async () => {
    if (!confirm(`确定删除「${item.title || "未命名"}」？会先进回收站。`)) return;
    try {
      await api(`/api/admin/media/${kind}/${item.id}`, { method: "DELETE" });
      state.sel[kind].delete(item.id);
      loadMedia(kind);
      loadOverview();
      toast("已删除");
    } catch (e) { toast(e.message); }
  };
  box.appendChild(del);

  // 所属文件夹
  const col = state.collections[kind].find((c) => c.id === item.collection_id);
  if (col) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = col.name;
    box.appendChild(tag);
  }

  // 标题（点击就地编辑）
  const cap = document.createElement("span");
  cap.textContent = item.title || fmtSize(item.size);
  cap.title = "点击修改标题";
  cap.onclick = () => editTitle(kind, item, cap, box);
  box.appendChild(cap);

  return box;
}

function editTitle(kind, item, cap, box) {
  if (box.querySelector("input.cap-edit")) return;

  const input = document.createElement("input");
  input.className = "cap-edit";
  input.type = "text";
  input.maxLength = 120;
  input.value = item.title || "";
  cap.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;

  const restore = () => {
    if (input.parentNode) input.replaceWith(cap);
  };

  const save = async () => {
    if (settled) return;
    settled = true;
    const value = input.value.trim();
    restore();

    if (value === (item.title || "")) return;
    try {
      await api(`/api/admin/media/${kind}/${item.id}`, {
        method: "PATCH", headers: jsonHeaders,
        body: JSON.stringify({ title: value }),
      });
      item.title = value;
      cap.textContent = value || fmtSize(item.size);
      toast("标题已更新");
    } catch (e) {
      toast(e.message);
    }
  };

  input.onblur = save;
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
    if (ev.key === "Escape") {
      settled = true;
      restore();
    }
  };
}

function renderBulk(kind) {
  const bar = $(`${kind}-bulk`);
  const set = state.sel[kind];
  bar.textContent = "";

  if (!set.size) { bar.hidden = true; updateFoot(kind); return; }
  bar.hidden = false;

  const all = document.createElement("label");
  const allCb = document.createElement("input");
  allCb.type = "checkbox";
  allCb.checked = set.size >= state.items[kind].length && state.items[kind].length > 0;
  allCb.onchange = () => {
    if (allCb.checked) state.items[kind].forEach((it) => set.add(it.id));
    else set.clear();
    loadMedia(kind);
  };
  all.appendChild(allCb);
  all.appendChild(document.createTextNode("全选"));

  const label = document.createElement("span");
  label.textContent = `已选 ${set.size} 项`;

  const spacer = document.createElement("span");
  spacer.className = "sp";

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn sm ghost";
  clear.textContent = "取消选择";
  clear.onclick = () => { set.clear(); loadMedia(kind); };

  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn sm danger";
  del.textContent = "删除所选";
  del.onclick = () => bulkDelete(kind);

  bar.append(all, label, spacer, clear, del);
  updateFoot(kind);
}

function updateFoot(kind) {
  const el = $(`${kind}-foot`);
  if (!el) return;
  const f = (state.foot || {})[kind];
  if (!f) { el.textContent = ""; return; }
  const unit = UNIT[kind] || "项";
  el.textContent =
    `共 ${f.total} ${unit} · 本页 ${fmtSize(f.bytes)} · 已选 ${state.sel[kind].size} 项`;
}

async function bulkDelete(kind) {
  const ids = [...state.sel[kind]];
  if (!ids.length) return;
  const label = kind === "photo" ? "照片" : "视频";
  if (!confirm(`确定删除选中的 ${ids.length} 个${label}？文件会从磁盘移除，不可恢复。`)) return;

  try {
    const data = await api("/api/admin/media/bulk-delete", {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ kind, ids }),
    });
    state.sel[kind].clear();
    toast(`已删除 ${data.deleted} 个${label}`);
    loadMedia(kind);
    loadOverview();
  } catch (e) {
    toast(e.message);
  }
}

async function loadMedia(kind) {
  const box = $(`${kind}-list`);
  box.textContent = "";
  try {
    const qs = state.filter[kind] ? `&collection=${state.filter[kind]}` : "";
    const data = await api(`/api/${ENDPOINT[kind]}?limit=60&offset=0${qs}`);
    state.items[kind] = data.items;
    // 清掉已经不存在的选中项
    const alive = new Set(data.items.map((i) => i.id));
    [...state.sel[kind]].forEach((id) => { if (!alive.has(id)) state.sel[kind].delete(id); });

    data.items.forEach((item) => box.appendChild(mediaTile(item, kind)));
    if (!data.items.length) {
      box.appendChild(emptyLine(
        kind === "photo" ? "还没有照片" : kind === "video" ? "还没有视频" : "还没有音乐"));
    }
    state.foot = state.foot || {};
    state.foot[kind] = {
      total: data.total,
      bytes: data.items.reduce((sum, i) => sum + i.size, 0),
    };
    const totalEl = $(`${kind}-total`);
    if (totalEl) totalEl.textContent = data.total ? String(data.total) : "";
    renderBulk(kind);
  } catch (e) {
    box.appendChild(emptyLine(e.message));
  }
}

/* ---------------------------------------------------------------- 论坛 */

function initForumFilters() {
  const apply = debounce(() => {
    state.forum.q = $("forum-q").value.trim();
    state.forum.user = $("forum-user").value.trim();
    state.forum.since = Number($("forum-since").value) || 0;
    loadForum();
  }, 300);

  $("forum-q").oninput = apply;
  $("forum-user").oninput = apply;
  $("forum-since").onchange = apply;
  $("forum-reset").onclick = () => {
    $("forum-q").value = "";
    $("forum-user").value = "";
    $("forum-since").value = "0";
    state.forum = { q: "", user: "", since: 0 };
    loadForum();
  };
}

async function loadForum() {
  const box = $("forum-list");
  box.textContent = "";

  const params = new URLSearchParams({ limit: "60", offset: "0" });
  if (state.forum.q) params.set("q", state.forum.q);
  if (state.forum.user) params.set("user", state.forum.user);
  if (state.forum.since) params.set("since", String(state.forum.since));

  $("page-sub").textContent = "删除的帖子不再显示";

  try {
    const data = await api(`/api/posts?${params}`);
    if (!data.items.length) {
      box.appendChild(emptyLine(
        state.forum.q || state.forum.user || state.forum.since
          ? "没有符合条件的帖子"
          : "还没有帖子"));
      return;
    }

    const { el, tbody } = table(["作者", "内容", "时间", ""]);
    data.items.forEach((item) => {
      const tr = document.createElement("tr");

      const tdName = document.createElement("td");
      tdName.textContent = item.username;

      const tdBody = document.createElement("td");
      tdBody.textContent = item.body.length > 60 ? item.body.slice(0, 60) + "…" : item.body;

      const tdTime = document.createElement("td");
      tdTime.textContent = relTime(item.created_at);

      const tdAct = document.createElement("td");
      tdAct.style.textAlign = "right";
      const del = document.createElement("button");
      del.className = "btn danger sm";
      del.type = "button";
      del.textContent = "删除";
      del.onclick = async () => {
        if (!confirm("确定删除这条帖子？")) return;
        try {
          await api(`/api/admin/posts/${item.id}/delete`, { method: "POST" });
          loadForum();
          toast("已删除");
        } catch (e) { toast(e.message); }
      };
      tdAct.appendChild(del);

      tr.append(tdName, tdBody, tdTime, tdAct);
      tbody.appendChild(tr);
    });
    box.appendChild(el);
  } catch (e) {
    box.appendChild(emptyLine(e.message));
  }
}

/* ---------------------------------------------------------------- 用户 */

function initUserFilters() {
  $("user-q").oninput = debounce(() => {
    state.userQ = $("user-q").value.trim();
    loadUsers();
  }, 300);
  $("user-reset").onclick = () => {
    $("user-q").value = "";
    state.userQ = "";
    loadUsers();
  };
}

async function loadUsers() {
  const box = $("user-table");
  box.textContent = "";
  $("page-sub").textContent = "封禁后无法登录和发帖";

  try {
    const qs = state.userQ ? `?q=${encodeURIComponent(state.userQ)}` : "";
    const data = await api(`/api/admin/users${qs}`);
    if (!data.items.length) { box.appendChild(emptyLine("没有匹配的用户")); return; }

    const { el, tbody } = table(["ID", "用户名", "角色", "注册时间", "状态", ""]);
    data.items.forEach((u) => {
      const tr = document.createElement("tr");
      const cells = [
        String(u.id), u.username,
        u.role === "admin" ? "管理员" : "普通用户",
        relTime(u.created_at),
        u.banned ? "已封禁" : "正常",
      ];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (i === 0) td.className = "num";
        tr.appendChild(td);
      });

      const tdAct = document.createElement("td");
      tdAct.style.textAlign = "right";
      if (u.role !== "admin") {
        const btn = document.createElement("button");
        btn.className = u.banned ? "btn sm ghost" : "btn sm danger";
        btn.type = "button";
        btn.textContent = u.banned ? "解封" : "封禁";
        btn.onclick = async () => {
          try {
            await api("/api/admin/ban", {
              method: "POST", headers: jsonHeaders,
              body: JSON.stringify({ id: u.id, banned: !u.banned }),
            });
            loadUsers();
            toast(u.banned ? "已解封" : "已封禁");
          } catch (e) { toast(e.message); }
        };
        tdAct.appendChild(btn);
      }
      tr.appendChild(tdAct);
      tbody.appendChild(tr);
    });
    box.appendChild(el);
  } catch (e) {
    box.appendChild(emptyLine(e.message));
  }
}

/* ---------------------------------------------------------------- 改密码 */

async function savePassword() {
  const oldPw = $("old-pw").value;
  const newPw = $("new-pw").value;
  if (!oldPw || !newPw) { toast("两个密码都要填"); return; }
  if (newPw.length < 6) { toast("新密码至少 6 位"); return; }
  try {
    await api("/api/auth/password", {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ old: oldPw, new: newPw }),
    });
    $("old-pw").value = "";
    $("new-pw").value = "";
    toast("密码已更新");
  } catch (e) { toast(e.message); }
}

/* ---------------------------------------------------------------- 侧边栏用户 */

function renderSideUser(user) {
  const box = $("side-user");
  if (!box) return;
  box.textContent = "";

  const name = document.createElement("b");
  name.textContent = user.username;

  const role = document.createElement("span");
  role.textContent = "管理员";

  const out = document.createElement("a");
  out.href = "#";
  out.textContent = "退出";
  out.onclick = async (ev) => {
    ev.preventDefault();
    try {
      await api("/api/auth/logout", { method: "POST" });
      location.href = "/";
    } catch (e) { toast(e.message); }
  };

  box.append(name, role, out);
}

/* ---------------------------------------------------------------- 启动 */

async function boot() {
  try {
    const me = await api("/api/me");
    if (!me.user || me.user.role !== "admin") {
      location.replace("/login?next=/admin");
      return;
    }
    state.me = me.user;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = me.user.username;
    $("nav-right").appendChild(who);
    renderSideUser(me.user);
  } catch {
    location.replace("/login?next=/admin");
    return;
  }

  try {
    const boot = await api("/api/bootstrap");
    state.limits = boot.limits;
    $("photo-limit").textContent =
      `支持 JPG / PNG / GIF / WebP · 单张不超过 ${fmtSize(boot.limits.photo)}`;
    $("video-limit").textContent =
      `支持 MP4 / WebM · 单个不超过 ${fmtSize(boot.limits.video)}`;
    const trackLimit = $("track-limit");
    if (trackLimit) {
      trackLimit.textContent =
        `支持 MP3 / M4A / WAV / OGG / FLAC · 单首不超过 ${fmtSize(boot.limits.track)}`;
    }
  } catch { /* 用默认值 */ }

  document.querySelectorAll("#admin-nav button").forEach((btn) => {
    btn.onclick = () => setTab(btn.dataset.tab);
  });

  initDrop("photo");
  initDrop("video");
  initDrop("track");
  initForumFilters();
  initUserFilters();
  $("pw-save").onclick = savePassword;
  const setSave = $("set-save");
  if (setSave) setSave.onclick = saveSettings;

  ["photo", "video", "track"].forEach((k) => {
    const b = $(`${k}-new`);
    if (b) b.onclick = () => createFolder(k);
  });

  await Promise.allSettled([
    loadOverview(),
    loadCollections("photo"), loadCollections("video"), loadCollections("track"),
    loadMedia("photo"), loadMedia("video"), loadMedia("track"),
  ]);
}

boot();

/* ---------------------------------------------------------------- 发通知 */


async function loadNotifyUsers() {
  const box = $("nt-users");
  if (!box) return;

  if (!state.notifyUsers) {
    box.textContent = "读取中…";
    try {
      const data = await api("/api/admin/users");
      state.notifyUsers = data.items || [];
    } catch (e) {
      box.textContent = e.message;
      return;
    }
  }
  paintNotifyUsers();
}

function paintNotifyUsers() {
  const mode = $("nt-scope").value;
  const single = mode === "one";
  const box = $("nt-users");
  const kw = ($("nt-search") ? $("nt-search").value : "").trim().toLowerCase();
  const all = state.notifyUsers || [];
  const list = kw ? all.filter((u) => u.username.toLowerCase().includes(kw)) : all;

  // 记住已经勾了谁，重绘后还原
  const checked = new Set(
    Array.from(box.querySelectorAll("input:checked")).map((el) => el.value));

  box.textContent = "";
  if (!list.length) {
    box.textContent = "没有匹配的用户";
    return;
  }

  list.forEach((u) => {
    const label = document.createElement("label");
    label.className = "chk";
    label.style.marginRight = "14px";

    const cb = document.createElement("input");
    cb.type = single ? "radio" : "checkbox";
    cb.name = "nt-pick";
    cb.value = u.username;
    if (checked.has(u.username) && !single) cb.checked = true;

    const span = document.createElement("span");
    span.textContent = u.role === "admin" ? `${u.username}（管理员）` : u.username;

    label.append(cb, span);
    box.appendChild(label);
  });
}

function initNotify() {
  const btn = $("nt-send");
  if (!btn) return;

  const scope = $("nt-scope");
  const wrap = $("nt-user-wrap");
  const ta = $("nt-text");
  const count = $("nt-count");

  const search = $("nt-search");
  if (search) {
    search.oninput = paintNotifyUsers;
  }

  scope.onchange = async () => {
    wrap.hidden = scope.value === "all";
    if (!wrap.hidden) await loadNotifyUsers();
  };
  ta.oninput = () => { count.textContent = String(ta.value.length); };

  btn.onclick = async () => {
    const text = $("nt-text").value.trim();
    const picked = Array.from(
      document.querySelectorAll("#nt-users input:checked")).map((el) => el.value);
    const to = scope.value === "one" ? "one"
      : scope.value === "many" ? "many" : "all";
    if (to !== "all" && !picked.length) {
      toast("先在名单里选人");
      return;
    }
    if (!text) { toast("写点内容再发"); return; }
    btn.disabled = true;
    try {
      const data = await api("/api/admin/notify", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ text, to, users: picked }),
      });
      toast(`已发给 ${data.sent} 人`);
      $("nt-text").value = "";
      count.textContent = "0";
    } catch (e) {
      toast(e.message);
    } finally {
      btn.disabled = false;
    }
  };
}
