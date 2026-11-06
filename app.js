/* Collector's Fix — bazaar ledger
   Static site: talks to api.torn.com with each person's own key (kept in her browser only)
   and to Supabase for the shared data (suppliers, lots, payouts, rent). */
(() => {
"use strict";

const SB_URL = "https://ynxbcangavwfbyogwbpg.supabase.co";
const SB_KEY = "sb_publishable_ykexkIxj6Y4Xn4Em6QwvRQ_WW6e0l1i";
const sb = window.supabase.createClient(SB_URL, SB_KEY);

const $app = document.getElementById("app");
const LS = {
  get(k){ try { return localStorage.getItem(k); } catch { return null; } },
  set(k,v){ try { localStorage.setItem(k,v); } catch {} },
  del(k){ try { localStorage.removeItem(k); } catch {} }
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money = n => (n < 0 ? "−$" : "$") + Math.round(Math.abs(n || 0)).toLocaleString("en-US");
const nowTs = () => Math.floor(Date.now() / 1000);
const KIND_LABEL = { bazaar_sale: "Bazaar", im_sale: "Item Market", mug: "Mugged", receive: "Received" };
// Collector's Fix's own accounts. Items moved between them are always Collector's Fix stock, never a supplier's.
const TEAM = { 4572145: "RivenCross", 4546045: "BellaTricks" };
const isTeam = id => id != null && (TEAM[+id] !== undefined || state.profiles.some(p => +p.torn_id === +id));

let session = null;
let state = { suppliers: [], lots: [], shares: [], profiles: [], stock: [], events: [], settings: {} };

/* ---------------- Torn API ---------------- */
const tornKey = () => (LS.get("cf_torn_key") || "").trim();

async function torn(path, params = {}) {
  const key = tornKey();
  if (!key) throw new Error("Add your Torn API key in Settings first.");
  const u = new URL("https://api.torn.com" + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("key", key);
  u.searchParams.set("comment", "CollectorsFix");
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Torn API HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) {
    const what = params.selections || path.replace(/^\/(v2\/)?/, "").replace(/\/$/, "");
    const hint = j.error.code === 16 ? ` — the key is missing the "${what}" permission` : "";
    throw new Error(`Torn API error ${j.error.code} on ${what}: ${j.error.error}${hint}`);
  }
  return j;
}

async function tornItems() {
  const stamp = new Date().toISOString().slice(0, 10);
  try { const c = JSON.parse(LS.get("cf_items") || "null"); if (c && c.stamp === stamp) return c.items; } catch {}
  const j = await torn("/torn/", { selections: "items" });
  const items = {};
  for (const [id, it] of Object.entries(j.items || {})) items[id] = { name: it.name, type: it.type, value: it.market_value };
  LS.set("cf_items", JSON.stringify({ stamp, items }));
  return items;
}

async function logTypes() {
  try { const c = JSON.parse(LS.get("cf_logtypes5") || "null"); if (c) return c; } catch {}
  let list = [];
  try {
    const j = await torn("/v2/torn/logtypes");
    list = Array.isArray(j.logtypes) ? j.logtypes
      : Object.entries(j.logtypes || {}).map(([id, t]) => ({ id: +id, title: typeof t === "string" ? t : t.title }));
  } catch {}
  const pick = re => list.filter(t => re.test(t.title || "")).map(t => +t.id);
  const ids = {
    bazaar: pick(/^bazaar sell$/i), im: pick(/^item market sell$/i),
    receive: pick(/^item receive$/i), mug: pick(/mug/i),
    im_buy: pick(/^item market buy$/i), bazaar_buy: pick(/^bazaar buy$/i),
    abroad_buy: pick(/abroad.*buy|buy.*abroad|travel.*buy/i), shop_buy: pick(/shop buy/i).filter(id => !list.find(t => +t.id === id && /abroad/i.test(t.title))),
    money_send: pick(/^money send$/i), money_receive: pick(/^money receive$/i)
  };
  if (!ids.bazaar.length) ids.bazaar = [1221];
  if (!ids.im.length) ids.im = [1113];
  if (!ids.receive.length) ids.receive = [4103];
  // Known Torn log type ids, used whenever the title lookup is missing or failed.
  const KNOWN = { bazaar: [1226, 1221], im: [1113], receive: [4103], mug: [8156], im_buy: [1112], bazaar_buy: [1225, 1220],
    abroad_buy: [4201], shop_buy: [4200], money_send: [4800], money_receive: [4810] };
  for (const [k, v] of Object.entries(KNOWN)) ids[k] = [...new Set([...(ids[k] || []), ...v])];
  if (list.length) LS.set("cf_logtypes5", JSON.stringify(ids));
  return ids;
}

function itemsOf(d) {
  let it = Array.isArray(d.items) ? d.items : (d.item != null ? [{ id: d.item, qty: d.quantity ?? d.qty ?? 1 }] : []);
  return it.map(i => ({ id: +(i.id ?? i.item), qty: Number(i.qty ?? i.quantity ?? i.amount ?? 1) }));
}

function parseLog(hash, e, ids, me, names) {
  const d = e.data || {};
  const rows = [];
  let kind = null;
  if (ids.bazaar.includes(e.log)) kind = "bazaar_sale";
  else if (ids.im.includes(e.log)) kind = "im_sale";
  else if (ids.receive.includes(e.log)) kind = "receive";
  else if (ids.mug.includes(e.log) || /mug/i.test(e.title || "")) kind = "mug";
  else for (const k of ["im_buy", "bazaar_buy", "abroad_buy", "shop_buy", "money_send", "money_receive"]) if ((ids[k] || []).includes(e.log)) { kind = k; break; }
  if (!kind) return rows;
  const base = { account_id: me, kind, ts: e.timestamp, raw: e };

  if (kind === "mug") {
    const attacker = d.attacker ?? d.attacker_id ?? d.mugger;
    const defender = d.defender ?? d.defender_id ?? d.target;
    let victim;
    if (attacker != null) victim = +attacker !== me;
    else if (defender != null) victim = +defender === me;
    else victim = /(receive|defend|mugged|victim|lose|lost)/i.test(e.title || "");
    const amt = Number(d.money_mugged ?? d.money_lost ?? d.mugged ?? d.money ?? d.amount ?? d.value ?? 0);
    if (!victim || !amt) return rows;
    rows.push({ ...base, id: `${hash}:0`, qty: 0, gross: amt, net: amt, fee: 0, counterparty_id: attacker != null ? +attacker : null });
    return rows;
  }

  if (kind === "money_send" || kind === "money_receive") {
    const amt = Number(d.money ?? d.amount ?? d.value ?? d.cash ?? 0);
    const other = kind === "money_send" ? (d.receiver ?? d.receiver_id ?? d.target ?? d.user) : (d.sender ?? d.sender_id ?? d.user ?? d.from);
    if (!amt) return rows;
    rows.push({ ...base, id: `${hash}:0`, qty: 0, gross: amt, net: amt, fee: 0, counterparty_id: other != null ? +other : null });
    return rows;
  }

  const items = itemsOf(d);
  const totalQty = items.reduce((s, i) => s + i.qty, 0) || 1;
  if (kind === "receive") {
    const from = d.sender ?? d.sender_id ?? d.user ?? d.from;
    items.forEach((i, n) => rows.push({ ...base, id: `${hash}:${n}`, item_id: i.id, item_name: names[i.id]?.name || `Item #${i.id}`,
      qty: i.qty, gross: 0, fee: 0, net: 0, counterparty_id: from != null ? +from : null }));
    return rows;
  }
  const gross = Number(d.cost_total ?? d.total_cost ?? (d.cost_each != null ? d.cost_each * totalQty : (d.cost ?? d.price ?? 0)));
  const fee = d.fee != null ? Number(d.fee) : (kind === "im_sale" ? Math.round(gross * 0.05) : 0);
  const buyer = d.buyer ?? d.buyer_id ?? (d.seller ? d.seller : null) ?? null; // buyer on sales, seller on purchases
  items.forEach((i, n) => {
    const share = i.qty / totalQty;
    const g = Math.round(gross * share), f = Math.round(fee * share);
    rows.push({ ...base, id: `${hash}:${n}`, item_id: i.id, item_name: names[i.id]?.name || `Item #${i.id}`,
      qty: i.qty, gross: g, fee: f, net: g - f, counterparty_id: buyer != null ? +buyer : null });
  });
  return rows;
}

/* ---------------- Sync ---------------- */
async function sync(statusEl) {
  const say = (m, c) => { if (statusEl) { statusEl.textContent = m; statusEl.className = "status" + (c ? " " + c : ""); } };
  say("Connecting to Torn…");
  const [ids, names] = await Promise.all([logTypes(), tornItems()]);
  const warnings = [];
  const basic = await torn("/user/", { selections: "basic" });
  Object.assign(basic, await torn("/user/", { selections: "money" }));
  // Stock market holdings, valued at today's share price. Optional: needs the "stocks" permission (user + torn).
  let stocks = null;
  try {
    const mine = await torn("/user/", { selections: "stocks" }).catch(e => { throw new Error(e.message.replace(/on stocks/, "on stocks (User column)").replace(/"stocks" permission/, '"stocks" permission in the USER column')); });
    const market = await torn("/torn/", { selections: "stocks" }).catch(e => { throw new Error(e.message.replace(/on stocks/, "on stocks (Torn column)").replace(/"stocks" permission/, '"stocks" permission in the TORN column')); });
    const list = Object.values(mine.stocks || {}).map(h => {
      const m = (market.stocks || {})[h.stock_id] || {};
      const shares = Number(h.total_shares) || 0, price = Number(m.current_price) || 0;
      return { id: +h.stock_id, acronym: m.acronym || "", name: m.name || `Stock #${h.stock_id}`, shares, price, value: Math.round(shares * price) };
    }).filter(h => h.shares > 0);
    stocks = { list, value: list.reduce((a, h) => a + h.value, 0) };
  } catch (e) { console.warn("stocks", e); stocks = { error: e.message }; warnings.push("stocks: " + e.message); }
  const me = +basic.player_id;
  const { data: prof } = await sb.from("profiles").select("*").eq("user_id", session.user.id).maybeSingle();
  const trackStart = Number(state.settings.tracking_start) || (nowTs() - 3 * 86400);
  let from = Math.max(trackStart, (prof?.torn_id === me ? prof.last_log_ts : 0) - 120);
  const backfillKey = "cf_backfill_money3_" + me;
  if (!LS.get(backfillKey)) from = trackStart; // first sync since the Money tab: read purchases and transfers from the start
  const to = nowTs();

  // logs, newest first, 100 per page
  // Torn silently returns an empty log when more than 10 log types are asked at once, so ask in groups of 10.
  const all = new Map();
  const typeIds = [...new Set(Object.values(ids).flat())];
  for (let g = 0; g < typeIds.length; g += 10) {
    const typeList = typeIds.slice(g, g + 10).join(",");
    let upper = to;
    for (let page = 0; page < 40; page++) {
      const j = await torn("/user/", { selections: "log", log: typeList, from, to: upper });
      const entries = Object.entries(j.log || {});
      let added = 0, oldest = Infinity;
      for (const [h, e] of entries) { if (!all.has(h)) { all.set(h, e); added++; } oldest = Math.min(oldest, e.timestamp); }
      say(`Reading logs… ${all.size} entries`);
      if (entries.length < 100 || added === 0 || oldest <= from) break;
      upper = oldest;
    }
  }
  const rows = [];
  for (const [h, e] of all) rows.push(...parseLog(h, e, ids, me, names));
  const cnt = k => rows.filter(r => k.includes(r.kind)).length;
  const readNote = `read ${cnt(["bazaar_sale", "im_sale"])} sales, ${cnt(["im_buy", "bazaar_buy", "abroad_buy", "shop_buy"])} purchases, ${cnt(["money_send", "money_receive"])} money transfers, ${cnt(["receive"])} items received`;
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from("events").upsert(rows.slice(i, i + 200), { onConflict: "id", ignoreDuplicates: true });
    if (error) throw new Error("Saving events: " + error.message + (/kind_check/.test(error.message) ? " — run the new SQL for the Money tab in Supabase" : ""));
  }

  LS.set(backfillKey, "1");
  // stock snapshot: bazaar + item market + inventory for the items we care about
  say("Counting stock…");
  const stock = new Map();
  const add = (id, name, field, q, price) => {
    id = +id; if (!id) return;
    const s = stock.get(id) || { account_id: me, item_id: id, item_name: name || names[id]?.name || `Item #${id}`, bazaar_qty: 0, im_qty: 0, inv_qty: 0 };
    s[field] += Number(q) || 0; if (price != null) s.bazaar_price = Number(price) || 0; stock.set(id, s);
  };
  try {
    const bz = await torn("/user/", { selections: "bazaar" });
    for (const b of (bz.bazaar || [])) add(b.ID ?? b.id, b.name, "bazaar_qty", b.quantity ?? b.amount, b.price);
  } catch (e) { console.warn("bazaar", e); }
  try {
    const im = await torn("/v2/user/itemmarket");
    for (const l of (im.itemmarket || [])) add(l.item?.id ?? l.item_id ?? l.id, l.item?.name, "im_qty", l.amount ?? l.quantity ?? 1);
  } catch (e) { console.warn("itemmarket", e); }
  const lotKinds = ["bazaar_sale", "im_sale", "receive"];
  const relevant = new Set([...state.events, ...rows].filter(r => lotKinds.includes(r.kind) && +r.ts >= trackStart).map(r => r.item_id).concat([...stock.keys()]).filter(Boolean));
  const cats = new Set([...relevant].map(id => names[id]?.type).filter(Boolean));
  for (const cat of cats) {
    try {
      const inv = await torn("/v2/user/inventory", { cat });
      for (const it of (inv.items || inv.inventory || [])) if (relevant.has(+it.id)) add(it.id, it.name, "inv_qty", it.amount ?? it.quantity);
    } catch (e) { console.warn("inventory", cat, e); }
  }
  await sb.from("stock").delete().eq("account_id", me);
  if (stock.size) {
    const rowsS = [...stock.values()].map(s => ({ ...s, updated_at: new Date().toISOString() }));
    let { error } = await sb.from("stock").insert(rowsS);
    if (error && /bazaar_price/.test(error.message)) { // database not updated yet: save without prices
      warnings.push("bazaar prices not saved (database is missing the bazaar_price column)");
      ({ error } = await sb.from("stock").insert(rowsS.map(({ bazaar_price, ...r }) => r)));
    }
    if (error) throw new Error("Saving stock: " + error.message);
  }

  const newest = Math.max(prof?.last_log_ts || 0, ...[...all.values()].map(e => e.timestamp), from);
  const profRow = { user_id: session.user.id, email: session.user.email, torn_id: me, torn_name: basic.name,
    money: Number(basic.money_onhand) || 0, last_log_ts: newest, synced_ts: nowTs() };
  if (stocks && !stocks.error) Object.assign(profRow, { stocks_value: stocks.value, stocks: stocks.list, stocks_ts: nowTs() });
  let { error: pErr } = await sb.from("profiles").upsert(profRow);
  if (pErr && /stocks/.test(pErr.message)) { // database not updated yet: save without stocks
    warnings.push("stocks not saved (database is missing the stocks columns)");
    const { stocks_value, stocks: _s, stocks_ts, ...rest } = profRow; ({ error: pErr } = await sb.from("profiles").upsert(rest));
  }
  if (pErr) throw new Error("Saving profile: " + pErr.message);

  say("Checking lots…");
  await loadAll();
  const closed = await closeLots();
  await loadAll();
  say(`Synced ${basic.name} · ${readNote} · ${closed} lot${closed === 1 ? "" : "s"} closed · ${new Date().toLocaleTimeString("en-GB")}` +
    (warnings.length ? ` · ⚠ ${warnings.join(" · ")}` : ""), warnings.length ? "err" : "okc");
}

/* ---------------- Lots ---------------- */
/* Every shipment a registered supplier sends is its own lot.
   Sales of that item made after the shipment arrived are matched to the open shipments in arrival order
   (first in, first out). When all of a shipment's units are sold, the lot closes and his share becomes a pending payout.
   A later shipment of the same item is always a new lot, so units never carry over. Sales not matched to any
   shipment are Collector's Fix stock. */
function computeBatches() {
  const trackStart = Number(state.settings.tracking_start) || 0;
  const supByTorn = new Map(state.suppliers.map(s => [+s.torn_id, s]));
  const ov = state.overrides || [];
  const byBatch = new Map();
  for (const o of [...ov].sort((x, y) => x.created_ts - y.created_ts)) {
    if (!o.event_id) continue;
    const c = byBatch.get(o.event_id) || {};
    if (o.kind === "exclude") c.removed = true;
    else if (o.kind === "include") c.removed = false;
    else if (o.kind === "supplier_qty") c.qty = +o.qty;
    else if (o.kind === "withdraw") c.kept = +o.qty;
    byBatch.set(o.event_id, c);
  }
  const closedById = new Map(state.lots.filter(l => l.batch_id).map(l => [l.batch_id, l]));
  const items = new Map();
  for (const e of state.events) {
    if (!e.item_id || +e.ts < trackStart) continue;
    if (e.kind === "receive") {
      if (isTeam(e.counterparty_id)) continue;
      const sup = supByTorn.get(+e.counterparty_id); if (!sup) continue;
      const c = byBatch.get(e.id) || {};
      const g = items.get(e.item_id) || { batches: [], sales: [] }; items.set(e.item_id, g);
      const qty = c.qty != null ? c.qty : e.qty, kept = Math.min(qty, c.kept || 0);
      g.batches.push({ id: e.id, item_id: e.item_id, item_name: e.item_name, ts: +e.ts, sup, logged: e.qty, qty, kept, toSell: qty - kept,
        removed: !!c.removed, edited: c.qty != null, sold: 0, revenue: 0, lastSale: 0, closed: closedById.get(e.id) || null });
    } else if (e.kind === "bazaar_sale" || e.kind === "im_sale") {
      const g = items.get(e.item_id) || { batches: [], sales: [] }; items.set(e.item_id, g);
      g.sales.push(e);
    }
  }
  const oldestSync = state.profiles.length ? Math.min(...state.profiles.map(p => Number(p.synced_ts) || 0)) : 0;
  const all = [];
  for (const g of items.values()) {
    const live = g.batches.filter(b => !b.removed).sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1));
    for (const sale of [...g.sales].sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1))) {
      let units = sale.qty; const each = Number(sale.net) / (sale.qty || 1);
      for (const b of live) {
        if (units <= 0) break;
        if (b.ts > +sale.ts || b.sold >= b.toSell) continue;
        const take = Math.min(units, b.toSell - b.sold);
        b.sold += take; b.revenue += take * each; b.lastSale = Math.max(b.lastSale, +sale.ts); units -= take;
      }
    }
    for (const b of g.batches) {
      b.revenue = Math.round(b.revenue);
      b.done = b.toSell > 0 && b.sold >= b.toSell;
      b.canClose = b.done && !b.closed && !b.removed && oldestSync >= b.lastSale;
      all.push(b);
    }
  }
  return all.sort((x, y) => y.ts - x.ts);
}

/* Lots closed under the earlier "whole item" rule were already paid. When a shipment lot covers the same item
   and supplier, and that old lot closed after the shipment arrived, the shipment was settled by that old payout. */
function oldSettlement(b) {
  const sharesByLot = new Map(); for (const sh of state.shares) (sharesByLot.get(sh.lot_id) || sharesByLot.set(sh.lot_id, []).get(sh.lot_id)).push(sh);
  for (const l of state.lots) {
    if (l.batch_id || l.item_id !== b.item_id || +l.closed_ts < b.ts) continue;
    const sh = (sharesByLot.get(l.id) || []).find(x => x.status === "paid" && (x.supplier_id === b.sup.id || x.supplier_name === b.sup.name));
    if (sh) return sh;
  }
  return null;
}

// Mark shipment payouts that duplicate an already-paid old payout as paid.
async function settleDuplicates() {
  if (!state.lots.some(l => !l.batch_id)) return 0;
  const batchByLot = new Map(state.lots.filter(l => l.batch_id).map(l => [l.id, l]));
  const fixes = [];
  for (const sh of state.shares.filter(x => x.status === "pending" && batchByLot.has(x.lot_id))) {
    const l = batchByLot.get(sh.lot_id);
    const old = oldSettlement({ item_id: l.item_id, ts: +l.opened_ts, sup: { id: sh.supplier_id, name: sh.supplier_name } });
    if (old) fixes.push({ id: sh.id, paid_at: old.paid_at, paid_by: (old.paid_by || "") + " (paid before the new lot rule)" });
  }
  for (const f of fixes) await sb.from("lot_shares").update({ status: "paid", paid_at: f.paid_at, paid_by: f.paid_by }).eq("id", f.id);
  return fixes.length;
}

async function closeLots() {
  let n = 0;
  for (const b of computeBatches().filter(x => x.canClose)) {
    const rate = Number(b.sup.rate);
    const payout = Math.round(b.revenue * (1 - rate / 100));
    const { data, error } = await sb.from("lots").insert({ item_id: b.item_id, item_name: b.item_name, batch_id: b.id, opened_ts: b.ts, closed_ts: b.lastSale,
      sold_qty: b.sold, revenue: b.revenue, own_qty: 0, cf_keeps: b.revenue - payout }).select().maybeSingle();
    if (error || !data) continue; // already closed by the other person
    const old = oldSettlement(b);
    await sb.from("lot_shares").insert({ lot_id: data.id, supplier_id: b.sup.id, supplier_name: b.sup.name, qty: b.sold, rate, gross_share: b.revenue, payout,
      ...(old ? { status: "paid", paid_at: old.paid_at, paid_by: (old.paid_by || "") + " (paid before the new lot rule)" } : {}) });
    n++;
  }
  return n;
}

/* ---------------- Data ---------------- */
// Supabase hands back at most 1000 rows per request, so read the events in pages.
async function loadEvents() {
  const out = [];
  for (let from = 0; from < 50000; from += 1000) {
    const r = await sb.from("events").select("id,account_id,kind,ts,item_id,item_name,qty,gross,fee,net,counterparty_id")
      .order("ts", { ascending: false }).order("id").range(from, from + 999);
    if (r.error) return r;
    out.push(...r.data);
    if (r.data.length < 1000) break;
  }
  return { data: out, error: null };
}
async function loadAll() {
  const trackStart = 0;
  const [sup, lots, shares, profiles, stock, events, settings, manual, rentLog, overrides] = await Promise.all([
    sb.from("suppliers").select("*").order("name"),
    sb.from("lots").select("*").order("closed_ts", { ascending: false }).limit(500),
    sb.from("lot_shares").select("*").order("id", { ascending: false }).limit(1000),
    sb.from("profiles").select("*"),
    sb.from("stock").select("*"),
    loadEvents(),
    sb.from("settings").select("*"),
    sb.from("money_entries").select("*").order("ts", { ascending: false }).limit(5000),
    sb.from("rent_log").select("*").order("paid_at", { ascending: false }).limit(500),
    sb.from("lot_overrides").select("*").order("created_ts").limit(5000)
  ]);
  const err = [sup, lots, shares, profiles, stock, events, settings].find(r => r.error);
  state.manual = manual.error ? null : manual.data;   // null = table not created yet
  state.rentLog = rentLog.error ? [] : rentLog.data;
  state.overrides = overrides.error ? null : overrides.data;   // null = table not created yet
  if (err) throw new Error(err.error.message + " — did you run setup.sql in Supabase?");
  state.suppliers = sup.data; state.lots = lots.data; state.shares = shares.data; state.profiles = profiles.data;
  state.stock = stock.data; state.events = events.data;
  state.settings = Object.fromEntries(settings.data.map(r => [r.key, r.value]));
}

async function saveSetting(key, value) {
  const { error } = await sb.from("settings").upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw error;
  state.settings[key] = value;
}

/* ---------------- Shell ---------------- */
const VIEWS = { till: "Daily Till", money: "Money", bazaar: "Bazaar Listings", alerts: "Payouts", lots: "Lots", suppliers: "Suppliers", rent: "Rent", settings: "Settings" };

function shell(inner) {
  const view = currentView();
  const pending = state.shares.filter(s => s.status === "pending").length;
  const me = state.profiles.find(p => p.user_id === session.user.id);
  $app.innerHTML = `
    <header>
      <h1><small>Collector's Fix</small>${esc(VIEWS[view])}</h1>
      <div class="who">
        <span>${esc(session.user.email)}${me ? ` · ${esc(me.torn_name)} [${me.torn_id}]` : ""}</span>
        <span>${tornKey() ? `<button class="go small" id="syncBtn" type="button">Sync now</button>` : `<a href="#settings" style="color:var(--neon)">Add your Torn key →</a>`}</span>
        <span class="status" id="syncStatus"></span>
      </div>
    </header>
    <nav>${Object.entries(VIEWS).map(([k, v]) =>
      `<a href="#${k}" ${k === view ? 'aria-current="page"' : ""}>${v}${k === "alerts" && pending ? `<span class="count">${pending}</span>` : ""}</a>`).join("")}</nav>
    ${inner}`;
  const btn = document.getElementById("syncBtn");
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    const st = document.getElementById("syncStatus");
    try { await sync(st); const m = st.textContent, c = st.className; render(); const s2 = document.getElementById("syncStatus"); s2.textContent = m; s2.className = c; }
    catch (e) { st.textContent = e.message; st.className = "status err"; btn.disabled = false; }
  };
}

function currentView() { const h = location.hash.slice(1); return VIEWS[h] ? h : "till"; }

function render() {
  const v = currentView();
  ({ till: viewTill, money: viewMoney, bazaar: viewBazaar, alerts: viewAlerts, lots: viewLots, suppliers: viewSuppliers, rent: viewRent, settings: viewSettings })[v]();
}

/* ---------------- Daily Till ---------------- */
let tillDay = null;
function dayRange(day) {
  const [y, m, d] = day.split("-").map(Number);
  const start = LS.get("cf_tz") === "local" ? new Date(y, m - 1, d).getTime() : Date.UTC(y, m - 1, d);
  return { from: start / 1000, to: start / 1000 + 86399 };
}
function todayStr() {
  const d = new Date();
  if (LS.get("cf_tz") !== "local") return d.toISOString().slice(0, 10);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const fmtTime = ts => new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: LS.get("cf_tz") === "local" ? undefined : "UTC" });

function stocksPanel(net) {
  const ps = state.profiles.filter(p => p.stocks_value != null);
  const total = ps.reduce((a, p) => a + Number(p.stocks_value || 0), 0);
  const last = ps.length ? Math.max(...ps.map(p => Number(p.stocks_ts) || 0)) : 0;
  const wallets = state.profiles.reduce((a, p) => a + Number(p.money || 0), 0);
  const tip = p => (p.stocks || []).map(h => `${h.acronym || h.name}: ${Number(h.shares).toLocaleString("en-US")} sh · ${money(h.value)}`).join("\n");
  return `<div class="panel pad stocks">
    <div><span class="sub">STOCKS BY ACCOUNT</span>
      ${ps.length ? ps.map(p => `<div class="acct" title="${esc(tip(p))}"><b>${esc(p.torn_name || p.email)}</b><span class="big" style="font-size:22px">${money(p.stocks_value)}</span></div>`).join("")
        : `<p class="note">No stock data yet. Add the <b>stocks</b> permission (User and Torn) to your key, then sync.</p>`}</div>
    <div><span class="sub">STOCKS COMBINED</span><div class="big">${money(total)}</div>
      <div class="sub">${last ? "share prices as of " + new Date(last * 1000).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : ""}</div></div>
    <div><span class="sub">TOTAL MONEY (WALLETS + STOCKS)</span><div class="big pos">${money(wallets + total)}</div>
      <div class="sub">${money(wallets)} in wallets + ${money(total)} in stocks · today's sales are already inside these</div></div>
  </div>`;
}

function viewTill() {
  tillDay = tillDay || todayStr();
  const { from, to } = dayRange(tillDay);
  const ev = state.events.filter(e => e.ts >= from && e.ts <= to && KIND_LABEL[e.kind]);
  const sum = (k, f = "net") => ev.filter(e => e.kind === k).reduce((a, e) => a + Number(e[f]), 0);
  const cnt = k => ev.filter(e => e.kind === k);
  const bz = sum("bazaar_sale"), im = sum("im_sale"), imFee = sum("im_sale", "fee"), loss = sum("mug");
  const lotsToday = state.lots.filter(l => l.closed_ts >= from && l.closed_ts <= to);
  const supToday = state.shares.filter(s => lotsToday.some(l => l.id === s.lot_id)).reduce((a, s) => a + Number(s.payout), 0);
  const BUY = ["im_buy", "bazaar_buy", "abroad_buy", "shop_buy"];
  const buys = state.events.filter(e => e.ts >= from && e.ts <= to && BUY.includes(e.kind));
  const spent = buys.reduce((a, e) => a + Number(e.gross), 0);
  const mugs = cnt("mug").length;
  const losses = loss + spent;
  const net = bz + im - losses;
  const agg = new Map();
  for (const e of ev.filter(e => e.kind === "bazaar_sale" || e.kind === "im_sale")) {
    const k = e.kind + "|" + e.item_id;
    const a = agg.get(k) || { kind: e.kind, name: e.item_name, qty: 0, net: 0 };
    a.qty += e.qty; a.net += Number(e.net); agg.set(k, a);
  }
  const [y, m, d] = tillDay.split("-");
  shell(`
    <div class="panel pad row">
      <button class="ghost" id="prev" type="button" aria-label="Previous day">◀</button>
      <label for="day">Day<input id="day" type="date" value="${tillDay}"></label>
      <button class="ghost" id="next" type="button" aria-label="Next day">▶</button>
      <label for="tz">Day rollover
        <select id="tz"><option value="tct">Midnight TCT (Torn time)</option><option value="local" ${LS.get("cf_tz") === "local" ? "selected" : ""}>Midnight on my clock</option></select>
      </label>
      <span class="sub">${d}/${m}/${y}</span>
    </div>
    <div class="drawers">
      <div class="panel drawer" style="--c:var(--neon)"><h2>Bazaar</h2><div class="big">${money(bz)}</div>
        <div class="sub">${cnt("bazaar_sale").length} sales · ${cnt("bazaar_sale").reduce((a, e) => a + e.qty, 0)} items</div></div>
      <div class="panel drawer" style="--c:var(--teal)"><h2>Item Market</h2><div class="big">${money(im)}</div>
        <div class="sub">${cnt("im_sale").length} sales · fees ${money(imFee)}</div></div>
      <div class="panel drawer" style="--c:var(--bad)"><h2>Losses</h2><div class="big neg">${losses ? "−" : ""}${money(losses)}</div>
        <div class="sub">${mugs} mugging${mugs === 1 ? "" : "s"}, ${buys.length} purchase${buys.length === 1 ? "" : "s"}</div></div>
      <div class="panel drawer" style="--c:var(--rust)"><h2>Owed from lots closed</h2><div class="big">${money(supToday)}</div>
        <div class="sub">${lotsToday.length} lot${lotsToday.length === 1 ? "" : "s"} sold out today</div></div>
    </div>
    <div class="panel pad row" style="justify-content:space-between">
      <div><span class="sub">NET TODAY (sales − losses)</span><div class="big ${net < 0 ? "neg" : "pos"}">${money(net)}</div></div>
      <p class="note">Item Market amounts are after the 5% fee. Supplier shares are settled per lot, on the Payouts tab.</p>
    </div>
    ${stocksPanel(net)}
    <section><h3>By item</h3><div class="panel tbl"><table>
      <thead><tr><th>Item</th><th>Where</th><th class="n">Qty</th><th class="n">Avg</th><th class="n">Total</th></tr></thead>
      <tbody>${agg.size ? [...agg.values()].sort((a, b) => b.net - a.net).map(a =>
        `<tr><td>${esc(a.name)}</td><td><span class="pill ${a.kind}">${KIND_LABEL[a.kind]}</span></td><td class="n">${a.qty}</td><td class="n">${money(a.net / a.qty)}</td><td class="n">${money(a.net)}</td></tr>`).join("")
        : `<tr><td colspan="5" class="empty">No sales on this day${state.events.length ? "" : " yet. Press Sync now to read your logs"}.</td></tr>`}</tbody>
    </table></div></section>
    <section><h3>Ledger</h3><div class="panel tbl"><table>
      <thead><tr><th>Time</th><th>Type</th><th>Detail</th><th class="n">Qty</th><th class="n">Amount</th></tr></thead>
      <tbody>${ev.length ? [...ev].sort((a, b) => a.ts - b.ts).map(e => {
        const sup = state.suppliers.find(s => +s.torn_id === +e.counterparty_id);
        const from = isTeam(e.counterparty_id) ? `${esc(TEAM[+e.counterparty_id] || "team")} (Collector's Fix)` : sup ? esc(sup.name) + " (supplier)" : "player #" + (e.counterparty_id ?? "?");
        const detail = e.kind === "mug" ? `Mugged by player #${e.counterparty_id ?? "?"}` : e.kind === "receive" ? `${esc(e.item_name)} from ${from}` : esc(e.item_name);
        const amt = e.kind === "mug" ? `<span class="neg">−${money(e.net)}</span>` : e.kind === "receive" ? "—" : money(e.net);
        return `<tr><td class="t">${fmtTime(e.ts)}</td><td><span class="pill ${e.kind}">${KIND_LABEL[e.kind]}</span></td><td>${detail}</td><td class="n">${e.kind === "mug" ? "—" : e.qty}</td><td class="n">${amt}</td></tr>`;
      }).join("") : `<tr><td colspan="5" class="empty">Nothing recorded on this day.</td></tr>`}</tbody>
    </table></div></section>`);
  const go = n => { const [Y, M, D] = tillDay.split("-").map(Number); tillDay = new Date(Date.UTC(Y, M - 1, D + n)).toISOString().slice(0, 10); render(); };
  document.getElementById("prev").onclick = () => go(-1);
  document.getElementById("next").onclick = () => go(1);
  document.getElementById("day").onchange = e => { tillDay = e.target.value || todayStr(); render(); };
  document.getElementById("tz").onchange = e => { LS.set("cf_tz", e.target.value); render(); };
}

/* ---------------- Money (statement) ---------------- */
const TAGS = ["Sale", "Purchase", "Trade", "Supplier payment", "Rent", "Transfer", "Gift", "Loan", "Investment", "Loss", "Other"];
const METHODS = ["Trade", "Sent money", "In person", "Bazaar", "Item Market", "Shop", "Other"];
let moneyFilter = { period: "7", dir: "all", internal: false };

function statementRows() {
  const supByTorn = new Map(state.suppliers.map(s => [+s.torn_id, s]));
  const acctName = id => state.profiles.find(p => +p.torn_id === +id)?.torn_name || TEAM[+id] || `#${id}`;
  const who = id => id == null ? "?" : isTeam(id) ? acctName(id) : supByTorn.get(+id)?.name || `player #${id}`;
  const out = [];
  for (const e of state.events) {
    const base = { ts: +e.ts, account: acctName(e.account_id), amount: Number(e.net) };
    const q = e.qty ? `${e.qty}× ` : "";
    switch (e.kind) {
      case "bazaar_sale": out.push({ ...base, dir: "in", what: `Sold ${q}${e.item_name}`, tag: "Sale", method: "Bazaar" }); break;
      case "im_sale": out.push({ ...base, dir: "in", what: `Sold ${q}${e.item_name}`, tag: "Sale", method: "Item Market", note: e.fee ? `after ${money(e.fee)} fee` : "" }); break;
      case "im_buy": out.push({ ...base, dir: "out", what: `Bought ${q}${e.item_name}`, tag: "Purchase", method: "Item Market", amount: Number(e.gross) }); break;
      case "bazaar_buy": out.push({ ...base, dir: "out", what: `Bought ${q}${e.item_name}`, tag: "Purchase", method: "Bazaar", note: e.counterparty_id ? `from ${who(e.counterparty_id)}` : "", amount: Number(e.gross) }); break;
      case "abroad_buy": out.push({ ...base, dir: "out", what: `Bought ${q}${e.item_name}`, tag: "Purchase", method: "Shop abroad", amount: Number(e.gross) }); break;
      case "shop_buy": out.push({ ...base, dir: "out", what: `Bought ${q}${e.item_name}`, tag: "Purchase", method: "City shop", amount: Number(e.gross) }); break;
      case "mug": out.push({ ...base, dir: "out", what: `Mugged by ${who(e.counterparty_id)}`, tag: "Loss", method: "Mugging" }); break;
      case "money_send": {
        const internal = isTeam(e.counterparty_id), sup = supByTorn.get(+e.counterparty_id);
        out.push({ ...base, dir: "out", internal, what: internal ? `Moved to ${who(e.counterparty_id)}` : `Sent to ${who(e.counterparty_id)}`, tag: internal ? "Internal" : sup ? "Supplier payment" : "Transfer", method: "Sent money" }); break;
      }
      case "money_receive": {
        const internal = isTeam(e.counterparty_id);
        out.push({ ...base, dir: "in", internal, what: internal ? `Moved from ${who(e.counterparty_id)}` : `Received from ${who(e.counterparty_id)}`, tag: internal ? "Internal" : "Transfer", method: "Sent money" }); break;
      }
    }
  }
  for (const r of state.rentLog || []) out.push({ ts: Math.floor(new Date(r.paid_at).getTime() / 1000), dir: "out", what: "Rent", tag: "Rent", method: "Rent", amount: Number(r.amount), account: r.paid_by || "", note: "marked on the Rent tab" });
  for (const m of state.manual || []) out.push({ ts: +m.ts, dir: m.direction, what: m.description, tag: m.tag, method: m.method, amount: Number(m.amount), account: m.account || "", manual: m.id });
  return out.sort((a, b) => b.ts - a.ts);
}

function viewMoney() {
  const nowS = nowTs();
  const since = moneyFilter.period === "today" ? dayRange(todayStr()).from : moneyFilter.period === "all" ? 0 : nowS - (+moneyFilter.period) * 86400;
  let rows = statementRows().filter(r => r.ts >= since);
  if (!moneyFilter.internal) rows = rows.filter(r => !r.internal);
  const totIn = rows.filter(r => r.dir === "in").reduce((a, r) => a + r.amount, 0);
  const isMug = r => r.method === "Mugging";
  const totOut = rows.filter(r => r.dir === "out" && !isMug(r)).reduce((a, r) => a + r.amount, 0);
  const mugRows = rows.filter(isMug), totMug = mugRows.reduce((a, r) => a + r.amount, 0);
  const balance = totIn - totOut - totMug;
  const inCount = rows.filter(r => r.dir === "in").length;
  const byTag = new Map();
  for (const r of rows.filter(r => r.dir === "out" && !isMug(r))) byTag.set(r.tag, (byTag.get(r.tag) || 0) + r.amount);
  if (moneyFilter.dir !== "all") rows = rows.filter(r => r.dir === moneyFilter.dir);
  const days = new Map();
  for (const r of rows) {
    const k = new Date(r.ts * 1000).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: LS.get("cf_tz") === "local" ? undefined : "UTC" });
    (days.get(k) || days.set(k, []).get(k)).push(r);
  }
  const nowLocal = (() => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; })();
  const me = state.profiles.find(p => p.user_id === session.user.id);
  const opt = (list, sel) => list.map(v => `<option ${v === sel ? "selected" : ""}>${esc(v)}</option>`).join("");
  shell(`
    ${stocksPanel(0, true)}

    <form class="panel card" id="manualForm">
      <div class="card-head"><h2>Add an entry</h2><span class="sub">for trades and anything the logs don't show</span></div>
      ${state.manual === null ? `<p class="status err">Run the new SQL for the Money tab in Supabase to enable manual entries.</p>` : ""}
      <div class="row">
        <div class="seg" role="radiogroup" aria-label="Direction">
          <label class="segbtn in"><input type="radio" name="mdir" value="in" checked> ↑ Money in</label>
          <label class="segbtn out"><input type="radio" name="mdir" value="out"> ↓ Money out</label>
        </div>
        <label for="mAmt">Amount<input id="mAmt" type="number" min="1" step="1" required placeholder="2500000" style="width:150px"></label>
        <label for="mDesc" style="flex:1 1 260px">What happened<input id="mDesc" required maxlength="200" placeholder="Traded 10 Xanax with Lord for cash"></label>
      </div>
      <div class="row">
        <label for="mTag">Tag<select id="mTag">${opt(TAGS, "Trade")}</select></label>
        <label for="mMethod">Method<select id="mMethod">${opt(METHODS, "Trade")}</select></label>
        <label for="mAcct">Account<select id="mAcct">${opt(["Collector's Fix", ...state.profiles.map(p => p.torn_name).filter(Boolean)], me?.torn_name || "Collector's Fix")}</select></label>
        <label for="mWhen">When<input id="mWhen" type="datetime-local" value="${nowLocal}"></label>
        <button class="go" type="submit" ${state.manual === null ? "disabled" : ""}>Add entry</button>
        <span class="status" id="mStatus"></span>
      </div>
    </form>

    <section>
      <div class="card-head" style="margin-bottom:10px"><h3 style="margin:0">Statement</h3>
        <div class="row">
          <select id="fPeriod" aria-label="Period">${[["today", "Today"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["all", "Everything"]].map(([v, l]) => `<option value="${v}" ${moneyFilter.period === v ? "selected" : ""}>${l}</option>`).join("")}</select>
          <select id="fDir" aria-label="Direction">${[["all", "In and out"], ["in", "Money in"], ["out", "Money out"]].map(([v, l]) => `<option value="${v}" ${moneyFilter.dir === v ? "selected" : ""}>${l}</option>`).join("")}</select>
          <label class="check" for="fInt" style="display:flex;align-items:center;gap:6px;text-transform:none;letter-spacing:0;font:13px var(--f-body);color:var(--fg)"><input id="fInt" type="checkbox" ${moneyFilter.internal ? "checked" : ""}> show moves between your accounts</label>
        </div>
      </div>
      <div class="drawers" style="margin-bottom:14px">
        <div class="panel drawer" style="--c:var(--good)"><h2>Money in</h2><div class="big pos">${money(totIn)}</div><div class="sub">${inCount} entr${inCount === 1 ? "y" : "ies"}</div></div>
        <div class="panel drawer" style="--c:var(--bad)"><h2>Money out</h2><div class="big neg">${totOut ? "−" : ""}${money(totOut)}</div>
          <div class="sub">${[...byTag].sort((a, b) => b[1] - a[1]).map(([t, v]) => `${esc(t)} ${money(v)}`).join(" · ") || "nothing spent"}</div></div>
        <div class="panel drawer" style="--c:var(--rust)"><h2>Muggings</h2><div class="big neg">${totMug ? "−" : ""}${money(totMug)}</div>
          <div class="sub">${mugRows.length} mugging${mugRows.length === 1 ? "" : "s"}</div></div>
        <div class="panel drawer" style="--c:var(--neon)"><h2>Total balance</h2><div class="big ${balance < 0 ? "neg" : "pos"}">${balance < 0 ? "−" : ""}${money(Math.abs(balance))}</div><div class="sub">in − out − muggings for this period</div></div>
      </div>
      <div class="panel statement">${days.size ? [...days].map(([day, list]) => {
        const dIn = list.filter(r => r.dir === "in").reduce((a, r) => a + r.amount, 0), dOut = list.filter(r => r.dir === "out").reduce((a, r) => a + r.amount, 0);
        return `<div class="sday"><span>${day}</span><span class="sub"><span class="pos">+${money(dIn)}</span> · <span class="neg">−${money(dOut)}</span></span></div>
          ${list.map(r => `<div class="sline ${r.dir}${r.internal ? " internal" : ""}">
            <span class="arrow" aria-hidden="true">${r.dir === "in" ? "↑" : "↓"}</span>
            <div class="swhat"><b>${esc(r.what)}</b>
              <span class="sub">${fmtTime(r.ts)} · ${esc(r.method)}${r.account ? " · " + esc(r.account) : ""}${r.note ? " · " + esc(r.note) : ""}</span></div>
            <span class="tag">${esc(r.tag)}</span>
            <span class="samt">${r.dir === "in" ? "+" : "−"}${money(r.amount)}</span>
            ${r.manual ? `<button class="ghost small" data-del="${r.manual}" type="button" aria-label="Delete entry">✕</button>` : `<span class="spacer"></span>`}
          </div>`).join("")}`;
      }).join("") : `<div class="empty">Nothing in this period. Sync to read purchases and sales, or add an entry above.</div>`}</div>
      <p class="note" style="margin-top:10px">Sales and purchases come from the Torn logs of every synced account. Money moved between RivenCross and BellaTricks is hidden by default because it stays inside Collector's Fix. Your wallets and stocks above already reflect everything here.</p>
    </section>`);

  const pick = () => { moneyFilter = { period: document.getElementById("fPeriod").value, dir: document.getElementById("fDir").value, internal: document.getElementById("fInt").checked }; render(); };
  ["fPeriod", "fDir", "fInt"].forEach(id => document.getElementById(id).onchange = pick);
  document.getElementById("manualForm").onsubmit = async ev => {
    ev.preventDefault();
    const st = document.getElementById("mStatus");
    const when = document.getElementById("mWhen").value;
    const row = { ts: when ? Math.floor(new Date(when).getTime() / 1000) : nowTs(), direction: document.querySelector('input[name="mdir"]:checked').value,
      amount: Math.round(+document.getElementById("mAmt").value), description: document.getElementById("mDesc").value.trim(),
      tag: document.getElementById("mTag").value, method: document.getElementById("mMethod").value, account: document.getElementById("mAcct").value, created_by: session.user.email };
    const { error } = await sb.from("money_entries").insert(row);
    if (error) { st.textContent = error.message; st.className = "status err"; return; }
    await loadAll(); render();
  };
  $app.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Delete?"; b.classList.add("danger"); return; }
    await sb.from("money_entries").delete().eq("id", +b.dataset.del); await loadAll(); render();
  });
}

/* ---------------- Bazaar listings ---------------- */
function viewBazaar() {
  let names = {};
  try { names = JSON.parse(LS.get("cf_items") || "null")?.items || {}; } catch {}
  const nameOf = id => { const p = state.profiles.find(p => +p.torn_id === +id); return p?.torn_name || TEAM[+id] || `#${id}`; };
  const rows = state.stock.filter(s => s.bazaar_qty > 0);
  const accounts = [...new Set(rows.map(r => r.account_id))];
  const supLeft = new Map();
  for (const b of computeBatches().filter(b => !b.closed && !b.removed && b.toSell > b.sold)) {
    const m = supLeft.get(b.item_id) || new Map(); m.set(b.sup.name, (m.get(b.sup.name) || 0) + b.toSell - b.sold); supLeft.set(b.item_id, m);
  }
  const hasPrice = rows.some(r => Number(r.bazaar_price) > 0);
  const totalQty = rows.reduce((a, r) => a + r.bazaar_qty, 0);
  const totalVal = rows.reduce((a, r) => a + r.bazaar_qty * (Number(r.bazaar_price) || 0), 0);
  const updated = rows.length ? new Date(Math.max(...rows.map(r => new Date(r.updated_at).getTime()))) : null;
  shell(`
    <div class="drawers">
      <div class="panel drawer" style="--c:var(--neon)"><h2>Items listed</h2><div class="big">${totalQty.toLocaleString("en-US")}</div><div class="sub">${rows.length} different item${rows.length === 1 ? "" : "s"}</div></div>
      <div class="panel drawer" style="--c:var(--teal)"><h2>Listed value</h2><div class="big">${hasPrice ? money(totalVal) : "—"}</div><div class="sub">at your bazaar prices</div></div>
      <div class="panel drawer" style="--c:var(--rust)"><h2>Last read</h2><div class="big" style="font-size:22px">${updated ? updated.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—"}</div><div class="sub">${updated ? updated.toLocaleDateString("en-GB") : "Sync to read the bazaar"}</div></div>
    </div>
    ${accounts.length ? accounts.map(acc => {
      const list = rows.filter(r => r.account_id === acc).sort((a, b) => (b.bazaar_qty * (b.bazaar_price || 0)) - (a.bazaar_qty * (a.bazaar_price || 0)) || a.item_name.localeCompare(b.item_name));
      return `<section><h3>${esc(nameOf(acc))}'s bazaar</h3><div class="panel tbl"><table>
        <thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Your price</th><th class="n">Market value</th><th class="n">Total</th><th>From suppliers</th></tr></thead>
        <tbody>${list.map(r => {
          const mv = names[r.item_id]?.value, pr = Number(r.bazaar_price) || 0, lot = supLeft.get(r.item_id);
          const diff = pr && mv ? Math.round((pr / mv - 1) * 100) : null;
          return `<tr><td>${esc(r.item_name)}</td><td class="n">${r.bazaar_qty}</td>
            <td class="n">${pr ? money(pr) : "—"}${diff != null ? ` <span class="sub ${diff > 0 ? "pos" : diff < 0 ? "neg" : ""}">${diff > 0 ? "+" : ""}${diff}%</span>` : ""}</td>
            <td class="n">${mv ? money(mv) : "—"}</td><td class="n">${pr ? money(pr * r.bazaar_qty) : "—"}</td>
            <td class="sub">${lot ? [...lot].map(([n, q]) => `${esc(n)} ${q}`).join(" · ") : "—"}</td></tr>`;
        }).join("")}</tbody></table></div></section>`;
    }).join("") : `<div class="panel empty">Nothing listed, or no sync yet. The bazaar is read from the account it belongs to, so BellaTricks needs to sync for her bazaar to show here.</div>`}
    <p class="note">This is a snapshot from the last sync of each account, so it works while you travel. Market value comes from Torn and is refreshed once a day on this browser. "From suppliers" counts units of open supplier lots that are still unsold.</p>`);
}

/* ---------------- Payouts (alerts) ---------------- */
const paySel = new Set();
function viewAlerts() {
  const lotById = new Map(state.lots.map(l => [l.id, l]));
  const pend = state.shares.filter(s => s.status === "pending");
  const paid = state.shares.filter(s => s.status === "paid").slice(0, 30);
  for (const id of [...paySel]) if (!pend.some(s => s.id === id)) paySel.delete(id);
  const owedBy = new Map();
  for (const s of pend) owedBy.set(s.supplier_name, (owedBy.get(s.supplier_name) || 0) + Number(s.payout));
  const line = s => {
    const l = lotById.get(s.lot_id) || {};
    const pick = s.status === "pending" ? `<label class="pick" title="Select"><input type="checkbox" data-sel="${s.id}" ${paySel.has(s.id) ? "checked" : ""} aria-label="Select this payout"></label>` : "";
    return `<div class="alert ${s.status}${paySel.has(s.id) ? " picked" : ""}">
      ${pick}
      <div class="msg"><span class="dot"></span><b>${l.sold_qty ?? "?"} ${esc(l.item_name || "items")}</b> sold out.
        ${s.status === "pending" ? "Pay" : "Paid"} <b>${esc(s.supplier_name)}</b> for ${s.qty} unit${s.qty === 1 ? "" : "s"}:
        <b class="amt">${money(s.payout)}</b>
        <div class="sub">Lot revenue ${money(l.revenue)} · his share ${money(s.gross_share)} − your ${Number(s.rate)}% · closed ${new Date(l.closed_ts * 1000).toLocaleDateString("en-GB")}${s.paid_at ? ` · paid ${new Date(s.paid_at).toLocaleDateString("en-GB")} by ${esc(s.paid_by || "")}` : ""}</div>
      </div>
      ${s.status === "pending" ? `<button class="ok small" data-pay="${s.id}" type="button">Mark paid</button>` : `<button class="ghost small" data-unpay="${s.id}" type="button">Undo</button>`}
    </div>`;
  };
  const sel = pend.filter(s => paySel.has(s.id));
  const selTotal = sel.reduce((a, s) => a + Number(s.payout), 0);
  const selBy = new Map(); for (const s of sel) selBy.set(s.supplier_name, (selBy.get(s.supplier_name) || 0) + Number(s.payout));
  shell(`
    <div class="drawers">
      <div class="panel drawer" style="--c:var(--bad)"><h2>Still to pay</h2><div class="big neg">${money(pend.reduce((a, s) => a + Number(s.payout), 0))}</div>
        <div class="sub">${pend.length} pending payout${pend.length === 1 ? "" : "s"}</div></div>
      ${[...owedBy].map(([n, v]) => `<div class="panel drawer" style="--c:var(--rust)"><h2>${esc(n)}</h2><div class="big">${money(v)}</div><div class="sub">owed · <button class="linkbtn" type="button" data-selsup="${esc(n)}">select all</button></div></div>`).join("")}
    </div>
    ${pend.length ? `<div class="panel paybar ${sel.length ? "active" : ""}">
      <div class="paysum">
        <span class="sub">${sel.length ? `${sel.length} SELECTED · SEND` : "SELECT PAYOUTS TO ADD THEM UP"}</span>
        <div class="big" id="selTotal">${money(selTotal)}</div>
        <div class="sub">${[...selBy].map(([n, v]) => `${esc(n)}: ${money(v)}`).join(" · ")}</div>
      </div>
      <div class="row">
        <button class="ghost small" type="button" data-selall>${sel.length === pend.length ? "Clear" : "Select all"}</button>
        <button class="ghost small" type="button" data-copy ${sel.length ? "" : "disabled"}>Copy amount</button>
        <button class="ok small" type="button" data-paysel ${sel.length ? "" : "disabled"}>Mark selected as paid</button>
      </div>
      ${selBy.size > 1 ? `<p class="note">These go to ${selBy.size} different suppliers, so send each one their own amount.</p>` : ""}
    </div>` : ""}
    <section><h3>Pending</h3><div class="alerts">${pend.length ? pend.map(line).join("") : `<div class="panel empty">Nothing to pay. When a lot with supplier items sells out, it shows up here in red.</div>`}</div></section>
    <section><h3>Paid recently</h3><div class="alerts">${paid.length ? paid.map(line).join("") : `<div class="panel empty">No payouts marked as paid yet.</div>`}</div></section>`);
  $app.querySelectorAll("[data-pay]").forEach(b => b.onclick = () => setPaid(+b.dataset.pay, true));
  $app.querySelectorAll("[data-unpay]").forEach(b => b.onclick = () => setPaid(+b.dataset.unpay, false));
  $app.querySelectorAll("[data-sel]").forEach(c => c.onchange = () => { c.checked ? paySel.add(+c.dataset.sel) : paySel.delete(+c.dataset.sel); render(); });
  $app.querySelectorAll("[data-selsup]").forEach(b => b.onclick = () => { for (const s of pend) if (s.supplier_name === b.dataset.selsup) paySel.add(s.id); render(); });
  const all = $app.querySelector("[data-selall]");
  if (all) all.onclick = () => { if (sel.length === pend.length) paySel.clear(); else pend.forEach(s => paySel.add(s.id)); render(); };
  const copy = $app.querySelector("[data-copy]");
  if (copy) copy.onclick = async () => {
    const txt = String(Math.round(selTotal));
    try { await navigator.clipboard.writeText(txt); copy.textContent = "Copied " + money(selTotal); }
    catch { const r = document.createRange(); r.selectNodeContents(document.getElementById("selTotal")); getSelection().removeAllRanges(); getSelection().addRange(r); copy.textContent = "Selected, press ⌘C"; }
  };
  const ps = $app.querySelector("[data-paysel]");
  if (ps) ps.onclick = async () => {
    if (ps.dataset.confirm !== "1") { ps.dataset.confirm = "1"; ps.textContent = `Confirm: mark ${sel.length} as paid`; return; }
    ps.disabled = true;
    await sb.from("lot_shares").update({ status: "paid", paid_at: new Date().toISOString(), paid_by: session.user.email }).in("id", sel.map(s => s.id));
    paySel.clear(); await loadAll(); render();
  };
}
async function setPaid(id, paid) {
  await sb.from("lot_shares").update(paid ? { status: "paid", paid_at: new Date().toISOString(), paid_by: session.user.email } : { status: "pending", paid_at: null, paid_by: null }).eq("id", id);
  await loadAll(); render();
}

/* ---------------- Lots ---------------- */
function viewLots() {
  const batches = computeBatches();
  const open = batches.filter(b => !b.closed && !b.removed);
  const removed = batches.filter(b => b.removed && !b.closed);
  const shareByLot = new Map();
  for (const s of state.shares) (shareByLot.get(s.lot_id) || shareByLot.set(s.lot_id, []).get(s.lot_id)).push(s);
  const fmtD = ts => new Date(ts * 1000).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const newLots = state.lots.filter(l => l.batch_id);
  shell(`
    <p class="note">Each shipment a supplier sends is its own lot. Sales of that item made after it arrived count towards it, oldest shipment first. When all its units are sold the lot closes and his share goes to Payouts. A new shipment always starts a new lot. Items from RivenCross, BellaTricks or anyone who isn't a registered supplier are Collector's Fix stock.</p>
    ${state.overrides === null ? `<p class="status err">Run the SQL for lot editing in Supabase to enable editing.</p>` : ""}
    <section><h3>In progress</h3><div class="grid2">${open.length ? open.map(b => {
      const pct = b.toSell ? Math.min(100, Math.round(b.sold / b.toSell * 100)) : 0;
      const share = Math.round(b.revenue * (1 - Number(b.sup.rate) / 100));
      return `<div class="panel card" data-batch="${esc(b.id)}" data-item="${b.item_id}">
        <div class="card-head"><h2>${esc(b.item_name)}</h2><span class="sub">${esc(b.sup.name)} · received ${fmtD(b.ts)}</span></div>
        <div class="bar ${b.done ? "full" : ""}"><i style="width:${pct}%"></i></div>
        <div class="kv"><div><span>Sold</span><b>${b.sold} / ${b.toSell}</b></div><div><span>Revenue so far</span><b>${money(b.revenue)}</b></div>
          <div><span>His share so far</span><b>${money(share)}</b></div><div><span>Your ${Number(b.sup.rate)}%</span><b>${money(b.revenue - share)}</b></div></div>
        <div class="sub">${b.edited ? `Units edited (logs say ${b.logged}) · ` : ""}${b.kept ? `${b.kept} kept, not for sale · ` : ""}${b.done ? "Sold out · closes after every account syncs" : `${b.toSell - b.sold} left to sell`}</div>
        ${state.overrides === null ? "" : `<details class="lotedit"><summary>Edit</summary>
          <div class="row" style="margin-top:10px">
            <label>Units he sent<input type="number" min="0" value="${b.qty}" data-q style="width:100px"></label>
            <label>Kept, not for sale<input type="number" min="0" value="${b.kept}" data-kept style="width:110px"></label>
            <button class="go small" type="button" data-save>Save</button>
            <button class="ghost small" type="button" data-remove>Remove this lot</button>
          </div>
          <p class="note" style="margin-top:8px">Kept units are left out, so the lot closes once the rest is sold. Removing the lot stops it counting; its sales go back to Collector's Fix.</p>
        </details>`}
      </div>`;
    }).join("") : `<div class="panel empty">No open lots. A lot appears when a registered supplier sends you items.</div>`}</div></section>
    ${removed.length ? `<section><h3>Removed</h3><div class="panel tbl"><table><tbody>${removed.map(b => `<tr data-batch="${esc(b.id)}" data-item="${b.item_id}">
      <td class="t">${fmtD(b.ts)}</td><td>${b.qty}× ${esc(b.item_name)}</td><td>${esc(b.sup.name)}</td><td class="n"><button class="ghost small" type="button" data-restore>Restore</button></td></tr>`).join("")}</tbody></table></div></section>` : ""}
    <section><h3>Sold out</h3><div class="panel tbl"><table>
      <thead><tr><th>Received</th><th>Closed</th><th>Item</th><th>Supplier</th><th class="n">Units</th><th class="n">Revenue</th><th class="n">His payout</th><th class="n">You keep</th></tr></thead>
      <tbody>${newLots.length ? newLots.map(l => { const sh = (shareByLot.get(l.id) || [])[0];
        return `<tr><td class="t">${new Date(l.opened_ts * 1000).toLocaleDateString("en-GB")}</td><td class="t">${new Date(l.closed_ts * 1000).toLocaleDateString("en-GB")}</td><td>${esc(l.item_name)}</td>
        <td>${esc(sh?.supplier_name || "")}</td><td class="n">${l.sold_qty}</td><td class="n">${money(l.revenue)}</td>
        <td class="n ${sh?.status === "paid" ? "pos" : "neg"}">${sh ? money(sh.payout) : "—"}</td><td class="n">${money(l.cf_keeps)}</td></tr>`; }).join("")
        : `<tr><td colspan="8" class="empty">No supplier lots sold out yet.</td></tr>`}</tbody>
    </table></div></section>`);
  const addOv = rows => sb.from("lot_overrides").insert(rows.map(r => ({ ...r, created_ts: nowTs(), created_by: session.user.email })));
  const done = async res => { await loadAll(); render(); if (res?.error) { const st = document.getElementById("syncStatus"); st.textContent = "Could not save: " + res.error.message; st.className = "status err"; } };
  for (const el of $app.querySelectorAll("[data-batch]")) {
    const id = el.dataset.batch, item = +el.dataset.item, b = batches.find(x => x.id === id);
    const save = el.querySelector("[data-save]");
    if (save) save.onclick = async () => {
      const q = Math.max(0, Math.round(+el.querySelector("[data-q]").value || 0)), k = Math.max(0, Math.round(+el.querySelector("[data-kept]").value || 0));
      const rows = [];
      if (q !== b.qty) rows.push({ item_id: item, event_id: id, kind: "supplier_qty", qty: q });
      if (k !== b.kept) rows.push({ item_id: item, event_id: id, kind: "withdraw", qty: k });
      if (rows.length) done(await addOv(rows));
    };
    const rm = el.querySelector("[data-remove]");
    if (rm) rm.onclick = async () => {
      if (rm.dataset.confirm !== "1") { rm.dataset.confirm = "1"; rm.textContent = "Click again to remove"; rm.classList.add("danger"); return; }
      done(await addOv([{ item_id: item, event_id: id, kind: "exclude" }]));
    };
    const rs = el.querySelector("[data-restore]");
    if (rs) rs.onclick = async () => done(await addOv([{ item_id: item, event_id: id, kind: "include" }]));
  }
}

/* ---------------- Suppliers ---------------- */
function viewSuppliers() {
  const owed = id => state.shares.filter(s => s.supplier_id === id && s.status === "pending").reduce((a, s) => a + Number(s.payout), 0);
  const paid = id => state.shares.filter(s => s.supplier_id === id && s.status === "paid").reduce((a, s) => a + Number(s.payout), 0);
  shell(`
    <form class="panel pad row" id="addSup">
      <label for="supName">Name<input id="supName" required placeholder="Torn name"></label>
      <label for="supId">Torn ID<input id="supId" required inputmode="numeric" pattern="[0-9]+" placeholder="1234567"></label>
      <label for="supRate">Your rate %<input id="supRate" type="number" min="0" max="100" step="0.5" value="10" style="width:100px"></label>
      <button class="go" type="submit">Add supplier</button>
      <span class="status" id="supStatus"></span>
    </form>
    <div class="grid2">${state.suppliers.length ? state.suppliers.map(s => `
      <div class="panel card ${s.active ? "" : "inactive"}" data-sup="${s.id}">
        <div class="card-head"><h2>${esc(s.name)}</h2><a class="sub" href="https://www.torn.com/profiles.php?XID=${s.torn_id}" target="_blank" rel="noopener">[${s.torn_id}]</a></div>
        <div class="kv">
          <div><span>Owed now</span><b class="${owed(s.id) ? "neg" : ""}">${money(owed(s.id))}</b></div>
          <div><span>Paid so far</span><b class="pos">${money(paid(s.id))}</b></div>
          <div><span>Your rate</span><b>${Number(s.rate)}%</b></div>
        </div>
        <div class="row">
          <label for="rate${s.id}">Change rate %<input id="rate${s.id}" type="number" min="0" max="100" step="0.5" value="${Number(s.rate)}" style="width:100px"></label>
          <button class="ghost small" data-save="${s.id}" type="button">Save rate</button>
          <button class="ghost small" data-toggle="${s.id}" type="button">${s.active ? "Deactivate" : "Activate"}</button>
        </div>
        <div class="calc">
          <span class="sub">CALCULATOR</span>
          <div class="row">
            <label for="cq${s.id}">Qty<input id="cq${s.id}" type="number" min="0" value="25" style="width:90px"></label>
            <label for="cp${s.id}">Sale price each<input id="cp${s.id}" type="number" min="0" value="30000" style="width:140px"></label>
          </div>
          <div class="out" id="co${s.id}"></div>
        </div>
      </div>`).join("") : `<div class="panel empty">No suppliers yet. Add the first one above with his Torn ID, so the site can recognise the items he sends.</div>`}</div>
    <p class="note">Rate changes apply to lots that sell out from now on. Lots already closed keep the rate they had.</p>`);

  document.getElementById("addSup").onsubmit = async ev => {
    ev.preventDefault();
    const st = document.getElementById("supStatus");
    const row = { name: document.getElementById("supName").value.trim(), torn_id: +document.getElementById("supId").value, rate: +document.getElementById("supRate").value };
    if (isTeam(row.torn_id)) { st.textContent = "That's a Collector's Fix account, not a supplier."; st.className = "status err"; return; }
    const { error } = await sb.from("suppliers").insert(row);
    if (error) { st.textContent = error.message.includes("duplicate") ? "That Torn ID is already a supplier." : error.message; st.className = "status err"; return; }
    await loadAll(); render();
  };
  for (const s of state.suppliers) {
    const calc = () => {
      const q = +document.getElementById("cq" + s.id).value || 0, p = +document.getElementById("cp" + s.id).value || 0;
      const gross = q * p, his = gross * (1 - s.rate / 100);
      document.getElementById("co" + s.id).innerHTML = `Sold for <b>${money(gross)}</b> → ${esc(s.name)} gets <b>${money(his)}</b> · Collector's Fix keeps <b>${money(gross - his)}</b>`;
    };
    ["cq", "cp"].forEach(p => document.getElementById(p + s.id).oninput = calc); calc();
  }
  $app.querySelectorAll("[data-save]").forEach(b => b.onclick = async () => {
    const id = +b.dataset.save; await sb.from("suppliers").update({ rate: +document.getElementById("rate" + id).value }).eq("id", id); await loadAll(); render();
  });
  $app.querySelectorAll("[data-toggle]").forEach(b => b.onclick = async () => {
    const s = state.suppliers.find(x => x.id === +b.dataset.toggle); await sb.from("suppliers").update({ active: !s.active }).eq("id", s.id); await loadAll(); render();
  });
}

/* ---------------- Rent ---------------- */
function viewRent() {
  const rent = state.settings.rent || { amount: 12000000, every_days: 3, next_due: null };
  const wallets = state.profiles.reduce((a, p) => a + Number(p.money || 0), 0);
  const stockVal = state.profiles.reduce((a, p) => a + Number(p.stocks_value || 0), 0);
  const cash = wallets + stockVal;
  const owed = state.shares.filter(s => s.status === "pending").reduce((a, s) => a + Number(s.payout), 0);
  const free = cash - owed;
  const enough = free >= rent.amount;
  const pctRaw = Math.max(0, free / rent.amount * 100);
  const pct = Math.min(100, pctRaw);
  const pctLabel = pctRaw >= 10 ? Math.floor(pctRaw) : pctRaw.toFixed(1);
  const due = rent.next_due ? new Date(rent.next_due) : null;
  const hoursLeft = due ? (due - Date.now()) / 3600000 : null;
  const weekAgo = nowTs() - 7 * 86400;
  const wk = state.events.filter(e => e.ts >= weekAgo);
  const daily = (wk.filter(e => e.kind.endsWith("_sale")).reduce((a, e) => a + Number(e.net), 0) - wk.filter(e => e.kind === "mug").reduce((a, e) => a + Number(e.net), 0)) / 7;
  const short = Math.max(0, rent.amount - free);
  const daysToCover = short === 0 ? 0 : daily > 0 ? short / daily : Infinity;
  const toLocalInput = d => { const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  shell(`
    <div class="panel pad card">
      <div class="card-head"><h2>Next rent · ${money(rent.amount)}</h2><span class="badge ${enough ? "good" : "bad"}">${enough ? "Covered" : "Not covered yet"}</span></div>
      <div class="progress">
        <div class="bar big-bar ${enough ? "full" : "warn"}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><i style="width:${pct}%;min-width:${free > 0 ? "6px" : "0"}"></i></div>
        <div class="sub">${pctLabel}% of the rent · ${money(Math.min(free, rent.amount))} / ${money(rent.amount)}${enough ? "" : ` · ${money(short)} to go`}</div>
      </div>
      <div class="rentbig">
        <div><span class="sub">CASH + STOCKS</span><div class="big">${money(cash)}</div>
          <div class="sub">${state.profiles.map(p => `${esc(p.torn_name || p.email)}: ${money(p.money)} wallet + ${money(p.stocks_value || 0)} stocks`).join("<br>") || "Sync to read wallets"}</div></div>
        <div><span class="sub">OWED TO SUPPLIERS</span><div class="big ${owed ? "neg" : ""}">${owed ? "−" + money(owed) : money(0)}</div></div>
        <div><span class="sub">FREE FOR RENT</span><div class="big ${enough ? "pos" : "neg"}">${money(free)}</div><div class="sub">${enough ? `${money(free - rent.amount)} left after paying` : `${money(short)} short`}</div></div>
        <div><span class="sub">DUE</span><div class="big">${due ? (hoursLeft > 0 ? `${Math.floor(hoursLeft / 24)}d ${Math.floor(hoursLeft % 24)}h` : "Overdue") : "—"}</div>
          <div class="sub">${due ? due.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "Set the next due date below"}</div></div>
      </div>
      <p class="note">${short === 0 ? "You already have the rent free and clear." : daily > 0 ? `At the last 7 days' pace (${money(daily)}/day net sales) you cover the gap in about ${daysToCover < 1 ? "less than a day" : Math.ceil(daysToCover) + " day" + (Math.ceil(daysToCover) === 1 ? "" : "s")}.` : "No sales in the last 7 days to project from."}
        Cash is the wallet plus stock market holdings of every synced account, minus supplier payouts that are still pending. It updates on every sync.</p>
      <div class="row"><button class="ok" id="paidRent" type="button" ${due ? "" : "disabled"}>Rent paid · move to next due date</button><span class="status" id="rentStatus"></span></div>
    </div>
    <form class="panel pad row" id="rentForm">
      <label for="rAmt">Rent amount<input id="rAmt" type="number" min="0" step="100000" value="${rent.amount}"></label>
      <label for="rEvery">Every (days)<input id="rEvery" type="number" min="1" value="${rent.every_days}" style="width:90px"></label>
      <label for="rDue">Next due (your clock)<input id="rDue" type="datetime-local" value="${due ? toLocalInput(due) : ""}"></label>
      <button class="go" type="submit">Save</button>
    </form>`);
  document.getElementById("rentForm").onsubmit = async ev => {
    ev.preventDefault();
    const v = document.getElementById("rDue").value;
    await saveSetting("rent", { amount: +document.getElementById("rAmt").value, every_days: +document.getElementById("rEvery").value, next_due: v ? new Date(v).toISOString() : null });
    render();
  };
  document.getElementById("paidRent").onclick = async () => {
    await sb.from("rent_log").insert({ amount: rent.amount, paid_by: session.user.email });
    const next = new Date(due.getTime() + rent.every_days * 86400000);
    await saveSetting("rent", { ...rent, next_due: next.toISOString() });
    render();
    const st = document.getElementById("rentStatus"); st.textContent = "Rent marked as paid."; st.className = "status okc";
  };
}

/* ---------------- Settings ---------------- */
function viewSettings() {
  const ts = Number(state.settings.tracking_start) || 0;
  const toLocalInput = d => { const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  shell(`
    <div class="grid2">
      <form class="panel card" id="keyForm">
        <h2>Your Torn API key</h2>
        <p class="note">Use a <b>Custom</b> key with: basic, log, money, inventory, bazaar, itemmarket, stocks (User) and items, logtypes, stocks (Torn). It stays in this browser only and is sent only to api.torn.com.</p>
        <label for="tkey">Key<input id="tkey" type="password" autocomplete="off" value="${esc(tornKey())}" placeholder="paste your key"></label>
        <div class="row"><button class="go" type="submit">Save key</button><button class="ghost" id="forgetKey" type="button">Remove from this browser</button></div>
        <span class="status" id="keyStatus"></span>
      </form>
      <form class="panel card" id="trackForm">
        <h2>Tracking start</h2>
        <p class="note">Logs before this moment are ignored. Set it to when you started using the site, so old sales don't land in lots.</p>
        <label for="tstart">Start (your clock)<input id="tstart" type="datetime-local" value="${ts ? toLocalInput(new Date(ts * 1000)) : ""}"></label>
        <div class="row"><button class="go" type="submit">Save</button><span class="sub">${ts ? "" : "Not set: the first sync reads the last 3 days."}</span></div>
      </form>
      <div class="panel card">
        <h2>Synced accounts</h2>
        ${state.profiles.length ? state.profiles.map(p => `<div class="sub"><b style="color:var(--fg)">${esc(p.torn_name || "?")}</b> [${p.torn_id || "?"}] · ${esc(p.email || "")} · last sync ${p.synced_ts ? new Date(p.synced_ts * 1000).toLocaleString("en-GB") : "never"}</div>`).join("") : `<p class="note">Nobody has synced yet.</p>`}
        <p class="note">Lots only close after every account here has synced, so each person should press Sync now regularly.</p>
      </div>
      <form class="panel card" id="pwForm">
        <h2>Change password</h2>
        <label for="pw1">New password<input id="pw1" type="password" minlength="8" autocomplete="new-password" required></label>
        <label for="pw2">Repeat<input id="pw2" type="password" minlength="8" autocomplete="new-password" required></label>
        <div class="row"><button class="go" type="submit">Update password</button><button class="ghost" id="logout" type="button">Sign out</button></div>
        <span class="status" id="pwStatus"></span>
      </form>
    </div>`);
  document.getElementById("keyForm").onsubmit = ev => { ev.preventDefault(); LS.set("cf_torn_key", document.getElementById("tkey").value.trim()); render(); };
  document.getElementById("forgetKey").onclick = () => { LS.del("cf_torn_key"); render(); };
  document.getElementById("trackForm").onsubmit = async ev => {
    ev.preventDefault(); const v = document.getElementById("tstart").value;
    await saveSetting("tracking_start", v ? Math.floor(new Date(v).getTime() / 1000) : null); render();
  };
  document.getElementById("pwForm").onsubmit = async ev => {
    ev.preventDefault();
    const st = document.getElementById("pwStatus"), a = document.getElementById("pw1").value, b = document.getElementById("pw2").value;
    if (a !== b) { st.textContent = "The two passwords don't match."; st.className = "status err"; return; }
    const { error } = await sb.auth.updateUser({ password: a });
    st.textContent = error ? error.message : "Password updated."; st.className = "status " + (error ? "err" : "okc");
  };
  document.getElementById("logout").onclick = () => sb.auth.signOut();
}

/* ---------------- Auth ---------------- */
function viewLogin(msg = "") {
  $app.innerHTML = `
    <form class="panel login" id="loginForm">
      <h1><small>Collector's Fix</small>Ledger</h1>
      <label for="em">Email<input id="em" type="email" autocomplete="username" required></label>
      <label for="pw">Password<input id="pw" type="password" autocomplete="current-password" required></label>
      <button class="go" type="submit">Sign in</button>
      <button class="ghost" id="forgot" type="button">Forgot password</button>
      <span class="status" id="loginStatus">${esc(msg)}</span>
    </form>`;
  const st = document.getElementById("loginStatus");
  document.getElementById("loginForm").onsubmit = async ev => {
    ev.preventDefault(); st.textContent = "Signing in…"; st.className = "status";
    const { error } = await sb.auth.signInWithPassword({ email: document.getElementById("em").value, password: document.getElementById("pw").value });
    if (error) { st.textContent = "Wrong email or password."; st.className = "status err"; }
  };
  document.getElementById("forgot").onclick = async () => {
    const email = document.getElementById("em").value;
    if (!email) { st.textContent = "Type your email first."; st.className = "status err"; return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    st.textContent = error ? error.message : "Check your inbox for a reset link."; st.className = "status " + (error ? "err" : "okc");
  };
}

function viewNewPassword() {
  $app.innerHTML = `
    <form class="panel login" id="npForm">
      <h1><small>Collector's Fix</small>New password</h1>
      <label for="np">New password<input id="np" type="password" minlength="8" autocomplete="new-password" required></label>
      <button class="go" type="submit">Save password</button>
      <span class="status" id="npStatus"></span>
    </form>`;
  document.getElementById("npForm").onsubmit = async ev => {
    ev.preventDefault();
    const { error } = await sb.auth.updateUser({ password: document.getElementById("np").value });
    const st = document.getElementById("npStatus");
    if (error) { st.textContent = error.message; st.className = "status err"; return; }
    start();
  };
}

let recovering = false, startedFor = null;
async function start() {
  recovering = false;
  startedFor = session?.user?.id || null;
  if (!session) return viewLogin();
  try { await loadAll(); if (await settleDuplicates()) await loadAll(); render(); }
  catch (e) { $app.innerHTML = `<div class="panel login"><h2>Can't load data</h2><p class="status err">${esc(e.message)}</p></div>`; }
}

// Supabase advises not to call its API inside this callback directly, so defer with setTimeout.
sb.auth.onAuthStateChange((event, s) => {
  session = s;
  if (event === "PASSWORD_RECOVERY") { recovering = true; setTimeout(viewNewPassword, 0); return; }
  if (recovering && event !== "SIGNED_OUT") return;
  const uid = s?.user?.id || null;
  if (event === "SIGNED_OUT" || event === "INITIAL_SESSION" || (event === "SIGNED_IN" && uid !== startedFor)) setTimeout(start, 0);
});
window.addEventListener("hashchange", () => { if (session && !recovering) render(); });
})();
