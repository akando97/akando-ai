/* AKANDO AI student chat — frontend logic */
const $ = (id) => document.getElementById(id);
const state = { user: null, chats: [], activeChat: null, lastMsgId: 0, pollTimer: null };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("Error " + res.status));
  return data;
}

function show(viewId) {
  ["view-login", "view-register", "view-chat", "view-admin"].forEach((v) =>
    $(v).classList.add("hidden")
  );
  $(viewId).classList.remove("hidden");
}

function errBox(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.classList.remove("hidden");
}

/* ---------------- auth ---------------- */
async function boot() {
  try {
    const d = await api("/api/me");
    state.user = d.user;
    enterChat();
  } catch (e) {
    show("view-login");
  }
}

$("btn-login").onclick = async () => {
  try {
    const d = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ mobile: $("login-mobile").value, password: $("login-password").value }),
    });
    state.user = d.user;
    enterChat();
  } catch (e) { errBox("login-err", e.message); }
};

$("btn-register").onclick = async () => {
  try {
    const d = await api("/api/register", {
      method: "POST",
      body: JSON.stringify({
        name: $("reg-name").value, mobile: $("reg-mobile").value, password: $("reg-password").value,
      }),
    });
    $("reg-ok").textContent = d.message;
    $("reg-ok").classList.remove("hidden");
    $("reg-err").classList.add("hidden");
  } catch (e) { errBox("reg-err", e.message); }
};

$("link-register").onclick = (e) => { e.preventDefault(); show("view-register"); };
$("link-login").onclick = (e) => { e.preventDefault(); show("view-login"); };
$("link-logout").onclick = async (e) => {
  e.preventDefault();
  await api("/api/logout", { method: "POST" }).catch(() => {});
  state.user = null; state.activeChat = null;
  stopPolling(); show("view-login");
};

/* ---------------- chat ---------------- */
function enterChat() {
  show("view-chat");
  $("user-label").textContent = state.user.name;
  $("admin-link-row").classList.toggle("hidden", !state.user.is_admin);
  loadChats();
}

async function loadChats() {
  const d = await api("/api/chats").catch(() => ({ chats: [] }));
  state.chats = d.chats || [];
  renderChatList();
  if (!state.activeChat && state.chats.length) openChat(state.chats[0].id);
  if (!state.chats.length) {
    $("messages").innerHTML =
      `<div class="welcome"><div class="big">🤖</div><b>Hello, ${esc(state.user.name)}!</b><br>I'm <b>AKANDO AI</b> — your AI mentor.<br>Tap "＋ New chat" to start chatting. 💬</div>`;
    $("chat-title").textContent = "AKANDO AI Chat";
  }
}

function renderChatList() {
  const el = $("chat-list");
  el.innerHTML = state.chats.length
    ? "" : `<div class="chat-empty">No chats yet.</div>`;
  state.chats.forEach((c) => {
    const div = document.createElement("div");
    div.className = "chat-item" + (c.id === state.activeChat ? " active" : "");
    div.textContent = c.title;
    div.onclick = () => { openChat(c.id); $("sidebar").classList.remove("open"); };
    el.appendChild(div);
  });
}

$("btn-new-chat").onclick = async () => {
  const d = await api("/api/chats", { method: "POST", body: JSON.stringify({}) });
  state.chats.unshift(d.chat);
  renderChatList();
  openChat(d.chat.id);
  $("sidebar").classList.remove("open");
};

$("btn-side-open").onclick = () => $("sidebar").classList.add("open");
$("btn-side-close").onclick = () => $("sidebar").classList.remove("open");

function openChat(id) {
  state.activeChat = id;
  state.lastMsgId = 0;
  const c = state.chats.find((x) => x.id === id);
  $("chat-title").textContent = c ? c.title : "AKANDO AI Chat";
  $("messages").innerHTML = "";
  renderChatList();
  startPolling();
  pollMessages();
}

function esc(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function addMsg(m) {
  const wrap = $("messages");
  const welcome = wrap.querySelector(".welcome");
  if (welcome) welcome.remove();
  const div = document.createElement("div");
  div.className = "msg " + (m.role === "user" ? "user" : "ai");
  div.dataset.mid = m.id;
  div.innerHTML = esc(m.text) +
    (m.role === "user" && !m.delivered ? `<span class="pending-mark">⏳ AKANDO AI is replying…</span>` : "");
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

function updateTyping(msgs) {
  // Show the typing indicator while the newest user message has no reply yet.
  let waiting = false;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") break;
    if (msgs[i].role === "user" && !msgs[i].delivered) { waiting = true; break; }
  }
  $("typing").classList.toggle("hidden", !waiting);
}

async function pollMessages() {
  if (!state.activeChat) return;
  try {
    const d = await api(`/api/chats/${state.activeChat}/messages?after=${state.lastMsgId}`);
    const msgs = d.messages || [];
    if (msgs.length) {
      // If we re-fetched, easiest is a full refresh of the visible window.
      if (state.lastMsgId === 0) { $("messages").innerHTML = ""; msgs.forEach(addMsg); }
      else msgs.forEach(addMsg);
      state.lastMsgId = msgs[msgs.length - 1].id;
      // Refresh delivered flags (a reply may have landed for an older user msg).
      const all = await api(`/api/chats/${state.activeChat}/messages?after=0`);
      refreshDelivered(all.messages || []);
      updateTyping(all.messages || []);
    } else {
      updateTyping(await currentMessages());
    }
  } catch (e) { /* poll quietly fails; next tick retries */ }
}

async function currentMessages() {
  try {
    const d = await api(`/api/chats/${state.activeChat}/messages?after=0`);
    return d.messages || [];
  } catch (e) { return []; }
}

function refreshDelivered(msgs) {
  const byId = {};
  msgs.forEach((m) => (byId[m.id] = m));
  document.querySelectorAll("#messages .msg").forEach((el) => {
    const m = byId[el.dataset.mid];
    if (m && m.role === "user" && m.delivered) {
      const mark = el.querySelector(".pending-mark");
      if (mark) mark.remove();
    }
  });
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(pollMessages, 2000);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function sendMessage() {
  const inp = $("msg-input");
  const text = inp.value.trim();
  if (!text || !state.activeChat) return;
  inp.value = "";
  const btn = $("btn-send");
  btn.disabled = true;
  try {
    const d = await api(`/api/chats/${state.activeChat}/messages`, {
      method: "POST", body: JSON.stringify({ text }),
    });
    addMsg(d.message);
    state.lastMsgId = Math.max(state.lastMsgId, d.message.id);
    pollMessages();
  } catch (e) { errBox("login-err", e.message); }
  finally { btn.disabled = false; }
}

$("btn-send").onclick = sendMessage;
$("msg-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage();
});

/* ---------------- admin ---------------- */
$("link-admin").onclick = (e) => { e.preventDefault(); stopPolling(); show("view-admin"); loadAdmin(); };
$("link-back-chat").onclick = (e) => { e.preventDefault(); enterChat(); };

function badge(st, isAdmin) {
  if (isAdmin) return `<span class="badge admin">ADMIN</span>`;
  const map = { pending: "PENDING", approved: "APPROVED", rejected: "REJECTED" };
  return `<span class="badge ${st}">${map[st] || st}</span>`;
}

async function loadAdmin() {
  let users = [];
  try { users = (await api("/api/admin/users")).users || []; }
  catch (e) { $("pending-list").innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const pend = users.filter((u) => u.status === "pending" && !u.is_admin);
  $("pending-list").innerHTML = pend.length ? "" : `<div class="chat-empty">No pending requests. ✅</div>`;
  pend.forEach((u) => {
    const div = document.createElement("div");
    div.className = "user-row-card";
    div.innerHTML = `<div class="info"><div class="nm">${esc(u.name)}</div>
      <div class="mb">${esc(u.mobile)} · ${esc((u.created_at || "").slice(0, 16).replace("T", " "))}</div></div>
      ${badge(u.status, u.is_admin)}
      <button class="btn-sm btn-approve">Approve ✓</button>
      <button class="btn-sm btn-reject">Reject ✕</button>`;
    div.querySelector(".btn-approve").onclick = async () => {
      await api(`/api/admin/users/${u.id}/approve`, { method: "POST" });
      loadAdmin();
    };
    div.querySelector(".btn-reject").onclick = async () => {
      if (confirm("Reject " + u.name + "?")) {
        await api(`/api/admin/users/${u.id}/reject`, { method: "POST" });
        loadAdmin();
      }
    };
    $("pending-list").appendChild(div);
  });
  $("users-list").innerHTML = "";
  users.forEach((u) => {
    const div = document.createElement("div");
    div.className = "user-row-card";
    div.innerHTML = `<div class="info"><div class="nm">${esc(u.name)}</div>
      <div class="mb">${esc(u.mobile)}</div></div>${badge(u.status, u.is_admin)}`;
    $("users-list").appendChild(div);
  });
}

$("btn-pw").onclick = async () => {
  try {
    const d = await api("/api/me/password", {
      method: "POST",
      body: JSON.stringify({ old: $("pw-old").value, new: $("pw-new").value }),
    });
    $("pw-ok").textContent = d.message;
    $("pw-ok").classList.remove("hidden");
    $("pw-err").classList.add("hidden");
    $("pw-old").value = $("pw-new").value = "";
  } catch (e) { errBox("pw-err", e.message); }
};

boot();
