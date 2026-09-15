/*
  UI wiring. Mirrors app.py's loop:
  save raw -> classify -> append -> re-render -> (re)compose.
*/

marked.setOptions({ breaks: true });

function renderMarkdown(md) {
  const html = marked.parse(md || "");
  return DOMPurify.sanitize(html);
}

let currentSessionId = null;

async function refreshDocument() {
  const passages = await Storage.loadPassages(currentSessionId);
  const md = Storage.renderDocument(passages);
  document.getElementById("document-view").innerHTML = renderMarkdown(md);

  const select = document.getElementById("passage-select");
  select.innerHTML = "";
  [...passages].reverse().forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.raw_text.slice(0, 40)}... [${p.section}]`;
    select.appendChild(opt);
  });
}

async function refreshComposition() {
  const text = await Storage.loadComposition(currentSessionId);
  const view = document.getElementById("composition-view");
  view.innerHTML = text
    ? renderMarkdown(text)
    : `<p class="panel-note">No composition yet -- add a thought to generate one.</p>`;
  addKeepButtons();
}

function addKeepButtons() {
  const view = document.getElementById("composition-view");
  const paragraphs = view.querySelectorAll("p, blockquote");
  paragraphs.forEach((el) => {
    if (el.querySelector(".keep-btn")) return;
    const text = el.textContent.trim();
    if (text.length < 8) return;
    const btn = document.createElement("button");
    btn.className = "keep-btn";
    btn.textContent = "Keep this";
    btn.onclick = async () => {
      await Storage.addKept(currentSessionId, text, "composition");
      btn.textContent = "Kept";
      btn.disabled = true;
      await refreshKept();
    };
    el.appendChild(document.createElement("br"));
    el.appendChild(btn);
  });
}

async function refreshKept() {
  const kept = await Storage.loadKept(currentSessionId);
  const view = document.getElementById("kept-view");
  view.innerHTML = "";
  if (kept.length === 0) {
    view.innerHTML = `<p class="panel-note">Nothing kept yet. Use "Keep this" on a composition paragraph.</p>`;
    return;
  }
  [...kept].reverse().forEach((k) => {
    const div = document.createElement("div");
    div.className = "kept-item";
    div.textContent = k.text;
    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-kept";
    removeBtn.textContent = "Remove";
    removeBtn.onclick = async () => {
      await Storage.removeKept(k.id);
      await refreshKept();
    };
    div.appendChild(removeBtn);
    view.appendChild(div);
  });
}

function setStatus(text) {
  document.getElementById("stream-status").textContent = text;
}

function setLastDecision(html) {
  document.getElementById("last-decision").innerHTML = html;
}

async function handleSubmit() {
  const input = document.getElementById("thought-input");
  const thought = input.value.trim();
  if (!thought) return;

  const btn = document.getElementById("btn-submit");
  btn.disabled = true;

  try {
    setStatus("Saving...");
    await Storage.saveRawStream(thought);

    setStatus("Deciding where this belongs...");
    const existing = await Storage.existingSectionNames(currentSessionId);
    const result = await AI.classify(thought, existing);

    await Storage.addPassage(thought, result.section_name);

    const label = result.is_new_section ? "New section" : "Filed under";
    setLastDecision(`<strong>${label}:</strong> ${result.section_name}<br><span class="quiet-text">${result.reasoning}</span>`);

    input.value = "";
    await refreshDocument();

    setStatus("Updating composition...");
    const allStreams = (await Storage.loadRawStreams(currentSessionId)).map((s) => s.raw_text);
    const kept = await Storage.loadKept(currentSessionId);
    const composed = await AI.compose(allStreams, kept);
    if (composed) {
      await Storage.saveComposition(currentSessionId, composed);
      await refreshComposition();
    }

    setStatus("");
  } catch (err) {
    setStatus("");
    setLastDecision(`<span style="color:#a33;">Error: ${err.message}</span>`);
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

function switchTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabName));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${tabName}`));
}

function openModal(id) { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

async function refreshSessionsList() {
  const sessions = await Storage.listSessions();
  const list = document.getElementById("sessions-list");
  list.innerHTML = "";
  sessions.forEach((s) => {
    const div = document.createElement("div");
    div.className = "session-item";
    const label = s.id === currentSessionId ? `${s.id} (current)` : s.id;
    const status = s.archived ? "archived" : "active";
    div.innerHTML = `<span>${label}</span><span>${status}</span>`;
    list.appendChild(div);
  });
}

async function init() {
  currentSessionId = await Storage.currentSessionId();

  document.getElementById("api-key-input").value = localStorage.getItem("rt_api_key") || "";
  document.getElementById("model-input").value = localStorage.getItem("rt_model") || "google/gemma-4-26b-a4b-it:free";

  document.getElementById("btn-submit").onclick = handleSubmit;
  document.getElementById("thought-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
  });

  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.onclick = () => switchTab(b.dataset.tab);
  });

  document.getElementById("btn-settings").onclick = () => openModal("settings-modal");
  document.getElementById("btn-close-settings").onclick = () => closeModal("settings-modal");
  document.getElementById("btn-save-settings").onclick = () => {
    localStorage.setItem("rt_api_key", document.getElementById("api-key-input").value.trim());
    localStorage.setItem("rt_model", document.getElementById("model-input").value.trim());
    closeModal("settings-modal");
  };

  document.getElementById("btn-sessions").onclick = async () => {
    await refreshSessionsList();
    openModal("sessions-modal");
  };
  document.getElementById("btn-close-sessions").onclick = () => closeModal("sessions-modal");
  document.getElementById("btn-new-session").onclick = async () => {
    await Storage.startNewSession();
    currentSessionId = await Storage.currentSessionId();
    await refreshDocument();
    await refreshComposition();
    await refreshKept();
    setLastDecision("No thoughts streamed yet.");
    closeModal("sessions-modal");
  };

  document.getElementById("btn-undo").onclick = async () => {
    const removed = await Storage.deleteLastPassage(currentSessionId);
    if (removed) {
      setLastDecision(`<span class="quiet-text">Removed passage from document. Its raw text remains in your stream archive.</span>`);
      await refreshDocument();
    }
  };

  document.getElementById("btn-move").onclick = async () => {
    const passageId = document.getElementById("passage-select").value;
    const newSection = document.getElementById("new-section-input").value.trim();
    if (!passageId || !newSection) return;
    await Storage.updatePassageSection(passageId, newSection);
    document.getElementById("new-section-input").value = "";
    await refreshDocument();
  };

  document.getElementById("btn-refresh-composition").onclick = async () => {
    setStatus("Regenerating composition...");
    const allStreams = (await Storage.loadRawStreams(currentSessionId)).map((s) => s.raw_text);
    const kept = await Storage.loadKept(currentSessionId);
    try {
      const composed = await AI.compose(allStreams, kept);
      if (composed) {
        await Storage.saveComposition(currentSessionId, composed);
        await refreshComposition();
      }
    } catch (err) {
      setLastDecision(`<span style="color:#a33;">Error: ${err.message}</span>`);
    }
    setStatus("");
  };

  await refreshDocument();
  await refreshComposition();
  await refreshKept();
}

init();
