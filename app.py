import os
import re
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
NOTES_FILE = DATA_DIR / "notes.txt"
FILES_DIR = DATA_DIR / "files"
MAX_UPLOAD_MB = int(os.environ.get("LANPAD_MAX_UPLOAD_MB", "200"))

DATA_DIR.mkdir(parents=True, exist_ok=True)
FILES_DIR.mkdir(parents=True, exist_ok=True)
if not NOTES_FILE.exists():
    NOTES_FILE.write_text("", encoding="utf-8")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024


def _safe_name(name: str) -> str:
    name = secure_filename(name) or "file"
    return name[:200]


def _file_id() -> str:
    return uuid.uuid4().hex[:12]


def _stored_files():
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
        })
    return out


def _find_path(file_id: str):
    for p in FILES_DIR.iterdir():
        if p.is_file() and p.name.startswith(f"{file_id}__"):
            return p
    return None


def _notes_state():
    try:
        text = NOTES_FILE.read_text(encoding="utf-8")
    except FileNotFoundError:
        text = ""
    mtime = int(NOTES_FILE.stat().st_mtime) if NOTES_FILE.exists() else 0
    return text, mtime


@app.route("/")
def index():
    return render_template("index.html", max_upload_mb=MAX_UPLOAD_MB)


@app.route("/api/state")
def api_state():
    text, mtime = _notes_state()
    return jsonify({
        "notes": text,
        "notes_mtime": mtime,
        "files": _stored_files(),
        "server_time": int(time.time()),
    })


@app.route("/api/notes", methods=["POST"])
def api_save_notes():
    data = request.get_json(silent=True) or {}
    text = data.get("notes", "")
    if not isinstance(text, str):
        return jsonify({"error": "notes must be a string"}), 400
    NOTES_FILE.write_text(text, encoding="utf-8")
    _, mtime = _notes_state()
    return jsonify({"ok": True, "notes_mtime": mtime})


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


@app.route("/api/files/<file_id>", methods=["DELETE"])
def api_delete(file_id):
    if not re.fullmatch(r"[0-9a-f]{12}", file_id):
        abort(404)
    p = _find_path(file_id)
    if not p:
        return jsonify({"ok": True})
    p.unlink()
    return jsonify({"ok": True, "files": _stored_files()})


@app.errorhandler(413)
def too_big(_):
    return jsonify({"error": f"upload exceeds {MAX_UPLOAD_MB} MB limit"}), 413


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), debug=False)
