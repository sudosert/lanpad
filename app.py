import os
import re
import json
import time
import uuid
import mimetypes
from pathlib import Path
from flask import (
    Flask, render_template, request, jsonify, send_from_directory,
    abort, redirect, url_for,
)
from werkzeug.utils import secure_filename

DATA_DIR = Path(os.environ.get("LANPAD_DATA_DIR", "/data"))
NOTES_FILE = DATA_DIR / "notes.txt"   # legacy single-pad store (migrated on first run)
TABS_FILE = DATA_DIR / "tabs.json"    # current multi-tab store
LOCKS_FILE = DATA_DIR / "file_locks.json"  # ids of files protected from clearing
FILES_DIR = DATA_DIR / "files"
MAX_UPLOAD_MB = int(os.environ.get("LANPAD_MAX_UPLOAD_MB", "200"))
MAX_TABS = int(os.environ.get("LANPAD_MAX_TABS", "30"))

DATA_DIR.mkdir(parents=True, exist_ok=True)
FILES_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024


def _safe_name(name: str) -> str:
    name = secure_filename(name) or "file"
    return name[:200]


def _file_id() -> str:
    return uuid.uuid4().hex[:12]


def _load_locks():
    if LOCKS_FILE.exists():
        try:
            data = json.loads(LOCKS_FILE.read_text(encoding="utf-8"))
            locked = data.get("locked") if isinstance(data, dict) else None
            if isinstance(locked, list):
                return {str(x) for x in locked}
        except (OSError, ValueError):
            pass
    return set()


def _save_locks(locked_ids):
    tmp = LOCKS_FILE.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps({"locked": sorted(locked_ids)}, ensure_ascii=False),
        encoding="utf-8",
    )
    tmp.replace(LOCKS_FILE)


def _stored_files():
    locks = _load_locks()
    out = []
    for p in sorted(FILES_DIR.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        if not p.is_file():
            continue
        m = re.match(r"^([0-9a-f]{12})__(.+)$", p.name)
        if not m:
            continue
        fid, original = m.group(1), m.group(2)
        stat = p.stat()
        mime, _ = mimetypes.guess_type(original)
        out.append({
            "id": fid,
            "name": original,
            "size": stat.st_size,
            "mtime": int(stat.st_mtime),
            "mime": mime or "application/octet-stream",
            "is_image": (mime or "").startswith("image/"),
            "locked": fid in locks,
        })
    return out


def _find_path(file_id: str):
    for p in FILES_DIR.iterdir():
        if p.is_file() and p.name.startswith(f"{file_id}__"):
            return p
    return None


def _tab_id() -> str:
    return uuid.uuid4().hex[:8]


def _default_tabs():
    # Migrate a legacy single notepad into the first tab if it exists.
    content = ""
    if NOTES_FILE.exists():
        try:
            content = NOTES_FILE.read_text(encoding="utf-8")
        except OSError:
            content = ""
    return [{"id": _tab_id(), "name": "Tab 1", "content": content, "locked": False}]


def _sanitize_tabs(tabs):
    out = []
    seen = set()
    for t in tabs:
        if not isinstance(t, dict):
            continue
        tid = str(t.get("id") or _tab_id())[:32]
        if tid in seen:
            tid = _tab_id()
        seen.add(tid)
        name = (str(t.get("name") or "").strip() or "Tab")[:60]
        content = t.get("content")
        if not isinstance(content, str):
            content = ""
        out.append({
            "id": tid,
            "name": name,
            "content": content,
            "locked": bool(t.get("locked")),
        })
        if len(out) >= MAX_TABS:
            break
    if not out:
        out = [{"id": _tab_id(), "name": "Tab 1", "content": "", "locked": False}]
    return out


def _save_tabs(tabs):
    tmp = TABS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"tabs": tabs}, ensure_ascii=False), encoding="utf-8")
    tmp.replace(TABS_FILE)


def _load_tabs():
    if TABS_FILE.exists():
        try:
            data = json.loads(TABS_FILE.read_text(encoding="utf-8"))
            tabs = data.get("tabs") if isinstance(data, dict) else None
            if isinstance(tabs, list) and tabs:
                return _sanitize_tabs(tabs)
        except (OSError, ValueError):
            pass
    tabs = _default_tabs()
    _save_tabs(tabs)
    return tabs


def _notes_state():
    tabs = _load_tabs()
    mtime = int(TABS_FILE.stat().st_mtime) if TABS_FILE.exists() else 0
    return tabs, mtime


@app.route("/")
def index():
    return render_template("index.html", max_upload_mb=MAX_UPLOAD_MB)


@app.route("/favicon.ico")
def favicon():
    return send_from_directory(app.static_folder, "favicon.svg", mimetype="image/svg+xml")


@app.route("/api/state")
def api_state():
    tabs, mtime = _notes_state()
    return jsonify({
        "tabs": tabs,
        "notes_mtime": mtime,
        "files": _stored_files(),
        "server_time": int(time.time()),
    })


@app.route("/api/notes", methods=["POST"])
def api_save_notes():
    data = request.get_json(silent=True) or {}
    tabs = data.get("tabs")
    if not isinstance(tabs, list):
        return jsonify({"error": "tabs must be a list"}), 400
    tabs = _sanitize_tabs(tabs)
    _save_tabs(tabs)
    _, mtime = _notes_state()
    return jsonify({"ok": True, "notes_mtime": mtime, "tabs": tabs})


@app.route("/api/upload", methods=["POST"])
def api_upload():
    if "files" not in request.files and "file" not in request.files:
        return jsonify({"error": "no files in request"}), 400
    uploaded = request.files.getlist("files") or [request.files["file"]]
    saved = []
    for f in uploaded:
        if not f or not f.filename:
            continue
        original = _safe_name(f.filename)
        fid = _file_id()
        dest = FILES_DIR / f"{fid}__{original}"
        f.save(dest)
        saved.append({"id": fid, "name": original, "size": dest.stat().st_size})
    return jsonify({"ok": True, "saved": saved, "files": _stored_files()})


@app.route("/files/<file_id>")
def download(file_id):
    if not re.fullmatch(r"[0-9a-f]{12}", file_id):
        abort(404)
    p = _find_path(file_id)
    if not p:
        abort(404)
    original = p.name.split("__", 1)[1]
    as_attachment = request.args.get("dl") == "1"
    return send_from_directory(
        FILES_DIR, p.name, as_attachment=as_attachment, download_name=original
    )


@app.route("/api/files/<file_id>/lock", methods=["POST"])
def api_lock(file_id):
    if not re.fullmatch(r"[0-9a-f]{12}", file_id):
        abort(404)
    if not _find_path(file_id):
        abort(404)
    data = request.get_json(silent=True) or {}
    want = bool(data.get("locked", True))
    locks = _load_locks()
    if want:
        locks.add(file_id)
    else:
        locks.discard(file_id)
    _save_locks(locks)
    return jsonify({"ok": True, "locked": want, "files": _stored_files()})


@app.route("/api/files/<file_id>", methods=["DELETE"])
def api_delete(file_id):
    if not re.fullmatch(r"[0-9a-f]{12}", file_id):
        abort(404)
    p = _find_path(file_id)
    if not p:
        return jsonify({"ok": True})
    if file_id in _load_locks():
        return jsonify({"error": "file is locked", "files": _stored_files()}), 409
    p.unlink()
    return jsonify({"ok": True, "files": _stored_files()})


@app.route("/api/files", methods=["DELETE"])
def api_delete_all():
    locks = _load_locks()
    removed = 0
    kept = 0
    for p in FILES_DIR.iterdir():
        m = p.is_file() and re.match(r"^([0-9a-f]{12})__", p.name)
        if not m:
            continue
        if m.group(1) in locks:
            kept += 1
            continue
        p.unlink()
        removed += 1
    return jsonify({"ok": True, "removed": removed, "kept": kept, "files": _stored_files()})


@app.errorhandler(413)
def too_big(_):
    return jsonify({"error": f"upload exceeds {MAX_UPLOAD_MB} MB limit"}), 413


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), debug=False)
