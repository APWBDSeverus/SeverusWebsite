/* 共享迷你播放器：悬浮在底部，跨页用 sessionStorage 续播，带进度条。 */

(function () {
  const KEY = "sev.player";
  const ICON_PLAY = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M7 4l13 8-13 8z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';

  let audio = null;
  let built = false;
  let bar, fill, titleEl, timeEl, toggleBtn, listBox;
  let list = [];
  let cur = null;
  let saveAt = 0;
  let shuffle = false;
  let repeat = "off";      // off | all | one

  function fmt(t) {
    if (!isFinite(t) || t < 0) return "0:00";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function build() {
    if (built) return;
    built = true;

    const el = document.createElement("div");
    el.className = "miniplayer";
    el.hidden = true;
    el.innerHTML = [
      '<span class="mini-note" aria-hidden="true">♪</span>',
      '<div class="mini-info">',
      '  <strong class="mini-title"></strong>',
      '  <div class="mini-bar" title="点击跳转"><i></i></div>',
      "</div>",
      '<span class="mini-time">0:00</span>',
      '<div class="mini-controls">',
      '  <button type="button" class="mp-shuffle" aria-label="随机" title="随机播放">⤨</button>',
      '  <button type="button" class="mp-prev" aria-label="上一首">‹</button>',
      '  <button type="button" class="mp-toggle" aria-label="播放/暂停"></button>',
      '  <button type="button" class="mp-next" aria-label="下一首">›</button>',
      '  <button type="button" class="mp-repeat" aria-label="循环" title="循环">↻</button>',
      "</div>",
      '<button type="button" class="mini-range mp-listbtn">歌单</button>',
      '<button type="button" class="mini-close mp-close" aria-label="关闭">✕</button>',
      '<div class="miniplaylist" hidden></div>',
    ].join("");

    document.body.appendChild(el);

    titleEl = el.querySelector(".mini-title");
    fill = el.querySelector(".mini-bar i");
    timeEl = el.querySelector(".mini-time");
    toggleBtn = el.querySelector(".mp-toggle");
    listBox = el.querySelector(".miniplaylist");

    toggleBtn.onclick = () => {
      if (!audio || !cur) return;
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
    };
    el.querySelector(".mp-prev").onclick = () => step(-1);
    el.querySelector(".mp-next").onclick = () => step(1);

    const shuffleBtn = el.querySelector(".mp-shuffle");
    shuffleBtn.onclick = () => {
      shuffle = !shuffle;
      shuffleBtn.classList.toggle("on", shuffle);
    };

    const repeatBtn = el.querySelector(".mp-repeat");
    repeatBtn.onclick = () => {
      repeat = repeat === "off" ? "all" : repeat === "all" ? "one" : "off";
      repeatBtn.classList.toggle("on", repeat !== "off");
      repeatBtn.textContent = repeat === "one" ? "↻¹" : "↻";
      repeatBtn.title = repeat === "one" ? "单曲循环"
        : repeat === "all" ? "列表循环" : "不循环";
    };

    el.querySelector(".mp-listbtn").onclick = (ev) => {
      ev.stopPropagation();
      listBox.hidden = !listBox.hidden;
      if (!listBox.hidden) renderList();
    };
    listBox.onclick = (ev) => ev.stopPropagation();
    document.addEventListener("click", () => { if (listBox) listBox.hidden = true; });

    el.querySelector(".mp-close").onclick = stop;

    el.querySelector(".mini-bar").onclick = (ev) => {
      if (!audio || !audio.duration) return;
      const r = ev.currentTarget.getBoundingClientRect();
      const pct = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      audio.currentTime = pct * audio.duration;
    };
  }

  function ensureAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = "metadata";
    audio.addEventListener("timeupdate", paint);
    audio.addEventListener("play", paint);
    audio.addEventListener("pause", paint);
    audio.addEventListener("ended", () => {
      if (repeat === "one") {
        audio.currentTime = 0;
        audio.play().catch(() => {});
        return;
      }
      const i = list.findIndex((t) => t.id === (cur && cur.id));
      const isLast = i === list.length - 1;
      if (isLast && repeat === "off") { paint(); return; }
      step(1);
    });
    return audio;
  }

  function paint() {
    if (!built || !cur) return;
    bar = bar || document.querySelector(".miniplayer");
    bar.hidden = false;

    titleEl.textContent = cur.title || "未命名曲目";
    const d = audio && audio.duration ? audio.duration : 0;
    const t = audio ? audio.currentTime : 0;
    fill.style.width = d ? `${(t / d) * 100}%` : "0%";
    timeEl.textContent = `${fmt(t)} / ${fmt(d)}`;
    toggleBtn.innerHTML = audio && !audio.paused ? ICON_PAUSE : ICON_PLAY;

    const now = Date.now();
    if (now - saveAt > 900) {
      saveAt = now;
      save();
    }
  }

  function save(playing) {
    if (!cur) return;
    try {
      sessionStorage.setItem(KEY, JSON.stringify({
        id: cur.id,
        title: cur.title,
        filename: cur.filename,
        time: audio ? audio.currentTime : 0,
        playing: playing !== undefined ? playing : !!(audio && !audio.paused),
        list,
      }));
    } catch { /* 忽略 */ }
  }

  function step(delta) {
    if (!list.length) return;
    const i = list.findIndex((t) => t.id === (cur && cur.id));

    if (shuffle && list.length > 1) {
      let j = i;
      while (j === i) j = Math.floor(Math.random() * list.length);
      play(list[j], list);
      return;
    }

    const idx = ((i + delta) % list.length + list.length) % list.length;
    play(list[idx], list);
  }

  function play(item, items) {
    build();
    ensureAudio();

    if (Array.isArray(items) && items.length) {
      list = items.map((t) => ({ id: t.id, title: t.title, filename: t.filename }));
    }
    cur = { id: item.id, title: item.title, filename: item.filename };

    audio.src = `/media/tracks/${encodeURIComponent(item.filename)}`;
    audio.play().then(paint).catch(() => paint());
    paint();
    save(true);
  }

  function stop() {
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
    }
    cur = null;
    list = [];
    try { sessionStorage.removeItem(KEY); } catch { /* 忽略 */ }
    if (built) bar.hidden = true;
  }

  function renderList() {
    listBox.textContent = "";
    list.forEach((t, i) => {
      const b = document.createElement("button");
      b.type = "button";
      if (cur && t.id === cur.id) b.className = "on";

      const idx = document.createElement("span");
      idx.className = "idx";
      idx.textContent = String(i + 1);

      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = t.title || "未命名曲目";

      b.append(idx, nm);
      b.onclick = (ev) => { ev.stopPropagation(); play(t, list); };
      listBox.appendChild(b);
    });
  }

  function restore() {
    let s = null;
    try { s = JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { /* 忽略 */ }
    if (!s || !s.filename) return;

    build();
    ensureAudio();

    list = Array.isArray(s.list) ? s.list : [];
    cur = { id: s.id, title: s.title, filename: s.filename };
    audio.src = `/media/tracks/${encodeURIComponent(s.filename)}`;

    audio.addEventListener("loadedmetadata", () => {
      if (s.time) { try { audio.currentTime = s.time; } catch { /* 忽略 */ } }
      if (s.playing) audio.play().catch(() => { /* 等用户点 */ });
      paint();
    }, { once: true });

    paint();
  }

  window.MiniPlayer = { play, restore, stop };
})();
