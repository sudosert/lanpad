(() => {
  const $ = (id) => document.getElementById(id);
  const notesEl = $("notes");
  const statusEl = $("status");
  const fileListEl = $("file-list");
  const dropzone = $("dropzone");
  const fileInput = $("file-input");
  const pickBtn = $("pick-btn");
  const progressEl = $("upload-progress");
  const lightbox = $("lightbox");
  const lightboxImg = $("lightbox-img");
  const lightboxClose = $("lightbox-close");
  const copyBtn = $("copy-btn");
  const pasteBtn = $("paste-btn");
  const clearNotesBtn = $("clear-notes-btn");
  const clearTabsBtn = $("clear-tabs-btn");
  const clearFilesBtn = $("clear-files-btn");
  const tabsEl = $("tabs");
  const addTabBtn = $("add-tab-btn");

  const POLL_MS = 2000;
  const SAVE_DEBOUNCE_MS = 500;
  const MAX_TABS = 30;

  let lastNotesMtime = 0;
  let localDirty = false;
  let saveTimer = null;
  let suppressInputUntil = 0;

  // Multi-tab notepad state. Only the active tab's content is shown in the
  // textarea; tabs[].content holds the rest. The whole array is what we save.
  let tabs = [];
  let activeTabId = null;
  let dragId = null;

  function newTabId() {
    return (
      Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    );
  }

  function activeTab() {
    return tabs.find((t) => t.id === activeTabId) || null;
  }

  // Pull whatever is in the textarea back into the active tab object so the
  // model stays the source of truth before we save / switch / re-render.
  function syncActiveFromTextarea() {
    const t = activeTab();
    if (t) t.content = notesEl.value;
  }

  function setStatus(text, cls = "") {
    statusEl.textContent = text;
    statusEl.className = "status " + cls;
  }

  function fmtSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function fmtTime(ts) {
    const d = new Date(ts * 1000);
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function extOf(name) {
    const i = name.lastIndexOf(".");
    return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
  }

  function renderFiles(files) {
    if (!files.length) {
      fileListEl.innerHTML = '<li class="empty">No files yet — drop something in.</li>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const f of files) {
      const li = document.createElement("li");
      li.className = "file-row" + (f.locked ? " locked" : "");
      li.dataset.id = f.id;

      const thumb = document.createElement("div");
      thumb.className = "thumb";
      if (f.is_image) {
        const img = document.createElement("img");
        img.src = `/files/${f.id}`;
        img.alt = f.name;
        img.loading = "lazy";
        img.addEventListener("click", () => openLightbox(`/files/${f.id}`));
        thumb.appendChild(img);
      } else {
        const ext = document.createElement("span");
        ext.className = "ext";
        ext.textContent = extOf(f.name) || "file";
        thumb.appendChild(ext);
      }

      const meta = document.createElement("div");
      meta.className = "fmeta";
      const name = document.createElement("a");
      name.className = "fname";
      name.href = `/files/${f.id}?dl=1`;
      name.textContent = f.name;
      const sub = document.createElement("div");
      sub.className = "fsub";
      sub.textContent = `${fmtSize(f.size)} · ${fmtTime(f.mtime)}`;
      meta.appendChild(name);
      meta.appendChild(sub);

      const actions = document.createElement("div");
      actions.className = "factions";
      const dl = document.createElement("a");
      dl.className = "btn";
      dl.href = `/files/${f.id}?dl=1`;
      dl.textContent = "Download";
      const lock = document.createElement("button");
      lock.className = "btn" + (f.locked ? " locked" : "");
      lock.textContent = f.locked ? "🔒 Locked" : "🔓 Lock";
      lock.title = f.locked ? "Unlock — allow clearing" : "Lock — protect from clearing";
      lock.addEventListener("click", () => toggleFileLock(f.id, !f.locked));
      actions.appendChild(dl);
      actions.appendChild(lock);
      if (!f.locked) {
        const del = document.createElement("button");
        del.className = "btn danger";
        del.textContent = "Delete";
        del.addEventListener("click", () => deleteFile(f.id, f.name));
        actions.appendChild(del);
      }

      li.appendChild(thumb);
      li.appendChild(meta);
      li.appendChild(actions);
      frag.appendChild(li);
    }
    fileListEl.replaceChildren(frag);
  }

  function renderTabs() {
    const frag = document.createDocumentFragment();
    for (const t of tabs) {
      const tab = document.createElement("div");
      tab.className =
        "tab" + (t.id === activeTabId ? " active" : "") + (t.locked ? " locked" : "");
      tab.dataset.id = t.id;
      tab.setAttribute("role", "tab");
      tab.draggable = true;
      tab.title = "Click to switch · double-click to rename · drag to reorder";

      tab.addEventListener("dragstart", (e) => {
        dragId = t.id;
        tab.classList.add("dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          // Firefox needs data set for the drag to start.
          try { e.dataTransfer.setData("text/plain", t.id); } catch {}
        }
      });
      tab.addEventListener("dragend", () => {
        dragId = null;
        tab.classList.remove("dragging");
        tabsEl.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      });
      tab.addEventListener("dragover", (e) => {
        if (!dragId || dragId === t.id) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        tab.classList.add("drag-over");
      });
      tab.addEventListener("dragleave", () => tab.classList.remove("drag-over"));
      tab.addEventListener("drop", (e) => {
        e.preventDefault();
        tab.classList.remove("drag-over");
        reorderTab(dragId, t.id);
      });

      const lock = document.createElement("button");
      lock.className = "tab-lock" + (t.locked ? " on" : "");
      lock.type = "button";
      lock.textContent = t.locked ? "🔒" : "🔓";
      lock.title = t.locked ? "Unlock — allow clearing" : "Lock — protect from clearing";
      lock.setAttribute("aria-label", (t.locked ? "Unlock " : "Lock ") + t.name);
      lock.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleTabLock(t.id);
      });
      tab.appendChild(lock);

      const label = document.createElement("span");
      label.className = "tab-name";
      label.textContent = t.name;
      tab.appendChild(label);

      if (!t.locked) {
        const close = document.createElement("button");
        close.className = "tab-close";
        close.type = "button";
        close.textContent = "×";
        close.title = "Close tab";
        close.setAttribute("aria-label", `Close ${t.name}`);
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          closeTab(t.id);
        });
        tab.appendChild(close);
      }

      tab.addEventListener("click", () => switchTab(t.id));
      tab.addEventListener("dblclick", (e) => {
        e.preventDefault();
        renameTab(t.id);
      });
      frag.appendChild(tab);
    }
    tabsEl.replaceChildren(frag);
    addTabBtn.disabled = tabs.length >= MAX_TABS;
  }

  // Reflect the active tab's content into the textarea, optionally trying to
  // preserve the caret (used during background sync so typing isn't jarring).
  function showActiveTab(preserveCaret = false) {
    const t = activeTab();
    const text = t ? t.content : "";
    const cursor =
      preserveCaret && document.activeElement === notesEl
        ? notesEl.selectionStart
        : null;
    suppressInputUntil = Date.now() + 50;
    notesEl.value = text;
    if (cursor !== null) {
      const pos = Math.min(cursor, text.length);
      notesEl.setSelectionRange(pos, pos);
    }
  }

  function switchTab(id) {
    if (id === activeTabId) return;
    syncActiveFromTextarea();
    activeTabId = id;
    renderTabs();
    showActiveTab(false);
    notesEl.focus();
  }

  // Move the dragged tab so it sits immediately before the drop target.
  function reorderTab(srcId, targetId) {
    if (!srcId || srcId === targetId) return;
    syncActiveFromTextarea();
    const from = tabs.findIndex((t) => t.id === srcId);
    if (from < 0) return;
    const [moved] = tabs.splice(from, 1);
    const to = tabs.findIndex((t) => t.id === targetId);
    if (to < 0) {
      tabs.splice(from, 0, moved); // target vanished — put it back
      return;
    }
    tabs.splice(to, 0, moved);
    renderTabs();
    saveNow();
  }

  function addTab() {
    if (tabs.length >= MAX_TABS) {
      flashStatus("tab limit reached", "error");
      return;
    }
    syncActiveFromTextarea();
    const t = { id: newTabId(), name: nextTabName(), content: "", locked: false };
    tabs.push(t);
    activeTabId = t.id;
    renderTabs();
    showActiveTab(false);
    notesEl.focus();
    saveNow();
  }

  function nextTabName() {
    let n = tabs.length + 1;
    const names = new Set(tabs.map((t) => t.name));
    while (names.has("Tab " + n)) n++;
    return "Tab " + n;
  }

  function renameTab(id) {
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    const name = prompt("Rename tab:", t.name);
    if (name === null) return;
    t.name = name.trim().slice(0, 60) || t.name;
    renderTabs();
    saveNow();
  }

  function toggleTabLock(id) {
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    t.locked = !t.locked;
    renderTabs();
    saveNow();
    flashStatus(t.locked ? "tab locked" : "tab unlocked");
  }

  function closeTab(id) {
    const t = tabs.find((x) => x.id === id);
    if (t && t.locked) {
      flashStatus("tab is locked", "error");
      return;
    }
    if (tabs.length <= 1) {
      flashStatus("can't close the last tab", "error");
      return;
    }
    if (t && t.content.trim() && !confirm(`Close "${t.name}"? Its contents will be lost.`)) {
      return;
    }
    syncActiveFromTextarea();
    const idx = tabs.findIndex((x) => x.id === id);
    tabs = tabs.filter((x) => x.id !== id);
    if (activeTabId === id) {
      const next = tabs[Math.min(idx, tabs.length - 1)];
      activeTabId = next ? next.id : null;
    }
    renderTabs();
    showActiveTab(false);
    saveNow();
  }

  // Replace local tab state from a server payload, keeping the active tab
  // selected if it still exists.
  function adoptTabs(serverTabs) {
    tabs = (serverTabs || []).map((t) => ({
      id: t.id,
      name: t.name,
      content: t.content || "",
      locked: !!t.locked,
    }));
    if (!tabs.length) {
      tabs = [{ id: newTabId(), name: "Tab 1", content: "", locked: false }];
    }
    if (!tabs.some((t) => t.id === activeTabId)) {
      activeTabId = tabs[0].id;
    }
    renderTabs();
  }

  async function fetchState() {
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      if (!r.ok) throw new Error("state " + r.status);
      const s = await r.json();
      if (!localDirty && s.notes_mtime !== lastNotesMtime) {
        adoptTabs(s.tabs);
        showActiveTab(true);
        lastNotesMtime = s.notes_mtime;
      } else if (lastNotesMtime === 0) {
        lastNotesMtime = s.notes_mtime;
        adoptTabs(s.tabs);
        showActiveTab(false);
      }
      renderFiles(s.files);
    } catch (e) {
      setStatus("offline", "error");
    }
  }

  async function saveNotes() {
    saveTimer = null;
    syncActiveFromTextarea();
    setStatus("saving…", "saving");
    try {
      const r = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabs }),
      });
      if (!r.ok) throw new Error("save " + r.status);
      const s = await r.json();
      lastNotesMtime = s.notes_mtime;
      localDirty = false;
      setStatus("saved", "saved");
      setTimeout(() => {
        if (statusEl.textContent === "saved") setStatus("synced");
      }, 1200);
    } catch (e) {
      setStatus("save failed", "error");
    }
  }

  // Save immediately (no debounce) — for structural changes like adding,
  // renaming, closing or clearing tabs that other clients should see fast.
  function saveNow() {
    localDirty = true;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    return saveNotes();
  }

  notesEl.addEventListener("input", () => {
    if (Date.now() < suppressInputUntil) return;
    localDirty = true;
    setStatus("editing…", "saving");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNotes, SAVE_DEBOUNCE_MS);
  });

  // Flush a pending debounced save before the tab closes so the last
  // few characters typed inside the debounce window can't be lost.
  function flushPendingSave() {
    if (!localDirty) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      syncActiveFromTextarea();
      const blob = new Blob(
        [JSON.stringify({ tabs })],
        { type: "application/json" }
      );
      navigator.sendBeacon("/api/notes", blob);
      localDirty = false;
    } catch {
      // best-effort only
    }
  }
  window.addEventListener("beforeunload", flushPendingSave);
  window.addEventListener("pagehide", flushPendingSave);

  async function flashStatus(text, cls = "saved", revertMs = 1200) {
    setStatus(text, cls);
    setTimeout(() => {
      if (statusEl.textContent === text) setStatus("synced");
    }, revertMs);
  }

  async function doCopy() {
    const text = notesEl.value;
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {}
    }
    if (!ok) {
      // Fallback for plain-HTTP LAN access where the async clipboard API
      // is blocked: select the textarea contents and trigger a copy.
      const prevStart = notesEl.selectionStart;
      const prevEnd = notesEl.selectionEnd;
      notesEl.focus();
      notesEl.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      notesEl.setSelectionRange(prevStart, prevEnd);
    }
    flashStatus(ok ? "copied" : "copy failed", ok ? "saved" : "error");
  }

  async function doPaste() {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      flashStatus("paste needs HTTPS — use Ctrl+V", "error", 2400);
      notesEl.focus();
      return;
    }
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      flashStatus("paste blocked — use Ctrl+V", "error", 2400);
      notesEl.focus();
      return;
    }
    const start = notesEl.selectionStart ?? notesEl.value.length;
    const end = notesEl.selectionEnd ?? notesEl.value.length;
    notesEl.value =
      notesEl.value.slice(0, start) + text + notesEl.value.slice(end);
    const caret = start + text.length;
    notesEl.setSelectionRange(caret, caret);
    notesEl.focus();
    localDirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNotes, SAVE_DEBOUNCE_MS);
    flashStatus("pasted");
  }

  async function clearNotes() {
    const t = activeTab();
    if (!t) return;
    if (t.locked) {
      flashStatus("tab is locked", "error");
      return;
    }
    if (!notesEl.value) return;
    if (!confirm(`Clear the "${t.name}" tab for everyone?`)) return;
    notesEl.value = "";
    t.content = "";
    await saveNow();
    flashStatus("tab cleared");
  }

  async function clearAllTabs() {
    syncActiveFromTextarea();
    const locked = tabs.filter((t) => t.locked);
    const msg = locked.length
      ? `Clear all unlocked tabs for everyone? ${locked.length} locked tab(s) are kept.`
      : "Clear ALL tabs for everyone? This deletes every tab and its contents.";
    if (!confirm(msg)) return;
    tabs = locked.length
      ? locked
      : [{ id: newTabId(), name: "Tab 1", content: "", locked: false }];
    if (!tabs.some((t) => t.id === activeTabId)) {
      activeTabId = tabs[0].id;
    }
    renderTabs();
    showActiveTab(false);
    await saveNow();
    flashStatus(locked.length ? "unlocked tabs cleared" : "all tabs cleared");
    notesEl.focus();
  }

  async function clearAllFiles() {
    if (!confirm("Delete all UNLOCKED files? Locked files are kept. This can't be undone.")) return;
    try {
      const r = await fetch("/api/files", { method: "DELETE" });
      if (!r.ok) throw new Error("clear " + r.status);
      const j = await r.json();
      if (j.files) renderFiles(j.files);
      else fetchState();
      const kept = j.kept ? `, kept ${j.kept} locked` : "";
      flashStatus(`removed ${j.removed ?? 0} file(s)${kept}`);
    } catch {
      flashStatus("clear failed", "error");
    }
  }

  copyBtn.addEventListener("click", doCopy);
  pasteBtn.addEventListener("click", doPaste);
  clearNotesBtn.addEventListener("click", clearNotes);
  clearTabsBtn.addEventListener("click", clearAllTabs);
  clearFilesBtn.addEventListener("click", clearAllFiles);
  addTabBtn.addEventListener("click", addTab);

  pickBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) uploadFiles(fileInput.files);
    fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("drag");
    });
  });
  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });

  // Page-wide drag & drop
  ["dragover", "drop"].forEach((ev) =>
    document.addEventListener(ev, (e) => e.preventDefault())
  );
  document.addEventListener("drop", (e) => {
    if (e.target.closest("#dropzone")) return;
    if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });

  // Paste-to-upload (handy for screenshots)
  document.addEventListener("paste", (e) => {
    if (document.activeElement === notesEl) return;
    const items = e.clipboardData && e.clipboardData.files;
    if (items && items.length) uploadFiles(items);
  });

  function uploadFiles(fileList) {
    const fd = new FormData();
    let total = 0;
    for (const f of fileList) {
      fd.append("files", f, f.name || "pasted");
      total += f.size;
    }
    progressEl.textContent = `Uploading ${fileList.length} file(s) · ${fmtSize(total)}…`;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        progressEl.textContent = `Uploading… ${pct}%`;
      }
    });
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        progressEl.textContent = "Uploaded.";
        setTimeout(() => (progressEl.textContent = ""), 1500);
        try {
          const j = JSON.parse(xhr.responseText);
          if (j.files) renderFiles(j.files);
        } catch {}
        fetchState();
      } else {
        let msg = `Upload failed (${xhr.status})`;
        try {
          const j = JSON.parse(xhr.responseText);
          if (j.error) msg = "Upload failed: " + j.error;
        } catch {}
        progressEl.textContent = msg;
      }
    };
    xhr.onerror = () => (progressEl.textContent = "Upload failed (network)");
    xhr.send(fd);
  }

  async function deleteFile(id, name) {
    if (!confirm(`Delete "${name}"?`)) return;
    const r = await fetch(`/api/files/${id}`, { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (j.files) renderFiles(j.files);
    else fetchState();
    if (!r.ok) flashStatus(j.error || "delete failed", "error");
  }

  async function toggleFileLock(id, locked) {
    try {
      const r = await fetch(`/api/files/${id}/lock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locked }),
      });
      if (!r.ok) throw new Error("lock " + r.status);
      const j = await r.json();
      if (j.files) renderFiles(j.files);
      else fetchState();
      flashStatus(locked ? "file locked" : "file unlocked");
    } catch {
      flashStatus("lock failed", "error");
    }
  }

  function openLightbox(src) {
    lightboxImg.src = src;
    lightbox.classList.remove("hidden");
  }
  function closeLightbox() {
    lightbox.classList.add("hidden");
    lightboxImg.src = "";
  }
  lightboxClose.addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !lightbox.classList.contains("hidden")) closeLightbox();
  });

  // Initial load + polling
  fetchState().then(() => setStatus("synced"));
  setInterval(fetchState, POLL_MS);
})();
