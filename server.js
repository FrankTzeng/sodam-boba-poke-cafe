#!/usr/bin/env node
/**
 * Sodam Boba & Poke Cafe — server replica (standalone, Node stdlib only).
 *
 * Serves the Sodam site (public/index.html, built by build.py from the
 * approved preview) and the small JSON API the page calls:
 *
 *   GET  /api/menu                    menu + options (prices are set here)
 *   GET  /api/config                  public display config ({ taxRateBps })
 *   POST /api/orders                  place a pickup order (server reprices)
 *   POST /api/staff/login             shared staff password -> 12h token
 *   POST /api/staff/logout            invalidate a token
 *   GET  /api/staff/orders            all orders, newest first (staff only)
 *   POST /api/staff/orders/:id/status move an order new->preparing->ready->picked_up
 *   POST /api/regulars/signin         name+phone -> favourites + past orders
 *   POST /api/regulars/favourites     star / unstar an item (follows the phone)
 *   POST /api/staff/orders/:id/reprint re-queue an order's receipt + labels
 *   POST /api/print/cloudprnt/receipt  Star CloudPRNT poll   (receipt printer)
 *   GET  /api/print/cloudprnt/receipt  Star CloudPRNT fetch the waiting job
 *   DELETE /api/print/cloudprnt/receipt Star CloudPRNT confirm it printed
 *   (the same three under /api/print/cloudprnt/label for the label printer)
 *
 * Printing (Star CloudPRNT): every placed order queues one receipt job and
 * one label job per item, matching the cafe's Toast receipt/sticker layouts.
 * On each printer, set the CloudPRNT server URL to:
 *   receipt printer:  https://<this-server-host>/api/print/cloudprnt/receipt
 *   label printer:    https://<this-server-host>/api/print/cloudprnt/label
 * Optionally set PRINTER_RECEIPT_MAC / PRINTER_LABEL_MAC to the printers'
 * MAC addresses — a poll carrying a known MAC is routed by MAC even if the
 * path names the other printer. With no MACs set (development), the path
 * name alone decides, which is how the local tests drive it.
 * Env TAX_RATE_BPS: sales-tax rate in basis points for receipts
 * (1025 = 10.25%); default 0 = no tax charged, matching the site today.
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

// Printing: Star CloudPRNT. MACs are compared separator-free, upper case.
function normalizeMac(s) { return String(s || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase(); }
const PRINTER_RECEIPT_MAC = normalizeMac(process.env.PRINTER_RECEIPT_MAC || '');
const PRINTER_LABEL_MAC = normalizeMac(process.env.PRINTER_LABEL_MAC || '');
const TAX_RATE_BPS = Math.max(0, parseInt(process.env.TAX_RATE_BPS || '0', 10) || 0);

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
  return { seq: 1001, orders: [], customers: {}, tokens: {}, printJobs: [], jobSeq: 1 };
}
function loadDb() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!d || !Array.isArray(d.orders) || typeof d.seq !== 'number') return blankDb();
    d.customers = d.customers || {};
    d.tokens = d.tokens || {};
    d.printJobs = Array.isArray(d.printJobs) ? d.printJobs : [];
    d.jobSeq = typeof d.jobSeq === 'number' ? d.jobSeq : 1;
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
    totalCents: o.totalCents, tipCents: o.tipCents || 0, taxCents: o.taxCents || 0,
    status: o.status, placedLabel: o.placedLabel, placedAt: o.placedAt || null,
    // Print state for the staff board's "printed" mark; null on orders
    // placed before printing existed.
    print: o.print ? {
      receipt: o.print.receipt,
      labelsPrinted: o.print.labelsPrinted, labelsTotal: o.print.labelsTotal,
      allPrinted: o.print.receipt === 'printed' && o.print.labelsPrinted >= o.print.labelsTotal,
    } : null,
  };
}

// ----------------------------------------------------------- printing -------
// Star CloudPRNT print queue. Jobs are rendered to plain text at enqueue
// time (v1 format) and stored in db.printJobs; the renderers below are the
// only place the layouts live, so a richer format (e.g. Star Markup) can
// replace them later without touching the queue or the protocol handlers.
const PRINT_W = 42; // columns on 3" thermal paper at the standard font

function fmtMoney(cents) { return '$' + (cents / 100).toFixed(2); }
function centerLine(s, w) {
  s = String(s);
  if (s.length >= w) return s;
  return ' '.repeat(Math.floor((w - s.length) / 2)) + s;
}
function rightLine(s, w) {
  s = String(s);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}
function twoCol(left, right, w) {
  const gap = w - left.length - right.length;
  return gap < 1 ? left + ' ' + right : left + ' '.repeat(gap) + right;
}
function wrapText(text, width) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const word of words) {
    if (word.length > width) {
      if (cur) { lines.push(cur); cur = ''; }
      for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
    } else if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += ' ' + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}
// Cafe-local time strings in the shapes the Toast samples use.
function fmtOrdered(ms) { // "11/19/26 2:43 PM"
  return new Date(ms).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', month: 'numeric', day: 'numeric',
    year: '2-digit', hour: 'numeric', minute: '2-digit',
  }).replace(',', '');
}
function fmtTime(ms) { // "3:13 PM"
  return new Date(ms).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit',
  });
}
function fmtDateLong(ms) { // "Nov 19, 2026"
  return new Date(ms).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric',
  });
}
function dueMs(o) { return o.placedAt ? o.placedAt + 30 * 60 * 1000 : null; }

// One receipt line block: "qty name" wrapped like Toast wraps it, the line
// price right-aligned on the last wrapped line, then modifier lines and the
// line's own note indented underneath.
function receiptItemLines(it) {
  const lines = [];
  const price = fmtMoney(it.unitPrice * it.quantity);
  const wrapped = wrapText(it.quantity + ' ' + it.name, PRINT_W - price.length - 2);
  wrapped.forEach((ln, i) => {
    lines.push(i === wrapped.length - 1
      ? ln + ' '.repeat(Math.max(2, PRINT_W - ln.length - price.length)) + price
      : ln);
  });
  for (const opt of it.options || []) for (const ln of wrapText(opt, PRINT_W - 2)) lines.push('  ' + ln);
  if (it.notes) for (const ln of wrapText(it.notes, PRINT_W - 2)) lines.push('  ' + ln);
  return lines;
}

function renderReceipt(o) {
  const L = [];
  const due = dueMs(o);
  L.push('');
  L.push(centerLine('# ' + o.id, PRINT_W));
  L.push('');
  L.push(centerLine('Sodam Boba & Poke Cafe', PRINT_W));
  L.push(centerLine('23211 Hawthorne Boulevard', PRINT_W));
  L.push(centerLine('Suite 100', PRINT_W));
  L.push(centerLine('Torrance, CA 90505', PRINT_W));
  L.push('-'.repeat(PRINT_W));
  L.push(centerLine('Online Ordering - Takeout', PRINT_W));
  L.push('-'.repeat(PRINT_W));
  L.push('Order: ' + o.number);
  L.push('Customer: ' + o.name);
  L.push('Ordered: ' + (o.placedAt ? fmtOrdered(o.placedAt) : o.placedLabel));
  L.push('Due: ' + (due ? fmtOrdered(due) : (o.pickupLabel || '')));
  L.push('');
  for (const it of o.items) L.push(...receiptItemLines(it));
  if (o.notes) {
    L.push('');
    for (const ln of wrapText('Note: ' + o.notes, PRINT_W)) L.push(ln);
  }
  L.push('-'.repeat(PRINT_W));
  const sub = o.totalCents, tax = o.taxCents || 0, tip = o.tipCents || 0;
  L.push(twoCol('Subtotal', fmtMoney(sub), PRINT_W));
  L.push(twoCol('Tax', fmtMoney(tax), PRINT_W));
  L.push(twoCol('Tip', fmtMoney(tip), PRINT_W));
  L.push(twoCol('Total', fmtMoney(sub + tax + tip), PRINT_W));
  L.push('');
  // Pay-at-pickup: no card block and no signature lines until Stripe exists.
  L.push(centerLine('** Pay at pickup **', PRINT_W));
  L.push('');
  L.push(centerLine('Thank you!', PRINT_W));
  L.push('', '', '');
  return L.join('\n');
}

// Labels: one per physical item — a quantity of 2 prints two labels.
function expandLabelUnits(o) {
  const units = [];
  for (const it of o.items) {
    const q = Math.max(1, it.quantity || 1);
    for (let i = 0; i < q; i++) units.push({ name: it.name, options: it.options || [], notes: it.notes || '' });
  }
  return units;
}

function renderLabel(o, unit, n, m) {
  const L = [];
  const due = dueMs(o);
  L.push(twoCol('Online Ordering - Takeout', n + ' of ' + m, PRINT_W));
  L.push(rightLine(due ? fmtTime(due) : (o.pickupLabel || ''), PRINT_W));
  if (due) L.push(rightLine(fmtDateLong(due), PRINT_W));
  L.push('-'.repeat(PRINT_W));
  L.push('# ' + o.id);
  L.push(o.name);
  L.push('');
  for (const ln of wrapText(unit.name, PRINT_W)) L.push(ln);
  for (const opt of unit.options) for (const ln of wrapText(opt, PRINT_W)) L.push(ln);
  if (unit.notes) for (const ln of wrapText(unit.notes, PRINT_W)) L.push(ln);
  if (o.notes) for (const ln of wrapText(o.notes, PRINT_W)) L.push(ln);
  L.push('', '');
  return L.join('\n');
}

// Queue a fresh batch of jobs for an order and reset its print state. Any
// still-queued jobs from an earlier batch are superseded so a reprint can
// never double-print. Callers persist with saveDb.
function enqueuePrintJobs(o) {
  for (const j of db.printJobs) {
    if (j.orderId === o.id && (j.state === 'queued' || j.state === 'fetched')) j.state = 'superseded';
  }
  const now = Date.now();
  const receiptJob = {
    id: db.jobSeq++, orderId: o.id, printer: 'receipt', kind: 'receipt',
    content: renderReceipt(o), state: 'queued', createdAt: now, printedAt: null,
  };
  db.printJobs.push(receiptJob);
  const units = expandLabelUnits(o);
  const labelJobIds = [];
  units.forEach((unit, i) => {
    const job = {
      id: db.jobSeq++, orderId: o.id, printer: 'label', kind: 'label',
      labelIndex: i + 1, labelCount: units.length,
      content: renderLabel(o, unit, i + 1, units.length),
      state: 'queued', createdAt: now, printedAt: null,
    };
    db.printJobs.push(job);
    labelJobIds.push(job.id);
  });
  o.print = {
    receipt: 'queued', receiptJobId: receiptJob.id,
    labelsTotal: units.length, labelsPrinted: 0, labelJobIds,
    updatedAt: now,
  };
  return o.print;
}

function confirmPrintJob(job, ok, code) {
  if (!ok) {
    job.state = 'queued'; // stays in the queue for the next poll
    job.lastError = String(code || 'printer reported an error');
    return;
  }
  job.state = 'printed';
  job.printedAt = Date.now();
  delete job.lastError;
  const o = db.orders.find((x) => x.id === job.orderId);
  if (!o || !o.print) return;
  if (job.kind === 'receipt' && o.print.receiptJobId === job.id) o.print.receipt = 'printed';
  if (job.kind === 'label' && o.print.labelJobIds.includes(job.id)) {
    o.print.labelsPrinted = o.print.labelJobIds.filter((id) => {
      const j = db.printJobs.find((x) => x.id === id);
      return j && j.state === 'printed';
    }).length;
  }
  o.print.updatedAt = Date.now();
}

// Which logical printer is asking: a configured MAC wins over the URL path;
// with no MACs configured the path name alone decides (development default).
function classifyPrinter(pathName, macRaw) {
  const mac = normalizeMac(macRaw || '');
  if (mac && PRINTER_RECEIPT_MAC && mac === PRINTER_RECEIPT_MAC) return 'receipt';
  if (mac && PRINTER_LABEL_MAC && mac === PRINTER_LABEL_MAC) return 'label';
  if (pathName === 'receipt' || pathName === 'label') return pathName;
  return null;
}
function nextQueuedJob(printer) {
  return db.printJobs.find((j) => j.printer === printer && (j.state === 'queued' || j.state === 'fetched')) || null;
}

// ------------------------------------------------------------- routes --------
async function handleApi(req, res, url) {
  const method = req.method;
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  // GET /api/config — public, non-sensitive: the checkout's Tax line must
  // match the server's own math, so the page reads the rate applied here.
  if (method === 'GET' && parts.join('/') === 'api/config') return send(res, 200, { taxRateBps: TAX_RATE_BPS });

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

    // Optional tip (cents) from the customer; tax only when a rate is
    // configured (TAX_RATE_BPS) — the site charges neither today.
    const tipCents = Math.max(0, Math.min(100000, parseInt(b.tipCents, 10) || 0));
    const taxCents = TAX_RATE_BPS ? Math.round(totalCents * TAX_RATE_BPS / 10000) : 0;

    const order = {
      id: db.seq, number: 'S-' + db.seq, name, phone, pickupLabel,
      notes: String(b.notes || '').slice(0, 500), items, totalCents,
      tipCents, taxCents, placedAt: Date.now(),
      status: 'new', placedLabel: placedLabel(),
    };
    db.seq += 1;
    db.orders.unshift(order);
    const key = phoneKey(phone);
    const cust = db.customers[key] || (db.customers[key] = { name, phone, favourites: [] });
    cust.name = name; cust.phone = phone;
    // Printing is best-effort: a printer problem must never fail an order.
    try { enqueuePrintJobs(order); } catch (e) { console.error('print enqueue failed for order ' + order.id + ': ' + (e && e.message || e)); }
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

  // POST /api/staff/orders/:id/reprint — re-queue the receipt + labels
  if (method === 'POST' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'staff' && parts[2] === 'orders' && parts[4] === 'reprint') {
    if (!staffAuthed(req)) return send(res, 401, { error: 'Staff sign-in required.' });
    const id = parseInt(parts[3], 10);
    const o = db.orders.find((x) => x.id === id);
    if (!o) return send(res, 404, { error: 'Order not found.' });
    try { enqueuePrintJobs(o); } catch (e) { return send(res, 500, { error: 'Could not queue the reprint.' }); }
    saveDb(db);
    return send(res, 200, publicOrder(o));
  }
  // Same endpoint with the id in the body: /api/staff/orders/reprint
  if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'staff' && parts[2] === 'orders' && parts[3] === 'reprint') {
    if (!staffAuthed(req)) return send(res, 401, { error: 'Staff sign-in required.' });
    let b;
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const id = parseInt(b.id, 10);
    const o = db.orders.find((x) => x.id === id);
    if (!o) return send(res, 404, { error: 'Order not found.' });
    try { enqueuePrintJobs(o); } catch (e) { return send(res, 500, { error: 'Could not queue the reprint.' }); }
    saveDb(db);
    return send(res, 200, publicOrder(o));
  }

  // Star CloudPRNT: the printers poll one URL per logical printer.
  //   Poll:    POST   /api/print/cloudprnt/receipt   -> { jobReady, mediaTypes, jobToken }
  //   Fetch:   GET    /api/print/cloudprnt/receipt?mac=..&type=text/plain&token=..
  //   Confirm: DELETE /api/print/cloudprnt/receipt?mac=..&token=..&code=..
  if (parts[0] === 'api' && parts[1] === 'print' && parts[2] === 'cloudprnt') {
    const pathName = parts[3] || '';
    if (method === 'POST') {
      let b = {};
      try { b = await readBody(req); } catch (e) { b = {}; }
      const printer = classifyPrinter(pathName, b.printerMAC || b.mac || url.searchParams.get('mac'));
      if (!printer) return send(res, 400, { error: 'Unknown printer. Poll /api/print/cloudprnt/receipt or /api/print/cloudprnt/label.' });
      const job = nextQueuedJob(printer);
      const out = { jobReady: !!job, mediaTypes: ['text/plain'] };
      if (job) out.jobToken = String(job.id);
      return send(res, 200, out);
    }
    if (method === 'GET') {
      const printer = classifyPrinter(pathName, url.searchParams.get('mac'));
      if (!printer) return send(res, 400, { error: 'Unknown printer.' });
      const token = url.searchParams.get('token');
      let job = null;
      if (token) {
        job = db.printJobs.find((j) => String(j.id) === String(token) && j.printer === printer
          && (j.state === 'queued' || j.state === 'fetched')) || null;
      }
      if (!job) job = nextQueuedJob(printer);
      if (!job) return send(res, 404, { error: 'No print job waiting.' });
      job.state = 'fetched';
      saveDb(db);
      return sendText(res, 200, job.content, 'text/plain; charset=utf-8');
    }
    if (method === 'DELETE') {
      const printer = classifyPrinter(pathName, url.searchParams.get('mac'));
      if (!printer) return send(res, 400, { error: 'Unknown printer.' });
      const token = url.searchParams.get('token');
      const code = url.searchParams.get('code') || '';
      let job = null;
      if (token) job = db.printJobs.find((j) => String(j.id) === String(token) && j.printer === printer) || null;
      if (!job) job = db.printJobs.find((j) => j.printer === printer && j.state === 'fetched') || null;
      if (!job) return send(res, 404, { error: 'No print job to confirm.' });
      // CloudPRNT result codes look like "200 OK"; anything else re-queues.
      const ok = !code || /^2/.test(code) || /ok/i.test(code);
      confirmPrintJob(job, ok, code);
      saveDb(db);
      return send(res, 200, { ok: true, jobId: job.id, printed: ok });
    }
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
