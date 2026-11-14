(function () {
  "use strict";
  // ---------- Hjälpare ----------
  const $ = s => document.querySelector(s);
  const num = v => { if (v === undefined || v === null || v === "") return null; const n = parseFloat(String(v).replace(/\s/g, "").replace(",", ".")); return isFinite(n) ? n : null; };
  const fmt = (n, d) => n == null ? "–" : Number(n).toLocaleString("sv-SE", { maximumFractionDigits: d == null ? 2 : d, minimumFractionDigits: d == null ? 0 : d });
  const pct = (n, d) => n == null || !isFinite(n) ? "–" : (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(d == null ? 1 : d).replace(".", ",") + " %";
  const apct = n => n == null || !isFinite(n) ? "–" : Math.abs(n).toFixed(1).replace(".", ",") + " %";
  const tone = n => n > 0 ? "up" : n < 0 ? "down" : "";
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const lvls = a => Array.isArray(a) && a.length ? a.map(v => fmt(num(v))).join(" / ") : "–";
  const ts = v => v ? new Date(v).getTime() : 0;
  const dayCount = v => v ? Math.max(0, Math.floor((Date.now() - ts(v)) / 86400000)) : null;
  const date = v => v ? new Date(v).toLocaleDateString("sv-SE", { day: "numeric", month: "short" }) : "";

  const cfg = window.TRADELOGGEN_CONFIG || {};
  if (!window.supabase || !cfg.supabaseUrl) { document.body.innerHTML = '<div class="login"><p class="status">Appen är inte konfigurerad.</p></div>'; return; }
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });

  let user = null, signals = [], trades = [], view = "sig", openKey = null, inline = null, copied = null, channel = null;
  let quotes = {}, quotesAt = null, quoteTimer = null, buyFor = null;

  // ---------- Inloggning ----------
  const DOMAIN = "@tradeloggen.app";
  const toEmail = u => { u = u.trim().toLowerCase(); return u.includes("@") ? u : u + DOMAIN; };
  function showLogin() { $("#appView").hidden = true; $("#loginView").hidden = false; document.body.classList.add("auth"); }
  function showApp() { $("#loginView").hidden = true; $("#appView").hidden = false; document.body.classList.remove("auth"); setTimeout(() => refreshPushTip(), 0); }

  $("#loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    $("#loginBtn").disabled = true; $("#loginStatus").textContent = "Loggar in…";
    const { error } = await sb.auth.signInWithPassword({ email: toEmail($("#loginUser").value), password: $("#loginPass").value });
    $("#loginBtn").disabled = false;
    $("#loginStatus").textContent = error ? (/invalid/i.test(error.message) ? "Fel användarnamn eller lösenord." : "Kunde inte logga in just nu. Försök igen.") : "";
    if (!error) $("#loginPass").value = "";
  });
  $("#logoutBtn").addEventListener("click", () => sb.auth.signOut());

  sb.auth.onAuthStateChange((_e, session) => {
    const next = session ? session.user : null;
    if (next && (!user || user.id !== next.id)) { user = next; showApp(); load(); subscribe(); startQuotes(); }
    if (!next) { user = null; signals = []; trades = []; if (channel) { sb.removeChannel(channel); channel = null; } clearInterval(quoteTimer); showLogin(); }
  });
  sb.auth.getSession().then(({ data }) => { if (!data.session) showLogin(); });

  // ---------- Data ----------
  let dismissed = new Set();
  async function load() {
    const [s, t, d] = await Promise.all([
      sb.from("signals").select("*").order("skapad", { ascending: false }),
      sb.from("trades").select("*").order("skapad", { ascending: false }),
      sb.from("dismissed").select("signal_id")
    ]);
    if (s.error || t.error || d.error) { $("#headline").textContent = "Kunde inte hämta data. Ladda om sidan."; return; }
    signals = s.data; trades = t.data; dismissed = new Set(d.data.map(r => r.signal_id));
    render(); fetchQuotes();
  }
  function subscribe() {
    if (channel) sb.removeChannel(channel);
    let timer = null; const again = () => { clearTimeout(timer); timer = setTimeout(load, 300); };
    channel = sb.channel("tl").on("postgres_changes", { event: "*", schema: "public", table: "signals" }, again)
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, again).subscribe();
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && user) load(); });

  // ---------- Kurser ----------
  function ySym(tv) {
    if (!tv) return null;
    const p = String(tv).toUpperCase().split(":"), ex = p.length > 1 ? p[0] : "", s = p.length > 1 ? p[1] : p[0];
    if (/HEX|HEL/.test(ex)) return s.replace(/_/g, "-") + ".HE";
    if (/OMXCOP|CSE/.test(ex)) return s.replace(/_/g, "-") + ".CO";
    if (/OSL|OSE/.test(ex)) return s.replace(/_/g, "-") + ".OL";
    if (/OMX|STO|NGM|FN/.test(ex)) return s.replace(/_/g, "-") + ".ST";
    if (/XETR|FWB/.test(ex)) return s + ".DE";
    if (/EURONEXT|EPA/.test(ex)) return s + ".PA";
    return s.replace(/\./g, "-");
  }
  const q = t => { const y = ySym(t.ticker); return y ? quotes[y] : null; };
  const price = t => { const x = q(t); return x && typeof x.price === "number" ? x.price : num(t.kurs); };
  const today = t => { const x = q(t); return x && x.prev ? (x.price - x.prev) / x.prev * 100 : null; };
  async function fetchQuotes() {
    const syms = Array.from(new Set(signals.concat(trades.filter(t => t.status !== "Stängd")).map(t => ySym(t.ticker)).filter(Boolean)));
    if (!syms.length) return;
    try {
      const r = await fetch("/api/quote?symbols=" + encodeURIComponent(syms.join(",")));
      if (!r.ok) return;
      const data = await r.json();
      Object.keys(data).forEach(k => { if (data[k]) quotes[k] = data[k]; });
      quotesAt = new Date(); render(true);
    } catch (e) { /* behåll senaste */ }
  }
  function startQuotes() { clearInterval(quoteTimer); quoteTimer = setInterval(() => { if (!document.hidden) fetchQuotes(); }, 60000); }

  // ---------- Marknader ----------
  function markets() {
    const p = Object.fromEntries(new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value]));
    const wk = !/lör|sön/i.test(p.weekday), m = +p.hour * 60 + +p.minute;
    return { se: wk && m >= 540 && m < 1050, us: wk && m >= 930 && m < 1320 };
  }

  // ---------- Besked ----------
  const sameStock = (a, b) => (a.ticker && b.ticker && a.ticker === b.ticker) || (a.aktie || "").toLowerCase() === (b.aktie || "").toLowerCase();
  const open = () => trades.filter(t => t.status !== "Stängd");
  const closed = () => trades.filter(t => t.status === "Stängd");

  // Köpzon: utgår bara från Stockrobbers egna stöd/motstånd. Ett brutet motstånd räknas som nytt stöd
  // (han skriver själv att ett utbrott är en bekräftelsesignal), så "för sent" finns inte längre.
  const ZON_BRA = 3, ZON_OK = 7;
  function zone(s, p) {
    const list = a => (a || []).map(num).filter(v => v != null);
    const sup = list([s.kop].concat(s.stod || [])), res = list([s.mal1, s.mal2].concat(s.motstand || []));
    const lv = Array.from(new Set(sup.concat(res))).sort((a, b) => a - b);
    if (!lv.length || p == null) return null;
    let i = -1; lv.forEach((v, k) => { if (v <= p) i = k; });
    const ref = i < 0 ? lv[0] : lv[i];
    const kop = num(s.kop), stopp0 = num(s.stopp);
    const broken = res.includes(ref) && !sup.includes(ref);
    let stopp = stopp0;
    if (kop != null && ref > kop && i > 0) stopp = Math.max(stopp0 || 0, +(lv[i - 1] * 0.985).toFixed(2));
    const next = lv.filter(v => v > p);
    return { ref, broken, stopp, d: (p - ref) / ref * 100, top: ref >= 100 ? Math.round(ref * (1 + ZON_BRA / 100)) : +(ref * (1 + ZON_BRA / 100)).toFixed(2), next: next[0] != null ? next[0] : null, next2: next[1] != null ? next[1] : null };
  }
  function buyVerdict(s) {
    const p = price(s), stopp = num(s.stopp);
    if (p == null || num(s.kop) == null) return { cls: "b-wait", label: "Bevaka", text: "Väntar på kurs", rank: 3 };
    if (stopp != null && p < stopp) return { cls: "b-stop", label: "Under stopp", text: "Stödet är brutet. Vänta på ny analys från Stockrobber.", rank: 5 };
    const z = zone(s, p);
    const rd = s.rapport_datum ? (ts(s.rapport_datum + "T12:00:00Z") - Date.now()) / 864e5 : null;
    if (rd != null && rd >= -1 && rd <= 3) return { cls: "b-wait", label: "Vänta", text: "Rapport " + date(s.rapport_datum) + ", vänta till efter", rank: 3, z };
    if (z.d <= ZON_BRA) return { cls: "b-buy", label: "Bra köpläge", text: z.broken ? "Över utbrottet " + fmt(z.ref) + ", gammalt motstånd blir stöd" : (z.d < 0 ? "Under köpnivån, fortfarande över stopp" : "Nära stödet " + fmt(z.ref)), rank: 0, hot: true, z };
    if (z.d <= ZON_OK) return { cls: "b-ok", label: "Helt okej köpläge", text: apct(z.d) + " över stödet " + fmt(z.ref) + ". Okej för en swing, inte bästa nivån", rank: 1, z };
    return { cls: "b-wait", label: "Vänta på rekyl", text: "Bra läge runt " + fmt(z.ref) + "–" + fmt(z.top), rank: 2, z };
  }
  function srSell(t) { return signals.find(s => s.typ === "SÄLJ" && sameStock(s, t) && ts(s.skapad) > ts(t.skapad)); }
  function posVerdict(t) {
    const p = price(t), stopp = num(t.stopp), m1 = num(t.mal1), m2 = num(t.mal2), ko = num(t.knockout), sell = srSell(t);
    if (sell) return { cls: "b-sell", label: "Sälj", text: "Stockrobber säljer: " + (sell.skal || "se signalen"), rank: 0, hot: true };
    if (p == null) return { cls: "b-hold", label: "Håll", text: "Väntar på kurs", rank: 3 };
    if (stopp != null && p <= stopp) return { cls: "b-sell", label: "Sälj", text: "Stoppet " + fmt(stopp) + " är nått", rank: 0, hot: true };
    if (ko != null && t.instrument !== "Aktie" && p <= ko * 1.03) return { cls: "b-sell", label: "Nära knock-out", text: "Bara " + apct((p - ko) / p * 100) + " kvar till certifikatets stopnivå", rank: 0, hot: true };
    if (m2 != null && p >= m2) return { cls: "b-take", label: "Ta hem vinst", text: "Sista motståndet " + fmt(m2) + " är nått. Överväg att sälja en del.", rank: 1, hot: true };
    if (m1 != null && p >= m1) return { cls: "b-take", label: "Flytta stopp", text: "Över motståndet " + fmt(m1) + ". Flytta upp stoppet till ca " + fmt(m1 * 0.985) + " och låt den rulla.", rank: 1, hot: true };
    const parts = [];
    if (m1 != null) parts.push(apct((m1 - p) / p * 100) + " till motstånd");
    if (stopp != null) parts.push(apct((p - stopp) / p * 100) + " till stopp");
    return { cls: "b-hold", label: "Håll", text: parts.join(" · ") || "Inga nivåer satta", rank: 2 };
  }
  const lev = t => t.instrument === "Aktie" ? 1 : (num(t.hav) || 1);
  function since(t) { const p = t.status === "Stängd" ? num(t.salj_kurs) : price(t), kop = num(t.kop); return p != null && kop ? (p - kop) / kop * 100 : null; }
  // Certifikat: värdet följer (aktie − finansieringsnivå F), så utvecklingen blir (S − F) / (S0 − F) − 1,
  // exakt som på Avanza (bortsett från valuta och liten daglig ränta).
  const finOf = t => t.instrument !== "Aktie" ? num(t.fin_niva) : null;
  function lotGrowth(t, p) {
    const F = finOf(t), kop = num(t.kop);
    if (p == null || kop == null) return null;
    if (t.instrument === "Aktie") return p / kop;
    if (F != null && kop > F) return (p - F) / (kop - F);
    const L = lev(t); return 1 + (p / kop - 1) * L;
  }
  // Flera köp (påfyllningar) slås ihop: viktat efter insatt belopp
  function certSince(t) {
    const p = t.status === "Stängd" ? num(t.salj_kurs) : price(t), lots = t.lots || [t];
    let inv = 0, val = 0;
    for (const l of lots) { const g = lotGrowth(l, p), w = (num(l.antal) || 1) * (num(l.cert_kop) || num(l.kop) || 1); if (g == null) return null; inv += w; val += w * g; }
    return inv ? (val / inv - 1) * 100 : null;
  }
  const levNow = t => { const F = finOf(t), p = price(t); return F != null && p != null && p > F ? p / (p - F) : lev(t); };
  // Nästa motstånd (bara hans motståndsnivåer) över en kurs
  function resAbove(s, p) {
    const r = [s.mal1, s.mal2].concat(s.motstand || []).map(num).filter(v => v != null && v > p).sort((a, b) => a - b);
    return [r[0] != null ? r[0] : null, r[1] != null ? r[1] : null];
  }

  // ---------- Listor ----------
  function sigList() {
    const buys = signals.filter(s => s.typ !== "SÄLJ" && !dismissed.has(s.id) && !trades.some(t => t.signal_id === s.id));
    const sells = signals.filter(s => s.typ === "SÄLJ" && !dismissed.has(s.id));
    return sells.map(s => ({ s, v: { cls: "b-sell", label: "Säljsignal", text: open().some(t => sameStock(t, s)) ? "Du äger aktien" : "Du äger inte aktien", rank: -1, hot: open().some(t => sameStock(t, s)) } }))
      .concat(buys.map(s => ({ s, v: buyVerdict(s) })).sort((a, b) => a.v.rank - b.v.rank || ts(b.s.skapad) - ts(a.s.skapad)));
  }
  const gkey = t => t.signal_id || (t.aktie + "|" + (t.ticker || ""));
  const lotsOf = t => open().filter(x => gkey(x) === gkey(t)).sort((a, b) => ts(a.skapad) - ts(b.skapad));
  function merge(lots) {
    if (lots.length === 1) return lots[0];
    const w = l => (num(l.antal) || 1) * (num(l.cert_kop) || num(l.kop) || 1), W = lots.reduce((a, l) => a + w(l), 0);
    const last = lots[lots.length - 1];
    return Object.assign({}, last, { id: lots[0].id, lots, skapad: lots[0].skapad, kop: lots.reduce((a, l) => a + num(l.kop) * w(l), 0) / W, antal: lots.reduce((a, l) => a + (num(l.antal) || 0), 0) || null });
  }
  function posList() {
    const g = {}; open().forEach(t => (g[gkey(t)] = g[gkey(t)] || []).push(t));
    return Object.values(g).map(ls => merge(ls.sort((a, b) => ts(a.skapad) - ts(b.skapad)))).map(t => ({ t, v: posVerdict(t) })).sort((a, b) => a.v.rank - b.v.rank || ts(b.t.skapad) - ts(a.t.skapad));
  }

  // ---------- Rendering ----------
  function render(quiet) {
    const mk = markets();
    $("#markets").innerHTML = '<span><i class="dot' + (mk.se ? " on" : "") + '"></i>Stockholm ' + (mk.se ? "öppen" : "stängd") + '</span><span><i class="dot' + (mk.us ? " on" : "") + '"></i>USA ' + (mk.us ? "öppen" : "stängd") + "</span>";
    const sl = sigList(), pl = posList(), hl = closed();
    $("#cSig").textContent = sl.length; $("#cPos").textContent = pl.length; $("#cHis").textContent = hl.length;
    const buyNow = sl.filter(x => x.v.cls === "b-buy").length, act = pl.filter(x => x.v.hot).length;
    const parts = [];
    parts.push(buyNow ? "<b>" + buyNow + " " + (buyNow === 1 ? "bra köpläge" : "bra köplägen") + "</b> just nu" : "Inga bra köplägen just nu");
    if (act) parts.push("<b>" + act + " " + (act === 1 ? "aktie" : "aktier") + " att agera på</b>");
    else if (pl.length) parts.push(pl.length + " " + (pl.length === 1 ? "aktie" : "aktier") + " att hålla");
    $("#headline").innerHTML = parts.join(" · ");
    $("#updated").textContent = quotesAt ? "Kurser " + quotesAt.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" }) + " · uppdateras varje minut" : "";
    document.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-pressed", b.dataset.f === view ? "true" : "false"));

    let rows;
    if (view === "sig") rows = sl.map(x => ({ key: "s:" + x.s.id, html: sigCard(x.s, x.v) }));
    else if (view === "pos") rows = pl.map(x => ({ key: "t:" + x.t.id, html: posCard(x.t, x.v) }));
    else rows = hl.map(t => ({ key: "t:" + t.id, html: hisCard(t) }));

    if (!rows.length) {
      const m = { sig: ["Inga signaler just nu", "När Stockrobber går ut med ett köp eller sälj dyker det upp här automatiskt."],
        pos: ["Du äger inga aktier här än", "Tryck på Jag köpte på en signal, så följer appen aktien och säger till när det är dags att sälja."],
        his: ["Ingen historik än", "När du säljer en aktie hamnar den här med resultatet."] }[view];
      $("#list").innerHTML = '<div class="empty"><h2>' + m[0] + "</h2><p>" + m[1] + "</p></div>";
      return;
    }
    if (view === "his") { const wins = hl.filter(t => since(t) > 0).length; rows.unshift({ key: "x", html: '<p class="headline">Träffsäkerhet <b>' + Math.round(wins / hl.length * 100) + " %</b> · " + wins + " av " + hl.length + " med vinst</p>" }); }

    if (quiet) {
      rows.forEach(r => {
        const el = document.querySelector('[data-card="' + CSS.escape(r.key) + '"]'); if (!el) return;
        const tmp = document.createElement("div"); tmp.innerHTML = r.html;
        const n = tmp.firstElementChild;
        ["[data-sum]", "[data-live]", "[data-live2]"].forEach(sel => { const a = el.querySelector(sel), b = n.querySelector(sel); if (a && b) a.replaceWith(b); });
        el.className = n.className;
      });
      return;
    }
    $("#list").innerHTML = rows.map(r => r.html).join("");
    mountCharts();
  }

  function head(t, extra) {
    const p = price(t), d = today(t), cur = t.valuta || "SEK";
    return '<div class="row"><div><h2 class="name">' + esc(t.aktie) + '</h2><div class="sub">' + esc(extra) + "</div></div>" +
      '<div class="px">' + (p != null ? "<b>" + fmt(p, 2) + ' <small class="muted">' + esc(cur) + "</small></b>" : "") +
      (d != null ? '<small class="' + tone(d) + '">' + pct(d, 2) + " idag</small>" : "") + "</div></div>";
  }
  function track(lo, hi, mid, p, loL, hiL) {
    if (lo == null || hi == null || hi <= lo) return "";
    const x = v => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100)).toFixed(1);
    return '<div class="track">' + (p != null ? '<em style="width:' + x(p) + '%"></em>' : "") + (mid != null ? '<u style="left:' + x(mid) + '%"></u>' : "") + (p != null ? '<i style="left:' + x(p) + '%"></i>' : "") + "</div>" +
      '<div class="tlbl"><span>' + loL + " " + fmt(lo) + "</span><span>" + hiL + " " + fmt(hi) + "</span></div>";
  }

  function sigCard(s, v) {
    const key = "s:" + s.id, isOpen = openKey === key, sell = s.typ === "SÄLJ";
    const kop = num(s.kop), stopp = num(s.stopp), m1 = num(s.mal1), m2 = num(s.mal2), p = price(s);
    let h = '<article class="card' + (v.hot ? " hot" : "") + '" data-card="' + esc(key) + '"><button class="sum" type="button" data-a="toggle" data-k="' + esc(key) + '" aria-expanded="' + isOpen + '"><div data-sum style="display:flex;flex-direction:column;gap:12px">' +
      head(s, ["Stockrobber", s.datum, s.hogrisk ? "Högrisk" : ""].filter(Boolean).join(" · ")) +
      '<div class="verdict"><span class="badge ' + v.cls + '">' + v.label + '</span><span class="why-short">' + esc(v.text) + "</span></div>";
    const z = v.z || null;
    if (!sell) h += '<div class="plan"><div class="k"><span>Köpzon</span><b>' + (z ? fmt(z.ref) + "–" + fmt(z.top) : fmt(kop)) + "</b></div><div><span>Stopp</span><b>" + fmt(z ? z.stopp : stopp) + "</b></div><div><span>Motstånd</span><b>" + fmt(z ? z.next : m1) + "</b></div></div>";
    h += "</div></button>";
    if (!isOpen) return h + "</article>";

    h += '<div class="detail">';
    if (s.skal) h += '<div><p class="why">' + esc(s.skal) + '</p><p class="src">' + esc([s.kalla, s.datum].filter(Boolean).join(" · ")) + "</p></div>";
    if (s.rapport) h += '<div class="note">⚠️ ' + esc(s.rapport) + "</div>";
    if (s.hogrisk) h += '<div class="note red">Högriskbolag enligt Stockrobber. Liten position, helst utan hävstång.</div>';
    if (s.ticker) h += '<div class="chart" data-tv="' + esc(s.ticker) + '"></div>';
    if (!sell) {
      const st = z ? z.stopp : stopp;
      h += '<div class="facts" data-live>' +
        fact("Kurs nu", p != null ? fmt(p, 2) + " " + (s.valuta || "") : "–") +
        fact("Över närmaste stöd", z ? pct(z.d) + " · " + fmt(z.ref) : "–") +
        fact("Risk till stopp från nu", p != null && st ? pct((st - p) / p * 100) : "–") +
        fact("Nästa motstånd", z && z.next ? fmt(z.next) + " (" + pct((z.next - p) / p * 100) + ")" : "Inget över, fritt fält") +
        fact("Mini L, stopnivå under", fmt(num(s.knockout_max))) +
        fact("Stöd", lvls(s.stod)) + fact("Motstånd", lvls(s.motstand)) + "</div>";
    }
    h += '<div class="btns">';
    if (!sell) h += '<button class="btn primary wide" type="button" data-a="buy" data-k="' + esc(key) + '">Jag köpte</button>';
    if (s.ticker) h += '<a class="btn" href="' + tvUrl(s.ticker) + '">TradingView ↗</a>';
    if (!sell) h += '<button class="btn" type="button" data-a="copy" data-k="' + esc(key) + '">' + (copied === key ? "Kopierat ✓" : "Kopiera nivåer") + "</button>";
    h += (inline && inline.key === key && inline.kind === "dismiss")
      ? '<button class="btn danger wide" type="button" data-a="dismiss" data-k="' + esc(key) + '">Ja, dölj signalen</button>'
      : '<button class="btn ghost wide" type="button" data-a="askDismiss" data-k="' + esc(key) + '">Dölj signalen</button>';
    h += "</div>";
    if (copied === "fail:" + key) h += '<textarea readonly>' + esc(tvText(s)) + "</textarea>";
    return h + "</div></article>";
  }

  function posCard(t, v) {
    const key = "t:" + t.id, isOpen = openKey === key, p = price(t), kop = num(t.kop), sc = since(t), L = levNow(t), cs = t.instrument !== "Aktie" ? certSince(t) : null, exact = finOf(t) != null;
    const lo = num(t.stopp) != null ? num(t.stopp) : (t.instrument !== "Aktie" ? num(t.knockout) : null), hi = num(t.mal1);
    let h = '<article class="card' + (v.hot ? " hot" : "") + '" data-card="' + esc(key) + '"><button class="sum" type="button" data-a="toggle" data-k="' + esc(key) + '" aria-expanded="' + isOpen + '"><div data-sum style="display:flex;flex-direction:column;gap:12px">' +
      head(t, [t.instrument === "Aktie" ? "Aktie" : (t.instrument || "Mini L") + (L > 1 ? " " + fmt(L, 1) + "x" : ""), "köpt " + fmt(kop), dayCount(t.skapad) != null ? dayCount(t.skapad) + " d" : ""].filter(Boolean).join(" · ")) +
      (cs != null
        ? '<div class="big"><b class="' + tone(cs) + '">' + pct(cs) + "</b><span>certifikatet" + (exact ? "" : " ≈") + " · aktien " + pct(sc) + "</span></div>"
        : '<div class="big"><b class="' + tone(sc) + '">' + pct(sc) + "</b><span>sedan köp</span></div>") +
      '<div class="verdict"><span class="badge ' + v.cls + '">' + v.label + '</span><span class="why-short">' + esc(v.text) + "</span></div>" +
      track(lo, hi, kop, p, "Stopp", "Motstånd") + "</div></button>";
    if (!isOpen) return h + "</article>";

    h += '<div class="detail">';
    if (t.anteckning) h += '<div><p class="why">' + esc(t.anteckning) + "</p></div>";
    if (t.ticker) h += '<div class="chart" data-tv="' + esc(t.ticker) + '"></div>';
    h += '<div class="facts" data-live>' +
      fact("Köpt", fmt(kop) + " · " + date(t.skapad)) +
      fact("Kurs nu", p != null ? fmt(p, 2) + " " + (t.valuta || "") : "–") +
      fact("Sedan köp, aktien", pct(sc)) +
      (cs != null ? fact("Sedan köp, certifikat" + (exact ? "" : " ≈"), pct(cs)) : "") +
      (finOf(t) != null ? fact("Finansieringsnivå · hävstång nu", fmt(finOf(t)) + " · " + fmt(L, 1) + "x") : "") +
      fact("Till motstånd 1", p != null && num(t.mal1) ? pct((num(t.mal1) - p) / p * 100) + " · " + fmt(num(t.mal1)) : "–") +
      (num(t.mal2) ? fact("Till motstånd 2", p != null ? pct((num(t.mal2) - p) / p * 100) + " · " + fmt(num(t.mal2)) : "–") : "") +
      fact("Till stopp", p != null && num(t.stopp) ? pct((num(t.stopp) - p) / p * 100) + " · " + fmt(num(t.stopp)) : "–") +
      (t.instrument !== "Aktie" && num(t.knockout) ? fact("Till knock-out", p != null ? pct((num(t.knockout) - p) / p * 100) + " · " + fmt(num(t.knockout)) : "–") : "") + "</div>";
    if (inline && inline.key === key && inline.kind === "sell") {
      h += '<div class="inline"><label>Säljkurs (aktien)<input id="s-px" inputmode="decimal" value="' + (p != null ? p.toFixed(2) : "") + '"></label>' +
        '<div class="btns"><button class="btn ghost" type="button" data-a="cancel">Avbryt</button><button class="btn primary" type="button" data-a="sell" data-k="' + esc(key) + '">Spara försäljning</button></div></div>';
    } else if (inline && inline.key === key && inline.kind === "del") {
      h += '<div class="btns"><button class="btn ghost" type="button" data-a="cancel">Behåll</button><button class="btn danger" type="button" data-a="del" data-k="' + esc(key) + '">Ja, ta bort</button></div>';
    } else {
      if (t.lots) h += '<div class="lots">' + t.lots.map((l, i) => '<div class="lot"><span>Köp ' + (i + 1) + " · " + date(l.skapad) + (l.cert_namn ? " · " + esc(l.cert_namn) : "") + "</span><b>" + (num(l.antal) ? fmt(num(l.antal)) + " st · " : "") + fmt(num(l.kop)) + "</b></div>").join("") + "</div>";
      h += '<div class="btns"><button class="btn wide" type="button" data-a="refill" data-k="' + esc(key) + '">＋ Fyll på</button><button class="btn primary wide" type="button" data-a="askSell" data-k="' + esc(key) + '">Jag sålde</button>' +
        (t.ticker ? '<a class="btn" href="' + tvUrl(t.ticker) + '">TradingView ↗</a>' : "") +
        '<button class="btn ghost' + (t.ticker ? "" : " wide") + '" type="button" data-a="askDel" data-k="' + esc(key) + '">Ta bort</button></div>';
    }
    return h + "</div></article>";
  }

  function hisCard(t) {
    const key = "t:" + t.id, sc = since(t), L = lev(t);
    return '<article class="card" data-card="' + esc(key) + '"><div class="sum"><div class="row"><div><h2 class="name">' + esc(t.aktie) + '</h2><div class="sub">' +
      esc(fmt(num(t.kop)) + " → " + fmt(num(t.salj_kurs)) + " · " + date(t.skapad) + " – " + date(t.stangd) + (L > 1 ? " · " + fmt(L, 1) + "x" : "")) + '</div></div><div class="px"><b class="' + tone(sc) + '">' + pct(sc != null ? sc * L : null) + "</b>" +
      (L > 1 ? '<small class="muted">aktien ' + pct(sc) + "</small>" : "") + "</div></div></div></article>";
  }
  const fact = (a, b) => '<div class="fact"><span>' + a + "</span><b>" + b + "</b></div>";

  // Öppnar symbolsidan – på mobil tar iOS/Android den till TradingView-appen om den är installerad.
  function tvUrl(t) { return "https://www.tradingview.com/symbols/" + encodeURIComponent(String(t).replace(":", "-")) + "/"; }
  // Nivåerna i formatet som indikatorn "Tradeloggen nivåer" läser: köp;stopp;mål1;mål2;knock-out
  function tvText(s) {
    const z = zone(s, price(s));
    return (z ? [z.ref, z.stopp, z.next, z.next2, s.knockout_max] : [s.kop, s.stopp, s.mal1, s.mal2, s.knockout_max]).map(v => num(v) != null ? String(num(v)) : "").join(";");
  }


  function mountCharts() {
    document.querySelectorAll("[data-tv]").forEach(box => {
      if (box.dataset.m) return; box.dataset.m = "1";
      const w = document.createElement("div"); w.className = "tradingview-widget-container";
      const i = document.createElement("div"); i.className = "tradingview-widget-container__widget"; w.appendChild(i);
      const s = document.createElement("script"); s.async = true;
      s.src = "https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js";
      s.textContent = JSON.stringify({ symbol: box.dataset.tv, width: "100%", height: 220, locale: "sv_SE", dateRange: "3M", colorTheme: "dark", isTransparent: false, autosize: false, largeChartUrl: "", noTimeScale: false, trendLineColor: "rgba(76,141,255,1)", underLineColor: "rgba(76,141,255,0.18)", underLineBottomColor: "rgba(76,141,255,0)" });
      w.appendChild(s); box.appendChild(w);
    });
  }

  // ---------- Händelser ----------
  document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => { view = b.dataset.f; openKey = null; inline = null; render(); window.scrollTo({ top: 0 }); }));

  const find = key => { if (key.startsWith("s:")) return signals.find(s => "s:" + s.id === key); const t = trades.find(t => "t:" + t.id === key); return t && t.status !== "Stängd" ? merge(lotsOf(t)) : t; };
  $("#list").addEventListener("click", async e => {
    const b = e.target.closest("button[data-a]"); if (!b) return;
    const a = b.dataset.a, key = b.dataset.k, x = key ? find(key) : null;
    if (a === "toggle") { openKey = openKey === key ? null : key; inline = null; return render(); }
    if (a === "cancel") { inline = null; return render(); }
    if (a === "askDismiss" || a === "askSell" || a === "askDel") { inline = { key, kind: a === "askDismiss" ? "dismiss" : a === "askSell" ? "sell" : "del" }; render(); const i = $("#s-px"); if (i) i.focus(); return; }
    if (a === "copy" && x) {
      try { navigator.clipboard.writeText(tvText(x)).then(() => { copied = key; render(); setTimeout(() => { copied = null; render(); }, 2000); }, () => { copied = "fail:" + key; render(); }); }
      catch (err) { copied = "fail:" + key; render(); }
      return;
    }
    if (a === "buy" && x) return openBuy(x);
    if (!x) return;
    if (a === "refill") return openBuy(signals.find(sg => sg.id === x.signal_id) || null, x);
    b.disabled = true; let r = { error: null };
    if (a === "dismiss") r = await sb.from("dismissed").insert({ signal_id: x.id });
    if (a === "sell") { const v = num($("#s-px").value); r = await sb.from("trades").update({ status: "Stängd", salj_kurs: v, kurs: v, stangd: new Date().toISOString() }).in("id", (x.lots || [x]).map(l => l.id)); if (!r.error) view = "his"; }
    if (a === "del") r = await sb.from("trades").delete().in("id", (x.lots || [x]).map(l => l.id));
    if (r.error) { b.disabled = false; b.textContent = "Försök igen"; return; }
    inline = null; openKey = null; load();
  });

  // Jag köpte / egen aktie
  const buySheet = $("#buySheet"), buyForm = $("#buyForm");
  let buyPos = null;
  function openBuy(s, pos) {
    buyFor = s; buyPos = pos || null; buyForm.reset(); $("#buyStatus").textContent = ""; $("#impLbl").textContent = "📷 Läs in skärmbild från Avanza";
    const name = s ? s.aktie : pos ? pos.aktie : null;
    $("#manualFields").hidden = !!(s || pos);
    $("#buyTitle").textContent = pos ? "Fyll på " + name : s ? "Jag köpte " + name : "Lägg till köp";
    const src = s || pos, p = src ? price(src) : null;
    $("#b-kop").value = p != null ? p.toFixed(2) : "";
    if (pos && pos.instrument) $("#b-instr").value = pos.instrument;
    syncInstr();
    const kmax = s && s.knockout_max != null ? num(s.knockout_max) : null;
    $("#b-ko").placeholder = kmax != null ? "under " + fmt(kmax) : "från Avanza";
    $("#buyHint").textContent = kmax != null ? "Köper du Mini L: välj ett certifikat med stop loss under " + fmt(kmax) + "." : "";
    buySheet.hidden = false; document.body.classList.add("locked");
  }
  function syncInstr() { const aktie = $("#b-instr").value === "Aktie"; $("#certFields").hidden = aktie; $("#antalAktie").hidden = !aktie; }
  $("#b-instr").addEventListener("change", syncInstr);
  // Har du certifikatets köpkurs och kurs nu räknar vi fram aktiens kurs när du köpte: S0 = F + (S − F) × köp/nu
  function curPrice() { const src = buyFor || buyPos || matchSig($("#b-aktie").value); return src ? price(src) : null; }
  function fillS0(lev) {
    const S = curPrice(), ck = num($("#b-ck").value), cn = num($("#b-cn").value);
    let F = num($("#b-fin").value);
    if (F == null && lev && S != null) F = S - S / lev; // från indikativ hävstång
    if (F != null && ck && cn && S != null && S > F) $("#b-kop").value = (F + (S - F) * ck / cn).toFixed(2);
    return F;
  }
  ["b-fin", "b-ck", "b-cn"].forEach(id => $("#" + id).addEventListener("input", () => fillS0()));
  const norm = x => String(x || "").toLowerCase().replace(/[^a-z0-9åäö]/g, "");
  function matchSig(n) {
    const k = norm(n); if (!k) return null;
    return signals.find(sg => sg.typ !== "SÄLJ" && (norm(sg.aktie) === k || k.includes(norm(sg.aktie)) || norm(sg.aktie).includes(k))) || null;
  }
  // Skärmbild → Claude läser → formuläret fylls i
  async function toJpeg(file) {
    const img = await createImageBitmap(file), sc = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement("canvas"); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85).split(",")[1];
  }
  $("#b-img").addEventListener("change", async e => {
    const files = Array.from(e.target.files || []).slice(0, 3); if (!files.length) return;
    const st = $("#buyStatus"); $("#impLbl").textContent = "Läser bilden…"; st.textContent = "";
    try {
      const images = await Promise.all(files.map(toJpeg));
      const { data: ses } = await sb.auth.getSession();
      const res = await fetch(cfg.supabaseUrl + "/functions/v1/importera", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + (ses.session ? ses.session.access_token : ""), apikey: cfg.supabaseAnonKey }, body: JSON.stringify({ images }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || "Kunde inte läsa bilden.");
      const d = j.data || {};
      // koppla till signal/innehav om det inte redan är valt
      if (!buyFor && !buyPos) {
        const sg = matchSig(d.underliggande), have = open().find(t => norm(t.aktie) === norm(d.underliggande) || (sg && t.signal_id === sg.id));
        if (have) buyPos = merge(lotsOf(have));
        if (sg) buyFor = sg;
        if (buyFor || buyPos) { $("#manualFields").hidden = true; $("#buyTitle").textContent = (buyPos ? "Fyll på " : "Jag köpte ") + (buyFor || buyPos).aktie; }
        else if (d.underliggande) $("#b-aktie").value = d.underliggande;
      }
      const typ = d.typ === "Aktie" ? "Aktie" : d.typ === "Turbo L" ? "Turbo L" : "Mini L";
      $("#b-instr").value = typ; syncInstr();
      const set = (id, v) => { if (v != null && v !== "") $("#" + id).value = v; };
      set("b-fin", d.finansieringsniva); set("b-ko", d.stop_loss); set("b-ck", d.inkopskurs); set("b-cn", d.kurs);
      set("b-antal", d.antal); set("b-antal2", d.antal); set("b-cnamn", d.namn);
      if (typ === "Aktie") { set("b-kop", d.inkopskurs); }
      else {
        const F = fillS0(num(d.havstang));
        if (F != null && num($("#b-fin").value) == null) $("#b-fin").value = F.toFixed(2);
        if (!d.inkopskurs || !d.kurs) st.textContent = "Inköpskurs eller kurs syntes inte – fyll i dem så räknas aktiens kurs ut.";
        else if (num($("#b-fin").value) == null) st.textContent = "Finansieringsnivån syntes inte. Ta en bild på certifikatets sida också, eller fyll i den.";
      }
      $("#impLbl").textContent = "✓ Inläst – kolla och tryck Spara";
    } catch (err) { $("#impLbl").textContent = "📷 Läs in skärmbild från Avanza"; st.textContent = err.message; }
    e.target.value = "";
  });
  const closeBuy = () => { buySheet.hidden = true; document.body.classList.remove("locked"); buyFor = null; buyPos = null; };
  $("#newBtn").addEventListener("click", () => openBuy(null));
  $("#buyCancel").addEventListener("click", closeBuy);
  buySheet.addEventListener("click", e => { if (e.target === buySheet) closeBuy(); });
  buyForm.addEventListener("submit", async e => {
    e.preventDefault();
    const s = buyFor, pos = buyPos, g = id => $("#" + id).value.trim();
    const kop = num(g("b-kop")), instr = g("b-instr"), ko = instr !== "Aktie" ? num(g("b-ko")) : null;
    let row;
    if (pos) row = { signal_id: pos.signal_id || null, aktie: pos.aktie, ticker: pos.ticker, valuta: pos.valuta, stopp: pos.stopp, mal1: pos.mal1, mal2: pos.mal2, anteckning: pos.anteckning };
    else if (s) { const zz = zone(s, price(s) != null ? price(s) : kop), rr = kop != null ? resAbove(s, kop) : [null, null]; row = { signal_id: s.id, aktie: s.aktie, ticker: s.ticker, valuta: s.valuta, stopp: zz ? zz.stopp : s.stopp, mal1: rr[0], mal2: rr[1], anteckning: s.skal }; }
    else row = { aktie: g("b-aktie"), ticker: g("b-ticker").toUpperCase() || null, valuta: /^(OMX|STO)/i.test(g("b-ticker")) || !g("b-ticker").includes(":") ? "SEK" : "USD", stopp: num(g("b-stopp")), mal1: num(g("b-mal1")) };
    if (!row.aktie) { $("#buyStatus").textContent = "Fyll i aktiens namn."; return; }
    if (kop == null) { $("#buyStatus").textContent = "Fyll i aktiens kurs när du köpte."; return; }
    if (instr !== "Aktie" && ko != null && num(row.stopp) != null && ko >= num(row.stopp)) { $("#buyStatus").textContent = "Certifikatets stop loss bör ligga under stoppet " + fmt(num(row.stopp)) + ", annars slås du ut innan du hinner sälja."; return; }
    const F = instr !== "Aktie" ? num(g("b-fin")) : null;
    if (F != null && kop <= F) { $("#buyStatus").textContent = "Finansieringsnivån måste ligga under aktiens kurs."; return; }
    Object.assign(row, { status: "Öppen", instrument: instr, hav: F != null ? +(kop / (kop - F)).toFixed(2) : null, fin_niva: F, knockout: ko, kop, kurs: kop,
      antal: num(instr === "Aktie" ? g("b-antal2") : g("b-antal")), cert_kop: instr !== "Aktie" ? num(g("b-ck")) : null, cert_namn: instr !== "Aktie" ? (g("b-cnamn") || null) : null });
    $("#buySave").disabled = true; $("#buyStatus").textContent = "Sparar…";
    const { error } = await sb.from("trades").insert(row);
    $("#buySave").disabled = false;
    if (error) { $("#buyStatus").textContent = "Kunde inte spara. Försök igen."; return; }
    closeBuy(); view = "pos"; openKey = null; load();
  });

  // ---------- Notiser ----------
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  const b64 = s => { const r = atob((s + "=".repeat((4 - s.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(r, c => c.charCodeAt(0)); };
  async function pushState() {
    if (isIOS && !standalone()) return "install";
    if (!pushSupported()) return "unsupported";
    if (Notification.permission === "denied") return "denied";
    try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); return sub && Notification.permission === "granted" ? "on" : "off"; }
    catch (e) { return "off"; }
  }
  async function refreshPushTip() {
    const st = await pushState(), tip = $("#pushTip");
    tip.hidden = !(st === "off" || st === "install");
    tip.innerHTML = st === "install"
      ? "📲 Lägg till appen på hemskärmen för att få notiser: tryck på <b>Dela</b> och sedan <b>Lägg till på hemskärmen</b>."
      : '🔔 <button class="linkbtn" type="button" id="tipOn" style="color:inherit;text-decoration:underline">Slå på notiser</button> så säger appen till när det är dags att köpa eller sälja.';
    const b = $("#tipOn"); if (b) b.addEventListener("click", openPush);
    $("#bellBtn").style.color = st === "on" ? "var(--blue)" : "";
  }
  const pushSheet = $("#pushSheet");
  async function openPush() {
    const st = await pushState();
    const txt = {
      install: "På iPhone fungerar notiser bara när appen ligger på hemskärmen. Öppna sidan i Safari, tryck på Dela och välj Lägg till på hemskärmen. Öppna sedan appen därifrån och tryck på klockan igen.",
      unsupported: "Den här webbläsaren stödjer inte notiser. Prova Chrome på Android eller Safari på iPhone (med appen på hemskärmen).",
      denied: "Notiser är blockerade för appen. Tillåt dem i telefonens inställningar för webbläsaren eller appen, och försök igen.",
      off: "Du får en notis när Stockrobber går ut med ett köp eller sälj, när en signal hamnar i bra köpläge och när en av dina aktier når motstånd, stopp eller närmar sig knock-out.",
      on: "Notiser är påslagna på den här enheten. Du får besked om nya signaler, köplägen och när dina aktier når mål eller stopp."
    }[st];
    $("#pushText").textContent = txt; $("#pushStatus").textContent = "";
    $("#pushOn").hidden = st !== "off"; $("#pushTest").hidden = st !== "on";
    pushSheet.hidden = false; document.body.classList.add("locked");
  }
  const closePush = () => { pushSheet.hidden = true; document.body.classList.remove("locked"); refreshPushTip(); };
  $("#bellBtn").addEventListener("click", openPush);
  $("#pushClose").addEventListener("click", closePush);
  pushSheet.addEventListener("click", e => { if (e.target === pushSheet) closePush(); });
  $("#pushForm").addEventListener("submit", async e => {
    e.preventDefault();
    $("#pushOn").disabled = true; $("#pushStatus").textContent = "Slår på…";
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { $("#pushStatus").textContent = "Du tackade nej till notiser. Tillåt dem i inställningarna och försök igen."; $("#pushOn").disabled = false; return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(cfg.vapidPublicKey) });
      const j = sub.toJSON();
      const { error } = await sb.from("push_subscriptions").upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: "endpoint" });
      if (error) throw error;
      await sb.rpc("request_test_push");
      $("#pushStatus").className = "status ok"; $("#pushStatus").textContent = "Klart! En testnotis är på väg.";
      $("#pushOn").hidden = true; $("#pushTest").hidden = false;
    } catch (err) { $("#pushStatus").textContent = "Kunde inte slå på notiser. Försök igen."; }
    $("#pushOn").disabled = false; refreshPushTip();
  });
  $("#pushTest").addEventListener("click", async () => {
    $("#pushStatus").className = "status"; $("#pushStatus").textContent = "Skickar…";
    const { error } = await sb.rpc("request_test_push");
    $("#pushStatus").className = error ? "status" : "status ok"; $("#pushStatus").textContent = error ? "Kunde inte skicka. Försök igen." : "Testnotis skickad.";
  });

  // Byt lösenord
  const pwSheet = $("#pwSheet"), pwForm = $("#pwForm");
  const closePw = () => { pwSheet.hidden = true; document.body.classList.remove("locked"); pwForm.reset(); $("#pwStatus").textContent = ""; $("#pwStatus").className = "status"; };
  $("#pwBtn").addEventListener("click", () => { pwSheet.hidden = false; document.body.classList.add("locked"); setTimeout(() => $("#pwNew").focus(), 50); });
  $("#pwCancel").addEventListener("click", closePw);
  pwSheet.addEventListener("click", e => { if (e.target === pwSheet) closePw(); });
  pwForm.addEventListener("submit", async e => {
    e.preventDefault();
    if ($("#pwNew").value !== $("#pwNew2").value) { $("#pwStatus").textContent = "Lösenorden är inte lika."; return; }
    $("#pwSave").disabled = true; $("#pwStatus").textContent = "Sparar…";
    const { error } = await sb.auth.updateUser({ password: $("#pwNew").value });
    $("#pwSave").disabled = false;
    if (error) { $("#pwStatus").textContent = "Kunde inte byta lösenord. Välj minst 8 tecken."; return; }
    $("#pwStatus").className = "status ok"; $("#pwStatus").textContent = "Lösenordet är bytt."; setTimeout(closePw, 1200);
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") { if (!buySheet.hidden) closeBuy(); if (!pwSheet.hidden) closePw(); if (!pushSheet.hidden) closePush(); } });
  setInterval(() => { if (user) render(true); }, 60000);
})();
