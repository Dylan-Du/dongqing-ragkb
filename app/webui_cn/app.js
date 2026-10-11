/* AI 外脑 · 知识库 OS —— 前端逻辑（纯原生 JS，无依赖） */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const chatLog = $("#chat-log");
const askBtn = $("#ask");
const qBox = $("#q");

let apiKey = localStorage.getItem("kb_api_key") || "";
let currentView = "dash";
let currentCat = "all";
let docsCache = [];
let countsCache = {};

/* ── 通用请求 ─────────────────────── */
function headers(extra = {}) {
  const h = { ...extra };
  if (apiKey) h["Authorization"] = "Bearer " + apiKey;
  return h;
}
async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: headers(options.headers || {}) });
  if (res.status === 401 || res.status === 403) {
    openSettings("服务端要求鉴权，请填写 API 口令");
    throw new Error("需要鉴权");
  }
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).detail || ""; } catch { /* ignore */ }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res;
}

/* ── 极简 Markdown 渲染 ───────────── */
function stripThink(text) {
  let t = String(text).replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = t.indexOf("<think>");
  if (open !== -1) t = t.slice(0, open) + "🤔 思考中…";
  return t;
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function renderMd(text) {
  const blocks = [];
  text = String(text).replace(/```([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${escapeHtml(code.replace(/^\w*\n/, ""))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  let html = escapeHtml(text)
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h2>$1</h2>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/^\s*[-*] (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>")
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
  html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  return html;
}

/* ── 视图切换 ─────────────────────── */
const VIEW_NAMES = { dash: "总览驾驶舱", chat: "对话问答", assets: "知识资产库", graph: "知识图谱", models: "模型接入" };
function showView(name) {
  currentView = name;
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.nav === name));
  ["dash", "chat", "assets", "graph", "models"].forEach((v) => {
    $(`#view-${v}`).hidden = v !== name;
  });
  $("#page-title").textContent = VIEW_NAMES[name];
  if (name === "dash" || name === "chat") refreshStats();
  if (name === "assets") loadDocs().then(renderAssets);
  if (name === "models") loadModelsForm();
  if (name === "graph") { gResize(); if (!G.loaded) loadGraphData(); }
}
$("#side-nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-item");
  if (btn) showView(btn.dataset.nav);
});
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-goto]");
  if (go) { showView(go.dataset.goto); return; }
  const promptItem = e.target.closest("[data-ask]");
  if (promptItem) {
    showView("chat");
    qBox.value = promptItem.dataset.ask;
    qBox.focus();
    ask(qBox.value);
  }
});

/* ── 健康徽章 + 知识库统计 ─────────── */
async function loadHealth() {
  const badge = $("#badge-health"), st = $("#kb-status-line");
  try {
    const d = await (await api("/health")).json();
    badge.className = "badge ok";
    badge.innerHTML = '<i class="dot"></i>服务正常';
    const m = $("#badge-model");
    m.hidden = false;
    m.textContent = `${d.configuration?.llm_model || "?"} · ${d.configuration?.embedding_model || "?"}`;
    const v = $("#badge-vdb"), vdb = d.configuration?.vector_storage || "";
    v.hidden = false;
    if (vdb.includes("Milvus")) {
      v.className = "badge ok";
      v.innerHTML = '<i class="dot"></i>Milvus 向量库';
    } else {
      v.className = "badge warn";
      v.innerHTML = `<i class="dot"></i>向量库：${vdb}`;
    }
    st.className = "kb-status ok";
    st.innerHTML = '<i class="dot"></i>LightRAG 已连接';
  } catch {
    badge.className = "badge err";
    badge.innerHTML = '<i class="dot"></i>服务未连接';
    st.className = "kb-status err";
    st.innerHTML = '<i class="dot"></i>连接失败';
  }
}

let statsTimer = null;
async function refreshStats() {
  const jobs = [
    loadHealth(),
    loadDocs().then(() => renderStats()),
  ];
  // 图谱实体 / 关系数量
  try {
    const g = await (await api("/graphs?label=*")).json();
    statsTimer && clearTimeout(statsTimer);
    statsTimer = null;
    const en = (g.nodes || []).length, re = (g.edges || []).length;
    $("#st-entities").textContent = en;
    $("#st-relations").textContent = re;
    $("#kb-entities").textContent = en;
    $("#kb-relations").textContent = re;
    $("#co-entities").textContent = en;
    $("#co-relations").textContent = re;
  } catch { /* 图谱接口失败时保持 – */ }
  await Promise.allSettled(jobs);
}

function renderStats() {
  const counts = countsCache;
  const total = counts.all ?? docsCache.length;
  const ready = counts.processed || 0;
  const doing = (counts.processing || 0) + (counts.parsing || 0) + (counts.analyzing || 0) + (counts.pending || 0) + (counts.new || 0);
  const failed = counts.failed || 0;
  const pending = doing + failed;

  $("#st-docs").textContent = total;
  $("#st-docs-sub").textContent = `已就绪 ${ready} 篇`;
  $("#st-pending").textContent = pending;
  $("#st-pending-sub").textContent = failed ? `处理中 ${doing} / 失败 ${failed}` : `处理中 ${doing}`;
  $("#nav-doc-count").textContent = total || "";
  $("#kb-docs").textContent = total;
  $("#co-docs").textContent = total;
  $("#co-ready").textContent = ready;

  // 今日洞察
  const tips = [];
  if (failed > 0)
    tips.push(["warn", `有 <b>${failed} 篇文档入库失败</b> —— 多半是 .env 还没填模型 API Key；填好后 make server 重启会自动重试`]);
  if (doing > 0)
    tips.push(["hi", `正在入库 <b>${doing} 篇</b>：切片 → 抽实体 → 建图谱 → 向量化进 Milvus，稍等片刻`]);
  if (total === 0)
    tips.push(["", "资产库还是空的 —— 把 md / pdf / word 拖进「知识资产库」，外脑才能开始干活"]);
  else if (ready > 0)
    tips.push(["hi", `<b>${ready} 篇资料已就绪</b>，去「对话问答」试试它们的含金量，回答都会带出处`]);
  if (ready > 0 && ($("#st-entities").textContent === "–" || $("#st-entities").textContent === "0"))
    tips.push(["", "图谱还没有实体 —— 等文档全部处理完就会自动建立知识网络"]);
  if (ready >= 3)
    tips.push(["", "资料越多元谱越值钱：每天往 docs/ 丢一点，外脑会越来越懂你的业务"]);
  if (!tips.length) tips.push(["", "一切正常。去「对话问答」向你的外脑提个问题吧"]);
  $("#insight-list").innerHTML = tips
    .map(([cls, text]) => `<li class="${cls}">${text}</li>`).join("");

  // 最近入库（前 6 条）
  const recent = [...docsCache]
    .sort((a, b) => tsOf(b) - tsOf(a))
    .slice(0, 6);
  $("#recent-list").innerHTML = recent.length
    ? recent.map((d) => {
        const st = STATUS_MAP[d.status] || ["", "pending"];
        const cat = catOf(d);
        return `<li><span class="r-name" title="${escapeHtml(nameOf(d))}">${escapeHtml(nameOf(d))}</span>
          <span class="a-cat">${cat}</span><span class="st ${st[1]}">${st[0] || "待处理"}</span></li>`;
      }).join("")
    : '<li class="empty">还没有文档，去「知识资产库」上传一个吧</li>';
}

/* ── 文档数据 ─────────────────────── */
const STATUS_MAP = {
  processed: ["已就绪", "ok"],
  completed: ["已就绪", "ok"],
  preprocessed: ["已预处理", "ok"],
  parsing: ["解析中", "doing"],
  analyzing: ["分析中", "doing"],
  processing: ["处理中", "doing"],
  new: ["处理中", "doing"],
  pending: ["排队中", "pending"],
  failed: ["失败", "fail"],
};
const CATS = ["产品资产", "行业知识", "服务知识", "创作成果"];

function nameOf(d) { return d.file_path || d.summary || d.id || "未命名"; }
// 分类映射：入库时生成（文件名→业务分类），LightRAG 会把路径规范化成纯文件名
let catManifest = {};
fetch("/aiui/categories.json")
  .then((r) => (r.ok ? r.json() : {}))
  .then((m) => {
    catManifest = m || {};
    if (currentView === "assets") renderAssets();
    if (currentView === "dash") renderStats();
  })
  .catch(() => {});
function catOf(d) {
  const base = nameOf(d).split("/").pop();
  return catManifest[base] || "未分类";
}
function typeOf(d) {
  const m = /\.(\w+)$/.exec(nameOf(d));
  const ext = (m ? m[1] : "").toLowerCase();
  return { md: "MD", markdown: "MD", pdf: "PDF", docx: "DOCX", doc: "DOC", txt: "TXT" }[ext] || "FILE";
}
function tsOf(d) {
  const t = d.created_at || d.updated_at || 0;
  return typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t) || 0;
}
function fmtDate(d) {
  const t = tsOf(d);
  return t ? new Date(t).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) + " 入库" : "";
}

async function loadDocs() {
  try {
    const res = await api("/documents/paginated", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: 1, page_size: 200 }),
    });
    const data = await res.json();
    docsCache = data.documents || [];
    countsCache = data.status_counts || {};
  } catch (e) {
    if (e.message !== "需要鉴权") {
      $("#asset-grid").innerHTML = `<div class="empty" style="grid-column:1/-1">加载失败：${escapeHtml(e.message)}</div>`;
    }
  }
}

function renderAssets() {
  const grid = $("#asset-grid");
  // 一键重试按钮：有失败文档时显示
  const failed = countsCache.failed || 0;
  const retryBtn = $("#btn-retry-failed");
  retryBtn.hidden = failed === 0;
  retryBtn.innerHTML = `<svg class="ic sm"><use href="#i-refresh"/></svg>重试失败文档${failed ? ` (${failed})` : ""}`;
  const list = docsCache
    .filter((d) => currentCat === "all" || catOf(d) === currentCat)
    .sort((a, b) => tsOf(b) - tsOf(a));
  if (!list.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${docsCache.length ? "该分类下暂无资料" : "还没有文档，拖文件到上方或点「上传资料」"}</div>`;
    return;
  }
  grid.innerHTML = list.map((d) => {
    const st = STATUS_MAP[d.status] || ["待处理", "pending"];
    const size = d.content_len ? (d.content_len / 1024).toFixed(1) + " KB" : "";
    const chunks = d.chunks_count ? ` · ${d.chunks_count} 块` : "";
    const errTip = d.status === "failed" && d.error_msg ? ` title="${escapeHtml(String(d.error_msg).slice(0, 160))}"` : "";
    return `<div class="asset-card" data-id="${escapeHtml(d.id || "")}">
      <div class="a-top"><span class="a-cat">${catOf(d)}</span><span class="a-type">${typeOf(d)}</span></div>
      <div class="a-name" title="${escapeHtml(nameOf(d).replace(/^docs\//, ""))}">${escapeHtml(nameOf(d).replace(/^docs\//, ""))}</div>
      <div class="a-meta"><span>${fmtDate(d)}</span><span>${size}${chunks}</span></div>
      <div class="a-top"><span class="st ${st[1]}"${errTip}>${st[0] || "待处理"}</span>
        <button class="a-btn danger a-del" style="flex:none;padding:4px 12px"><svg class="ic sm"><use href="#i-trash"/></svg>删除</button></div>
    </div>`;
  }).join("");
}

$("#asset-grid").addEventListener("click", async (e) => {
  const btn = e.target.closest(".a-del");
  if (!btn) return;
  const card = btn.closest(".asset-card");
  const id = card?.dataset.id;
  if (!id || !confirm("确定删除这篇资料？将从知识库和向量库中移除。")) return;
  try {
    await api("/documents/delete_document", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
    });
    await loadDocs();
    renderAssets();
    renderStats();
  } catch (err) {
    if (err.message !== "需要鉴权") alert("删除失败：" + err.message);
  }
});
$("#cat-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".cat");
  if (!btn) return;
  currentCat = btn.dataset.cat;
  $$("#cat-tabs .cat").forEach((c) => c.classList.toggle("active", c === btn));
  renderAssets();
});

/* 上传 */
const dz = $("#dropzone");
dz.addEventListener("click", () => $("#file-input").click());
$("#btn-upload").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (e) => uploadFiles(e.target.files));
["dragover", "dragenter"].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
dz.addEventListener("drop", (e) => uploadFiles(e.dataTransfer.files));

async function uploadFiles(files) {
  if (!files || !files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  showView("assets");
  const grid = $("#asset-grid");
  const busy = document.createElement("div");
  busy.className = "empty";
  busy.style.gridColumn = "1/-1";
  busy.textContent = `正在上传 ${files.length} 个文件…`;
  grid.prepend(busy);
  try {
    await api("/documents/upload", { method: "POST", body: fd });
    busy.textContent = `✅ 已提交 ${files.length} 个文件，正在后台入库（抽实体 → 建图谱 → 向量化进 Milvus）`;
    pollWhileBusy();
  } catch (err) {
    busy.textContent = "❌ 上传失败：" + err.message;
    busy.classList.add("insight-warn");
  }
}
let pollTimer = null;
function pollWhileBusy() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    await loadDocs();
    renderAssets();
    renderStats();
    const busy = ["processing", "parsing", "analyzing", "pending", "new"].some((k) => countsCache[k] > 0);
    if (!busy) { clearInterval(pollTimer); pollTimer = null; }
  }, 3000);
}

/* ── 对话 ─────────────────────────── */
function addMsg(cls, contentHtml) {
  const el = document.createElement("div");
  el.className = "msg " + cls;
  el.innerHTML = contentHtml;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

async function ask(question) {
  if (!question.trim()) return;
  $(".chat-welcome")?.remove();
  addMsg("user", escapeHtml(question));
  qBox.value = "";
  askBtn.disabled = true;

  const mode = $("#mode").value;
  const onlyCtx = $("#only-ctx").checked;
  const bot = addMsg("bot", '<span class="cursor"></span>');

  try {
    if (onlyCtx) {
      const res = await api("/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: question, mode, only_need_context: true, user_prompt: "请用中文回答。" }),
      });
      const data = await res.json();
      bot.innerHTML = "<strong>📦 检索到的资料：</strong>" + renderMd(String(data.response ?? data));
    } else {
      const res = await api("/query/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: question, mode, stream: true, user_prompt: "请用中文回答。" }),
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          const s = line.trim().replace(/^data:\s?/, "");
          if (!s) continue;
          let piece = null;
          if (s.startsWith("{")) {
            try {
              const obj = JSON.parse(s);
              if (typeof obj.response === "string") piece = obj.response;
              // 其他 JSON 帧（如 references 元数据）直接跳过
            } catch { piece = s; }
          } else {
            piece = s;
          }
          if (typeof piece === "string") acc += piece;
        }
        bot.innerHTML = renderMd(stripThink(acc)) + '<span class="cursor"></span>';
        chatLog.scrollTop = chatLog.scrollHeight;
      }
      bot.innerHTML = renderMd(stripThink(acc));
      try {
        const dres = await api("/query/data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: question, mode }),
        });
        const inner = (await dres.json()).data || {};
        const seen = new Set();
        const files = [];
        for (const c of inner.chunks || []) {
          const fp = String(c.file_path || "").split("/").pop();
          if (fp && !seen.has(fp)) { seen.add(fp); files.push(fp); }
        }
        if (files.length) {
          bot.innerHTML = renderMd(stripThink(acc)) +
            `<div class="refs">📎 引用来源：${files.map((f) => `<span class="ref-file">${escapeHtml(f)}</span>`).join("")}</div>`;
        }
      } catch { /* 来源获取失败不影响回答 */ }
    }
  } catch (e) {
    if (e.message !== "需要鉴权") {
      bot.classList.add("err");
      bot.innerHTML = "❌ " + escapeHtml(e.message) +
        (/40[13]/.test(e.message) ? "<br>请检查 .env 里是否已填好模型 API Key，并 make server 重启。" : "");
    }
  } finally {
    askBtn.disabled = false;
    qBox.focus();
  }
}
askBtn.addEventListener("click", () => ask(qBox.value));
qBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(qBox.value); }
});
$("#scenes").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-q]");
  if (btn) ask(btn.dataset.q);
});

/* ── 模型连通性测试 ───────────────── */
async function testModelConn(kind) {
  const resBox = $(kind === "llm" ? "#test-llm-result" : "#test-emb-result");
  const pfx = kind === "llm" ? "llm" : "emb";
  resBox.textContent = "测试中…";
  resBox.className = "test-result";
  try {
    const res = await api("/aiui/test-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: kind,
        binding: $(`#${pfx}-binding`).value,
        host: $(`#${pfx}-host`).value,
        model: $(`#${pfx}-model`).value,
        api_key: $(`#${pfx}-key`).value,
      }),
    });
    const d = await res.json();
    if (d.ok) {
      if (kind === "emb") {
        $(`#emb-dim`).value = d.dim;
        resBox.textContent = `✅ 连通正常，向量维度 ${d.dim}（已自动填入）`;
      } else {
        resBox.textContent = `✅ 连通正常，模型回复：${d.reply}`;
      }
      resBox.className = "test-result ok";
    } else {
      resBox.textContent = "❌ " + d.error;
      resBox.className = "test-result err";
    }
  } catch (e) {
    resBox.textContent = "❌ " + e.message;
    resBox.className = "test-result err";
  }
}
$("#btn-test-llm").addEventListener("click", () => testModelConn("llm"));
$("#btn-test-emb").addEventListener("click", () => testModelConn("emb"));

/* ── 一键重试失败文档 ─────────────── */
let retryTimer = null;
$("#btn-retry-failed").addEventListener("click", async () => {
  const btn = $("#btn-retry-failed");
  btn.disabled = true;
  try {
    await api("/documents/reprocess_failed", { method: "POST" });
  } catch (e) {
    alert("重试请求失败：" + e.message);
    btn.disabled = false;
    return;
  }
  btn.textContent = "重试中…";
  if (retryTimer) clearInterval(retryTimer);
  let ticks = 0;
  retryTimer = setInterval(async () => {
    ticks++;
    try {
      const ps = await (await api("/documents/pipeline_status")).json();
      if (!ps.busy || ticks > 240) {
        clearInterval(retryTimer);
        retryTimer = null;
        btn.disabled = false;
      }
    } catch { /* ignore */ }
    await loadDocs();
    renderAssets();
    renderStats();
  }, 2500);
});

/* ── 知识图谱（自研 Canvas · Obsidian 风格力导向图）──────── */
const viewGraph = $("#view-graph");
const gc = $("#graph-canvas");
const gctx = gc.getContext("2d");

const TYPE_META = {
  method:       { name: "方法", color: "#3574db" },
  concept:      { name: "概念", color: "#8563c2" },
  artifact:     { name: "系统", color: "#239880" },
  organization: { name: "组织", color: "#c96597" },
  content:      { name: "内容", color: "#be922e" },
  data:         { name: "数据", color: "#4097b5" },
  person:       { name: "人物", color: "#cc6868" },
  location:     { name: "地点", color: "#659747" },
  event:        { name: "事件", color: "#cd8153" },
};
const TYPE_COLOR_FALLBACK = "#94a3b8";

const G = {
  nodes: [], edges: [], adj: new Map(),
  pos: new Map(), vel: new Map(),
  alpha: 0, zoom: 1, panX: 0, panY: 0,
  hoverId: null, selectId: null, dragNode: null,
  panning: false, panStart: null, dragMoved: 0,
  typeFilter: null, searchQ: "",
  loaded: false, loading: false, width: 0, height: 0,
  counts: { n: 0, e: 0 },
};

function gDegree(id) { return (G.adj.get(id) || []).length; }
function gColor(type) { return (TYPE_META[type] || {}).color || TYPE_COLOR_FALLBACK; }

async function loadGraphData() {
  if (G.loading) return;
  G.loading = true;
  const el = $("#graph-stats");
  el.textContent = "加载图谱数据…";
  try {
    const d = await (await api("/graphs?label=*")).json();
    G.nodes = (d.nodes || []).map((n) => ({
      id: n.id,
      label: (n.properties && n.properties.entity_id) || n.id,
      type: (n.properties && n.properties.entity_type) || "concept",
      desc: (n.properties && n.properties.description) || "",
      file: (n.properties && n.properties.file_path) || "",
    }));
    if (G.typeFilter && !G.nodes.some(n => n.type === G.typeFilter)) G.typeFilter = null;
    const ids = new Set(G.nodes.map(n => n.id));
    G.edges = (d.edges || []).map((e) => ({ s: e.source, t: e.target }))
      .filter(e => ids.has(e.s) && ids.has(e.t) && e.s !== e.t);
    G.pos.clear(); G.vel.clear();
    G.selectId = null; G.hoverId = null;
    $("#g-detail").hidden = true;
    G.adj = new Map();
    G.nodes.forEach((n) => G.adj.set(n.id, []));
    G.edges.forEach((e) => {
      if (G.adj.has(e.s)) G.adj.get(e.s).push(e.t);
      if (G.adj.has(e.t)) G.adj.get(e.t).push(e.s);
    });
    const N = G.nodes.length;
    G.nodes.forEach((n, i) => {
      const a = (i / N) * Math.PI * 2;
      const r = Math.max(180, Math.sqrt(N) * 25) + (i % 7) * 28;
      G.pos.set(n.id, {
        x: Math.cos(a) * r + (Math.random() - 0.5) * 50,
        y: Math.sin(a) * r + (Math.random() - 0.5) * 50,
      });
      G.vel.set(n.id, { x: 0, y: 0 });
    });
    G.loaded = true;
    heat(1);
    // Settle the initial layout before fitting, so nodes do not immediately
    // drift outside a viewport fitted to their seed positions.
    for (let i = 0; i < 40; i++) tick();
    gResize();
    zoomFit();
    renderLegend();
    updateGraphStatsLine();
    if (d.is_truncated) el.textContent += " · 当前显示部分图谱";
    $("#g-empty").hidden = N > 0;
  } catch (e) {
    el.textContent = "图谱加载失败：" + e.message;
  } finally {
    G.loading = false;
  }
}

function heat(v) { G.alpha = Math.max(G.alpha, v); }

function tick() {
  if (G.alpha < 0.002) return;
  const nodes = G.nodes, n = nodes.length, k = 78;
  const points = nodes.map(nd => G.pos.get(nd.id));
  const velocities = nodes.map(nd => G.vel.get(nd.id));
  const radii = nodes.map(nodeRadius);
  const alpha = G.alpha;
  for (let i = 0; i < n; i++) {
    const pa = points[i], va = velocities[i];
    for (let j = i + 1; j < n; j++) {
      const pb = points[j], vb = velocities[j];
      let dx = pa.x - pb.x, dy = pa.y - pb.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.01; }
      const d = Math.sqrt(d2);
      const spacing = radii[i] + radii[j] + 20;
      const collision = Math.max(0, spacing - d) * 0.15;
      const f = ((k * k) / d2 + collision) * alpha;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      va.x += fx; va.y += fy;
      vb.x -= fx; vb.y -= fy;
    }
  }
  for (const e of G.edges) {
    const pa = G.pos.get(e.s), pb = G.pos.get(e.t);
    if (!pa || !pb) continue;
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = (d - 155) / d * 0.035 * G.alpha;
    const fx = dx * f, fy = dy * f;
    G.vel.get(e.s).x += fx; G.vel.get(e.s).y += fy;
    G.vel.get(e.t).x -= fx; G.vel.get(e.t).y -= fy;
  }
  for (const nd of nodes) {
    const p = G.pos.get(nd.id), v = G.vel.get(nd.id);
    v.x += -p.x * 0.0006 * G.alpha;
    v.y += -p.y * 0.0006 * G.alpha;
    if (G.dragNode !== nd.id) { p.x += v.x * 0.9; p.y += v.y * 0.9; }
    v.x *= 0.86; v.y *= 0.86;
  }
  G.alpha *= 0.98;
}

function nodeRadius(nd) {
  return Math.min(4 + Math.sqrt(gDegree(nd.id)) * 2.4, 17);
}
function worldToScreen(wx, wy) {
  return { x: wx * G.zoom + G.panX, y: wy * G.zoom + G.panY };
}
function screenToWorld(sx, sy) {
  return { x: (sx - G.panX) / G.zoom, y: (sy - G.panY) / G.zoom };
}
function pickNode(mx, my) {
  let best = null, bestD = Infinity;
  for (const nd of G.nodes) {
    if (G.typeFilter && nd.type !== G.typeFilter) continue;
    if (G.searchQ.trim() && !nd.label.toLowerCase().includes(G.searchQ.trim().toLowerCase())) continue;
    const p = worldToScreen(G.pos.get(nd.id).x, G.pos.get(nd.id).y);
    const d = Math.hypot(p.x - mx, p.y - my);
    const r = Math.max(nodeRadius(nd) * G.zoom + 4, 9);
    if (d <= r && d < bestD) { best = nd; bestD = d; }
  }
  return best;
}

function focusSets() {
  const focusId = G.hoverId || G.selectId;
  let bright = null;
  if (focusId) bright = new Set([focusId, ...(G.adj.get(focusId) || [])]);
  const q = G.searchQ.trim().toLowerCase();
  let match = null;
  if (q) match = new Set(G.nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id));
  return { focusId, bright, match };
}

function nodeAlpha(nd, ctxSets) {
  const { focusId, bright, match } = ctxSets;
  if (match) return match.has(nd.id) ? 1 : 0.07;
  if (G.typeFilter && nd.type !== G.typeFilter) return 0.1;
  if (bright) return bright.has(nd.id) ? 1 : 0.12;
  return 1;
}

function render() {
  if (viewGraph.hidden) return;
  if (G.loaded) tick();
  gResize();
  const dpr = window.devicePixelRatio || 1;
  if (!G.width || !G.height) return;
  gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  gctx.clearRect(0, 0, G.width, G.height);
  if (!G.loaded) return;

  const cs = focusSets();
  const focusId = cs.focusId;
  const filteredIds = G.typeFilter ? new Set(G.nodes.filter(n => n.type === G.typeFilter).map(n => n.id)) : null;

  // 边
  for (const e of G.edges) {
    const pa = G.pos.get(e.s), pb = G.pos.get(e.t);
    if (!pa || !pb) continue;
    const a = worldToScreen(pa.x, pa.y), b = worldToScreen(pb.x, pb.y);
    if ((a.x < -50 && b.x < -50) || (a.x > G.width + 50 && b.x > G.width + 50)) continue;
    let alpha = 0.22, width = 1, color = "142,155,176";
    if (focusId && (e.s === focusId || e.t === focusId)) { alpha = 0.7; width = 1.6; color = "53,116,219"; }
    else if (focusId) alpha = 0.045;
    if (cs.match) alpha = cs.match.has(e.s) && cs.match.has(e.t) ? Math.max(alpha, 0.35) : 0.03;
    if (filteredIds && (!filteredIds.has(e.s) || !filteredIds.has(e.t))) alpha = 0.035;
    gctx.strokeStyle = `rgba(${color},${alpha})`;
    gctx.lineWidth = width;
    gctx.beginPath(); gctx.moveTo(a.x, a.y); gctx.lineTo(b.x, b.y); gctx.stroke();
  }

  // Nodes first, labels later: important labels get first claim on the space.
  const labels = [];
  for (const nd of G.nodes) {
    const p = G.pos.get(nd.id);
    const s = worldToScreen(p.x, p.y);
    if (s.x < -40 || s.x > G.width + 40 || s.y < -40 || s.y > G.height + 40) continue;
    const r = Math.max(nodeRadius(nd) * G.zoom, 2.5);
    const alpha = nodeAlpha(nd, cs);
    if (alpha <= 0.02) continue;
    const color = gColor(nd.type);
    const isFocus = cs.focusId === nd.id;
    gctx.globalAlpha = alpha;
    if (isFocus || G.hoverId === nd.id) {
      gctx.shadowColor = color; gctx.shadowBlur = 8;
    }
    gctx.fillStyle = color;
    gctx.beginPath(); gctx.arc(s.x, s.y, r, 0, Math.PI * 2); gctx.fill();
    gctx.shadowBlur = 0;
    if (r > 5) {
      gctx.strokeStyle = "rgba(255,255,255,0.9)"; gctx.lineWidth = 1.5;
      gctx.beginPath(); gctx.arc(s.x, s.y, r, 0, Math.PI * 2); gctx.stroke();
    }
    // 标签：聚焦邻居/搜索命中/大节点/缩放足够时显示
    const showLabel =
      (cs.bright && cs.bright.has(nd.id)) ||
      (cs.match && cs.match.has(nd.id)) ||
      gDegree(nd.id) >= 9 ||
      (G.zoom > 1.2 && r > 7);
    if (showLabel && alpha >= 0.5) labels.push({ nd, s, r, priority: isFocus ? 10000 : cs.match?.has(nd.id) ? 1000 : cs.bright?.has(nd.id) ? 500 : gDegree(nd.id) });
    gctx.globalAlpha = 1;
  }
  labels.sort((a, b) => b.priority - a.priority);
  const placed = [];
  const fs = Math.max(11, Math.min(13, 11 * G.zoom));
  gctx.font = `500 ${fs}px -apple-system, "PingFang SC", sans-serif`;
  gctx.textAlign = "center";
  for (const { nd, s, r, priority } of labels) {
    if (!cs.bright && !cs.match && placed.length >= 45) break;
    const width = gctx.measureText(nd.label).width + 12;
    const y = s.y - r - 7;
    const box = { left: s.x - width / 2, right: s.x + width / 2, top: y - fs - 3, bottom: y + 5 };
    if (priority < 10000 && placed.some(b => box.left < b.right && box.right > b.left && box.top < b.bottom && box.bottom > b.top)) continue;
    if (box.left < 4 || box.right > G.width - 4 || box.top < 4) continue;
    placed.push(box);
    gctx.lineWidth = 4; gctx.strokeStyle = "rgba(250,251,253,0.96)";
    gctx.strokeText(nd.label, s.x, y);
    gctx.fillStyle = nd.id === focusId ? "#245dc1" : "#475569";
    gctx.fillText(nd.label, s.x, y);
  }
}

function gResize() {
  const wrap = $("#graph-wrap");
  if (!wrap || !wrap.clientWidth || !wrap.clientHeight) return;
  const dpr = window.devicePixelRatio || 1;
  if (G.width && G.height) {
    G.panX += (wrap.clientWidth - G.width) / 2;
    G.panY += (wrap.clientHeight - G.height) / 2;
  }
  G.width = wrap.clientWidth; G.height = wrap.clientHeight;
  const width = Math.round(G.width * dpr), height = Math.round(G.height * dpr);
  if (gc.width !== width || gc.height !== height) { gc.width = width; gc.height = height; }
}
window.addEventListener("resize", gResize);

function zoomFit() {
  if (!G.nodes.length || !G.width || !G.height) return;
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const nd of G.nodes) {
    const p = G.pos.get(nd.id);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const padX = Math.min(80, G.width * 0.2), padY = Math.min(90, G.height * 0.2);
  const zx = (G.width - padX * 2) / (maxX - minX || 1), zy = (G.height - padY * 2) / (maxY - minY || 1);
  G.zoom = Math.min(Math.max(Math.min(zx, zy), 0.05), 2.5);
  G.panX = G.width / 2 - ((minX + maxX) / 2) * G.zoom;
  G.panY = G.height / 2 - ((minY + maxY) / 2) * G.zoom;
  updateZoomPct();
}
function updateZoomPct() { $("#g-zoompct").textContent = Math.round(G.zoom * 100) + "%"; }

function renderLegend() {
  const counts = {};
  G.nodes.forEach((n) => { counts[n.type] = (counts[n.type] || 0) + 1; });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  $("#g-legend").innerHTML = entries.map(([t, c]) => {
    const meta = TYPE_META[t] || { name: t, color: TYPE_COLOR_FALLBACK };
    return `<button class="g-leg ${G.typeFilter === t ? "on" : ""}" data-type="${escapeHtml(t)}">
      <i style="background:${meta.color}"></i>${meta.name} ${c}</button>`;
  }).join("");
}
$("#g-legend").addEventListener("click", (e) => {
  const btn = e.target.closest(".g-leg");
  if (!btn) return;
  G.typeFilter = G.typeFilter === btn.dataset.type ? null : btn.dataset.type;
  renderLegend();
});

$("#graph-search").addEventListener("input", (e) => { G.searchQ = e.target.value; });

function zoomAt(zoom, mx, my) {
  const before = screenToWorld(mx, my);
  G.zoom = Math.min(Math.max(zoom, 0.05), 5);
  G.panX = mx - before.x * G.zoom;
  G.panY = my - before.y * G.zoom;
  updateZoomPct();
}
$("#g-zin").addEventListener("click", () => zoomAt(G.zoom * 1.25, G.width / 2, G.height / 2));
$("#g-zout").addEventListener("click", () => zoomAt(G.zoom / 1.25, G.width / 2, G.height / 2));
$("#graph-fit").addEventListener("click", zoomFit);
$("#graph-refresh").addEventListener("click", loadGraphData);

gc.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = gc.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  zoomAt(G.zoom * Math.exp(-e.deltaY * 0.0012), mx, my);
}, { passive: false });

gc.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const rect = gc.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const nd = pickNode(mx, my);
  G.dragMoved = 0;
  if (nd) {
    G.dragNode = nd.id;
    heat(0.35);
  } else {
    G.panning = true;
    G.panStart = { x: e.clientX, y: e.clientY, px: G.panX, py: G.panY };
  }
});
window.addEventListener("mousemove", (e) => {
  const rect = gc.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  G.mouse = { x: mx, y: my };
  if (G.dragNode) {
    const w = screenToWorld(mx, my);
    const p = G.pos.get(G.dragNode);
    if (p) { p.x = w.x; p.y = w.y; }
    const v = G.vel.get(G.dragNode);
    if (v) { v.x = 0; v.y = 0; }
    G.dragMoved++;
    return;
  }
  if (G.panning && G.panStart) {
    G.panX = G.panStart.px + (e.clientX - G.panStart.x);
    G.panY = G.panStart.py + (e.clientY - G.panStart.y);
    return;
  }
  if (!viewGraph.hidden) {
    const nd = mx >= 0 && my >= 0 && mx <= G.width && my <= G.height ? pickNode(mx, my) : null;
    if ((nd && nd.id) !== G.hoverId) {
      G.hoverId = nd ? nd.id : null;
      gc.style.cursor = nd ? "pointer" : "grab";
    }
  }
});
window.addEventListener("mouseup", () => {
  if (G.dragNode) {
    if (G.dragMoved < 4) { G.selectId = G.dragNode; renderDetail(G.selectId); }
    G.dragNode = null;
    heat(0.15);
  }
  G.panning = false; G.panStart = null;
});
gc.addEventListener("click", (e) => {
  const rect = gc.getBoundingClientRect();
  const nd = pickNode(e.clientX - rect.left, e.clientY - rect.top);
  if (!nd && G.selectId) { G.selectId = null; $("#g-detail").hidden = true; }
});

function renderDetail(id) {
  const n = G.nodes.find((x) => x.id === id);
  if (!n) return;
  const meta = TYPE_META[n.type] || { name: n.type, color: TYPE_COLOR_FALLBACK };
  const neighbors = (G.adj.get(id) || []).slice(0, 60);
  // LightRAG 的 description 里可能带 <SEP> 拼接的多来源信息，取主描述、来源拆成多文件
  const desc = String(n.desc || "").split("<SEP>")[0].trim() || "（暂无描述）";
  const files = String(n.file || "").split("<SEP>").map((s) => s.trim()).filter(Boolean);
  $("#g-detail").innerHTML = `
    <div class="gd-head"><i class="gd-dot" style="background:${meta.color}"></i><b>${escapeHtml(n.label)}</b>
      <button class="gd-close" id="gd-close">✕</button></div>
    <div class="gd-meta"><span class="gd-type" style="border-color:${meta.color}66;color:${meta.color}">${meta.name}</span>
      <span>${gDegree(id)} 个连接</span></div>
    <div class="gd-desc">${escapeHtml(desc)}</div>
    <div class="gd-src">📄 来源：${files.length ? files.map((f) => `<span class="gd-file">${escapeHtml(f)}</span>`).join("") : "未知"}</div>
    <div class="gd-act"><button class="ghost-btn" id="gd-ask">💬 去对话问它</button></div>
    <div class="gd-nb-title">相邻实体</div>
    <div class="gd-nb">${neighbors.map((x) => `<span class="gd-nb-item" data-id="${escapeHtml(x)}">${escapeHtml(x)}</span>`).join("") || "无"}</div>`;
  $("#g-detail").hidden = false;
  $("#gd-close").onclick = () => { G.selectId = null; $("#g-detail").hidden = true; };
  $("#gd-ask").onclick = () => {
    showView("chat");
    $("#q").value = `介绍一下「${n.label}」：它是什么，和哪些概念相关？`;
    $("#q").focus();
  };
  $("#g-detail").querySelectorAll(".gd-nb-item").forEach((el) =>
    el.addEventListener("click", () => { G.selectId = el.dataset.id; renderDetail(G.selectId); }));
}

function updateGraphStatsLine() {
  G.counts = { n: G.nodes.length, e: G.edges.length };
  $("#graph-stats").textContent = `已提取 ${G.counts.n} 个实体 · ${G.counts.e} 条关系`;
  $("#g-statline").textContent = `${G.counts.n} 个节点 · ${G.counts.e} 条关系`;
}

(function gLoop() {
  try { render(); } catch (e) { console.warn("graph render:", e); }
  requestAnimationFrame(gLoop);
})();

/* ── 模型接入 ─────────────────────── */
const PRESETS = {
  zhipu: {
    llm: { binding: "openai", host: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
    emb: { binding: "openai", host: "https://open.bigmodel.cn/api/paas/v4", model: "embedding-3", dim: 2048 },
  },
  deepseek: {
    llm: { binding: "openai", host: "https://api.deepseek.com", model: "deepseek-chat" },
    emb: { binding: "openai", host: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3", dim: 1024 },
  },
  qwen: {
    llm: { binding: "openai", host: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
    emb: { binding: "openai", host: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "text-embedding-v4", dim: 1024 },
  },
  openai: {
    llm: { binding: "openai", host: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    emb: { binding: "openai", host: "https://api.openai.com/v1", model: "text-embedding-3-small", dim: 1536 },
  },
  ollama: {
    llm: { binding: "ollama", host: "http://localhost:11434", model: "qwen3:8b" },
    emb: { binding: "ollama", host: "http://localhost:11434", model: "bge-m3", dim: 1024 },
  },
};

async function loadModelsForm() {
  try {
    const st = await (await api("/aiui/model-status")).json();
    const warn = $("#mc-warning");
    if (!st.emb_key_ok) {
      warn.hidden = false;
      warn.innerHTML =
        "⚠️ <b>向量模型密钥未配置</b> —— 这就是入库失败的原因（对话 Key 管不了向量化）。" +
        "解决：注册 <b>open.bigmodel.cn</b>（智谱，选 embedding-3）或 <b>siliconflow.cn</b>（bge-m3 免费），" +
        "把拿到的 Key 填到下方向量模型的密钥框，测试连通后保存。";
    } else if (!st.llm_key_ok) {
      warn.hidden = false;
      warn.innerHTML = "⚠️ 对话模型密钥未配置，请填入后保存。";
    } else {
      warn.hidden = true;
    }
  } catch { /* ignore */ }
  try {
    const d = await (await api("/health")).json();
    const c = d.configuration || {};
    $("#cur-llm").textContent = `${c.llm_binding === "ollama" ? "本地 Ollama" : "在线接口"} · ${c.llm_model || "–"}`;
    $("#cur-llm-host").textContent = c.llm_binding_host || "";
    $("#cur-emb").textContent =
      `${c.embedding_binding === "ollama" ? "本地 Ollama" : "在线接口"} · ${c.embedding_model || "–"}` +
      (c.embedding_dim ? `（${c.embedding_dim} 维）` : "");
    $("#cur-emb-host").textContent = c.embedding_binding_host || "";
    const vdb = (c.vector_storage || "").includes("Milvus");
    $("#cur-vdb").textContent = vdb ? "Milvus · 本地知识库已就绪" : c.vector_storage;
    $("#mc-status").textContent = "已连接";
    // 预填表单（密钥不回填）
    if (!$("#llm-model").value) {
      $("#llm-binding").value = c.llm_binding === "ollama" ? "ollama" : "openai";
      $("#llm-host").value = c.llm_binding_host || "";
      $("#llm-model").value = c.llm_model || "";
      $("#emb-binding").value = c.embedding_binding === "ollama" ? "ollama" : "openai";
      $("#emb-host").value = c.embedding_binding_host || "";
      $("#emb-model").value = c.embedding_model || "";
      $("#emb-dim").value = c.embedding_dim ?? "";
    }
  } catch (e) {
    $("#mc-status").textContent = "服务未连接";
  }
}
$("#view-models").addEventListener("click", (e) => {
  const p = e.target.closest("[data-preset]");
  if (!p) return;
  const pre = PRESETS[p.dataset.preset];
  if (!pre) return;
  $("#llm-binding").value = pre.llm.binding;
  $("#llm-host").value = pre.llm.host;
  $("#llm-model").value = pre.llm.model;
  $("#emb-binding").value = pre.emb.binding;
  $("#emb-host").value = pre.emb.host;
  $("#emb-model").value = pre.emb.model;
  $("#emb-dim").value = pre.emb.dim;
  $("#save-hint").textContent = `已填入「${p.textContent}」预设，确认密钥后点「保存并生效」`;
});

$("#btn-save-model").addEventListener("click", async () => {
  const payload = {
    llm: {
      binding: $("#llm-binding").value,
      host: $("#llm-host").value.trim(),
      model: $("#llm-model").value.trim(),
      api_key: $("#llm-key").value.trim(),
    },
    embedding: {
      binding: $("#emb-binding").value,
      host: $("#emb-host").value.trim(),
      model: $("#emb-model").value.trim(),
      api_key: $("#emb-key").value.trim(),
      dim: $("#emb-dim").value.trim(),
    },
  };
  if (!payload.llm.model || !payload.embedding.model) {
    $("#save-hint").textContent = "⚠️ 请填写对话模型与向量模型的名称";
    return;
  }
  const btn = $("#btn-save-model");
  btn.disabled = true;
  $("#save-hint").textContent = "⏳ 正在写入配置并重启服务…";
  try {
    await api("/aiui/model-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    btn.disabled = false;
    $("#save-hint").textContent = "❌ 保存失败：" + e.message;
    return;
  }
  // 轮询等服务回来
  const target = payload.llm.model;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const d = await (await fetch("/health")).json();
      if (d.status === "healthy" && d.configuration?.llm_model === target) {
        btn.disabled = false;
        $("#save-hint").textContent = `✅ 模型已切换并接入本地知识库：${target}`;
        ["#llm-key", "#emb-key"].forEach((s) => ($(s).value = ""));
        loadModelsForm();
        loadHealth();
        return;
      }
    } catch { /* 还没起来，继续等 */ }
    $("#save-hint").textContent = `⏳ 服务重启中…（${i * 2 + 2} 秒）`;
  }
  btn.disabled = false;
  $("#save-hint").textContent = "⚠️ 等待超时，请稍后刷新页面查看状态";
});

/* ── 问候语与日期 ─────────────────── */
function renderGreet() {
  const h = new Date().getHours();
  const hi = h < 5 ? "夜深了" : h < 9 ? "早上好" : h < 12 ? "上午好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好";
  $("#greet-line").textContent = hi;
  const d = new Date();
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  $("#date-chip").textContent = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${week}`;
}

/* ── 设置 ─────────────────────────── */
const dlg = $("#settings-dlg");
function openSettings(note) {
  $("#api-key").value = apiKey;
  dlg.querySelector(".hint").textContent = note || "口令保存在本机浏览器，仅用于本页请求鉴权。";
  dlg.showModal();
}
$("#btn-settings").addEventListener("click", () => openSettings());
$("#dlg-cancel").addEventListener("click", () => dlg.close());
$("#dlg-save").addEventListener("click", () => {
  apiKey = $("#api-key").value.trim();
  localStorage.setItem("kb_api_key", apiKey);
  dlg.close();
  refreshStats();
});

/* ── 启动 ─────────────────────────── */
renderGreet();
showView("dash");
refreshStats();
