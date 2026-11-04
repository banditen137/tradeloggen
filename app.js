(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const num = v => { if (v === undefined || v === null || v === "") return null; const n = parseFloat(String(v).replace(/\s/g, "").replace(",", ".")); return isFinite(n) ? n : null; };
  const fmt = (n, d) => n == null ? "–" : Number(n).toLocaleString("sv-SE", {maximumFractionDigits: d == null ? 2 : d, minimumFractionDigits: d === 2 ? 2 : 0});
  const kr = n => (n == null ? "0" : Math.round(n).toLocaleString("sv-SE")) + " kr";
  const skr = n => (n > 0 ? "+" : "") + kr(n);
  const pct = n => n == null || !isFinite(n) ? "–" : (n > 0 ? "+" : "") + n.toFixed(1).replace(".", ",") + " %";
  const pct2 = n => n == null || !isFinite(n) ? "–" : (n > 0 ? "+" : "") + n.toFixed(2).replace(".", ",") + " %";
  const cls = n => n > 0 ? "pos" : n < 0 ? "neg" : "";
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
  const lvls = a => Array.isArray(a) && a.length ? a.map(v => fmt(num(v))).join(" / ") : "–";
  const ts = v => v ? new Date(v).getTime() : 0;
  const days = v => v ? Math.max(0, Math.floor((Date.now() - ts(v)) / 86400000)) : null;

  const cfg = window.TRADELOGGEN_CONFIG || {};
  if (!window.supabase || !cfg.supabaseUrl || cfg.supabaseUrl.includes("DITT-PROJEKT")) {
    document.body.innerHTML = '<div class="login"><h1>Tradeloggen</h1><p class="status">Appen är inte konfigurerad än. Fyll i Supabase-uppgifterna i config.js.</p></div>';
    return;
  }
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true}});

  let user = null, items = [], filter = "Signal", openAction = null, confirmDel = null, copied = null, channel = null;
  let quotes = {}, quotesAt = null, quoteTimer = null;
  const toggled = new Set();
  const isOpen = t => t.status === "Signal" ? !toggled.has(t.key) : toggled.has(t.key);

  // ---------- Inloggning ----------
  const DOMAIN = "@tradeloggen.app";
  const toEmail = u => { u = u.trim().toLowerCase(); return u.includes("@") ? u : u + DOMAIN; };
  const userName = e => (e || "").endsWith(DOMAIN) ? e.slice(0, -DOMAIN.length) : (e || "");
  function showLogin() { $("#appView").hidden = true; $("#loginView").hidden = false; document.body.classList.add("auth"); }
  function showApp() { $("#loginView").hidden = true; $("#appView").hidden = false; document.body.classList.remove("auth"); $("#whoEmail").textContent = userName(user.email); }

  $("#loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    $("#loginBtn").disabled = true; $("#loginStatus").className = "status"; $("#loginStatus").textContent = "Loggar in…";
    const { error } = await sb.auth.signInWithPassword({ email: toEmail($("#loginUser").value), password: $("#loginPass").value });
    $("#loginBtn").disabled = false;
    if (error) $("#loginStatus").textContent = /invalid/i.test(error.message) ? "Fel användarnamn eller lösenord." : "Kunde inte logga in just nu. Försök igen om en stund.";
    else { $("#loginStatus").textContent = ""; $("#loginPass").value = ""; }
  });
  $("#logoutBtn").addEventListener("click", async () => { await sb.auth.signOut(); });

  const pwSheet = $("#pwSheet"), pwForm = $("#pwForm");
  const closePw = () => { pwSheet.hidden = true; document.body.classList.remove("locked"); pwForm.reset(); $("#pwStatus").textContent = ""; $("#pwStatus").className = "status"; };
  $("#pwBtn").addEventListener("click", () => { pwSheet.hidden = false; document.body.classList.add("locked"); setTimeout(() => $("#pwNew").focus(), 50); });
  $("#pwCancel").addEventListener("click", closePw);
  pwSheet.addEventListener("click", e => { if (e.target === pwSheet) closePw(); });
  pwForm.addEventListener("submit", async e => {
    e.preventDefault();
    const a = $("#pwNew").value, b = $("#pwNew2").value;
    if (a !== b) { $("#pwStatus").textContent = "Lösenorden är inte lika."; return; }
    $("#pwSave").disabled = true; $("#pwStatus").textContent = "Sparar…";
    const { error } = await sb.auth.updateUser({ password: a });
    $("#pwSave").disabled = false;
    if (error) { $("#pwStatus").textContent = /weak|short|length/i.test(error.message) ? "Lösenordet är för svagt. Välj minst 8 tecken." : "Kunde inte byta lösenord. Försök igen."; return; }
    $("#pwStatus").className = "status ok"; $("#pwStatus").textContent = "Lösenordet är bytt.";
    setTimeout(closePw, 1200);
  });

  sb.auth.onAuthStateChange((_evt, session) => {
    const next = session ? session.user : null;
    if (next && (!user || user.id !== next.id)) { user = next; showApp(); load(); subscribe(); startQuotes(); }
    if (!next) { user = null; items = []; if (channel) { sb.removeChannel(channel); channel = null; } clearInterval(quoteTimer); showLogin(); }
  });
  sb.auth.getSession().then(({ data }) => { if (!data.session) showLogin(); });

  // ---------- Data ----------
  async function load() {
    $("#loadStatus").hidden = false; $("#loadStatus").textContent = "Hämtar…";
    const [s, t, d] = await Promise.all([
      sb.from("signals").select("*").order("skapad", { ascending: false }),
      sb.from("trades").select("*").order("skapad", { ascending: false }),
      sb.from("dismissed").select("signal_id")
    ]);
    if (s.error || t.error || d.error) { $("#loadStatus").textContent = "Kunde inte hämta data just nu. Ladda om sidan."; return; }
    const gone = new Set(d.data.map(r => r.signal_id));
    t.data.forEach(r => { if (r.signal_id) gone.add(r.signal_id); });
    const sigs = s.data.filter(r => !gone.has(r.id)).map(r => Object.assign({}, r, { key: "s:" + r.id, kind: "signal", status: "Signal", knockoutMax: r.knockout_max }));
    const trs = t.data.map(r => Object.assign({}, r, { key: "t:" + r.id, kind: "trade" }));
    items = sigs.concat(trs).sort((a, b) => ts(b.skapad) - ts(a.skapad));
    $("#loadStatus").hidden = true;
    render();
    fetchQuotes();
  }
  function subscribe() {
    if (channel) sb.removeChannel(channel);
    let timer = null;
    const again = () => { clearTimeout(timer); timer = setTimeout(load, 300); };
    channel = sb.channel("tradeloggen")
      .on("postgres_changes", { event: "*", schema: "public", table: "signals" }, again)
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, again)
      .subscribe();
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && user) { load(); } });

  // ---------- Kurser ----------
  // TradingView-symbol -> Yahoo-symbol: OMXSTO:VOLV_B -> VOLV-B.ST, NASDAQ:GOOGL -> GOOGL
  function ySym(tv) {
    if (!tv) return null;
    const parts = String(tv).toUpperCase().split(":"), ex = parts.length > 1 ? parts[0] : "", s = parts.length > 1 ? parts[1] : parts[0];
    if (/HEX|HEL/.test(ex)) return s.replace(/_/g, "-") + ".HE";
    if (/OMXCOP|CSE/.test(ex)) return s.replace(/_/g, "-") + ".CO";
    if (/OSL|OSE/.test(ex)) return s.replace(/_/g, "-") + ".OL";
    if (/OMX|STO|NGM|FN/.test(ex)) return s.replace(/_/g, "-") + ".ST";
    if (/XETR|FWB/.test(ex)) return s + ".DE";
    if (/EURONEXT|EPA/.test(ex)) return s + ".PA";
    return s.replace(/\./g, "-");
  }
  const quoteOf = t => { const y = ySym(t.ticker); return y ? quotes[y] : null; };
  const priceOf = t => { const q = quoteOf(t); return q && typeof q.price === "number" ? q.price : num(t.kurs); };
  const dayOf = t => { const q = quoteOf(t); return q && q.prev ? (q.price - q.prev) / q.prev * 100 : null; };

  async function fetchQuotes() {
    const syms = Array.from(new Set(items.filter(t => t.status !== "Stängd").map(t => ySym(t.ticker)).filter(Boolean)));
    if (!syms.length) return;
    try {
      const r = await fetch("/api/quote?symbols=" + encodeURIComponent(syms.join(",")));
      if (!r.ok) return;
      const data = await r.json();
      Object.keys(data).forEach(k => { if (data[k]) quotes[k] = data[k]; });
      quotesAt = new Date();
      render(true);
    } catch (e) { /* behåll senaste kurser */ }
  }
  function startQuotes() { clearInterval(quoteTimer); quoteTimer = setInterval(() => { if (!document.hidden) fetchQuotes(); }, 60000); }

  // ---------- Marknader ----------
  function marketState() {
    const now = new Date(), f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
    const p = Object.fromEntries(f.formatToParts(now).map(x => [x.type, x.value]));
    const wk = !/lör|sön/i.test(p.weekday), m = parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
    return { se: wk && m >= 540 && m < 1050, us: wk && m >= 930 && m < 1320 };
  }
  function paintMarkets() {
    const s = marketState();
    $("#markets").innerHTML =
      '<span class="mkt"><i class="dot' + (s.se ? " on" : "") + '"></i>Stockholm ' + (s.se ? "öppen" : "stängd") + "</span>" +
      '<span class="mkt"><i class="dot' + (s.us ? " on" : "") + '"></i>USA ' + (s.us ? "öppen" : "stängd") + "</span>";
  }

  // ---------- Beräkningar ----------
  function perf(t) {
    const p = priceOf(t), kop = num(t.kop), lev = t.instrument === "Aktie" ? 1 : (num(t.hav) || 1), ins = num(t.insats);
    if (p == null || !kop) return null;
    const move = (p - kop) / kop * 100, cert = move * lev;
    return { p, move, cert, kr: ins ? ins * cert / 100 : null, lev };
  }
  function koInfo(t) {
    if (t.instrument === "Aktie") return null;
    const p = priceOf(t) || num(t.kop), ko = num(t.knockout);
    if (!p || ko == null) return null;
    const d = (p - ko) / p * 100;
    return { d, cls: d >= 15 ? "r-good" : d >= 7 ? "r-warn" : "r-bad", txt: d >= 15 ? "Gott om marginal" : d >= 7 ? "Bevaka" : "Nära knock-out" };
  }

  // ---------- Vy ----------
  function render(quiet) {
    paintMarkets();
    const by = s => items.filter(t => t.status === s);
    ["Signal", "Öppen", "Planerad", "Stängd"].forEach(s => { $("#c" + s).textContent = by(s).length; });

    const act = by("Öppen"), cap = act.reduce((a, t) => a + (num(t.insats) || 0), 0);
    let pl = 0, dayKr = 0, dayBase = 0, hasPl = false;
    act.forEach(t => {
      const x = perf(t); if (x && x.kr != null) { pl += x.kr; hasPl = true; }
      const d = dayOf(t), ins = num(t.insats);
      if (d != null && ins) { dayKr += ins * d * (t.instrument === "Aktie" ? 1 : (num(t.hav) || 1)) / 100; dayBase += ins; }
    });
    $("#hPl").textContent = act.length ? (hasPl ? skr(pl) : "–") : "0 kr";
    $("#hPlPct").textContent = act.length ? (cap && hasPl ? pct(pl / cap * 100) + " på " + kr(cap) + " · " + act.length + " aktiva" : act.length + " aktiva · lägg in insats för att se resultat") : "Inga aktiva trades än";
    $("#hCap").textContent = kr(cap);
    $("#hDay").textContent = dayBase ? skr(dayKr) : "–";
    const closed = by("Stängd"), res = closed.reduce((a, t) => a + (num(t.resultat) || 0), 0);
    $("#hRes").textContent = closed.length ? skr(res) : "0 kr";
    $("#hHit").textContent = closed.length ? Math.round(closed.filter(t => num(t.resultat) > 0).length / closed.length * 100) + " %" : "–";
    $("#updated").textContent = quotesAt ? "Kurser uppdaterade " + quotesAt.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" }) + " · uppdateras varje minut" : "";

    document.querySelectorAll(".tab").forEach(x => x.setAttribute("aria-pressed", x.dataset.f === filter ? "true" : "false"));
    const shown = by(filter);
    if (!shown.length) {
      const m = {
        Signal: ["Inga nya signaler", "När Stockrobber går ut med ett köp dyker det upp här, med köp, stopp och mål."],
        Öppen: ["Inga aktiva trades", "Här hamnar trades du faktiskt är i. Ta en signal eller tryck på + för att lägga in en egen."],
        Planerad: ["Inga planerade trades", "Planerade är köp du lagt som limitorder men som inte gått igenom än."],
        Stängd: ["Inga stängda trades", "När du stänger en trade hamnar resultatet och träffsäkerheten här."]
      }[filter];
      $("#list").innerHTML = '<div class="empty"><h2>' + m[0] + "</h2><p>" + m[1] + "</p></div>";
      return;
    }
    // Vid tysta kursuppdateringar ritas bara kortens siffror om, så att graferna inte laddas om.
    if (quiet) {
      shown.forEach(t => {
        const el = document.querySelector('[data-card="' + CSS.escape(t.key) + '"]');
        if (!el) return;
        const fresh = document.createElement("div"); fresh.innerHTML = card(t, true);
        const nSum = fresh.querySelector(".sum"), oSum = el.querySelector(".sum");
        if (nSum && oSum) oSum.replaceWith(nSum);
        const nLive = fresh.querySelector("[data-livebox]"), oLive = el.querySelector("[data-livebox]");
        if (nLive && oLive) oLive.replaceWith(nLive);
        el.className = fresh.firstElementChild.className;
      });
      return;
    }
    $("#list").innerHTML = shown.map(t => card(t)).join("");
    mountCharts();
  }

  function rangeBar(t) {
    const lo = num(t.status === "Signal" ? t.stopp : (num(t.knockout) != null && t.instrument !== "Aktie" ? t.knockout : t.stopp)), hi = num(t.mal1), p = priceOf(t);
    if (lo == null || hi == null || p == null || hi <= lo) return "";
    const x = Math.max(0, Math.min(100, (p - lo) / (hi - lo) * 100));
    return '<div class="bar"><em style="width:' + x.toFixed(1) + '%"></em><i style="left:' + x.toFixed(1) + '%"></i></div>' +
      '<div class="barlbl"><span>' + (lo === num(t.knockout) ? "KO " : "Stopp ") + fmt(lo) + "</span><span>Mål " + fmt(hi) + "</span></div>";
  }

  function ladder(t) {
    let pts = [["ko", "KO", num(t.knockout)], ["stop", "STOPP", num(t.stopp)], ["buy", "KÖP", num(t.kop)], ["tgt", "MÅL 1", num(t.mal1)], ["tgt", "MÅL 2", num(t.mal2)]].filter(p => p[2] != null);
    const kurs = t.status !== "Stängd" ? priceOf(t) : null;
    const vals = pts.map(p => p[2]).concat(kurs != null ? [kurs] : []);
    if (vals.length < 2) return "";
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi === lo) return "";
    const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
    const xp = v => (v - lo) / (hi - lo) * 100;
    pts.sort((a, b) => a[2] - b[2]);
    let lastTop = -100, h = '<div class="ladder" aria-hidden="true"><div class="track"></div>';
    pts.forEach(p => { const x = xp(p[2]); let low = false; if (x - lastTop < 14) low = true; else lastTop = x; h += '<div class="mk ' + p[0] + (low ? " low" : "") + '" style="left:' + x.toFixed(2) + '%">' + p[1] + "<i></i></div>"; });
    if (kurs != null) h += '<div class="now" style="left:' + xp(kurs).toFixed(2) + '%" title="Senaste kurs"></div>';
    return h + "</div>";
  }

  function tvText(t) {
    const c = " " + (t.valuta || "");
    const rows = [t.aktie + (t.ticker ? " (" + t.ticker + ")" : "") + " – Stockrobber" + (t.datum ? " " + t.datum : "")];
    [["Köp", t.kop], ["Stopp", t.stopp], ["Mål 1", t.mal1], ["Mål 2", t.mal2]].forEach(r => { if (num(r[1]) != null) rows.push(r[0] + ": " + fmt(num(r[1])) + c); });
    if (Array.isArray(t.stod) && t.stod.length) rows.push("Stöd: " + lvls(t.stod) + c);
    if (Array.isArray(t.motstand) && t.motstand.length) rows.push("Motstånd: " + lvls(t.motstand) + c);
    if (num(t.knockoutMax) != null) rows.push("Mini L: stopnivå under " + fmt(num(t.knockoutMax)) + c);
    return rows.join("\n");
  }

  function summary(t) {
    const sig = t.status === "Signal", cur = t.valuta || "SEK", p = priceOf(t), d = dayOf(t), live = !!quoteOf(t);
    const label = sig ? "Ny signal" : (t.status === "Öppen" ? "Aktiv" : t.status);
    const meta = sig ? [t.ticker, t.datum].filter(Boolean).join(" · ") :
      [t.instrument === "Aktie" ? "Aktie" : (t.instrument || "Mini L") + (num(t.hav) ? " " + fmt(num(t.hav), 1) + "x" : ""), t.status === "Öppen" && days(t.skapad) != null ? days(t.skapad) + " dagar" : "", t.ticker].filter(Boolean).join(" · ");
    let right = '<span class="pill st-' + esc(t.status) + '">' + label + ' <span class="chev">▾</span></span>';
    if (p != null && t.status !== "Stängd") right += '<span class="live">' + fmt(p, 2) + ' <small class="status">' + esc(cur) + "</small></span>" + (d != null ? '<span class="chg ' + cls(d) + '">' + pct2(d) + " idag</span>" : (live ? "" : '<span class="chg">manuell kurs</span>'));
    let h = '<span class="sum-top"><span><span class="name">' + esc(t.aktie) + '</span><br><span class="status">' + esc(meta) + '</span></span><span class="right">' + right + "</span></span>";

    if (t.status === "Öppen") {
      const x = perf(t);
      if (x) h += '<span class="since"><b class="' + cls(x.cert) + '">' + pct(x.cert) + "</b><span>sedan köp" + (x.lev > 1 ? " (aktien " + pct(x.move) + ")" : "") + (x.kr != null ? " · " + skr(x.kr) : "") + "</span></span>";
      h += rangeBar(t);
      const k = koInfo(t); if (k && k.d < 15) h += '<span class="quick"><span class="pill ' + k.cls + '">' + k.txt + " · " + k.d.toFixed(1).replace(".", ",") + " % till KO</span></span>";
    } else if (t.status === "Signal" || t.status === "Planerad") {
      const kop = num(t.kop), q = [];
      if (p != null && kop) {
        const gap = (p - kop) / kop * 100;
        q.push(gap <= 1 ? '<span class="pill zone">✓ I köpläge</span>' : '<span>Köp <b>' + fmt(kop) + "</b> · <b>" + pct(gap).replace("+", "") + "</b> ovanför</span>");
      } else q.push("<span>Köp <b>" + fmt(kop) + "</b></span>");
      if (num(t.mal1) && kop) q.push("<span>Mål <b>" + pct((num(t.mal1) - kop) / kop * 100) + "</b></span>");
      if (t.rapport) q.push('<span class="pill r-warn">⚠️ Obs</span>');
      h += '<span class="quick">' + q.join("") + "</span>";
    } else if (t.status === "Stängd") {
      const r = num(t.resultat), ins = num(t.insats);
      h += '<span class="since"><b class="' + cls(r) + '">' + skr(r || 0) + "</b><span>" + (ins ? pct((r || 0) / ins * 100) + " · " : "") + (t.stangd ? new Date(t.stangd).toLocaleDateString("sv-SE", { day: "numeric", month: "short" }) : "") + "</span></span>";
    }
    return h;
  }

  function card(t, quiet) {
    const open = isOpen(t), sig = t.status === "Signal", x = t.status === "Öppen" ? perf(t) : null;
    const tone = x ? (x.cert > 0 ? " up" : x.cert < 0 ? " down" : "") : (t.status === "Stängd" ? (num(t.resultat) > 0 ? " up" : num(t.resultat) < 0 ? " down" : "") : "");
    let h = '<article class="card' + (sig ? " sig" : "") + tone + (open ? " open" : "") + '" data-card="' + esc(t.key) + '">' +
      '<button class="sum" type="button" data-a="toggle" data-k="' + esc(t.key) + '" aria-expanded="' + open + '">' + summary(t) + "</button>";
    if (!open) return h + "</article>";

    h += '<div class="detail">';
    const why = sig ? t.skal : t.anteckning;
    if (why) h += '<p class="' + (sig ? "why" : "note") + '">' + esc(why) + "</p>";
    if (t.ticker && t.status !== "Stängd") h += '<div class="tvbox" data-tv="' + esc(t.ticker) + '"></div>';

    h += '<div data-livebox>' + liveBox(t) + "</div>";
    h += ladder(t);
    if (sig) h += '<p class="sr">Stöd <b>' + lvls(t.stod) + "</b> · Motstånd <b>" + lvls(t.motstand) + "</b></p>";
    const facts = [], kop = num(t.kop), stopp = num(t.stopp), m1 = num(t.mal1);
    if (kop && stopp && m1 && kop > stopp) facts.push('<span class="pill r-neutral">Risk/belöning 1 : ' + ((m1 - kop) / (kop - stopp)).toFixed(1).replace(".", ",") + "</span>");
    if (t.rapport) facts.push('<span class="pill r-warn">⚠️ ' + esc(t.rapport) + "</span>");
    const k = !sig && t.status !== "Stängd" ? koInfo(t) : null;
    if (k) facts.push('<span class="pill ' + k.cls + '">' + k.txt + " · " + k.d.toFixed(1).replace(".", ",") + " % till KO</span>");
    if (facts.length) h += '<div class="facts">' + facts.join("") + "</div>";
    if (copied === "fail:" + t.key) h += '<pre class="tv">' + esc(tvText(t)) + "</pre>";
    if (t.ticker && t.status !== "Stängd") h += '<a class="btn tvlink" href="https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(t.ticker) + '" target="_blank" rel="noopener">Öppna i TradingView ↗</a>';
    h += actions(t);
    return h + "</div></article>";
  }

  function liveBox(t) {
    const sig = t.status === "Signal", p = priceOf(t), kop = num(t.kop), stopp = num(t.stopp), m1 = num(t.mal1), m2 = num(t.mal2);
    const dist = (a) => p != null && a != null ? pct((a - p) / p * 100) : "–";
    let h = '<div class="levels">' +
      '<div class="buy"><span>Köp</span><b>' + fmt(kop) + "</b></div>" +
      "<div><span>Stopp</span><b>" + fmt(stopp) + "</b></div>" +
      "<div><span>Mål</span><b>" + fmt(m1) + (m2 ? " → " + fmt(m2) : "") + "</b></div>" +
      "<div><span>" + (sig ? "Mini L stopnivå" : "Knock-out") + "</span><b>" + (sig ? "under " + fmt(num(t.knockoutMax)) : (t.instrument === "Aktie" ? "–" : fmt(num(t.knockout)))) + "</b></div></div>";
    if (p != null && t.status !== "Stängd") {
      h += '<div class="grid3" style="margin-top:8px">' +
        "<div><span>Till stopp</span><b class=\"neg\">" + dist(stopp) + "</b></div>" +
        "<div><span>Till mål 1</span><b class=\"pos\">" + dist(m1) + "</b></div>" +
        "<div><span>" + (sig || t.status === "Planerad" ? "Till köp" : "Till mål 2") + "</span><b>" + (sig || t.status === "Planerad" ? dist(kop) : dist(m2)) + "</b></div></div>";
    }
    if (t.status === "Öppen") {
      const x = perf(t);
      if (x) h += '<div class="grid3" style="margin-top:8px">' +
        "<div><span>Köpt</span><b>" + fmt(kop) + "</b></div>" +
        "<div><span>Aktien</span><b class=\"" + cls(x.move) + "\">" + pct(x.move) + "</b></div>" +
        "<div><span>" + (x.lev > 1 ? "Cert. ≈ " + fmt(x.lev, 1) + "x" : "Resultat") + "</span><b class=\"" + cls(x.cert) + "\">" + (x.kr != null ? skr(x.kr) : pct(x.cert)) + "</b></div></div>";
    }
    return h;
  }

  // TradingView-minigraf i kortet
  function mountCharts() {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light";
    document.querySelectorAll("[data-tv]").forEach(box => {
      if (box.dataset.mounted) return;
      box.dataset.mounted = "1";
      const wrap = document.createElement("div"); wrap.className = "tradingview-widget-container";
      const inner = document.createElement("div"); inner.className = "tradingview-widget-container__widget"; wrap.appendChild(inner);
      const s = document.createElement("script");
      s.src = "https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js"; s.async = true;
      s.textContent = JSON.stringify({ symbol: box.dataset.tv, width: "100%", height: 220, locale: "sv_SE", dateRange: "3M", colorTheme: dark ? "dark" : "light", isTransparent: true, autosize: false, largeChartUrl: "", chartOnly: false, noTimeScale: false, trendLineColor: "rgba(91,154,230,1)", underLineColor: "rgba(91,154,230,0.25)" });
      wrap.appendChild(s); box.appendChild(wrap);
    });
  }

  function actions(t) {
    const k = esc(t.key), cur = t.valuta || "SEK";
    if (confirmDel === t.key) return '<div class="btns"><button class="btn quiet" type="button" data-a="cancel">Behåll</button><button class="btn danger" type="button" data-a="del" data-k="' + k + '">' + (t.status === "Signal" ? "Avfärda" : "Ta bort") + "</button></div>";
    if (openAction && openAction.key === t.key) {
      if (openAction.kind === "ta") return '<div class="inline"><div class="grid">' +
        '<label>Instrument<select id="t-instr"><option>Mini L</option><option>Aktie</option><option>Turbo L</option></select></label>' +
        '<label>Status<select id="t-status"><option>Planerad</option><option value="Öppen">Aktiv (köpt)</option></select></label>' +
        '<label>Köpkurs (aktien)<input id="t-kop" inputmode="decimal" value="' + esc(priceOf(t) != null ? priceOf(t).toFixed(2) : t.kop) + '"></label>' +
        '<label>Hävstång (x)<input id="t-lev" inputmode="decimal" placeholder="3"></label>' +
        '<label>Cert. stopnivå<input id="t-ko" inputmode="decimal" placeholder="' + (num(t.knockoutMax) != null ? "under " + fmt(num(t.knockoutMax)) : "") + '"></label>' +
        '<label>Insats (kr)<input id="t-insats" inputmode="decimal" placeholder="6500"></label></div>' +
        '<p class="status" id="takeStatus" role="status"></p>' +
        '<div class="btns"><button class="btn quiet" type="button" data-a="cancel">Avbryt</button><button class="btn primary" type="button" data-a="saveTake" data-k="' + k + '">Lägg till</button></div></div>';
      if (openAction.kind === "kurs") return '<div class="inline"><label>Senaste kurs (' + esc(cur) + ')<input id="a-kurs" inputmode="decimal" value="' + esc(t.kurs == null ? "" : t.kurs) + '"></label>' +
        '<p class="hint">Behövs bara om kursen inte hämtas automatiskt.</p>' +
        '<div class="btns"><button class="btn quiet" type="button" data-a="cancel">Avbryt</button><button class="btn primary" type="button" data-a="saveKurs" data-k="' + k + '">Spara</button></div></div>';
      if (openAction.kind === "stang") {
        const x = perf(t);
        return '<div class="inline"><label>Resultat i kr (minus för förlust)<input id="a-res" inputmode="decimal" value="' + (x && x.kr != null ? Math.round(x.kr) : "") + '" placeholder="1200 eller -800"></label>' +
          '<p class="hint">Förifyllt med beräknat resultat. Justera till det du faktiskt fick på Avanza.</p>' +
          '<div class="btns"><button class="btn quiet" type="button" data-a="cancel">Avbryt</button><button class="btn primary" type="button" data-a="saveClose" data-k="' + k + '">Stäng trade</button></div></div>';
      }
    }
    const b = [];
    if (t.status === "Signal") {
      b.push('<button class="btn primary wide" type="button" data-a="ta" data-k="' + k + '">Ta traden</button>');
      b.push('<button class="btn" type="button" data-a="copy" data-k="' + k + '">' + (copied === t.key ? "Kopierat ✓" : "Kopiera nivåer") + "</button>");
      b.push('<button class="btn quiet" type="button" data-a="askDel" data-k="' + k + '">Avfärda</button>');
    } else {
      if (t.status === "Planerad") b.push('<button class="btn primary wide" type="button" data-a="open" data-k="' + k + '">Markera köpt</button>');
      if (t.status === "Öppen") b.push('<button class="btn primary" type="button" data-a="stang" data-k="' + k + '">Stäng trade</button><button class="btn" type="button" data-a="kurs" data-k="' + k + '">Ange kurs</button>');
      if (t.status === "Planerad") b.push('<button class="btn" type="button" data-a="kurs" data-k="' + k + '">Ange kurs</button>');
      b.push('<button class="btn quiet' + (t.status === "Planerad" ? "" : " wide") + '" type="button" data-a="askDel" data-k="' + k + '">Ta bort</button>');
    }
    return '<div class="btns">' + b.join("") + "</div>";
  }

  // ---------- Händelser ----------
  document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => { filter = b.dataset.f; openAction = null; confirmDel = null; render(); window.scrollTo({ top: 0 }); }));

  const sheet = $("#sheet"), form = $("#form");
  const closeSheet = () => { sheet.hidden = true; document.body.classList.remove("locked"); form.reset(); $("#formStatus").textContent = ""; };
  $("#newBtn").addEventListener("click", () => { sheet.hidden = false; document.body.classList.add("locked"); setTimeout(() => $("#f-aktie").focus(), 50); });
  $("#cancelBtn").addEventListener("click", closeSheet);
  sheet.addEventListener("click", e => { if (e.target === sheet) closeSheet(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") { if (!sheet.hidden) closeSheet(); if (!pwSheet.hidden) closePw(); } });
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const g = id => $("#" + id).value.trim();
    const kop = num(g("f-kop")), stopp = num(g("f-stopp")), ko = num(g("f-ko"));
    if (kop == null) { $("#formStatus").textContent = "Fyll i en köpnivå."; return; }
    if (stopp != null && stopp >= kop) { $("#formStatus").textContent = "Stoppet måste ligga under köpnivån."; return; }
    if (ko != null && stopp != null && ko >= stopp && g("f-instr") !== "Aktie") { $("#formStatus").textContent = "Certifikatets stopnivå bör ligga under ditt stopp, annars slås du ut innan du hinner sälja."; return; }
    const row = { aktie: g("f-aktie"), ticker: g("f-ticker").toUpperCase() || null, valuta: g("f-valuta"), status: g("f-status"), instrument: g("f-instr"),
      hav: num(g("f-lev")), kop, stopp, mal1: num(g("f-mal1")), mal2: num(g("f-mal2")), knockout: ko, insats: num(g("f-insats")), anteckning: g("f-note") || null, kurs: kop };
    $("#saveBtn").disabled = true; $("#formStatus").textContent = "Sparar…";
    const { error } = await sb.from("trades").insert(row);
    $("#saveBtn").disabled = false;
    if (error) { $("#formStatus").textContent = "Kunde inte spara. Försök igen."; return; }
    filter = row.status; closeSheet(); load();
  });

  $("#list").addEventListener("click", async e => {
    const b = e.target.closest("button[data-a]"); if (!b) return;
    const a = b.dataset.a, key = b.dataset.k, t = items.find(x => x.key === key);
    if (a === "toggle") { toggled.has(key) ? toggled.delete(key) : toggled.add(key); if (openAction && openAction.key === key) openAction = null; return render(); }
    if (a === "cancel") { openAction = null; confirmDel = null; return render(); }
    if (a === "copy" && t) {
      try { navigator.clipboard.writeText(tvText(t)).then(() => { copied = key; render(); setTimeout(() => { if (copied === key) { copied = null; render(); } }, 2500); }, () => { copied = "fail:" + key; render(); }); }
      catch (err) { copied = "fail:" + key; render(); }
      return;
    }
    if (a === "ta" || a === "kurs" || a === "stang") { openAction = { key, kind: a }; confirmDel = null; render(); const i = $("#t-lev") || $("#a-kurs") || $("#a-res"); if (i) i.focus(); return; }
    if (a === "askDel") { confirmDel = key; openAction = null; return render(); }
    if (!t) return;
    b.disabled = true;
    let res = { error: null };
    if (a === "saveTake") {
      const instr = $("#t-instr").value, ko = num($("#t-ko").value), stopp = num(t.stopp), kop = num($("#t-kop").value) || num(t.kop);
      if (instr !== "Aktie" && ko != null && stopp != null && ko >= stopp) { $("#takeStatus").textContent = "Certifikatets stopnivå bör ligga under stoppet " + fmt(stopp) + "."; b.disabled = false; return; }
      const st = $("#t-status").value;
      res = await sb.from("trades").insert({ signal_id: t.id, aktie: t.aktie, ticker: t.ticker, valuta: t.valuta, status: st, instrument: instr,
        hav: num($("#t-lev").value), kop, stopp: t.stopp, mal1: t.mal1, mal2: t.mal2, knockout: ko, insats: num($("#t-insats").value), kurs: kop, anteckning: t.skal });
      if (!res.error) filter = st;
    }
    if (a === "saveKurs") { const v = num($("#a-kurs").value); if (v != null) res = await sb.from("trades").update({ kurs: v, kurs_datum: new Date().toISOString() }).eq("id", t.id); }
    if (a === "saveClose") { const v = num($("#a-res").value); res = await sb.from("trades").update({ status: "Stängd", resultat: v == null ? 0 : v, kurs: priceOf(t), stangd: new Date().toISOString() }).eq("id", t.id); }
    if (a === "open") res = await sb.from("trades").update({ status: "Öppen", skapad: new Date().toISOString() }).eq("id", t.id);
    if (a === "del") res = t.kind === "signal" ? await sb.from("dismissed").insert({ signal_id: t.id }) : await sb.from("trades").delete().eq("id", t.id);
    if (res.error) { $("#loadStatus").hidden = false; $("#loadStatus").textContent = "Ändringen sparades inte. Försök igen."; b.disabled = false; return; }
    openAction = null; confirmDel = null;
    load();
  });

  setInterval(paintMarkets, 60000);
})();
