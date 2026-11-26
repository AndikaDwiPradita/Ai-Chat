"""Skill registry for Cosmic AI.

Skills are markdown files (with optional YAML frontmatter) stored in backend/skills/.
"""
import json
import os
import re
import shutil
import urllib.request
from pathlib import Path

SKILLS_DIR = Path(__file__).resolve().parent / "skills"
SKILLS_DIR.mkdir(exist_ok=True)


def _parse_frontmatter(text):
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", text, re.DOTALL)
    if not m:
        return {}, text
    fm_raw, body = m.group(1), m.group(2)
    fm = {}
    for line in fm_raw.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip().strip('"').strip("'")
    return fm, body


def list_skills():
    out = []
    for f in sorted(SKILLS_DIR.glob("*.md")):
        text = f.read_text(encoding="utf-8")
        fm, body = _parse_frontmatter(text)
        out.append({
            "id": f.stem,
            "name": fm.get("name", f.stem),
            "description": fm.get("description", ""),
            "path": str(f),
            "size": len(text),
        })
    return out


def get_skill(skill_id):
    f = SKILLS_DIR / (skill_id + ".md")
    if not f.exists():
        return None
    text = f.read_text(encoding="utf-8")
    fm, body = _parse_frontmatter(text)
    return {
        "id": skill_id,
        "name": fm.get("name", skill_id),
        "description": fm.get("description", ""),
        "frontmatter": fm,
        "content": text,
        "body": body,
    }


def install_skill(source, name=None):
    source = source.strip()
    if source.startswith("http://") or source.startswith("https://"):
        with urllib.request.urlopen(source, timeout=30) as resp:
            text = resp.read().decode("utf-8")
        # derive name from url
        fname = source.split("/")[-1].split("?")[0]
        if not fname.endswith(".md"):
            fname = (name or "skill") + ".md"
        target = SKILLS_DIR / fname
        target.write_text(text, encoding="utf-8")
        return target.stem
    else:
        src = Path(source).expanduser().resolve()
        if src.is_file():
            target = SKILLS_DIR / src.name
            shutil.copyfile(src, target)
            return target.stem
        elif src.is_dir():
            # copy all md files
            installed = []
            for f in src.glob("*.md"):
                target = SKILLS_DIR / f.name
                shutil.copyfile(f, target)
                installed.append(target.stem)
            return installed
        else:
            raise ValueError("Path tidak ditemukan")


def delete_skill(skill_id):
    f = SKILLS_DIR / (skill_id + ".md")
    if not f.exists():
        return False
    f.unlink()
    return True
