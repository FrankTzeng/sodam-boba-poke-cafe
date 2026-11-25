#!/usr/bin/env python3
"""Owner feedback 2026-11-25 — simple menu site.

Applies the Sodam owner's requested changes to public/index.html:
  1. Site ordering removed (Add to Order / cart / checkout / item options);
     online ordering is Toast-only via the red ORDER HERE buttons (kept).
  2. All prices removed from customer display.
  3. Regulars sign-in + Favourites / Order Again HIDDEN (not deleted):
     gated by the SIMPLE_MENU flag in the page script + the marked <style>
     block in <head>. Restore = set SIMPLE_MENU=false and delete that
     style block. All ordering code, server endpoints and data stay intact.
  4. " (*raw)" appended to the display names of the owner's 9 items
     (display-only via dispName(); internal names/data unchanged).
  5. Owner photos added for Iced Jasmine Green Tea (Unsweetened),
     Mango Smoothie, Strawberry Slush, Cookies & Cream Blended
     (MENU_IMGS indices 76-79; menu.json photoIndex updated to match).
  6. Story-section bowl photo replaced with the owner's new top-down
     salmon & tuna poke bowl photo.
  7. Our Story copy replaced with the owner's verbatim 3 paragraphs
     (read from the spec file so the wording is exact).

Every replacement is asserted; the script fails loudly rather than
shipping a half-patched file (same convention as build.py).
"""
import base64, json, os, re, sys

BASE = os.path.dirname(os.path.abspath(__file__))
DST = os.path.join(BASE, "public", "index.html")
WORK = os.path.expanduser("~/workspace/sodam-owner-work")
SPEC = os.path.expanduser("~/workspace/sodam-owner-photos-2026-11-25/owner-feedback-2026-11-25.md")
URIS = json.load(open(os.path.join(WORK, "photo_uris.json")))

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

def rep_re(pattern, new, label, expect):
    global html
    n = len(re.findall(pattern, html))
    if n != expect:
        print(f"FAIL [{label}]: expected {expect} match(es), found {n}")
        sys.exit(1)
    html = re.sub(pattern, new.replace("\\", "\\\\"), html)
    print(f"  [{label}]: replaced {n}")

# ---------- 1+2+3: SIMPLE MENU style gate in <head> -------------------------
CSS = """<style>
/* ===== Owner feedback 2026-11-25: SIMPLE MENU MODE =====
   Ordering moved to Toast only; prices, the site's own ordering,
   regulars sign-in and favourites are hidden (not deleted). To restore
   them: delete this style block AND set SIMPLE_MENU = false in the
   page script. All ordering code, server endpoints and data are intact. */
#cartBtn,#accountBtn,#staffNavLink,#signinModal,#regulars,#tabFavs,
#floatCart,#cartModal,#confirmation,#addedToast,.fav-star,.price,
.sigcard-price,.add-btn,#modalPrice,#modalCustomize,#modalExtra,
#modalNotes,#itemModal .qty-row,#itemModal .modal-addrow,
#itemModal .modal-note,#itemModal .modal-body > h4{display:none !important}
#mainNav a[href="#regulars"]{display:none !important}
</style>
</head>"""
rep("</head>", CSS, "simple-menu CSS gate")

# ---------- JS flag + (*raw) display names ----------------------------------
FLAG = """function imgPath(i){ return MENU_IMGS[i]; }
  // ===== Owner feedback 2026-11-25: SIMPLE MENU MODE (see the marked
  // <style> block in <head>). Ordering code stays intact; set
  // SIMPLE_MENU = false (and remove that style block) to restore it. =====
  var SIMPLE_MENU = true;
  var RAW_ITEMS = {"Salmon & Tuna Poke Bowl":1, "Spicy Salmon & Tuna Poke Bowl":1, "Tuna Poke Bowl":1, "Spicy Tuna Poke Bowl":1, "Spicy Tuna Onigiri / Okinawa Style":1, "Ahi Tuna Rice Ball":1, "Spicy Tuna Rice Ball":1, "Salmon Rice Ball":1, "Spicy Salmon Rice Ball":1};
  function dispName(n){ return RAW_ITEMS[n] ? n + ' (*raw)' : n; }"""
rep("function imgPath(i){ return MENU_IMGS[i]; }", FLAG, "SIMPLE_MENU flag + dispName")

# ---------- menu card render -------------------------------------------------
rep("card.setAttribute('aria-label', item.n + ' — ' + money(item.p) + '. View details.');",
    "card.setAttribute('aria-label', dispName(item.n) + '. View details.');",
    "card aria-label (no price, raw name)")
rep("var starHtml = '<button type=\"button\" class=\"fav-star\"",
    "var starHtml = SIMPLE_MENU ? '' : '<button type=\"button\" class=\"fav-star\"",
    "card favourite star gated")
rep("html += '<h3>' + item.n + '</h3>';",
    "html += '<h3>' + dispName(item.n) + '</h3>';",
    "card name (*raw)")
rep("html += '<div class=\"price\">' + money(item.p) + '</div>';",
    "if (!SIMPLE_MENU) html += '<div class=\"price\">' + money(item.p) + '</div>';",
    "card price gated")
rep("html += item.o ? '<button type=\"button\" class=\"add-btn\" disabled",
    "if (!SIMPLE_MENU) html += item.o ? '<button type=\"button\" class=\"add-btn\" disabled",
    "card add-to-order gated")
rep("html += '<span class=\"viewhint\">Tap to view &amp; customize</span>';",
    "html += '<span class=\"viewhint\">' + (SIMPLE_MENU ? 'Tap to view' : 'Tap to view &amp; customize') + '</span>';",
    "card view hint")
rep("html += '<p class=\"sim-note\">Photo shows a similar item (' + item.rn + ') — Toast has no photo for this one.</p>';",
    "html += '<p class=\"sim-note\">Photo shows a similar item (' + dispName(item.rn) + ') — Toast has no photo for this one.</p>';",
    "card sim-note raw name")

# ---------- item modal --------------------------------------------------------
rep("modalName.textContent = item.n;",
    "modalName.textContent = dispName(item.n);", "modal name (*raw)")
rep("modalPrice.textContent = money(item.p);",
    "modalPrice.textContent = SIMPLE_MENU ? '' : money(item.p);", "modal price gated")
rep("var groups = groupsFor(item);",
    "var groups = SIMPLE_MENU ? [] : groupsFor(item);", "modal option groups gated")
rep("modalSimNote.textContent = 'Photo shows a similar item (' + item.rn + ') — Toast has no photo for the ' + item.n + '.';",
    "modalSimNote.textContent = 'Photo shows a similar item (' + dispName(item.rn) + ') — Toast has no photo for the ' + dispName(item.n) + '.';",
    "modal sim-note raw names")
rep("    if (item.c === 'drinks' && item.s !== 'Can Soda') kind =",
    "    if (SIMPLE_MENU) kind = ''; else if (item.c === 'drinks' && item.s !== 'Can Soda') kind =",
    "modal extra kind gated")
rep("if (item.f === 'onigiri') selField(",
    "if (!SIMPLE_MENU && item.f === 'onigiri') selField(", "modal filling selector gated")
rep("if (item.f === 'blended' || item.f === 'ade') selField(",
    "if (!SIMPLE_MENU && (item.f === 'blended' || item.f === 'ade')) selField(", "modal flavor selector gated")

# ---------- search results -----------------------------------------------------
rep("rn.textContent = item.n;", "rn.textContent = dispName(item.n);", "search result name (*raw)")
rep("rp.textContent = money(item.p);",
    "rp.textContent = SIMPLE_MENU ? '' : money(item.p);", "search result price gated")

# ---------- 5: MENU photo indices for the 4 owner drinks ----------------------
rep('{n:"Iced Jasmine Green Tea (Unsweetened)", p:3.75, c:"drinks", s:"Fruit Tea", i:-1}',
    '{n:"Iced Jasmine Green Tea (Unsweetened)", p:3.75, c:"drinks", s:"Fruit Tea", i:76}', "jasmine photo index")
rep('{n:"Mango Smoothie", p:5.45, c:"drinks", s:"Smoothies", i:-1}',
    '{n:"Mango Smoothie", p:5.45, c:"drinks", s:"Smoothies", i:77}', "mango photo index")
rep('{n:"Strawberry Slush", p:5.45, c:"drinks", s:"Slushies", i:-1}',
    '{n:"Strawberry Slush", p:5.45, c:"drinks", s:"Slushies", i:78}', "strawberry photo index")
rep('{n:"Cookies & Cream Blended", p:5.99, c:"drinks", s:"Milk Tea Blended", i:-1}',
    '{n:"Cookies & Cream Blended", p:5.99, c:"drinks", s:"Milk Tea Blended", i:79}', "cookies photo index")

# ---------- 5: append the 4 photos to MENU_IMGS (76-79) -----------------------
arr_start = html.find("var MENU_IMGS=[")
if arr_start < 0:
    print("FAIL [MENU_IMGS append]: array not found"); sys.exit(1)
arr_end = html.find('"];', arr_start)
if arr_end < 0:
    print("FAIL [MENU_IMGS append]: array close not found"); sys.exit(1)
arr_end += 1  # closing quote of last entry
new_imgs = [URIS["jasmine"], URIS["mango"], URIS["strawberry"], URIS["cookies"]]
insert = ',"' + '","'.join(new_imgs) + '"'
html = html[:arr_end] + insert + html[arr_end:]
region = html[arr_start:html.find('"];', arr_start)]
n_imgs = region.count("data:image/jpeg;base64,")
if n_imgs != 80:
    print(f"FAIL [MENU_IMGS append]: expected 80 entries, found {n_imgs}"); sys.exit(1)
print("  [MENU_IMGS append]: 80 entries (76 existing + 4 owner photos)")

# ---------- hero: remove the site-ordering CTA --------------------------------
rep('<a class="btn btn-solid" href="#menu">Order Pickup — Pay at the Cafe</a>\n          ',
    '',
    "hero pickup-order CTA removed")

# ---------- signatures section --------------------------------------------------
rep("Swipe sideways and tap any card to see it in full — then add it to your pickup order.",
    "Swipe sideways and tap any card to see it in full.",
    "signatures intro copy")
rep_re(r'<span class="sigcard-price">\$[0-9.]+</span>', "", "sigcard price spans removed", expect=6)
rep('aria-label="Spicy Salmon and Tuna Poke Bowl — $14.99. View details."',
    'aria-label="Spicy Salmon and Tuna Poke Bowl (*raw). View details."', "sigcard bestseller aria-label")
rep_re(r' aria-label="([A-Za-z ]+) — \$5\.45\. View details\."', r' aria-label="\1. View details."',
       "sigcard drink aria-labels (prices out)", expect=5)
rep("<h3>Spicy Salmon &amp; Tuna Poke Bowl</h3>",
    "<h3>Spicy Salmon &amp; Tuna Poke Bowl (*raw)</h3>", "sigcard bestseller name (*raw)")
rep('<span class="view">View &amp; Customize &#8599;</span>',
    '<span class="view">View &#8599;</span>', "sigcard view label", expect=6)
rep('aria-label="Show signature item 1 — Spicy Salmon and Tuna Poke Bowl"',
    'aria-label="Show signature item 1 — Spicy Salmon and Tuna Poke Bowl (*raw)"', "sig dot aria-label")

# ---------- menu intro copy ------------------------------------------------------
i = html.find("<h2>Menu Highlights</h2>")
if i < 0:
    print("FAIL [menu intro]: heading not found"); sys.exit(1)
p_start = html.find("<p>", i)
p_end = html.find("</p>", p_start)
if p_start < 0 or p_end < 0:
    print("FAIL [menu intro]: paragraph not found"); sys.exit(1)
NEW_INTRO = ("The full menu, built from Sodam's Toast page — every category, item and photo Toast lists. "
             "Tap any item to see it up close. To order online, tap the red Order Here button — "
             "online orders go through Toast. Where Toast lists no description for a drink, "
             "none is shown for it here either.")
html = html[:p_start + 3] + NEW_INTRO + html[p_end:]
print("  [menu intro]: copy replaced")

# ---------- 7: Our Story — owner text verbatim from the spec -------------------
spec = open(SPEC, encoding="utf-8").read()
paras, cur = [], []
for line in spec.splitlines():
    if line.startswith("> "):
        cur.append(line[2:])
    elif line.strip() == ">" or (line == ">" ):
        if cur: paras.append(" ".join(cur)); cur = []
    elif cur and not line.startswith(">"):
        paras.append(" ".join(cur)); cur = []
if cur: paras.append(" ".join(cur))
paras = [p.strip() for p in paras if p.strip()]
if len(paras) != 3:
    print(f"FAIL [our story]: expected 3 paragraphs from spec, got {len(paras)}"); sys.exit(1)
s_start = html.find('<p class="story-state" data-reveal>')
s_end_anchor = "built one guest at a time.</p>"
s_end = html.find(s_end_anchor)
if s_start < 0 or s_end < 0:
    print("FAIL [our story]: story copy anchors not found"); sys.exit(1)
s_end += len(s_end_anchor)
story_html = "\n      ".join(f'<p class="story-copy" data-reveal>{p}</p>' for p in paras)
html = html[:s_start] + story_html + html[s_end:]
print("  [our story]: owner text installed verbatim (3 paragraphs)")

# ---------- 6: story bowl photo -> owner's new poke bowl photo ------------------
ALT_OLD = 'alt="Sodam bowl with seasoned beef, rice, cucumber, tomatoes, corn, and greens"'
a = html.find(ALT_OLD)
if a < 0:
    print("FAIL [story photo]: beef bowl alt not found"); sys.exit(1)
src_start = html.rfind('src="data:image/jpeg;base64,', 0, a)
if src_start < 0:
    print("FAIL [story photo]: img src not found"); sys.exit(1)
src_end = html.find('"', src_start + 5)
old_uri = html[src_start + 5:src_end]
html = html[:src_start + 5] + URIS["poke"] + html[src_end:]
rep(ALT_OLD,
    'alt="Sodam Salmon and Tuna Poke Bowl seen from above — salmon and tuna cubes with avocado, seaweed salad, imitation crab and a lemon half"',
    "story photo alt updated")
print(f"  [story photo]: replaced ({len(old_uri)//1024} KB uri -> {len(URIS['poke'])//1024} KB uri)")

open(DST, "w", encoding="utf-8").write(html)
print("written:", DST, len(html), "bytes")

# ---------- menu.json photoIndex consistency -----------------------------------
mpath = os.path.join(BASE, "menu.json")
menu = json.load(open(mpath, encoding="utf-8"))
by_name = {it["name"]: it for it in menu["items"]}
for name, idx in [("Iced Jasmine Green Tea (Unsweetened)", 76), ("Mango Smoothie", 77),
                  ("Strawberry Slush", 78), ("Cookies & Cream Blended", 79)]:
    if by_name[name]["photoIndex"] is not None:
        print(f"FAIL [menu.json]: {name} already has photoIndex"); sys.exit(1)
    by_name[name]["photoIndex"] = idx
json.dump(menu, open(mpath, "w", encoding="utf-8"), indent=1, sort_keys=True)
print("  [menu.json]: photoIndex set for the 4 owner drinks (76-79)")
