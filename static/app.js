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

  const POLL_MS = 2000;
  const SAVE_DEBOUNCE_MS = 500;

  let lastNotesMtime = 0;
  let localDirty = false;
  let saveTimer = null;
  let suppressInputUntil = 0;

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
      li.className = "file-row";
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
      const del = document.createElement("button");
      del.className = "btn danger";
      del.textContent = "Delete";
      del.addEventListener("click", () => deleteFile(f.id, f.name));
      actions.appendChild(dl);
      actions.appendChild(del);

      li.appendChild(thumb);
      li.appendChild(meta);
      li.appendChild(actions);
      frag.appendChild(li);
    }
    fileListEl.replaceChildren(frag);
  }

  async function fetchState() {
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      if (!r.ok) throw new Error("state " + r.status);
      const s = await r.json();
      if (!localDirty && s.notes_mtime !== lastNotesMtime) {
        const cursor = document.activeElement === notesEl ? notesEl.selectionStart : null;
        suppressInputUntil = Date.now() + 50;
        notesEl.value = s.notes;
        if (cursor !== null) {
          const pos = Math.min(cursor, s.notes.length);
          notesEl.setSelectionRange(pos, pos);
        }
        lastNotesMtime = s.notes_mtime;
      } else if (lastNotesMtime === 0) {
        lastNotesMtime = s.notes_mtime;
        notesEl.value = s.notes;
      }
      renderFiles(s.files);
    } catch (e) {
      setStatus("offline", "error");
    }
  }

  async function saveNotes() {
    saveTimer = null;
    setStatus("saving…", "saving");
    try {
      const r = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notesEl.value }),
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

  notesEl.addEventListener("input", () => {
    if (Date.now() < suppressInputUntil) return;
    localDirty = true;
    setStatus("editing…", "saving");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNotes, SAVE_DEBOUNCE_MS);
  });

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
    if (r.ok) {
      const j = await r.json();
      if (j.files) renderFiles(j.files);
      else fetchState();
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
