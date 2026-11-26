"""Plugin registry for Cosmic AI.

Plugins live in backend/plugins/<id>/ with a manifest.json file.
Optional: prompt.txt (system prompt addition), tools (list in manifest).
"""
import json
import os
import shutil
import urllib.request
from pathlib import Path

PLUGINS_DIR = Path(__file__).resolve().parent / "plugins"
PLUGINS_DIR.mkdir(exist_ok=True)


def _manifest_path(plugin_dir):
    return plugin_dir / "manifest.json"


def list_plugins():
    out = []
    for d in sorted(PLUGINS_DIR.iterdir()):
        if not d.is_dir():
            continue
        mp = _manifest_path(d)
        if not mp.exists():
            continue
        try:
            manifest = json.loads(mp.read_text(encoding="utf-8"))
        except Exception:
            continue
        manifest.setdefault("id", d.name)
        manifest["enabled"] = (d / ".enabled").exists()
        # read prompt
        prompt_file = d / "prompt.txt"
        manifest["has_prompt"] = prompt_file.exists()
        manifest["prompt"] = prompt_file.read_text(encoding="utf-8").strip() if prompt_file.exists() else ""
        out.append(manifest)
    return out


def get_plugin(plugin_id):
    d = PLUGINS_DIR / plugin_id
    if not d.is_dir() or not _manifest_path(d).exists():
        return None
    manifest = json.loads(_manifest_path(d).read_text(encoding="utf-8"))
    manifest.setdefault("id", d.name)
    manifest["enabled"] = (d / ".enabled").exists()
    pf = d / "prompt.txt"
    manifest["prompt"] = pf.read_text(encoding="utf-8").strip() if pf.exists() else ""
    return manifest


def install_plugin(source):
    """Install from a local path or URL (zip not supported; expects directory or manifest URL)."""
    source = source.strip()
    if source.startswith("http://") or source.startswith("https://"):
        # fetch manifest.json from URL base
        base = source.rstrip("/")
        if not base.endswith("manifest.json"):
            base = base + "/manifest.json"
        try:
            with urllib.request.urlopen(base, timeout=30) as resp:
                manifest = json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            raise ValueError(f"Gagal mengambil manifest: {exc}")
        plugin_id = manifest.get("id") or manifest.get("name", "plugin").lower().replace(" ", "-")
        target = PLUGINS_DIR / plugin_id
        target.mkdir(exist_ok=True)
        _manifest_path(target).write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        # optional prompt
        if manifest.get("prompt"):
            (target / "prompt.txt").write_text(manifest["prompt"], encoding="utf-8")
        return plugin_id
    else:
        # local path: copy directory
        src = Path(source).expanduser().resolve()
        if not src.is_dir() or not (src / "manifest.json").exists():
            raise ValueError("Path lokal harus berupa folder berisi manifest.json")
        plugin_id = json.loads((src / "manifest.json").read_text()).get("id", src.name)
        target = PLUGINS_DIR / plugin_id
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(src, target)
        return plugin_id


def set_enabled(plugin_id, enabled):
    d = PLUGINS_DIR / plugin_id
    if not d.is_dir():
        return False
    flag = d / ".enabled"
    if enabled:
        flag.touch()
    else:
        try:
            flag.unlink()
        except FileNotFoundError:
            pass
    return True


def delete_plugin(plugin_id):
    d = PLUGINS_DIR / plugin_id
    if not d.is_dir():
        return False
    shutil.rmtree(d)
    return True


def enabled_prompts():
    """Concatenate prompt.txt of all enabled plugins."""
    parts = []
    for p in list_plugins():
        if p.get("enabled") and p.get("prompt"):
            parts.append(f"[Plugin: {p.get('name', p['id'])}]\n{p['prompt']}")
    return "\n\n".join(parts)


def enabled_tools():
    """Collect tools declared by enabled plugins."""
    tools = []
    for p in list_plugins():
        if not p.get("enabled"):
            continue
        for t in (p.get("tools") or []):
            tools.append({"plugin": p["id"], "plugin_name": p.get("name", p["id"]), **t})
    return tools
