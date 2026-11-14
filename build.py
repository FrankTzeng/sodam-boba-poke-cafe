#!/usr/bin/env python3
"""Build the deployable Sodam server replica from the approved static preview.

Reads ~/workspace/your_files/sodam-boba-poke-cafe/sodam-boba-poke-cafe.html
(the designed preview: hero, Visit, reaction carousel) and patches its
in-page script so orders / staff sign-in / regulars sign-in / favourites talk
to the Node server in server.js instead of living only in the page's memory.

v2 (2026-11-14): the menu is REGENERATED from menu.json — the FIXED 80-item
Toast menu (Vanilla Latte Over Ice added, Blended Vanilla Latte removed,
Coke Zero with real can photos, Iced Strawberry/Mango Matcha names, Lavender
out of stock, Google Map in Visit). The preview's own MENU literal (71 items,
with the collapsed duplicate rows and picker fields) is replaced wholesale.
Every replacement is asserted to match exactly once (or an exact expected
count); the build fails loudly rather than shipping a half-patched file.
"""
import base64, json, os, sys

HOME = os.path.expanduser("~")
BASE = os.path.dirname(os.path.abspath(__file__))  # repo root, local or on Render
SRC = os.path.join(HOME, "workspace/your_files/sodam-boba-poke-cafe/sodam-boba-poke-cafe.html")
DST = os.path.join(BASE, "public/index.html")
MENU_JSON = os.path.join(BASE, "menu.json")
CANS_DIR = os.path.join(BASE, "assets/cans")
# MENU_IMGS indices 73/74/75 — real can product photos (Toast has no can photos).
# Sprite is a Toast-hosted photo from another restaurant's Toast menu;
# Coke and Coke Zero are clean product shots from other restaurants' menus.
CANS = ["can73-sprite.jpg", "can74-coke.jpg", "can75-coke-zero.jpg"]

# Render-safe: on the host the preview source and can photos are not present —
# public/index.html is already built and committed, so just keep it as-is.
# The built page is ~16 MB, too large for one API upload, so it is stored in
# the repo as public/index.html.part0..N — join them back if needed.
if not os.path.exists(SRC):
    if os.path.exists(DST):
        print("source preview not present (host build) — keeping existing public/index.html")
        sys.exit(0)
    import glob as _glob
    _parts = sorted(_glob.glob(DST + ".part*"))
    if _parts:
        with open(DST, "wb") as _out:
            for _p in _parts:
                with open(_p, "rb") as _f:
                    _out.write(_f.read())
        print(f"joined {len(_parts)} parts into public/index.html")
        sys.exit(0)
    print("FAIL: neither source preview nor built public/index.html found")
    sys.exit(1)

menu = json.load(open(MENU_JSON, encoding="utf-8"))
ITEMS = menu["items"]
assert len(ITEMS) == 80, f"expected 80 menu items, got {len(ITEMS)}"
assert [it["id"] for it in ITEMS] == list(range(1, 81)), "menu ids must be 1..80 in order"

def js_str(s):
    return json.dumps(s, ensure_ascii=True)

def menu_literal():
    lines = ["var MENU = ["]
    for it in ITEMS:
        parts = [
            "n:" + js_str(it["name"]),
            "p:%.2f" % (it["priceCents"] / 100.0),
            "c:" + js_str(it["category"]),
            "s:" + js_str(it["subcategory"]),
            "i:%d" % (it["photoIndex"] if it.get("photoIndex") is not None else -1),
        ]
        if it.get("badge"):
            parts.append("b:" + js_str(it["badge"]))
        if it.get("description"):
            parts.append("d:" + js_str(it["description"]))
        if it.get("kind") in ("bowl", "oki"):
            parts.append("k:" + js_str(it["kind"]))
        if it.get("ingredients"):
            parts.append("g:" + json.dumps(it["ingredients"], ensure_ascii=True))
        if it.get("outOfStock"):
            parts.append("o:1")
        lines.append("    {" + ", ".join(parts) + "},")
    lines[-1] = lines[-1].rstrip(",")
    lines.append("  ];")
    return "\n".join(lines)

def sub_notes_literal():
    notes = menu["options"]["subNotes"]
    lines = ["var SUB_NOTES = {"]
    keys = list(notes.keys())
    for idx, k in enumerate(keys):
        comma = "," if idx < len(keys) - 1 else ""
        lines.append("    " + js_str(k) + ": " + js_str(notes[k]) + comma)
    lines.append("  };")
    return "\n".join(lines)

def rep(html, old, new, label):
    n = html.count(old)
    if n != 1:
        print(f"FAIL [{label}]: expected 1 occurrence, found {n}")
        sys.exit(1)
    return html.replace(old, new)

def rep_all(html, old, new, label, expect=None):
    n = html.count(old)
    if n < 1:
        print(f"FAIL [{label}]: expected at least 1 occurrence, found 0")
        sys.exit(1)
    if expect is not None and n != expect:
        print(f"FAIL [{label}]: expected {expect} occurrences, found {n}")
        sys.exit(1)
    print(f"  [{label}]: replaced {n} occurrence(s)")
    return html.replace(old, new)

def splice(html, start_marker, end_marker, new_text, label):
    s = html.find(start_marker)
    if s < 0:
        print(f"FAIL [{label}]: start marker not found: {start_marker[:60]}")
        sys.exit(1)
    e = html.find(end_marker, s)
    if e < 0:
        print(f"FAIL [{label}]: end marker not found after start")
        sys.exit(1)
    e += len(end_marker)
    return html[:s] + new_text + html[e:]

html = open(SRC, encoding="utf-8", errors="ignore").read()
print("source bytes:", len(html))

# --- M0: regenerate the MENU literal from the fixed 80-item menu.json --------
html = splice(html, "var MENU = [", "\n  ];", menu_literal(), "MENU literal regen")
print("  [MENU literal regen]: 80 items from menu.json")

# --- M1: SUB_NOTES from the fixed menu (subcategory keys, Toast wording) ------
html = splice(html, "var SUB_NOTES = {", "\n  };", sub_notes_literal(), "SUB_NOTES regen")
print("  [SUB_NOTES regen]:", len(menu["options"]["subNotes"]), "notes")

# --- M1b: update the field comment (no pickers / similar photos any more) ----
cpos = html.find("  // n=name, p=price, c=tab category")
if cpos < 0:
    print("FAIL [field comment]: not found")
    sys.exit(1)
cend = html.find("\n", cpos)
html = html[:cpos] + ("  // n=name, p=price, c=tab category, s=Toast subcategory, i=Toast photo index "
    "(-1 = Toast has no photo for this item; the card shows 'Photo coming soon'), "
    "b=badge, d=Toast description, k=customize group key, g=ingredient list, "
    "o=1 means out of stock (Lavender Milk Tea Over Ice)") + html[cend:]

# --- M2: 'No photo available' -> 'Photo coming soon' (fixed-version wording) --
html = rep(html, "No photo available", "Photo coming soon", "photo-coming-soon card")

# --- M3: same wording in the item-detail modal (cup icon + text) ---------------
pos = html.find('id="modalImgNone" hidden>')
if pos < 0:
    print("FAIL [modal photo soon]: modalImgNone not found")
    sys.exit(1)
svg_end = html.find("</svg>", pos)
if svg_end < 0:
    print("FAIL [modal photo soon]: svg end not found")
    sys.exit(1)
svg_end += len("</svg>")
html = html[:svg_end] + '<span style="font-size:13px;letter-spacing:.06em">Photo coming soon</span>' + html[svg_end:]

# --- M4: out-of-stock badge on the menu card ----------------------------------
html = rep(html,
    "if (item.b) html += '<span class=\"badge\">' + item.b + '</span>';",
    "if (item.b) html += '<span class=\"badge\">' + item.b + '</span>';\n"
    "    if (item.o) html += '<span class=\"badge badge-oos\">OUT OF STOCK</span>';",
    "oos badge")

# --- M5: out-of-stock card button (disabled, no data-add) ----------------------
html = rep(html,
    r"""html += '<button type="button" class="add-btn" data-add="' + idx + '" aria-label="Add ' + item.n + ' to your pickup order">\uFF0B Add to Order</button>';""",
    r"""html += item.o ? '<button type="button" class="add-btn" disabled aria-label="' + item.n + ' is out of stock">Out of Stock</button>' : '<button type="button" class="add-btn" data-add="' + idx + '" aria-label="Add ' + item.n + ' to your pickup order">\uFF0B Add to Order</button>';""",
    "oos card button")

# --- M6: modal Add button respects out-of-stock (syncOrder runs on open) -------
html = rep(html,
    r"""if (ab && currentItem) ab.textContent = 'Add to Order \u00B7 ' + money(currentItem.p * qty);""",
    r"""if (ab && currentItem) { if (currentItem.o) { ab.disabled = true; ab.textContent = 'Out of Stock'; } else { ab.disabled = false; ab.textContent = 'Add to Order \u00B7 ' + money(currentItem.p * qty); } }""",
    "oos syncOrder")

# --- M7: quick-add (tap + on a card) refuses out-of-stock ----------------------
html = rep(html,
    "if (item.f) { openItem(idx, null); return; } // filling/flavor picker items must be picked in the item sheet first",
    "if (item.f) { openItem(idx, null); return; } // filling/flavor picker items must be picked in the item sheet first\n"
    r"""    if (item.o) { showToast('Sorry \u2014 ' + item.n + ' is out of stock right now.'); return; }""",
    "oos quickAdd guard")

# --- M8: belt-and-braces — modal Add handler also refuses out-of-stock ---------
html = rep(html,
    "if (!currentItem) return;\n    var opts = collectOptions();",
    "if (!currentItem) return;\n    if (currentItem.o) return;\n    var opts = collectOptions();",
    "oos modal add guard")

# --- M9: signature renames (fixed names) ---------------------------------------
html = rep_all(html, "Strawberry Matcha Cream", "Iced Strawberry Matcha", "sig rename strawberry", expect=5)
html = rep_all(html, "Mango Matcha Cream", "Iced Mango Matcha", "sig rename mango", expect=5)

# --- M10: embedded Google Map in Visit (like Toast's) ---------------------------
html = rep(html,
    "    </div>\n  </section>\n  <!-- STORY -->",
    "    </div>\n"
    "  <div class=\"wrap\" style=\"margin-top:28px\"><iframe title=\"Map \\u2014 Sodam Boba &amp; Poke Cafe, 23211 Hawthorne Boulevard, Torrance\" src=\"https://www.google.com/maps?q=Sodam+Boba+%26+Poke+Cafe,+23211+Hawthorne+Blvd,+Suite+100,+Torrance,+CA+90505&amp;output=embed\" style=\"width:100%;height:340px;border:0;border-radius:10px\" loading=\"lazy\" referrerpolicy=\"no-referrer-when-downgrade\" allowfullscreen></iframe></div>\n"
    "  </section>\n  <!-- STORY -->",
    "visit map")

# --- M11: append the 3 real can photos to MENU_IMGS (indices 73/74/75) ---------
can_uris = []
for fname in CANS:
    with open(os.path.join(CANS_DIR, fname), "rb") as f:
        can_uris.append("data:image/jpeg;base64," + base64.b64encode(f.read()).decode("ascii"))
arr_start = html.find("var MENU_IMGS=[")
if arr_start < 0:
    print("FAIL [can photos]: MENU_IMGS not found")
    sys.exit(1)
arr_end = html.find('"];', arr_start)
if arr_end < 0:
    print("FAIL [can photos]: MENU_IMGS close not found")
    sys.exit(1)
# arr_end is the closing quote of the last entry — insert AFTER it, before ].
arr_end += 1
insert = ',"' + '","'.join(can_uris) + '"'
html = html[:arr_end] + insert + html[arr_end:]
region = html[arr_start:html.find('"];', arr_start)]
n_imgs = region.count("data:image/jpeg;base64,")
if n_imgs != 76:
    print(f"FAIL [can photos]: expected 76 MENU_IMGS entries, found {n_imgs}")
    sys.exit(1)
print("  [can photos]: MENU_IMGS now 76 entries (73 Toast + 3 cans)")

# --- P0: remove the preview's client-side staff password hash -----------------
html = rep(html,
    "var STAFF_PASSWORD_HASH = 'df3cabf7310b54502aef490e8f5ba1bd258b5dd3df7bdbf2db82610c6752a344';",
    "var STAFF_PASSWORD_HASH = ''; // staff sign-in is checked on the server now (/api/staff/login); no password or hash lives in this page.",
    "staff hash removal")

# --- P1: full-photo frames (Frank's v5 fix: whole photo, same size, not cut) -
html = rep(html, "</head>",
    """<style>
/* Server replica: show the whole photo inside the same-size frame, never cropped (Frank's fix). */
.menu-card .photo img{object-fit:contain !important;background:#fff}
.sigcard-thumb img{object-fit:contain !important;background:#fff}
.badge-oos{background:#8a8a8a !important}
</style>
</head>""", "photo-fit css")

# --- P2: staff token helpers ---------------------------------------------------
html = rep(html,
    "var staffAuthed = false; // in-memory only for this page session — never saved to localStorage",
    "var staffAuthed = false; // in-memory only for this page session — never saved to localStorage\n"
    "  function __staffToken(){ try { return window.sessionStorage.getItem('sodam_staff_token') || ''; } catch(e){ return ''; } }\n"
    "  function __setStaffToken(t){ try { if (t) window.sessionStorage.setItem('sodam_staff_token', t); else window.sessionStorage.removeItem('sodam_staff_token'); } catch(e){} }",
    "staff token helpers")

# --- P3: staff sign-in -> server ----------------------------------------------
old_try = """  function tryStaffSignin(){
    var err = document.getElementById('staffPwError');
    var val = document.getElementById('staffPw').value;
    if (!val) { staffPwFail(); return; }
    var hex = '';
    try { hex = sha256Hex(unescape(encodeURIComponent(val))); } catch(e) { hex = ''; }
    if (hex && hex === STAFF_PASSWORD_HASH) {
      staffAuthed = true;
      if (err) err.hidden = true;
      closeStaffSignin();
      renderStaffGate();
      showToast('Staff signed in — Staff Board unlocked');
      document.getElementById('staff').scrollIntoView({behavior: 'auto'});
    } else staffPwFail();
  }"""
new_try = """  function tryStaffSignin(){
    var err = document.getElementById('staffPwError');
    var val = document.getElementById('staffPw').value;
    if (!val) { staffPwFail(); return; }
    fetch('/api/staff/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({password: val})})
    .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||'Wrong password'); return j; }); })
    .then(function(j){
      __setStaffToken(j.token);
      staffAuthed = true;
      if (err) err.hidden = true;
      closeStaffSignin();
      renderStaffGate();
      renderStaff();
      showToast('Staff signed in — Staff Board unlocked');
      document.getElementById('staff').scrollIntoView({behavior: 'auto'});
    })
    .catch(function(){ staffPwFail(); });
  }"""
html = rep(html, old_try, new_try, "tryStaffSignin server login")

# --- P4: staff sign-out clears the server session ------------------------------
html = rep(html,
    """  if (staffSignOutBtn) staffSignOutBtn.addEventListener('click', function(){
    staffAuthed = false;""",
    """  if (staffSignOutBtn) staffSignOutBtn.addEventListener('click', function(){
    fetch('/api/staff/logout', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({token: __staffToken()})}).catch(function(){});
    __setStaffToken('');
    staffAuthed = false;""",
    "staff sign-out")

# --- P5: renderStaff fetches the shared order list from the server ------------
old_head = """  function renderStaff(){
    if (!staffAuthed) {
      var lockedBoard = document.getElementById('staffBoard');
      if (lockedBoard) lockedBoard.innerHTML = '';
      var c0 = document.getElementById('staffCounts');
      if (c0) c0.textContent = '0 new · 0 preparing · 0 ready';
      return;
    }
    var counts = {new:0, preparing:0, ready:0, picked_up:0};"""
new_head = """  var __staffFetching = false;
  var __lastStaffIds = '';
  function renderStaff(){
    if (!staffAuthed) {
      var lockedBoard = document.getElementById('staffBoard');
      if (lockedBoard) lockedBoard.innerHTML = '';
      var c0 = document.getElementById('staffCounts');
      if (c0) c0.textContent = '0 new · 0 preparing · 0 ready';
      return;
    }
    if (__staffFetching) return;
    __staffFetching = true;
    fetch('/api/staff/orders', {headers:{'Authorization':'Bearer ' + __staffToken()}})
    .then(function(r){ if(!r.ok) throw new Error('staff orders failed'); return r.json(); })
    .then(function(list){
      __staffFetching = false;
      var ids = list.map(function(o){ return o.id; }).join(',');
      var arrived = __lastStaffIds && ids !== __lastStaffIds && list.length && list[0].status === 'new';
      __lastStaffIds = ids;
      orders.length = 0; list.forEach(function(o){ orders.push(o); });
      list.forEach(function(o){ if (o.status === 'new' && alertList.indexOf(o.id) === -1) alertList.push(o.id); });
      syncAlerts();
      if (arrived && soundOn) playChime();
      __renderStaffList();
    })
    .catch(function(){ __staffFetching = false; __renderStaffList(); });
  }
  function __renderStaffList(){
    var counts = {new:0, preparing:0, ready:0, picked_up:0};"""
html = rep(html, old_head, new_head, "renderStaff server fetch")

# --- P6: staff status changes -> server ---------------------------------------
html = rep(html,
    "    orders.forEach(function(o){ if (o.id === id) o.status = sel.value; });",
    "    fetch('/api/staff/orders/' + id + '/status', {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer ' + __staffToken()}, body: JSON.stringify({status: sel.value})}).catch(function(){});\n"
    "    orders.forEach(function(o){ if (o.id === id) o.status = sel.value; });",
    "status select server update")
html = rep(html,
    "    orders.forEach(function(o){ if (o.id === id) o.status = btn.getAttribute('data-next'); });",
    "    var __next = btn.getAttribute('data-next');\n"
    "    fetch('/api/staff/orders/' + id + '/status', {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer ' + __staffToken()}, body: JSON.stringify({status: __next})}).catch(function(){});\n"
    "    orders.forEach(function(o){ if (o.id === id) o.status = __next; });",
    "status next-button server update")

# --- P7: place order -> server (server reprices, server assigns the number) ---
old_tail = """    orderSeq++;
    orders.unshift(order);
    lastPlacedId = order.id;
    saveOrderToHistory(order);
    cart = [];
    closeCart();
    renderCart(); renderStaff(); renderConfirmation(); renderAccount();
    alertList.unshift(order.id);
    alertDismissed = false;
    syncAlerts();
    if (soundOn && staffAuthed) playChime();
    document.getElementById('confirmation').scrollIntoView({behavior: reduceMotion ? 'auto' : 'smooth'});
  });"""
new_tail = """    orderSeq++;
    (function(){
      var localOrder = order;
      fetch('/api/orders', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name: localOrder.name, phone: localOrder.phone, pickupLabel: localOrder.pickupLabel, notes: localOrder.notes, items: localOrder.items})})
      .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||'Order failed'); return j; }); })
      .then(function(serverOrder){
        localOrder.id = serverOrder.id; localOrder.number = serverOrder.number; localOrder.totalCents = serverOrder.totalCents; localOrder.status = serverOrder.status; localOrder.placedLabel = serverOrder.placedLabel;
        orders.unshift(localOrder);
        lastPlacedId = localOrder.id;
        saveOrderToHistory(localOrder);
        cart = [];
        closeCart();
        renderCart(); renderStaff(); renderConfirmation(); renderAccount();
        alertList.unshift(localOrder.id);
        alertDismissed = false;
        syncAlerts();
        if (soundOn && staffAuthed) playChime();
        document.getElementById('confirmation').scrollIntoView({behavior: reduceMotion ? 'auto' : 'smooth'});
      })
      .catch(function(e){ err.textContent = 'Could not place the order — please try again. (' + e.message + ')'; err.hidden = false; });
    })();
  });"""
html = rep(html, old_tail, new_tail, "placeOrder server")

# --- P8: regulars sign-in loads favourites + history from the server ----------
html = rep(html,
    """    currentUser = {name: name, phone: phone};
    writeJSON(LS_USER, currentUser);""",
    """    currentUser = {name: name, phone: phone};
    writeJSON(LS_USER, currentUser);
    fetch('/api/regulars/signin', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name: name, phone: phone})})
    .then(function(r){ return r.json(); })
    .then(function(j){
      if (j && j.favourites) { var f = favsMap(); f[phoneKey(phone)] = j.favourites.map(function(id){ return id - 1; }).filter(function(i){ return !!MENU[i]; }); writeJSON(LS_FAVS, f); }
      if (j && j.orders) { var h = historyMap(); h[phoneKey(phone)] = j.orders; writeJSON(LS_HIST, h); }
      renderAccount(); updateFavStars();
    })
    .catch(function(){});""",
    "regulars signin sync")

# --- P9: favourite toggle -> server --------------------------------------------
html = rep(html,
    """    setMyFavs(favs);
    updateFavStars();""",
    """    setMyFavs(favs);
    fetch('/api/regulars/favourites', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({phone: currentUser.phone, itemId: idx + 1, on: favs.indexOf(idx) !== -1})}).catch(function(){});
    updateFavStars();""",
    "favourite toggle sync")

# --- P10: boot — restore staff session, poll for new orders --------------------
html = rep(html,
    """  buildPickupSlots();
  renderCart();
  renderStaffGate();
  initAccount();""",
    """  buildPickupSlots();
  renderCart();
  renderStaffGate();
  initAccount();
  // Server replica: restore a staff session (token lives in this browser session only) and poll for new orders while the board is open.
  (function(){
    var t = __staffToken();
    if (t) {
      fetch('/api/staff/orders', {headers:{'Authorization':'Bearer ' + t}})
      .then(function(r){ if(!r.ok) throw new Error('no session'); return r.json(); })
      .then(function(){ staffAuthed = true; renderStaffGate(); renderStaff(); })
      .catch(function(){ __setStaffToken(''); });
    }
    setInterval(function(){ if (staffAuthed) renderStaff(); }, 10000);
  })();""",
    "boot restore + poll")

# --- P11: copy that was only true for the device-only preview ------------------
html = rep(html,
    "First version to explore: your sign-in, favorites, and past orders are saved on this device and browser only — they&rsquo;ll be here next time you order from the same phone or computer, but they don&rsquo;t follow you to a different device yet.",
    "Your sign-in, favorites, and past orders are saved with the cafe, so they follow you to any device — sign in with the same phone number.",
    "device note")
html = rep(html,
    "We&rsquo;ll pull up your favorites and past orders on this device so you can repeat an order in one tap.",
    "We&rsquo;ll pull up your favorites and past orders so you can repeat an order in one tap.",
    "signin modal copy")
html = rep(html,
    "First version to explore: this stays on this device and browser only. Prefer not to sign in? Guest checkout works exactly as always — just close this and order.",
    "Your sign-in is saved with the cafe and follows you across devices. Prefer not to sign in? Guest checkout works exactly as always — just close this and order.",
    "signin modal note")
html = rep(html,
    "it is set in the page code as a hash (look for STAFF_PASSWORD_HASH), never printed here.",
    "it is checked on the cafe&rsquo;s server, never printed here.",
    "staff test note")
html = rep(html,
    "Sign in to see your favorites and past orders on this device — then tap <strong>Order again</strong> and your usual is back in your pickup order. Ordered as a guest on this device before?",
    "Sign in to see your favorites and past orders — then tap <strong>Order again</strong> and your usual is back in your pickup order. Ordered as a guest before?",
    "been here before copy")
html = rep(html,
    "No previous orders on this device yet — once you place a pickup order, it will appear here so you can repeat it in one tap.",
    "No previous orders yet — once you place a pickup order, it will appear here so you can repeat it in one tap.",
    "no previous orders copy")

os.makedirs(os.path.dirname(DST), exist_ok=True)
open(DST, "w", encoding="utf-8").write(html)
print("wrote", DST, "bytes:", len(html))
print("OK — all patches applied")
