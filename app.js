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
  try { const c = JSON.parse(LS.get("cf_logtypes3") || "null"); if (c) return c; } catch {}
  let list = [];
  try {
    const j = await torn("/v2/torn/logtypes");
    list = Array.isArray(j.logtypes) ? j.logtypes
      : Object.entries(j.logtypes || {}).map(([id, t]) => ({ id: +id, title: typeof t === "string" ? t : t.title }));
  } catch {}
  const pick = re => list.filter(t => re.test(t.title || "")).map(t => +t.id);
  const ids = {
    bazaar: pick(/^bazaar sell$/i), im: pick(/^item market sell$/i),
    receive: pick(/^item receive$/i), mug: pick(/mug/i)
  };
  if (!ids.bazaar.length) ids.bazaar = [1221];
  if (!ids.im.length) ids.im = [1113];
  if (!ids.receive.length) ids.receive = [4103];
  if (list.length) LS.set("cf_logtypes3", JSON.stringify(ids));
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
  const buyer = d.buyer ?? d.buyer_id ?? null;
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
  const basic = await torn("/user/", { selections: "basic" });
  Object.assign(basic, await torn("/user/", { selections: "money" }));
  // Stock market holdings, valued at today's share price. Optional: needs the "stocks" permission (user + torn).
  let stocks = null;
  try {
    const [mine, market] = await Promise.all([torn("/user/", { selections: "stocks" }), torn("/torn/", { selections: "stocks" })]);
    const list = Object.values(mine.stocks || {}).map(h => {
      const m = (market.stocks || {})[h.stock_id] || {};
      const shares = Number(h.total_shares) || 0, price = Number(m.current_price) || 0;
      return { id: +h.stock_id, acronym: m.acronym || "", name: m.name || `Stock #${h.stock_id}`, shares, price, value: Math.round(shares * price) };
    }).filter(h => h.shares > 0);
    stocks = { list, value: list.reduce((a, h) => a + h.value, 0) };
  } catch (e) { console.warn("stocks", e); stocks = { error: e.message }; }
  const me = +basic.player_id;
  const { data: prof } = await sb.from("profiles").select("*").eq("user_id", session.user.id).maybeSingle();
  const trackStart = Number(state.settings.tracking_start) || (nowTs() - 3 * 86400);
  let from = Math.max(trackStart, (prof?.torn_id === me ? prof.last_log_ts : 0) - 120);
  const to = nowTs();

  // logs, newest first, 100 per page
  const all = new Map();
  let upper = to;
  const typeList = [...ids.bazaar, ...ids.im, ...ids.receive, ...ids.mug].join(",");
  for (let page = 0; page < 40; page++) {
    const j = await torn("/user/", { selections: "log", log: typeList, from, to: upper });
    const entries = Object.entries(j.log || {});
    let added = 0, oldest = Infinity;
    for (const [h, e] of entries) { if (!all.has(h)) { all.set(h, e); added++; } oldest = Math.min(oldest, e.timestamp); }
    say(`Reading logs… ${all.size} entries`);
    if (entries.length < 100 || added === 0 || oldest <= from) break;
    upper = oldest;
  }
  const rows = [];
  for (const [h, e] of all) rows.push(...parseLog(h, e, ids, me, names));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from("events").upsert(rows.slice(i, i + 200), { onConflict: "id", ignoreDuplicates: true });
    if (error) throw new Error("Saving events: " + error.message);
  }

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
  const { data: evIds } = await sb.from("events").select("item_id").gte("ts", trackStart).in("kind", ["bazaar_sale", "im_sale", "receive"]).limit(10000);
  const relevant = new Set([...(evIds || []).map(r => r.item_id), ...stock.keys()].filter(Boolean));
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
    if (error && /bazaar_price/.test(error.message)) // database not updated yet: save without prices
      ({ error } = await sb.from("stock").insert(rowsS.map(({ bazaar_price, ...r }) => r)));
    if (error) throw new Error("Saving stock: " + error.message);
  }

  const newest = Math.max(prof?.last_log_ts || 0, ...[...all.values()].map(e => e.timestamp), from);
  const profRow = { user_id: session.user.id, email: session.user.email, torn_id: me, torn_name: basic.name,
    money: Number(basic.money_onhand) || 0, last_log_ts: newest, synced_ts: nowTs() };
  if (stocks && !stocks.error) Object.assign(profRow, { stocks_value: stocks.value, stocks: stocks.list, stocks_ts: nowTs() });
  let { error: pErr } = await sb.from("profiles").upsert(profRow);
  if (pErr && /stocks/.test(pErr.message)) { // database not updated yet: save without stocks
    const { stocks_value, stocks: _s, stocks_ts, ...rest } = profRow; ({ error: pErr } = await sb.from("profiles").upsert(rest));
  }
  if (pErr) throw new Error("Saving profile: " + pErr.message);

  say("Checking lots…");
  await loadAll();
  const closed = await closeLots();
  await loadAll();
  say(`Synced ${basic.name} · ${rows.length} new log lines · ${closed} lot${closed === 1 ? "" : "s"} closed · ${new Date().toLocaleTimeString("en-GB")}`, "okc");
}

/* ---------------- Lots ---------------- */
function computeLots() {
  const trackStart = Number(state.settings.tracking_start) || 0;
  const supByTorn = new Map(state.suppliers.map(s => [+s.torn_id, s]));
  const lastClose = new Map();
  for (const l of state.lots) lastClose.set(l.item_id, Math.max(lastClose.get(l.item_id) || 0, Number(l.closed_ts)));
  const byItem = new Map();
  for (const e of state.events) {
    if (!["bazaar_sale", "im_sale", "receive"].includes(e.kind) || !e.item_id) continue;
    const start = Math.max(trackStart, lastClose.get(e.item_id) || 0);
    if (Number(e.ts) <= start) continue;
    const g = byItem.get(e.item_id) || { item_id: e.item_id, item_name: e.item_name, start, sales: [], receipts: [] };
    (e.kind === "receive" ? g.receipts : g.sales).push(e);
    byItem.set(e.item_id, g);
  }
  const stockOf = id => state.stock.filter(s => s.item_id === id).reduce((a, s) => a + s.bazaar_qty + s.im_qty + s.inv_qty, 0);
  const oldestSync = state.profiles.length ? Math.min(...state.profiles.map(p => Number(p.synced_ts) || 0)) : 0;
  const out = [];
  for (const g of byItem.values()) {
    const sold = g.sales.reduce((a, e) => a + e.qty, 0);
    const revenue = g.sales.reduce((a, e) => a + Number(e.net), 0);
    const perSup = new Map();
    for (const r of g.receipts) {
      if (isTeam(r.counterparty_id)) continue; // RivenCross ⇄ BellaTricks transfers stay Collector's Fix
      const s = supByTorn.get(+r.counterparty_id);
      if (s) perSup.set(s.id, { sup: s, qty: (perSup.get(s.id)?.qty || 0) + r.qty });
    }
    const left = stockOf(g.item_id);
    const lastEv = Math.max(0, ...g.sales.map(e => +e.ts), ...g.receipts.map(e => +e.ts));
    out.push({ ...g, sold, revenue, perSup: [...perSup.values()], left,
      opened: Math.min(...[...g.sales, ...g.receipts].map(e => +e.ts)), lastSale: Math.max(0, ...g.sales.map(e => +e.ts)),
      canClose: sold > 0 && left === 0 && oldestSync >= lastEv });
  }
  return out.sort((a, b) => b.lastSale - a.lastSale);
}

function splitLot(l) {
  let supTotal = l.perSup.reduce((a, p) => a + p.qty, 0);
  const scale = supTotal > l.sold ? l.sold / supTotal : 1;
  const shares = l.perSup.map(p => {
    const qty = Math.round(p.qty * scale);
    const gross = Math.round(l.revenue * qty / l.sold);
    const rate = Number(p.sup.rate);
    return { supplier_id: p.sup.id, supplier_name: p.sup.name, qty, rate, gross_share: gross, payout: Math.round(gross * (1 - rate / 100)) };
  });
  supTotal = shares.reduce((a, s) => a + s.qty, 0);
  const cfKeeps = l.revenue - shares.reduce((a, s) => a + s.payout, 0);
  return { shares, own: Math.max(0, l.sold - supTotal), cfKeeps };
}

async function closeLots() {
  let n = 0;
  for (const l of computeLots().filter(x => x.canClose)) {
    const { shares, own, cfKeeps } = splitLot(l);
    const { data, error } = await sb.from("lots").insert({ item_id: l.item_id, item_name: l.item_name, opened_ts: l.opened, closed_ts: l.lastSale,
      sold_qty: l.sold, revenue: l.revenue, own_qty: own, cf_keeps: cfKeeps }).select().maybeSingle();
    if (error || !data) continue; // the other person closed it first
    if (shares.length) await sb.from("lot_shares").insert(shares.map(s => ({ ...s, lot_id: data.id })));
    n++;
  }
  return n;
}

/* ---------------- Data ---------------- */
async function loadAll() {
  const trackStart = 0;
  const [sup, lots, shares, profiles, stock, events, settings] = await Promise.all([
    sb.from("suppliers").select("*").order("name"),
    sb.from("lots").select("*").order("closed_ts", { ascending: false }).limit(500),
    sb.from("lot_shares").select("*").order("id", { ascending: false }).limit(1000),
    sb.from("profiles").select("*"),
    sb.from("stock").select("*"),
    sb.from("events").select("id,account_id,kind,ts,item_id,item_name,qty,gross,fee,net,counterparty_id").gte("ts", trackStart).order("ts", { ascending: false }).limit(10000),
    sb.from("settings").select("*")
  ]);
  const err = [sup, lots, shares, profiles, stock, events, settings].find(r => r.error);
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
const VIEWS = { till: "Daily Till", bazaar: "Bazaar Listings", alerts: "Payouts", lots: "Lots", suppliers: "Suppliers", rent: "Rent", settings: "Settings" };

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
    try { await sync(st); const m = st.textContent; render(); const s2 = document.getElementById("syncStatus"); s2.textContent = m; s2.className = "status okc"; }
    catch (e) { st.textContent = e.message; st.className = "status err"; btn.disabled = false; }
  };
}

function currentView() { const h = location.hash.slice(1); return VIEWS[h] ? h : "till"; }

function render() {
  const v = currentView();
  ({ till: viewTill, bazaar: viewBazaar, alerts: viewAlerts, lots: viewLots, suppliers: viewSuppliers, rent: viewRent, settings: viewSettings })[v]();
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
  const tip = p => (p.stocks || []).map(h => `${h.acronym || h.name}: ${Number(h.shares).toLocaleString("en-US")} sh · ${money(h.value)}`).join("\n");
  return `<div class="panel pad stocks">
    <div><span class="sub">STOCKS BY ACCOUNT</span>
      ${ps.length ? ps.map(p => `<div class="acct" title="${esc(tip(p))}"><b>${esc(p.torn_name || p.email)}</b><span class="big" style="font-size:22px">${money(p.stocks_value)}</span></div>`).join("")
        : `<p class="note">No stock data yet. Add the <b>stocks</b> permission (User and Torn) to your key, then sync.</p>`}</div>
    <div><span class="sub">STOCKS COMBINED</span><div class="big">${money(total)}</div>
      <div class="sub">${last ? "share prices as of " + new Date(last * 1000).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : ""}</div></div>
    <div><span class="sub">NET TODAY + STOCKS</span><div class="big ${net + total < 0 ? "neg" : "pos"}">${money(net + total)}</div>
      <div class="sub">${money(net)} today + ${money(total)} in stocks</div></div>
  </div>`;
}

function viewTill() {
  tillDay = tillDay || todayStr();
  const { from, to } = dayRange(tillDay);
  const ev = state.events.filter(e => e.ts >= from && e.ts <= to);
  const sum = (k, f = "net") => ev.filter(e => e.kind === k).reduce((a, e) => a + Number(e[f]), 0);
  const cnt = k => ev.filter(e => e.kind === k);
  const bz = sum("bazaar_sale"), im = sum("im_sale"), imFee = sum("im_sale", "fee"), loss = sum("mug");
  const lotsToday = state.lots.filter(l => l.closed_ts >= from && l.closed_ts <= to);
  const supToday = state.shares.filter(s => lotsToday.some(l => l.id === s.lot_id)).reduce((a, s) => a + Number(s.payout), 0);
  const net = bz + im - loss;
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
      <div class="panel drawer" style="--c:var(--bad)"><h2>Losses</h2><div class="big neg">${loss ? "−" : ""}${money(loss)}</div>
        <div class="sub">${cnt("mug").length} mugging${cnt("mug").length === 1 ? "" : "s"}</div></div>
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

/* ---------------- Bazaar listings ---------------- */
function viewBazaar() {
  let names = {};
  try { names = JSON.parse(LS.get("cf_items") || "null")?.items || {}; } catch {}
  const nameOf = id => { const p = state.profiles.find(p => +p.torn_id === +id); return p?.torn_name || TEAM[+id] || `#${id}`; };
  const rows = state.stock.filter(s => s.bazaar_qty > 0);
  const accounts = [...new Set(rows.map(r => r.account_id))];
  const open = new Map(computeLots().map(l => [l.item_id, l]));
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
          const mv = names[r.item_id]?.value, pr = Number(r.bazaar_price) || 0, lot = open.get(r.item_id);
          const diff = pr && mv ? Math.round((pr / mv - 1) * 100) : null;
          return `<tr><td>${esc(r.item_name)}</td><td class="n">${r.bazaar_qty}</td>
            <td class="n">${pr ? money(pr) : "—"}${diff != null ? ` <span class="sub ${diff > 0 ? "pos" : diff < 0 ? "neg" : ""}">${diff > 0 ? "+" : ""}${diff}%</span>` : ""}</td>
            <td class="n">${mv ? money(mv) : "—"}</td><td class="n">${pr ? money(pr * r.bazaar_qty) : "—"}</td>
            <td class="sub">${lot && lot.perSup.length ? lot.perSup.map(p => `${esc(p.sup.name)} ${p.qty}`).join(" · ") : "—"}</td></tr>`;
        }).join("")}</tbody></table></div></section>`;
    }).join("") : `<div class="panel empty">Nothing listed, or no sync yet. The bazaar is read from the account it belongs to, so BellaTricks needs to sync for her bazaar to show here.</div>`}
    <p class="note">This is a snapshot from the last sync of each account, so it works while you travel. Market value comes from Torn and is refreshed once a day on this browser. "From suppliers" counts units suppliers sent into the current lot of that item.</p>`);
}

/* ---------------- Payouts (alerts) ---------------- */
function viewAlerts() {
  const lotById = new Map(state.lots.map(l => [l.id, l]));
  const pend = state.shares.filter(s => s.status === "pending");
  const paid = state.shares.filter(s => s.status === "paid").slice(0, 30);
  const owedBy = new Map();
  for (const s of pend) owedBy.set(s.supplier_name, (owedBy.get(s.supplier_name) || 0) + Number(s.payout));
  const line = s => {
    const l = lotById.get(s.lot_id) || {};
    return `<div class="alert ${s.status}">
      <div class="msg"><span class="dot"></span><b>${l.sold_qty ?? "?"} ${esc(l.item_name || "items")}</b> sold out.
        ${s.status === "pending" ? "Pay" : "Paid"} <b>${esc(s.supplier_name)}</b> for ${s.qty} unit${s.qty === 1 ? "" : "s"}:
        <b class="amt">${money(s.payout)}</b>
        <div class="sub">Lot revenue ${money(l.revenue)} · his share ${money(s.gross_share)} − your ${Number(s.rate)}% · closed ${new Date(l.closed_ts * 1000).toLocaleDateString("en-GB")}${s.paid_at ? ` · paid ${new Date(s.paid_at).toLocaleDateString("en-GB")} by ${esc(s.paid_by || "")}` : ""}</div>
      </div>
      ${s.status === "pending" ? `<button class="ok small" data-pay="${s.id}" type="button">Mark paid</button>` : `<button class="ghost small" data-unpay="${s.id}" type="button">Undo</button>`}
    </div>`;
  };
  shell(`
    <div class="drawers">
      <div class="panel drawer" style="--c:var(--bad)"><h2>Still to pay</h2><div class="big neg">${money(pend.reduce((a, s) => a + Number(s.payout), 0))}</div>
        <div class="sub">${pend.length} pending payout${pend.length === 1 ? "" : "s"}</div></div>
      ${[...owedBy].map(([n, v]) => `<div class="panel drawer" style="--c:var(--rust)"><h2>${esc(n)}</h2><div class="big">${money(v)}</div><div class="sub">owed</div></div>`).join("")}
    </div>
    <section><h3>Pending</h3><div class="alerts">${pend.length ? pend.map(line).join("") : `<div class="panel empty">Nothing to pay. When a lot with supplier items sells out, it shows up here in red.</div>`}</div></section>
    <section><h3>Paid recently</h3><div class="alerts">${paid.length ? paid.map(line).join("") : `<div class="panel empty">No payouts marked as paid yet.</div>`}</div></section>`);
  $app.querySelectorAll("[data-pay]").forEach(b => b.onclick = () => setPaid(+b.dataset.pay, true));
  $app.querySelectorAll("[data-unpay]").forEach(b => b.onclick = () => setPaid(+b.dataset.unpay, false));
}
async function setPaid(id, paid) {
  await sb.from("lot_shares").update(paid ? { status: "paid", paid_at: new Date().toISOString(), paid_by: session.user.email } : { status: "pending", paid_at: null, paid_by: null }).eq("id", id);
  await loadAll(); render();
}

/* ---------------- Lots ---------------- */
function viewLots() {
  const open = computeLots();
  const shareByLot = new Map();
  for (const s of state.shares) (shareByLot.get(s.lot_id) || shareByLot.set(s.lot_id, []).get(s.lot_id)).push(s);
  shell(`
    <p class="note">A lot is every unit of one item from the moment it arrives until the last one sells. Supplier items are recognised from "item received" logs; everything else counts as Collector's Fix stock, including anything RivenCross and BellaTricks send each other. Nobody is paid until the whole lot sells out.</p>
    <section><h3>In progress</h3><div class="grid2">${open.length ? open.map(l => {
      const total = l.sold + l.left, pct = total ? Math.round(l.sold / total * 100) : 0;
      const supQ = l.perSup.reduce((a, p) => a + p.qty, 0);
      return `<div class="panel card">
        <div class="card-head"><h2>${esc(l.item_name)}</h2><span class="sub">${l.sold}/${total} sold</span></div>
        <div class="bar ${pct >= 100 ? "full" : ""}"><i style="width:${pct}%"></i></div>
        <div class="kv"><div><span>Revenue so far</span><b>${money(l.revenue)}</b></div><div><span>Left</span><b>${l.left}</b></div>
          <div><span>From suppliers</span><b>${supQ}</b></div><div><span>Collector's Fix</span><b>${Math.max(0, total - supQ)}</b></div></div>
        <div class="sub">${l.perSup.length ? l.perSup.map(p => `${esc(p.sup.name)}: ${p.qty}`).join(" · ") : "No supplier items in this lot"}${l.left === 0 && l.sold && !l.canClose ? " · waiting for every account to sync before closing" : ""}</div>
      </div>`;
    }).join("") : `<div class="panel empty">No open lots. Sync to read your logs.</div>`}</div></section>
    <section><h3>Sold out</h3><div class="panel tbl"><table>
      <thead><tr><th>Closed</th><th>Item</th><th class="n">Sold</th><th class="n">Revenue</th><th>Split</th><th class="n">Collector's Fix keeps</th></tr></thead>
      <tbody>${state.lots.length ? state.lots.map(l => `<tr><td class="t">${new Date(l.closed_ts * 1000).toLocaleDateString("en-GB")}</td><td>${esc(l.item_name)}</td>
        <td class="n">${l.sold_qty}</td><td class="n">${money(l.revenue)}</td>
        <td>${(shareByLot.get(l.id) || []).map(s => `<span class="${s.status === "paid" ? "pos" : "neg"}">${esc(s.supplier_name)} ${s.qty} → ${money(s.payout)}</span>`).join(" · ")}${(shareByLot.get(l.id) || []).length ? " · " : ""}CF ${l.own_qty}</td>
        <td class="n">${money(l.cf_keeps)}</td></tr>`).join("") : `<tr><td colspan="6" class="empty">No lots sold out yet.</td></tr>`}</tbody>
    </table></div></section>`);
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
  const cash = state.profiles.reduce((a, p) => a + Number(p.money || 0), 0);
  const owed = state.shares.filter(s => s.status === "pending").reduce((a, s) => a + Number(s.payout), 0);
  const free = cash - owed;
  const enough = free >= rent.amount;
  const pct = Math.max(0, Math.min(100, Math.round(free / rent.amount * 100)));
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
      <div class="bar ${enough ? "full" : "warn"}"><i style="width:${pct}%"></i></div>
      <div class="rentbig">
        <div><span class="sub">CASH ON HAND</span><div class="big">${money(cash)}</div><div class="sub">${state.profiles.map(p => `${esc(p.torn_name || p.email)} ${money(p.money)}`).join(" · ") || "Sync to read wallets"}</div></div>
        <div><span class="sub">OWED TO SUPPLIERS</span><div class="big neg">−${money(owed)}</div></div>
        <div><span class="sub">FREE FOR RENT</span><div class="big ${enough ? "pos" : "neg"}">${money(free)}</div><div class="sub">${enough ? `${money(free - rent.amount)} left after paying` : `${money(short)} short`}</div></div>
        <div><span class="sub">DUE</span><div class="big">${due ? (hoursLeft > 0 ? `${Math.floor(hoursLeft / 24)}d ${Math.floor(hoursLeft % 24)}h` : "Overdue") : "—"}</div>
          <div class="sub">${due ? due.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "Set the next due date below"}</div></div>
      </div>
      <p class="note">${short === 0 ? "You already have the rent free and clear." : daily > 0 ? `At the last 7 days' pace (${money(daily)}/day net sales) you cover the gap in about ${daysToCover < 1 ? "less than a day" : Math.ceil(daysToCover) + " day" + (Math.ceil(daysToCover) === 1 ? "" : "s")}.` : "No sales in the last 7 days to project from."}
        Cash is the wallet of every synced account, minus supplier payouts that are still pending.</p>
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
  try { await loadAll(); render(); }
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
