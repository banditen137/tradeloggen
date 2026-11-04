(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const num = v => { if (v === undefined || v === null || v === "") return null; const n = parseFloat(String(v).replace(/\s/g, "").replace(",", ".")); return isFinite(n) ? n : null; };
  const fmt = (n, d) => n == null ? "–" : Number(n).toLocaleString("sv-SE", {maximumFractionDigits: d == null ? 2 : d});
  const kr = n => (n == null ? "0" : Math.round(n).toLocaleString("sv-SE")) + " kr";
  const pct = n => n == null ? "–" : (n > 0 ? "+" : "") + n.toFixed(1).replace(".", ",") + " %";
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
  const lvls = a => Array.isArray(a) && a.length ? a.map(v => fmt(num(v))).join(" / ") : "–";
  const ts = v => v ? new Date(v).getTime() : 0;

  const cfg = window.TRADELOGGEN_CONFIG || {};
  if (!window.supabase || !cfg.supabaseUrl || cfg.supabaseUrl.includes("DITT-PROJEKT")) {
    document.body.innerHTML = '<div class="login"><h1>Tradeloggen</h1><p class="status">Appen är inte konfigurerad än. Fyll i Supabase-uppgifterna i config.js.</p></div>';
    return;
  }
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true}});

  let user = null, items = [], filter = "Signal", openAction = null, confirmDel = null, copied = null, channel = null;
  const toggled = new Set();
  const isOpen = t => t.status === "Signal" ? !toggled.has(t.key) : toggled.has(t.key);

  // ---------- Inloggning ----------
  function showLogin() {
    $("#appView").hidden = true; $("#loginView").hidden = false; document.body.classList.add("auth");
  }
  function showApp() {
    $("#loginView").hidden = true; $("#appView").hidden = false; document.body.classList.remove("auth");
    $("#whoEmail").textContent = userName(user.email);
  }
  // Användarnamnet "edwin" blir kontot edwin@tradeloggen.app i Supabase. Inga mejl skickas dit.
  const DOMAIN = "@tradeloggen.app";
  const toEmail = u => { u = u.trim().toLowerCase(); return u.includes("@") ? u : u + DOMAIN; };
  const userName = e => (e || "").endsWith(DOMAIN) ? e.slice(0, -DOMAIN.length) : (e || "");

  $("#loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    const u = $("#loginUser").value, p = $("#loginPass").value;
    $("#loginBtn").disabled = true; $("#loginStatus").className = "status"; $("#loginStatus").textContent = "Loggar in…";
    const { error } = await sb.auth.signInWithPassword({ email: toEmail(u), password: p });
    $("#loginBtn").disabled = false;
    if (error) {
      $("#loginStatus").textContent = /invalid/i.test(error.message)
        ? "Fel användarnamn eller lösenord."
        : "Kunde inte logga in just nu. Försök igen om en stund.";
    } else {
      $("#loginStatus").textContent = ""; $("#loginPass").value = "";
    }
  });
  $("#logoutBtn").addEventListener("click", async () => { await sb.auth.signOut(); });

  const pwSheet = $("#pwSheet"), pwForm = $("#pwForm");
  const closePw = () => { pwSheet.hidden = true; document.body.classList.remove("locked"); pwForm.reset(); $("#pwStatus").textContent = ""; };
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
    if (next && (!user || user.id !== next.id)) { user = next; showApp(); load(); subscribe(); }
    if (!next) { user = null; items = []; if (channel) { sb.removeChannel(channel); channel = null; } showLogin(); }
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
    if (s.error || t.error || d.error) { $("#loadStatus").textContent = "Kunde inte hämta data just nu. Dra ner för att ladda om."; return; }
    const gone = new Set(d.data.map(r => r.signal_id));
    t.data.forEach(r => { if (r.signal_id) gone.add(r.signal_id); });
    const sigs = s.data.filter(r => !gone.has(r.id)).map(r => Object.assign({}, r, { key: "s:" + r.id, kind: "signal", status: "Signal", knockoutMax: r.knockout_max }));
    const trs = t.data.map(r => Object.assign({}, r, { key: "t:" + r.id, kind: "trade" }));
    items = sigs.concat(trs).sort((a, b) => ts(b.skapad) - ts(a.skapad));
    $("#loadStatus").hidden = true;
    render();
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
  document.addEventListener("visibilitychange", () => { if (!document.hidden && user) load(); });

  // ---------- Vy ----------
  function koInfo(t) {
    if (t.instrument === "Aktie") return null;
    const kurs = num(t.kurs) || num(t.kop), ko = num(t.knockout);
    if (!kurs || ko == null) return null;
    const d = (kurs - ko) / kurs * 100;
    return { d, cls: d >= 15 ? "r-good" : d >= 7 ? "r-warn" : "r-bad", txt: d >= 15 ? "Gott om marginal" : d >= 7 ? "Bevaka" : "Nära knock-out" };
  }

  function render() {
    const by = s => items.filter(t => t.status === s);
    ["Signal", "Öppen", "Planerad", "Stängd"].forEach(s => { $("#c" + s).textContent = by(s).length; });
    $("#sSig").textContent = by("Signal").length;
    $("#sCap").textContent = kr(by("Öppen").reduce((a, t) => a + (num(t.insats) || 0), 0));
    const res = by("Stängd").reduce((a, t) => a + (num(t.resultat) || 0), 0);
    const sRes = $("#sRes"); sRes.textContent = (res > 0 ? "+" : "") + kr(res); sRes.className = res > 0 ? "pos" : res < 0 ? "neg" : "";
    document.querySelectorAll(".tab").forEach(x => x.setAttribute("aria-pressed", x.dataset.f === filter ? "true" : "false"));
    const shown = by(filter);
    if (!shown.length) {
      const m = {
        Signal: ["Inga nya signaler", "När Stockrobber går ut med ett köp dyker det upp här, med köp, stopp och mål."],
        Öppen: ["Inga aktiva trades", "Här hamnar trades du faktiskt är i. Ta en signal eller tryck på + för att lägga in en egen."],
        Planerad: ["Inga planerade trades", "Planerade är köp du lagt som limitorder men som inte gått igenom än."],
        Stängd: ["Inga stängda trades", "När du stänger en trade hamnar resultatet här."]
      }[filter];
      $("#list").innerHTML = '<div class="empty"><h2>' + m[0] + "</h2><p>" + m[1] + "</p></div>";
      return;
    }
    $("#list").innerHTML = shown.map(card).join("");
  }

  function ladder(t) {
    let pts = [["ko", "KO", num(t.knockout)], ["stop", "STOPP", num(t.stopp)], ["buy", "KÖP", num(t.kop)], ["tgt", "MÅL 1", num(t.mal1)], ["tgt", "MÅL 2", num(t.mal2)]].filter(p => p[2] != null);
    const kurs = t.status === "Öppen" || t.status === "Planerad" ? num(t.kurs) : null;
    const vals = pts.map(p => p[2]).concat(kurs != null ? [kurs] : []);
    if (vals.length < 2) return "";
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi === lo) return "";
    const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
    const xp = v => (v - lo) / (hi - lo) * 100;
    pts.sort((a, b) => a[2] - b[2]);
    let lastTop = -100, h = '<div class="ladder" aria-hidden="true"><div class="track"></div>';
    pts.forEach(p => {
      const x = xp(p[2]); let low = false;
      if (x - lastTop < 14) low = true; else lastTop = x;
      h += '<div class="mk ' + p[0] + (low ? " low" : "") + '" style="left:' + x.toFixed(2) + '%">' + p[1] + "<i></i></div>";
    });
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

  function quick(t) {
    const kop = num(t.kop), m1 = num(t.mal1), kurs = num(t.kurs), q = [];
    if (t.status === "Signal") {
      q.push("Köp <b>" + fmt(kop) + "</b>");
      if (m1 && kop) q.push("Mål <b>" + pct((m1 - kop) / kop * 100) + "</b>");
      if (t.rapport) q.push('<span class="pill r-warn">⚠️ Obs</span>');
      return q.join("");
    }
    if (t.status === "Stängd") {
      const r = num(t.resultat);
      return '<span class="pill ' + (r >= 0 ? "r-good" : "r-bad") + '">' + (r > 0 ? "+" : "") + kr(r) + "</span>";
    }
    if (kurs != null && kop && t.status === "Öppen") q.push("Aktien <b>" + pct((kurs - kop) / kop * 100) + "</b>");
    else q.push("Köp <b>" + fmt(kop) + "</b>");
    if (kurs != null && m1) q.push("Till mål <b>" + pct((m1 - kurs) / kurs * 100) + "</b>");
    const k = koInfo(t);
    if (k) q.push('<span class="pill ' + k.cls + '">KO ' + k.d.toFixed(0) + " %</span>");
    return q.join("");
  }

  function card(t) {
    const open = isOpen(t), sig = t.status === "Signal", cur = t.valuta || "SEK";
    const kop = num(t.kop), stopp = num(t.stopp), m1 = num(t.mal1), m2 = num(t.mal2);
    const label = sig ? "Ny signal" : (t.status === "Öppen" ? "Aktiv" : t.status);
    const meta = sig ? [t.datum, cur].filter(Boolean).join(" · ") :
      [t.instrument === "Aktie" ? "Aktie" : (t.instrument || "Mini L") + (num(t.hav) ? " " + fmt(num(t.hav), 1) + "x" : ""), num(t.insats) ? kr(num(t.insats)) : "", cur].filter(Boolean).join(" · ");
    let h = '<article class="card' + (sig ? " sig" : "") + (open ? " open" : "") + '">' +
      '<button class="sum" type="button" data-a="toggle" data-k="' + esc(t.key) + '" aria-expanded="' + open + '">' +
        '<span class="sum-top"><span><span class="name">' + esc(t.aktie) + '</span><br><span class="status">' + esc(meta) + "</span></span>" +
        '<span class="pill st-' + esc(t.status) + '">' + label + ' <span class="chev">▾</span></span></span>' +
        '<span class="quick">' + quick(t) + "</span></button>";
    if (!open) return h + "</article>";

    h += '<div class="detail">';
    const why = sig ? t.skal : t.anteckning;
    if (why) h += '<p class="' + (sig ? "why" : "note") + '">' + esc(why) + "</p>";
    const koVal = sig ? "under " + fmt(num(t.knockoutMax)) : (t.instrument === "Aktie" ? "–" : fmt(num(t.knockout)));
    h += '<div class="levels">' +
      '<div class="buy"><span>Köp</span><b>' + fmt(kop) + "</b></div>" +
      "<div><span>Stopp</span><b>" + fmt(stopp) + "</b></div>" +
      "<div><span>Mål</span><b>" + fmt(m1) + (m2 ? " → " + fmt(m2) : "") + "</b></div>" +
      "<div><span>" + (sig ? "Mini L stopnivå" : "Knock-out") + "</span><b>" + koVal + "</b></div></div>";
    h += ladder(t);
    if (sig) h += '<p class="sr">Stöd <b>' + lvls(t.stod) + "</b> · Motstånd <b>" + lvls(t.motstand) + "</b></p>";
    const facts = [];
    if (kop && stopp && m1 && kop > stopp) facts.push('<span class="pill r-neutral">Risk/belöning 1 : ' + ((m1 - kop) / (kop - stopp)).toFixed(1).replace(".", ",") + "</span>");
    if (t.rapport) facts.push('<span class="pill r-warn">⚠️ ' + esc(t.rapport) + "</span>");
    const k = !sig && t.status !== "Stängd" ? koInfo(t) : null;
    if (k) facts.push('<span class="pill ' + k.cls + '">' + k.txt + " · " + k.d.toFixed(1).replace(".", ",") + " % till KO</span>");
    const kurs = num(t.kurs);
    if (t.status === "Öppen" && kurs != null && kop && num(t.insats)) {
      const est = num(t.insats) * (num(t.hav) || 1) * (kurs - kop) / kop;
      facts.push('<span class="pill ' + (est >= 0 ? "r-good" : "r-bad") + '">≈ ' + (est > 0 ? "+" : "") + kr(est) + "</span>");
    }
    if (facts.length) h += '<div class="facts">' + facts.join("") + "</div>";
    if (copied === "fail:" + t.key) h += '<pre class="tv">' + esc(tvText(t)) + "</pre>";
    if (t.ticker && t.status !== "Stängd") h += '<a class="btn tvlink" href="https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(t.ticker) + '" target="_blank" rel="noopener">Öppna grafen i TradingView ↗</a>';
    h += actions(t);
    return h + "</div></article>";
  }

  function actions(t) {
    const k = esc(t.key), cur = t.valuta || "SEK";
    if (confirmDel === t.key) return '<div class="btns"><button class="btn quiet" type="button" data-a="cancel">Behåll</button><button class="btn danger" type="button" data-a="del" data-k="' + k + '">' + (t.status === "Signal" ? "Avfärda" : "Ta bort") + "</button></div>";
    if (openAction && openAction.key === t.key) {
      if (openAction.kind === "ta") return '<div class="inline"><div class="grid">' +
        '<label>Instrument<select id="t-instr"><option>Mini L</option><option>Aktie</option><option>Turbo L</option></select></label>' +
        '<label>Status<select id="t-status"><option>Planerad</option><option value="Öppen">Aktiv (köpt)</option></select></label>' +
        '<label>Hävstång (x)<input id="t-lev" inputmode="decimal" placeholder="3"></label>' +
        '<label>Cert. stopnivå<input id="t-ko" inputmode="decimal" placeholder="' + (num(t.knockoutMax) != null ? "under " + fmt(num(t.knockoutMax)) : "") + '"></label>' +
        '<label class="full">Insats (kr)<input id="t-insats" inputmode="decimal" placeholder="6500"></label></div>' +
        '<p class="status" id="takeStatus" role="status"></p>' +
        '<div class="btns"><button class="btn quiet" type="button" data-a="cancel">Avbryt</button><button class="btn primary" type="button" data-a="saveTake" data-k="' + k + '">Lägg till</button></div></div>';
      if (openAction.kind === "kurs") return '<div class="inline"><label>Senaste kurs (' + esc(cur) + ')<input id="a-kurs" inputmode="decimal" value="' + esc(t.kurs == null ? "" : t.kurs) + '"></label>' +
        '<div class="btns"><button class="btn quiet" type="button" data-a="cancel">Avbryt</button><button class="btn primary" type="button" data-a="saveKurs" data-k="' + k + '">Spara</button></div></div>';
      if (openAction.kind === "stang") return '<div class="inline"><label>Resultat i kr (minus för förlust)<input id="a-res" inputmode="decimal" placeholder="1200 eller -800"></label>' +
        '<div class="btns"><button class="btn quiet" type="button" data-a="cancel">Avbryt</button><button class="btn primary" type="button" data-a="saveClose" data-k="' + k + '">Stäng trade</button></div></div>';
    }
    const b = [];
    if (t.status === "Signal") {
      b.push('<button class="btn primary wide" type="button" data-a="ta" data-k="' + k + '">Ta traden</button>');
      b.push('<button class="btn" type="button" data-a="copy" data-k="' + k + '">' + (copied === t.key ? "Kopierat ✓" : "Kopiera nivåer") + "</button>");
      b.push('<button class="btn quiet" type="button" data-a="askDel" data-k="' + k + '">Avfärda</button>');
    } else {
      if (t.status === "Planerad") b.push('<button class="btn primary wide" type="button" data-a="open" data-k="' + k + '">Markera köpt</button>');
      if (t.status === "Öppen") b.push('<button class="btn primary" type="button" data-a="kurs" data-k="' + k + '">Uppdatera kurs</button><button class="btn" type="button" data-a="stang" data-k="' + k + '">Stäng</button>');
      if (t.status === "Planerad") b.push('<button class="btn" type="button" data-a="kurs" data-k="' + k + '">Uppdatera kurs</button>');
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
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !sheet.hidden) closeSheet(); });
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
      const instr = $("#t-instr").value, ko = num($("#t-ko").value), stopp = num(t.stopp);
      if (instr !== "Aktie" && ko != null && stopp != null && ko >= stopp) { $("#takeStatus").textContent = "Certifikatets stopnivå bör ligga under stoppet " + fmt(stopp) + "."; b.disabled = false; return; }
      const st = $("#t-status").value;
      res = await sb.from("trades").insert({ signal_id: t.id, aktie: t.aktie, ticker: t.ticker, valuta: t.valuta, status: st, instrument: instr,
        hav: num($("#t-lev").value), kop: t.kop, stopp: t.stopp, mal1: t.mal1, mal2: t.mal2, knockout: ko, insats: num($("#t-insats").value), kurs: t.kop, anteckning: t.skal });
      if (!res.error) filter = st;
    }
    if (a === "saveKurs") { const v = num($("#a-kurs").value); if (v != null) res = await sb.from("trades").update({ kurs: v, kurs_datum: new Date().toISOString() }).eq("id", t.id); }
    if (a === "saveClose") { const v = num($("#a-res").value); res = await sb.from("trades").update({ status: "Stängd", resultat: v == null ? 0 : v, stangd: new Date().toISOString() }).eq("id", t.id); }
    if (a === "open") res = await sb.from("trades").update({ status: "Öppen" }).eq("id", t.id);
    if (a === "del") res = t.kind === "signal" ? await sb.from("dismissed").insert({ signal_id: t.id }) : await sb.from("trades").delete().eq("id", t.id);
    if (res.error) { $("#loadStatus").hidden = false; $("#loadStatus").textContent = "Ändringen sparades inte. Försök igen."; b.disabled = false; return; }
    openAction = null; confirmDel = null;
    load();
  });
})();
