// observatory/app.js — fetches the workflow model and renders it live.
const listEl = document.getElementById("list");
const mainEl = document.getElementById("main");

let selected = null;            // wf id
const openCards = new Set();    // agentId set that the user expanded (persist across polls)

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const ago = (ms) => {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

async function getJSON(u) { const r = await fetch(u); if (!r.ok) throw new Error(r.status); return r.json(); }

function renderList(wfs) {
  listEl.innerHTML = wfs.map((w) => `
    <div class="wf ${w.id === selected ? "active" : ""}" data-id="${w.id}">
      <div class="name">${esc(w.name)}</div>
      <div class="meta">${esc(w.id)}</div>
    </div>`).join("") || `<div class="empty">No workflows found yet.</div>`;
  for (const el of listEl.querySelectorAll(".wf")) {
    el.onclick = () => { selected = el.dataset.id; openCards.clear(); refreshDetail(); renderList(wfs); };
  }
  if (!selected && wfs[0]) { selected = wfs[0].id; refreshDetail(); renderList(wfs); }
}

function cardHTML(a) {
  const open = openCards.has(a.agentId);
  const chips = Object.entries(a.counts || {})
    .map(([n, c]) => `<span class="chip">${esc(n)} <b>${c}</b></span>`).join("");
  const timeline = (a.toolCalls || []).map((t) =>
    `<li><span class="tname">${esc(t.name)}</span><span class="tsum">${esc(t.summary)}</span></li>`).join("")
    || `<li><span class="tsum" style="color:#667">(no tool calls)</span></li>`;
  return `
    <div class="card ${a.status} ${open ? "open" : ""}" data-id="${esc(a.agentId)}">
      <div class="top">
        <span class="label">${esc(a.label)}</span>
        <span class="badge ${a.status}">${a.status === "running" ? "● live" : "done"}</span>
      </div>
      <div class="chips">${chips || '<span class="chip">no tools</span>'}</div>
      <div class="stat">${(a.toolCalls || []).length} tool calls · ${a.lines} msgs${a.durationMs ? " · " + ago(a.durationMs) : ""}</div>
      <div class="detail">
        <h3>Prompt</h3><pre class="prompt">${esc(a.prompt) || "(none captured)"}</pre>
        <h3>Work (tool-call timeline)</h3><ul class="timeline">${timeline}</ul>
        <h3>Output</h3><pre class="output">${esc(a.output) || "(pending…)"}</pre>
      </div>
    </div>`;
}

function renderDetail(m) {
  const phases = m.phases.length ? m.phases : ["agents"];
  mainEl.innerHTML = phases.map((p) => {
    const cards = m.agents.filter((a) => a.phase === p);
    if (!cards.length) return "";
    const live = cards.filter((c) => c.status === "running").length;
    return `<section class="phase">
      <h2>${esc(p)} <span style="color:#667;font-weight:400">— ${cards.length} agent${cards.length > 1 ? "s" : ""}${live ? `, ${live} live` : ""}</span></h2>
      <div class="grid">${cards.map(cardHTML).join("")}</div>
    </section>`;
  }).join("") || `<div class="empty">No agents yet — workflow is spinning up.</div>`;
  for (const el of mainEl.querySelectorAll(".card")) {
    el.onclick = () => {
      const id = el.dataset.id;
      el.classList.toggle("open");
      el.classList.contains("open") ? openCards.add(id) : openCards.delete(id);
    };
  }
}

async function refreshDetail() {
  if (!selected) return;
  try { renderDetail(await getJSON(`/api/workflow?id=${encodeURIComponent(selected)}`)); }
  catch (e) { mainEl.innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`; }
}

async function tick() {
  try {
    const wfs = await getJSON("/api/workflows");
    renderList(wfs);
    await refreshDetail();
  } catch (e) { /* server momentarily busy — retry next tick */ }
}

tick();
setInterval(tick, 1500);
