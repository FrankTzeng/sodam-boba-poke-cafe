#!/usr/bin/env node
/**
 * Sodam Boba & Poke Cafe — server replica (standalone, Node stdlib only).
 *
 * Serves the Sodam site (public/index.html, built by build.py from the
 * approved preview) and the small JSON API the page calls:
 *
 *   GET  /api/menu                    menu + options (prices are set here)
 *   POST /api/orders                  place a pickup order (server reprices)
 *   POST /api/staff/login             shared staff password -> 12h token
 *   POST /api/staff/logout            invalidate a token
 *   GET  /api/staff/orders            all orders, newest first (staff only)
 *   POST /api/staff/orders/:id/status move an order new->preparing->ready->picked_up
 *   POST /api/regulars/signin         name+phone -> favourites + past orders
 *   POST /api/regulars/favourites     star / unstar an item (follows the phone)
 *
 * Pay at pickup only. No online payment, no Stripe — payment fields for
 * Stripe later are a future step, not built here.
 *
 * State lives in ./data/db.json (JSON file). On Render's free tier the disk
 * is ephemeral: a redeploy or a host restart loses orders. That is fine for
 * the owner demo; for real live use the data needs a small hosted database.
 *
 * Staff password: env STAFF_PASSWORD. Default test password is
 * "sodam-staff-2026" — the same test password Frank was given for the Muse
 * server version. The owner MUST pick a real one before going live
 * (set STAFF_PASSWORD on the host; never put the real password in this repo).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'sodam-staff-2026';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const menu = JSON.parse(fs.readFileSync(path.join(__dirname, 'menu.json'), 'utf8'));

// Hero video: stored in the repo as base64 text parts under video/ (the
// repo sync is text-only); decoded once at startup and served from memory.
let HERO_VIDEO = null;
try {
  const vdir = path.join(__dirname, 'video');
  const parts = fs.readdirSync(vdir).filter((f) => f.startsWith('hero.mp4.b64.part')).sort();
  if (parts.length) {
    const b64 = parts.map((f) => fs.readFileSync(path.join(vdir, f), 'utf8')).join('');
    HERO_VIDEO = Buffer.from(b64, 'base64');
    console.log('Hero video loaded: ' + HERO_VIDEO.length + ' bytes from ' + parts.length + ' parts');
  }
} catch (e) {
  console.log('Hero video not loaded: ' + (e && e.message || e));
}
const MENU_BY_NAME = new Map(menu.items.map((it) => [it.name, it]));
const MENU_BY_ID = new Map(menu.items.map((it) => [it.id, it]));

// ---------------------------------------------------------------- db ----------
function blankDb() {
  return { seq: 1001, orders: [], customers: {}, tokens: {} };
}
function loadDb() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!d || !Array.isArray(d.orders) || typeof d.seq !== 'number') return blankDb();
    d.customers = d.customers || {};
    d.tokens = d.tokens || {};
    return d;
  } catch (e) {
    return blankDb();
  }
}
function saveDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}
let db = loadDb();

// ------------------------------------------------------------ helpers ---------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendText(res, code, text, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain', 'Cache-Control': 'no-store' });
  res.end(text);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
function phoneKey(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}
function placedLabel() {
  // e.g. "Sat, Nov 14, 2:41 PM" in the cafe's timezone
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short',
    day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}
function bearer(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : '';
}
function staffAuthed(req) {
  const t = bearer(req);
  if (!t) return false;
  const rec = db.tokens[t];
  if (!rec) return false;
  if (Date.now() > rec.expires) { delete db.tokens[t]; saveDb(db); return false; }
  return true;
}
function publicOrder(o) {
  // The page's money() expects dollars (its cart lines carry item.p = 14.99),
  // while the server stores cents internally — so the wire format is dollars
  // for line prices and cents for the order total (totalCents), matching the
  // page's own local order objects. Without this the staff board renders
  // "$1499.00" for a $14.99 bowl.
  return {
    id: o.id, number: o.number, name: o.name, phone: o.phone,
    pickupLabel: o.pickupLabel, notes: o.notes || '',
    items: o.items.map((it) => ({ ...it, unitPrice: it.unitPrice / 100 })),
    totalCents: o.totalCents, status: o.status, placedLabel: o.placedLabel,
  };
}

// ------------------------------------------------------------- routes --------
async function handleApi(req, res, url) {
  const method = req.method;
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  // GET /api/menu
  if (method === 'GET' && parts.join('/') === 'api/menu') return send(res, 200, menu);

  // POST /api/orders
  if (method === 'POST' && parts.join('/') === 'api/orders') {
    let b;
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const name = String(b.name || '').trim();
    const phone = String(b.phone || '').trim();
    const pickupLabel = String(b.pickupLabel || '').trim();
    if (!name) return send(res, 400, { error: 'Please enter the name for pickup.' });
    if (phoneKey(phone).length < 7) return send(res, 400, { error: 'Please enter a phone number the cafe can reach.' });
    if (!pickupLabel) return send(res, 400, { error: 'Please choose a pickup time.' });
    if (!Array.isArray(b.items) || !b.items.length) return send(res, 400, { error: 'Your order is empty.' });

    // Reprice every line from the server menu — the page's prices are never trusted.
    const items = [];
    let totalCents = 0;
    for (const line of b.items) {
      const m = MENU_BY_NAME.get(String(line.name || ''));
      if (!m) return send(res, 400, { error: 'Unknown menu item: ' + String(line.name || '') });
      if (m.outOfStock) return send(res, 400, { error: m.name + ' is out of stock right now.' });
      const qty = Math.max(1, Math.min(99, parseInt(line.quantity, 10) || 1));
      // The page sends unitPrice as a dollar float (e.g. 14.99); accept that
      // as well as cents (1499) — a real browser order must never 400 here.
      const sent = Number(line.unitPrice);
      const sentCents = (Number.isInteger(sent) && sent >= 100) ? sent : Math.round(sent * 100);
      if (sentCents !== m.priceCents) {
        return send(res, 400, { error: 'Price mismatch for ' + m.name + ' — please reload the menu.' });
      }
      const opts = Array.isArray(line.options) ? line.options.map(String).slice(0, 20) : [];
      items.push({
        name: m.name, unitPrice: m.priceCents, quantity: qty,
        options: opts, notes: String(line.notes || '').slice(0, 300),
        sig: line.sig ? String(line.sig) : undefined,
      });
      totalCents += m.priceCents * qty;
    }

    const order = {
      id: db.seq, number: 'S-' + db.seq, name, phone, pickupLabel,
      notes: String(b.notes || '').slice(0, 500), items, totalCents,
      status: 'new', placedLabel: placedLabel(),
    };
    db.seq += 1;
    db.orders.unshift(order);
    const key = phoneKey(phone);
    const cust = db.customers[key] || (db.customers[key] = { name, phone, favourites: [] });
    cust.name = name; cust.phone = phone;
    saveDb(db);
    return send(res, 201, publicOrder(order));
  }

  // POST /api/staff/login
  if (method === 'POST' && parts.join('/') === 'api/staff/login') {
    let b;
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const pw = String(b.password || '');
    // Constant-time compare so a wrong guess takes the same time as a right one.
    const a = Buffer.from(pw);
    const c = Buffer.from(STAFF_PASSWORD);
    const ok = a.length === c.length && crypto.timingSafeEqual(a, c);
    if (!ok) return send(res, 401, { error: 'That password is not right — check with the owner for the staff password.' });
    const token = crypto.randomBytes(24).toString('hex');
    db.tokens[token] = { expires: Date.now() + TOKEN_TTL_MS };
    saveDb(db);
    return send(res, 200, { token, expiresInHours: 12 });
  }

  // POST /api/staff/logout
  if (method === 'POST' && parts.join('/') === 'api/staff/logout') {
    let b;
    try { b = await readBody(req); } catch (e) { b = {}; }
    if (b.token && db.tokens[b.token]) { delete db.tokens[b.token]; saveDb(db); }
    return send(res, 200, { ok: true });
  }

  // GET /api/staff/orders
  if (method === 'GET' && parts.join('/') === 'api/staff/orders') {
    if (!staffAuthed(req)) return send(res, 401, { error: 'Staff sign-in required.' });
    return send(res, 200, db.orders.map(publicOrder));
  }

  // POST /api/staff/orders/:id/status
  if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'staff' && parts[2] === 'orders' && parts[3] === 'status') {
    if (!staffAuthed(req)) return send(res, 401, { error: 'Staff sign-in required.' });
    let b;
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const id = parseInt(b.id, 10);
    const status = String(b.status || '');
    if (!['new', 'preparing', 'ready', 'picked_up'].includes(status)) {
      return send(res, 400, { error: 'Unknown status.' });
    }
    const o = db.orders.find((x) => x.id === id);
    if (!o) return send(res, 404, { error: 'Order not found.' });
    o.status = status;
    saveDb(db);
    return send(res, 200, publicOrder(o));
  }
  // Same endpoint with the id in the path: /api/staff/orders/123/status
  if (method === 'POST' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'staff' && parts[2] === 'orders' && parts[4] === 'status') {
    if (!staffAuthed(req)) return send(res, 401, { error: 'Staff sign-in required.' });
    let b;
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const id = parseInt(parts[3], 10);
    const status = String(b.status || '');
    if (!['new', 'preparing', 'ready', 'picked_up'].includes(status)) {
      return send(res, 400, { error: 'Unknown status.' });
    }
    const o = db.orders.find((x) => x.id === id);
    if (!o) return send(res, 404, { error: 'Order not found.' });
    o.status = status;
    saveDb(db);
    return send(res, 200, publicOrder(o));
  }

  // POST /api/regulars/signin
  if (method === 'POST' && parts.join('/') === 'api/regulars/signin') {
    let b;
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const name = String(b.name || '').trim();
    const phone = String(b.phone || '').trim();
    if (!name) return send(res, 400, { error: 'Please enter your name.' });
    if (phoneKey(phone).length < 7) return send(res, 400, { error: 'Please enter a phone number.' });
    const key = phoneKey(phone);
    const cust = db.customers[key] || (db.customers[key] = { name, phone, favourites: [] });
    cust.name = name; cust.phone = phone;
    cust.favourites = (cust.favourites || []).filter((id) => MENU_BY_ID.has(id));
    saveDb(db);
    const orders = db.orders.filter((o) => phoneKey(o.phone) === key).map(publicOrder);
    return send(res, 200, { name: cust.name, phone: cust.phone, favourites: cust.favourites, orders });
  }

  // POST /api/regulars/favourites
  if (method === 'POST' && parts.join('/') === 'api/regulars/favourites') {
    let b;
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const key = phoneKey(b.phone);
    if (key.length < 7) return send(res, 400, { error: 'Please sign in first.' });
    const itemId = parseInt(b.itemId, 10);
    if (!MENU_BY_ID.has(itemId)) return send(res, 400, { error: 'Unknown menu item.' });
    const cust = db.customers[key] || (db.customers[key] = { name: '', phone: String(b.phone || ''), favourites: [] });
    cust.favourites = cust.favourites || [];
    const i = cust.favourites.indexOf(itemId);
    if (b.on === true || b.on === 'true') { if (i === -1) cust.favourites.push(itemId); }
    else if (b.on === false || b.on === 'false') { if (i !== -1) cust.favourites.splice(i, 1); }
    saveDb(db);
    return send(res, 200, { favourites: cust.favourites });
  }

  // GET /api/regulars/me?phone=...
  if (method === 'GET' && parts.join('/') === 'api/regulars/me') {
    const key = phoneKey(url.searchParams.get('phone') || '');
    const cust = db.customers[key];
    if (!cust) return send(res, 200, { favourites: [], orders: [] });
    const orders = db.orders.filter((o) => phoneKey(o.phone) === key).map(publicOrder);
    return send(res, 200, { name: cust.name, phone: cust.phone, favourites: cust.favourites || [], orders });
  }

  return send(res, 404, { error: 'Not found.' });
}

// ------------------------------------------------------------ hero video ----
function serveHero(req, res) {
  if (!HERO_VIDEO) return sendText(res, 404, 'Not found');
  const total = HERO_VIDEO.length;
  const headOnly = req.method === 'HEAD';
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start, end;
      if (m[1] === '' && m[2] !== '') {
        start = Math.max(0, total - parseInt(m[2], 10));
        end = total - 1;
      } else {
        start = m[1] === '' ? 0 : parseInt(m[1], 10);
        end = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1);
      }
      if (start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + total });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': 'public, max-age=3600',
      });
      return res.end(headOnly ? undefined : HERO_VIDEO.subarray(start, end + 1));
    }
  }
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Length': total,
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(headOnly ? undefined : HERO_VIDEO);
}

// ----------------------------------------------------------- static files ----
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return sendText(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') return sendText(res, 200, 'ok');
  if (url.pathname === '/hero.mp4') return serveHero(req, res);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => send(res, 500, { error: String(e && e.message || e) }));
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Sodam server replica listening on port ' + PORT);
  console.log('Menu items: ' + menu.items.length + ' | orders on file: ' + db.orders.length);
});
