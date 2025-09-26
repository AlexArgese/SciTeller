#!/usr/bin/env python3
"""
patch_css_layers.py
- Wrappa tutti i CSS locali (tranne global.css) in @layer components { ... }
- Rimuove !important e commenta proprietà in conflitto con il tema glass del global:
  background*, border*, border-radius, box-shadow
- Solo dentro i selettori chiave (navbarShell, card, panel, sidebar, control-panel, story-view, btn, input, select, textarea, table, modal, dropdown)
- Crea backup .bak

USO:
  python patch_css_layers.py
  # opzionale: python patch_css_layers.py --root src
"""

import os, re, argparse, io

TARGET_SELECTOR_KEYWORDS = [
    "navbar", "navbarShell",
    "card", "panel", "sidebar",
    "control", "story",
    "btn", "button",
    "input", "select", "textarea",
    "table", "modal", "dropdown"
]

CONFLICTING_PROPS = [
    r"background(?:-color)?",
    r"box-shadow",
    r"border(?:-color|(?:-radius)?)?"
]

conflicting_re = re.compile(r"^\s*(" + "|".join(CONFLICTING_PROPS) + r")\s*:\s*[^;]+;.*$", re.IGNORECASE)
important_re = re.compile(r"!\s*important", re.IGNORECASE)

def should_skip(path: str) -> bool:
    base = os.path.basename(path).lower()
    if base in ("global.css", "globals.css"):
        return True
    # evita cartelle/nomi "global"
    norm = path.replace("\\", "/").lower()
    return "/global/" in norm

def selector_is_target(selector: str) -> bool:
    s = selector.lower()
    return any(k in s for k in TARGET_SELECTOR_KEYWORDS)

def process_css(text: str) -> tuple[str, bool]:
    changed = False
    has_layer = "@layer" in text

    # incapsula tutto in un layer se non già presente
    if not has_layer:
        text = "@layer components {\n" + text + "\n}\n"
        changed = True

    lines = text.splitlines()
    out = []
    in_block = False
    brace_depth = 0
    current_selector = ""

    for line in lines:
        if not in_block and "{" in line:
            # inizio regola
            current_selector = line.split("{")[0].strip()
            in_block = True
            brace_depth = line.count("{") - line.count("}")
            out.append(line)
            continue

        if in_block:
            brace_depth += line.count("{")
            brace_depth -= line.count("}")

            if selector_is_target(current_selector):
                # rimuovi !important
                if "!" in line and important_re.search(line):
                    new_line = important_re.sub("", line)
                    if new_line != line:
                        line = new_line
                        changed = True
                # commenta proprietà in conflitto
                if conflicting_re.match(line):
                    out.append("/* " + line.strip() + "  — disabled by global glass theme */")
                    changed = True
                    if brace_depth == 0:
                        in_block = False
                        current_selector = ""
                    continue

            out.append(line)

            if brace_depth <= 0:
                in_block = False
                current_selector = ""
            continue

        out.append(line)

    return "\n".join(out), changed

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".", help="cartella root da cui cercare i CSS (default: .)")
    args = ap.parse_args()

    patched = 0
    for root, _, files in os.walk(args.root):
        for f in files:
            if not f.lower().endswith((".css", ".scss", ".sass")):
                continue
            full = os.path.join(root, f)
            if should_skip(full):
                continue
            try:
                with open(full, "r", encoding="utf-8", errors="ignore") as fh:
                    txt = fh.read()
            except:
                continue

            new_txt, changed = process_css(txt)
            if changed:
                bak = full + ".bak"
                with open(bak, "w", encoding="utf-8") as fh:
                    fh.write(txt)
                with open(full, "w", encoding="utf-8") as fh:
                    fh.write(new_txt)
                patched += 1
                print(f"[patched] {os.path.relpath(full, args.root)}  (backup: {os.path.relpath(bak, args.root)})")

    print(f"\nDone. Patched files: {patched}")

if __name__ == "__main__":
    main()
