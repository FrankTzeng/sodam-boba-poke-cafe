#!/usr/bin/env python3
"""Follow-up to owner feedback 2026-11-25 — hide the "Tap to view" hint.

Frank's refinement after the SIMPLE_MENU build went live:
  - The menu cards' "Tap to view" hint text is hidden. The cards still
    open the view-only item modal when tapped; only the hint goes.
  - Implemented inside the existing SIMPLE_MENU mechanism: the
    .menu-card .viewhint selector is added to the display:none rule in
    the marked <style> block in <head>, and the block's comment notes
    it. Reversible the same way as the rest of the mode: delete that
    style block AND set SIMPLE_MENU = false in the page script.
  - Staff Board: no change — its nav link stays hidden (not deleted),
    as Frank confirmed.

Every replacement is asserted; the script fails loudly rather than
shipping a half-patched file (same convention as build.py).
"""
import os, sys

BASE = os.path.dirname(os.path.abspath(__file__))
DST = os.path.join(BASE, "public", "index.html")

html = open(DST, encoding="utf-8", errors="ignore").read()
print("source bytes:", len(html))

def rep(old, new, label, expect=1):
    global html
    n = html.count(old)
    if n != expect:
        print(f"FAIL [{label}]: expected {expect} occurrence(s), found {n}")
        sys.exit(1)
    html = html.replace(old, new)
    print(f"  [{label}]: ok")

# ---------- 1: note the hint in the SIMPLE MENU block comment --------------
rep("""   page script. All ordering code, server endpoints and data are intact. */""",
    """   page script. All ordering code, server endpoints and data are intact.
   Follow-up (Frank, 2026-11-25): the menu-card "Tap to view" hint is
   hidden too (.menu-card .viewhint in the rule below); the cards still
   open the view-only item modal when tapped. */""",
    "comment-note")

# ---------- 2: hide .menu-card .viewhint in the SIMPLE MENU rule -----------
rep("#itemModal .modal-note,#itemModal .modal-body > h4{display:none !important}",
    "#itemModal .modal-note,#itemModal .modal-body > h4,.menu-card .viewhint{display:none !important}",
    "hide-viewhint")

open(DST, "w", encoding="utf-8").write(html)
print("written bytes:", len(html))
print("OK — viewhint hidden inside SIMPLE_MENU mode")
