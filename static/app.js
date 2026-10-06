/* AKANDO AI — student chat frontend (dependency-free) */
const $ = (id) => document.getElementById(id);
const state = {
  user: null, chats: [], activeChat: null,
  lastMsgId: 0, pollTimer: null, search: "",
  pendingFile: null, // {file: File, previewUrl: string|null}
};

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

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function fileIcon(mime) {
  if ((mime || "").startsWith("image/")) return "🖼️";
  if (mime === "application/pdf") return "📄";
  return "📎";
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
      body: JSON.stringify({ mobile: $("login-mobile").value.trim(), password: $("login-password").value }),
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
        name: $("reg-name").value.trim(),
        mobile: $("reg-mobile").value.trim(),
        password: $("reg-password").value,
      }),
    });
    $("reg-ok").textContent = d.message;
    $("reg-ok").classList.remove("hidden");
    $("reg-err").classList.add("hidden");
  } catch (e) { errBox("reg-err", e.message); }
};

$("link-register").onclick = (e) => { e.preventDefault(); show("view-register"); };
$("link-login").onclick = (e) => { e.preventDefault(); show("view-login"); };

async function doLogout() {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  state.user = null; state.activeChat = null; state.chats = [];
  state.pendingFile = null;
  stopPolling(); closeUserMenu(); show("view-login");
}

/* ---------------- chat list: search + time groups ---------------- */
function chatGroup(createdAt) {
  const d = new Date(createdAt);
  if (isNaN(d)) return "Older";
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff <= 7) return "Previous 7 days";
  return "Older";
}
const GROUP_ORDER = ["Today", "Yesterday", "Previous 7 days", "Older"];

function enterChat() {
  show("view-chat");
  const name = state.user.name || "";
  $("user-label").textContent = name;
  $("user-avatar").textContent = (name.trim()[0] || "?").toUpperCase();
  $("menu-admin").classList.toggle("hidden", !state.user.is_admin);
  closeSidebar();
  loadChats();
}

async function loadChats() {
  const d = await api("/api/chats").catch(() => ({ chats: [] }));
  state.chats = d.chats || [];
  renderChatList();
  if (!state.activeChat && state.chats.length) openChat(state.chats[0].id);
  if (!state.chats.length && !state.activeChat) { stopPolling(); renderWelcome(); }
}

function renderChatList() {
  const el = $("chat-list");
  el.innerHTML = "";
  const q = state.search.trim().toLowerCase();
  const filtered = state.chats.filter((c) =>
    !q || (c.title || "").toLowerCase().includes(q));
  if (!state.chats.length) {
    el.innerHTML = `<div class="chat-empty">No chats yet.<br>Start a new conversation.</div>`;
    return;
  }
  if (!filtered.length) {
    el.innerHTML = `<div class="chat-empty">No chats match your search.</div>`;
    return;
  }
  const groups = {};
  filtered.forEach((c) => {
    const g = chatGroup(c.created_at);
    (groups[g] = groups[g] || []).push(c);
  });
  GROUP_ORDER.forEach((g) => {
    const list = groups[g];
    if (!list || !list.length) return;
    const label = document.createElement("div");
    label.className = "chat-group-label";
    label.textContent = g;
    el.appendChild(label);
    list.forEach((c) => el.appendChild(chatItemEl(c)));
  });
}

function chatItemEl(c) {
  const div = document.createElement("div");
  div.className = "chat-item" + (c.id === state.activeChat ? " active" : "");
  const label = document.createElement("span");
  label.className = "chat-item-title";
  label.textContent = c.title;
  const actions = document.createElement("span");
  actions.className = "chat-actions";
  const rn = document.createElement("button");
  rn.className = "icon-mini"; rn.title = "Rename chat"; rn.textContent = "✎";
  rn.onclick = (e) => { e.stopPropagation(); renameChat(c); };
  const del = document.createElement("button");
  del.className = "icon-mini danger"; del.title = "Delete chat"; del.textContent = "🗑";
  del.onclick = (e) => { e.stopPropagation(); deleteChat(c); };
  actions.append(rn, del);
  div.append(label, actions);
  div.onclick = () => { openChat(c.id); closeSidebar(); };
  return div;
}

$("chat-search").addEventListener("input", (e) => {
  state.search = e.target.value;
  renderChatList();
});

async function createChat() {
  const d = await api("/api/chats", { method: "POST", body: JSON.stringify({}) });
  state.chats.unshift(d.chat);
  renderChatList();
  openChat(d.chat.id);
  closeSidebar();
  return d.chat;
}

$("btn-new-chat").onclick = () => { createChat().catch((e) => alert(e.message)); };

async function renameChat(c) {
  const t = prompt("Rename chat:", c.title);
  if (t === null) return;
  const title = t.trim().slice(0, 60);
  if (!title || title === c.title) return;
  try {
    const d = await api(`/api/chats/${c.id}`, {
      method: "PATCH", body: JSON.stringify({ title }),
    });
    c.title = d.chat.title;
    renderChatList();
  } catch (e) { alert(e.message); }
}

async function deleteChat(c) {
  if (!confirm(`Delete "${c.title}"? This cannot be undone.`)) return;
  try {
    await api(`/api/chats/${c.id}`, { method: "DELETE" });
    state.chats = state.chats.filter((x) => x.id !== c.id);
    if (c.id === state.activeChat) {
      state.activeChat = null; state.lastMsgId = 0;
      stopPolling();
      if (state.chats.length) openChat(state.chats[0].id);
      else { renderChatList(); renderWelcome(); }
    } else {
      renderChatList();
    }
  } catch (e) { alert(e.message); }
}

function openSidebar() {
  $("sidebar").classList.add("open");
  $("side-backdrop").classList.add("show");
}
function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("side-backdrop").classList.remove("show");
}
$("btn-side-open").onclick = openSidebar;
$("btn-side-close").onclick = closeSidebar;
$("side-backdrop").onclick = closeSidebar;

function openChat(id) {
  state.activeChat = id;
  state.lastMsgId = 0;
  renderChatList();
  startPolling();
  pollMessages(true);
}

/* ---------------- user menu ---------------- */
function closeUserMenu() { $("user-menu").classList.add("hidden"); }
$("user-row").onclick = (e) => {
  e.stopPropagation();
  $("user-menu").classList.toggle("hidden");
};
document.addEventListener("click", (e) => {
  if (!$("user-menu").classList.contains("hidden") &&
      !$("user-menu-wrap").contains(e.target)) closeUserMenu();
});
$("menu-logout").onclick = (e) => { e.preventDefault(); doLogout(); };
$("menu-admin").onclick = (e) => {
  e.preventDefault(); closeUserMenu(); stopPolling(); show("view-admin"); loadAdmin();
};
$("menu-password").onclick = (e) => {
  e.preventDefault(); closeUserMenu(); openPwModal();
};
$("link-back-chat").onclick = (e) => { e.preventDefault(); enterChat(); };

/* ---------------- welcome ---------------- */
const SUGGESTIONS = [
  ["Ask about freelancing", "How do I start freelancing with AI skills?"],
  ["Content ideas", "Give me content ideas for my YouTube channel"],
  ["Video script help", "Help me write a video script"],
  ["Study help", "Explain a difficult topic simply"],
];

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function renderWelcome() {
  $("typing").classList.add("hidden");
  const first = (state.user.name || "").trim().split(/\s+/)[0] || "there";
  $("messages").innerHTML =
    `<div class="welcome"><img class="avatar avatar-welcome" src="/static/avatar.png" alt="AKANDO AI">` +
    `<h1>${esc(greeting())}, ${esc(first)}</h1>` +
    `<p>I'm <b>AKANDO AI</b> — your AI mentor. What would you like to work on today?</p>` +
    `<div class="chips">` +
    SUGGESTIONS.map(([label, q]) =>
      `<button class="chip" data-q="${esc(q)}">${esc(label)}</button>`).join("") +
    `</div></div>`;
  $("messages").querySelectorAll(".chip").forEach((ch) => {
    ch.onclick = async () => {
      try {
        if (!state.activeChat) await createChat();
        $("msg-input").value = ch.dataset.q;
        autoGrow();
        $("msg-input").focus();
      } catch (e) { /* leave composer alone */ }
    };
  });
}

/* ---------------- messages ---------------- */
function attachmentHtml(att) {
  if (!att || !att.url) return "";
  const url = esc(att.url), name = esc(att.name || "file"), size = esc(formatSize(att.size));
  const mime = att.mime || "";
  if (mime.startsWith("image/")) {
    return `<div class="attach"><a href="${url}" target="_blank" rel="noopener">` +
      `<img class="attach-img" src="${url}" alt="${name}" loading="lazy"></a></div>`;
  }
  return `<div class="attach"><a class="file-card" href="${url}" target="_blank" rel="noopener" download>` +
    `<span class="file-icon">${fileIcon(mime)}</span>` +
    `<span class="file-meta"><span class="file-name">${name}</span><br>` +
    `<span class="file-size">${size}</span></span>` +
    `<span class="file-dl">⬇</span></a></div>`;
}

function addMsg(m) {
  const wrap = $("messages");
  const welcome = wrap.querySelector(".welcome");
  if (welcome) welcome.remove();
  const div = document.createElement("div");
  div.className = "msg " + (m.role === "user" ? "user" : "ai");
  div.dataset.mid = m.id;
  if (m.role === "user") {
    div.innerHTML = esc(m.text) + attachmentHtml(m.attachment) +
      (!m.delivered ? `<span class="pending-mark">AKANDO AI is replying…</span>` : "");
  } else {
    div.innerHTML =
      `<div class="ai-head"><img class="avatar avatar-msg" src="/static/avatar.png" alt=""><span class="ai-name">AKANDO AI</span></div>` +
      `<div class="ai-text">${esc(m.text)}${attachmentHtml(m.attachment)}</div>`;
  }
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

function updateTyping(msgs) {
  let waiting = false;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") break;
    if (msgs[i].role === "user" && !msgs[i].delivered) { waiting = true; break; }
  }
  $("typing").classList.toggle("hidden", !waiting);
}

async function pollMessages(full) {
  if (!state.activeChat) return;
  try {
    const d = await api(`/api/chats/${state.activeChat}/messages?after=${full ? 0 : state.lastMsgId}`);
    const msgs = d.messages || [];
    if (full || state.lastMsgId === 0) {
      $("messages").innerHTML = "";
      if (!msgs.length) { renderWelcome(); return; }
      msgs.forEach(addMsg);
    } else {
      msgs.forEach(addMsg);
    }
    if (msgs.length) state.lastMsgId = msgs[msgs.length - 1].id;
    const all = full ? msgs : await api(`/api/chats/${state.activeChat}/messages?after=0`).then((x) => x.messages || []);
    refreshDelivered(all);
    updateTyping(all);
  } catch (e) { /* poll quietly fails; next tick retries */ }
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
  state.pollTimer = setInterval(() => pollMessages(false), 2000);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

/* ---------------- composer + attachments ---------------- */
function autoGrow() {
  const t = $("msg-input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
}
$("msg-input").addEventListener("input", autoGrow);
$("msg-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

$("btn-attach").onclick = () => $("file-input").click();

$("file-input").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!f) return;
  if (f.size > 10 * 1024 * 1024) { alert("File too large (max 10MB)."); return; }
  const okType = f.type.startsWith("image/") ||
    ["application/pdf", "text/plain", "text/markdown"].includes(f.type) ||
    /\.(pdf|txt|md)$/i.test(f.name);
  if (!okType) { alert("Only images, PDF or text files are allowed."); return; }
  if (state.pendingFile && state.pendingFile.previewUrl) {
    URL.revokeObjectURL(state.pendingFile.previewUrl);
  }
  state.pendingFile = {
    file: f,
    previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
  };
  renderAttachPreview();
});

function renderAttachPreview() {
  const box = $("attach-preview");
  const p = state.pendingFile;
  if (!p) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  const f = p.file;
  const thumb = p.previewUrl
    ? `<img src="${esc(p.previewUrl)}" alt="">`
    : `<span class="file-icon">${fileIcon(f.type)}</span>`;
  box.innerHTML =
    `<div class="attach-chip">${thumb}` +
    `<span><span class="nm">${esc(f.name)}</span><br><span class="sz">${esc(formatSize(f.size))}</span></span>` +
    `<button class="rm" id="attach-rm" aria-label="Remove file">✕</button></div>`;
  box.classList.remove("hidden");
  $("attach-rm").onclick = clearPendingFile;
}

function clearPendingFile() {
  if (state.pendingFile && state.pendingFile.previewUrl) {
    URL.revokeObjectURL(state.pendingFile.previewUrl);
  }
  state.pendingFile = null;
  renderAttachPreview();
}

async function uploadPendingFile() {
  const p = state.pendingFile;
  if (!p) return null;
  const fd = new FormData();
  fd.append("file", p.file, p.file.name);
  const res = await fetch("/api/upload", { method: "POST", credentials: "include", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("Upload failed (" + res.status + ")"));
  return data.file; // {name, url, mime, size}
}

async function sendMessage() {
  const inp = $("msg-input");
  const text = inp.value.trim();
  const hasFile = !!state.pendingFile;
  if (!text && !hasFile) return;
  const btn = $("btn-send");
  btn.disabled = true;
  try {
    if (!state.activeChat) await createChat();
  } catch (e) { btn.disabled = false; alert(e.message); return; }
  try {
    let attachment = null;
    if (hasFile) attachment = await uploadPendingFile();
    const d = await api(`/api/chats/${state.activeChat}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, attachment }),
    });
    inp.value = ""; autoGrow();
    clearPendingFile();
    addMsg(d.message);
    state.lastMsgId = Math.max(state.lastMsgId, d.message.id);
    startPolling(); // ensure polling runs (a fresh chat's welcome state stops nothing now, but be safe)
    updateTyping(await api(`/api/chats/${state.activeChat}/messages?after=0`).then((x) => x.messages || []).catch(() => []));
  } catch (e) { alert(e.message); }
  finally { btn.disabled = false; }
}

$("btn-send").onclick = sendMessage;

/* ---------------- password modal ---------------- */
function openPwModal() {
  $("pw-modal-old").value = $("pw-modal-new").value = "";
  $("pw-modal-err").classList.add("hidden");
  $("pw-modal-ok").classList.add("hidden");
  $("pw-modal").classList.remove("hidden");
}
function closePwModal() { $("pw-modal").classList.add("hidden"); }
$("btn-pw-modal-cancel").onclick = closePwModal;
$("pw-modal").addEventListener("click", (e) => {
  if (e.target === $("pw-modal") ) closePwModal();
});
$("btn-pw-modal-save").onclick = () => changePassword("pw-modal-old", "pw-modal-new", "pw-modal-err", "pw-modal-ok");

async function changePassword(oldId, newId, errId, okId) {
  try {
    const d = await api("/api/me/password", {
      method: "POST",
      body: JSON.stringify({ old: $(oldId).value, new: $(newId).value }),
    });
    $(okId).textContent = d.message;
    $(okId).classList.remove("hidden");
    $(errId).classList.add("hidden");
    $(oldId).value = $(newId).value = "";
  } catch (e) { errBox(errId, e.message); }
}

/* ---------------- admin ---------------- */
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
  $("pending-list").innerHTML = "";
  if (!pend.length) $("pending-list").innerHTML = `<div class="chat-empty">No pending requests.</div>`;
  pend.forEach((u) => {
    const div = document.createElement("div");
    div.className = "user-row-card";
    div.innerHTML = `<div class="info"><div class="nm">${esc(u.name)}</div>
      <div class="mb">${esc(u.mobile)} · ${esc((u.created_at || "").slice(0, 16).replace("T", " "))}</div></div>
      ${badge(u.status, u.is_admin)}
      <button class="btn-sm btn-approve">Approve</button>
      <button class="btn-sm btn-reject">Reject</button>`;
    div.querySelector(".btn-approve").onclick = async () => {
      try { await api(`/api/admin/users/${u.id}/approve`, { method: "POST" }); }
      catch (e) { alert(e.message); return; }
      loadAdmin();
    };
    div.querySelector(".btn-reject").onclick = async () => {
      if (confirm("Reject " + u.name + "?")) {
        try { await api(`/api/admin/users/${u.id}/reject`, { method: "POST" }); }
        catch (e) { alert(e.message); return; }
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
      <div class="mb">${esc(u.mobile)}</div></div>${badge(u.status, u.is_admin)}` +
      (!u.is_admin ? `<button class="btn-sm btn-reject">Remove</button>` : "");
    const rmBtn = div.querySelector(".btn-reject");
    if (rmBtn) {
      rmBtn.onclick = async () => {
        if (confirm(`Remove ${u.name}? This deletes their account and all their chats.`)) {
          try { await api(`/api/admin/users/${u.id}`, { method: "DELETE" }); }
          catch (e) { alert(e.message); return; }
          loadAdmin();
        }
      };
    }
    $("users-list").appendChild(div);
  });
}

$("btn-pw").onclick = () => changePassword("pw-old", "pw-new", "pw-err", "pw-ok");

boot();
