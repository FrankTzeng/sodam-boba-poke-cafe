#!/usr/bin/env python3
"""Follow-up 2 to owner feedback 2026-11-25 — cards fully inert in SIMPLE_MENU.

Frank reported the "Tap to view" hint was STILL visible on his phone after
the previous round, and that tapping a card still enlarged the item. The
previous round only CSS-hid the hint; the diagnosis for this round:

  - The card render path appended the hint span UNCONDITIONALLY (in
    SIMPLE_MENU mode with the text "Tap to view"); only the SIMPLE_MENU
    style-block rule (.menu-card .viewhint{display:none !important})
    hid it. The element and its text were always in the page.
  - The page is served with Cache-Control: public, max-age=3600, and
    Frank checked within that window of the previous deploy, so his
    phone plausibly still held the pre-fix HTML. Either way, a hint
    that exists in the DOM can resurface; one that is never rendered
    cannot.
  - The enlarge-on-tap was NOT cache: openItem() had no SIMPLE_MENU
    gate, and the grid click / keydown / search-result / signature-card
    handlers all called it.

Fix, inside the SIMPLE_MENU mechanism (reversible the same way as the
rest of the mode — delete the marked style block AND set
SIMPLE_MENU = false):
  1. The card render path no longer renders the viewhint span at all
     when SIMPLE_MENU is on.
  2. openItem() returns immediately when SIMPLE_MENU is on, so no tap,
     key press, search result or signature card can open the item
     modal. The modal code stays in place, unreachable from cards.
  3. Cards no longer get tabindex / role="button" / "View details."
     aria-label in SIMPLE_MENU mode (they are not buttons anymore).
  4. Comments in the style block and beside the SIMPLE_MENU flag note
     the change. The .viewhint CSS hide rule stays as a guard.

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

# ---------- 1: style-block comment notes follow-up 2 -----------------------
rep("""   Follow-up (Frank, 2026-11-25): the menu-card "Tap to view" hint is
   hidden too (.menu-card .viewhint in the rule below); the cards still
   open the view-only item modal when tapped. */""",
    """   Follow-up (Frank, 2026-11-25): the menu-card "Tap to view" hint is
   hidden too (.menu-card .viewhint in the rule below); the cards still
   open the view-only item modal when tapped.
   Follow-up 2 (Frank, 2026-11-25): the hint still showed on Frank's
   phone and the tap-to-enlarge was unwanted, so in SIMPLE_MENU mode
   the hint is no longer rendered at all (see the card render in the
   page script) and menu cards are inert — openItem() returns
   immediately, so no tap, key press, search result or signature card
   can open the item modal. The .viewhint rule below stays only as a
   belt-and-suspenders guard. */""",
    "style-comment")

# ---------- 2: SIMPLE_MENU flag comment ------------------------------------
rep("""  // ===== Owner feedback 2026-11-25: SIMPLE MENU MODE (see the marked
  // <style> block in <head>). Ordering code stays intact; set
  // SIMPLE_MENU = false (and remove that style block) to restore it. =====""",
    """  // ===== Owner feedback 2026-11-25: SIMPLE MENU MODE (see the marked
  // <style> block in <head>). Ordering code stays intact; set
  // SIMPLE_MENU = false (and remove that style block) to restore it.
  // In this mode menu cards are inert (openItem returns immediately)
  // and the "Tap to view" hint is not rendered at all. =====""",
    "flag-comment")

# ---------- 3: cards get no button affordances in SIMPLE_MENU --------------
rep("""    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', dispName(item.n) + '. View details.');""",
    """    if (!SIMPLE_MENU) {
      card.setAttribute('tabindex', '0');
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', dispName(item.n) + '. View details.');
    }""",
    "card-affordances")

# ---------- 4: hint span is not rendered in SIMPLE_MENU --------------------
rep("""    html += '<span class="viewhint">' + (SIMPLE_MENU ? 'Tap to view' : 'Tap to view &amp; customize') + '</span>';""",
    """    if (!SIMPLE_MENU) html += '<span class="viewhint">Tap to view &amp; customize</span>';""",
    "hint-not-rendered")

# ---------- 5: openItem is gated off in SIMPLE_MENU ------------------------
rep("""  function openItem(idx, trigger){
    var item = MENU[idx];
    if (!item) return;""",
    """  function openItem(idx, trigger){
    if (SIMPLE_MENU) return; // SIMPLE MENU MODE: cards are inert — no item modal
    var item = MENU[idx];
    if (!item) return;""",
    "openitem-gate")

open(DST, "w", encoding="utf-8").write(html)
print("written bytes:", len(html))
print("OK — cards inert and hint not rendered inside SIMPLE_MENU mode")
