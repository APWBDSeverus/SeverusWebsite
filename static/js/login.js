/* 登录 / 注册 */

const $ = (id) => document.getElementById(id);
let mode = "login";

const next = (() => {
  const raw = new URLSearchParams(location.search).get("next") || "/";
  // 只允许站内路径，避免开放重定向
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
})();

function setMode(m) {
  mode = m;
  const isLogin = m === "login";
  $("tab-login").classList.toggle("on", isLogin);
  $("tab-register").classList.toggle("on", !isLogin);
  $("title").textContent = isLogin ? "登录" : "注册";
  $("lead").textContent = isLogin
    ? "登录后可以发言，也会被记进访客簿。"
    : "注册一个名字，就能在聚落里留下痕迹。";
  $("submit").textContent = isLogin ? "登录" : "注册";
  $("password").autocomplete = isLogin ? "current-password" : "new-password";
  setMsg("");
}

function setMsg(text, kind = "err") {
  const el = $("msg");
  el.textContent = text;
  el.className = "msg" + (text ? " " + kind : "");
}

async function submit(ev) {
  ev.preventDefault();
  const username = $("username").value.trim();
  const password = $("password").value;

  if (!username || !password) {
    setMsg("用户名和密码都要填");
    return;
  }

  const btn = $("submit");
  btn.disabled = true;
  setMsg("");

  try {
    const res = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || "操作失败");
    }
    setMsg(mode === "login" ? "登录成功，正在进入…" : "注册成功，正在进入…", "ok");
    location.replace(next);
  } catch (e) {
    setMsg(e.message);
    btn.disabled = false;
  }
}

$("tab-login").onclick = () => setMode("login");
$("tab-register").onclick = () => setMode("register");
$("form").onsubmit = submit;

// 申请加入
$("to-apply").onclick = (ev) => {
  ev.preventDefault();
  $("form").hidden = true;
  $("apply-form").hidden = false;
  $("ap-user").focus();
};
$("to-login").onclick = (ev) => {
  ev.preventDefault();
  $("apply-form").hidden = true;
  $("form").hidden = false;
};

$("apply-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const username = $("ap-user").value.trim();
  const password = $("ap-pass").value;
  const note = $("ap-note").value.trim();
  const box = $("ap-msg");
  const btn = ev.target.querySelector('button[type="submit"]');

  if (btn && btn.disabled) return;          // 已经在提交了

  box.className = "msg";
  box.textContent = "";

  if (btn) {
    btn.disabled = true;
    btn.textContent = "提交中…";
  }

  try {
    const res = await fetch("/api/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: JSON.stringify({ username, password, note }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || "提交失败");
    box.className = "msg ok";
    box.textContent = "管理员已接收你的申请，通过后就能用这个账号登录";
    if (btn) btn.textContent = "已提交";
    $("ap-user").value = "";
    $("ap-pass").value = "";
    $("ap-note").value = "";
  } catch (e) {
    box.className = "msg err";
    box.textContent = e.message;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "提交申请";
    }
  }
};

// /login?tab=register 直接进注册
if (new URLSearchParams(location.search).get("tab") === "register") {
  setMode("register");
}

// 已登录就直接跳走
fetch("/api/me", { headers: { "X-Requested-With": "fetch" } })
  .then((r) => r.json())
  .then((d) => { if (d && d.user) location.replace(next); })
  .catch(() => {});


// 站点开了申请制（或关了注册）时，把「注册」标签换成「申请」
fetch("/api/me", { headers: { "X-Requested-With": "fetch" } })
  .then((r) => r.json())
  .then((d) => {
    if (!d) return;
    const closed = d.allow_register !== "1";
    const applyMode = d.apply_mode === "1";
    if (!closed && !applyMode) return;

    const tab = document.getElementById("tab-register");
    if (tab) {
      tab.textContent = "申请";
      tab.onclick = () => {
        document.getElementById("form").hidden = true;
        document.getElementById("apply-form").hidden = false;
        document.getElementById("ap-user").focus();
      };
    }
  })
  .catch(() => {});
