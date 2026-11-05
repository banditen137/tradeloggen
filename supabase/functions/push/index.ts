// Skickar push-notiser:
//  type "signal": ny signal från Stockrobber -> alla prenumeranter
//  type "check":  kurskoll -> köpläge för signaler, stopp/mål/knock-out för egna aktier
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const APP = "https://tradeloggen.vercel.app/";
const fmt = (n: number | null | undefined) => n == null ? "–" : Number(n).toLocaleString("sv-SE", { maximumFractionDigits: 2 });

async function secrets() {
  const { data } = await sb.from("app_secrets").select("key,value");
  const m = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  webpush.setVapidDetails(APP, m.vapid_public, m.vapid_private);
  return m;
}

async function send(userIds: string[] | null, payload: Record<string, unknown>) {
  let q = sb.from("push_subscriptions").select("endpoint,user_id,p256dh,auth");
  if (userIds) q = q.in("user_id", userIds);
  const { data } = await q;
  await Promise.all((data || []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600 });
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
    }
  }));
}

function ySym(tv?: string | null) {
  if (!tv) return null;
  const p = tv.toUpperCase().split(":"), ex = p.length > 1 ? p[0] : "", s = p.length > 1 ? p[1] : p[0];
  if (/HEX|HEL/.test(ex)) return s.replace(/_/g, "-") + ".HE";
  if (/OMXCOP|CSE/.test(ex)) return s.replace(/_/g, "-") + ".CO";
  if (/OSL|OSE/.test(ex)) return s.replace(/_/g, "-") + ".OL";
  if (/OMX|STO|NGM|FN/.test(ex)) return s.replace(/_/g, "-") + ".ST";
  if (/XETR|FWB/.test(ex)) return s + ".DE";
  return s.replace(/\./g, "-");
}
type Q = { price: number; sma50: number | null };
async function quote(sym: string): Promise<Q | null> {
  try {
    const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym) + "?range=6mo&interval=1d", { headers: { "User-Agent": "Mozilla/5.0 (compatible; Tradeloggen/1.0)" } });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j?.chart?.result?.[0], p = res?.meta?.regularMarketPrice;
    if (typeof p !== "number") return null;
    const c = ((res.indicators?.quote?.[0]?.close || []) as unknown[]).filter((v): v is number => typeof v === "number").slice(-50);
    return { price: p, sma50: c.length >= 40 ? c.reduce((a, b) => a + b, 0) / c.length : null };
  } catch { return null; }
}

// Skicka bara en gång per användare och händelse
async function once(userId: string, key: string) {
  const { error } = await sb.from("alerts_sent").insert({ user_id: userId, key });
  return !error;
}

async function onSignal(id: string) {
  const { data: s } = await sb.from("signals").select("*").eq("id", id).single();
  if (!s) return;
  const sell = s.typ === "SÄLJ";
  await send(null, {
    title: (sell ? "🔴 SÄLJ – " : "🟢 KÖP – ") + s.aktie,
    body: sell ? (s.skal || "Stockrobber säljer. Öppna appen.") : "Köpzon runt " + fmt(s.kop) + " · Stopp " + fmt(s.stopp) + " · Motstånd " + fmt(s.mal1) + (s.skal ? "\n" + s.skal : ""),
    tag: "sig-" + s.id, url: APP,
  });
}

// Samma logik som appen (app.js zone)
function zone(s: any, p: number) {
  const list = (a: any[]) => (a || []).map((v) => v == null ? null : Number(v)).filter((v) => v != null && !isNaN(v)) as number[];
  const sup = list([s.kop, ...(s.stod || [])]), res = list([s.mal1, s.mal2, ...(s.motstand || [])]);
  const lv = Array.from(new Set([...sup, ...res])).sort((a, b) => a - b);
  if (!lv.length) return null;
  let i = -1; lv.forEach((v, k) => { if (v <= p) i = k; });
  const ref = i < 0 ? lv[0] : lv[i];
  const broken = res.includes(ref) && !sup.includes(ref);
  let stopp = s.stopp;
  if (s.kop != null && ref > s.kop && i > 0) stopp = Math.max(s.stopp || 0, +(lv[i - 1] * 0.985).toFixed(2));
  const next = lv.filter((v) => v > p)[0] ?? null;
  return { ref, broken, stopp, next, d: (p - ref) / ref * 100 };
}

async function check() {
  const [{ data: sigs }, { data: trades }, { data: subs }, { data: dism }] = await Promise.all([
    sb.from("signals").select("*").eq("aktiv", true).eq("typ", "KÖP"),
    sb.from("trades").select("*").neq("status", "Stängd"),
    sb.from("push_subscriptions").select("user_id"),
    sb.from("dismissed").select("user_id,signal_id"),
  ]);
  const users = Array.from(new Set((subs || []).map((s) => s.user_id)));
  if (!users.length) return;
  const syms = Array.from(new Set([...[...(sigs || []), ...(trades || [])].map((t) => ySym(t.ticker)).filter(Boolean)])) as string[];
  const px: Record<string, Q | null> = {};
  await Promise.all(syms.map(async (s) => { px[s] = await quote(s); }));
  const qOf = (t: { ticker?: string | null }) => { const y = ySym(t.ticker); return y ? px[y] ?? null : null; };
  const priceOf = (t: { ticker?: string | null }) => qOf(t)?.price ?? null;

  // Signaler i bra köpläge (samma regler som appen)
  for (const s of sigs || []) {
    const qq = qOf(s), p = qq?.price ?? null;
    if (p == null || s.kop == null) continue;
    if (s.stopp != null && p < s.stopp) continue;
    const z = zone(s, p);
    if (!z || z.d > 3) continue;
    if (s.rapport_datum) { const rd = (new Date(s.rapport_datum + "T12:00:00Z").getTime() - Date.now()) / 864e5; if (rd >= -1 && rd <= 3) continue; }
    for (const u of users) {
      if ((dism || []).some((d) => d.user_id === u && d.signal_id === s.id)) continue;
      if ((trades || []).some((t) => t.user_id === u && t.signal_id === s.id)) continue;
      if (await once(u, "kop:" + s.id + ":" + z.ref)) await send([u], { title: "🟢 Bra köpläge – " + s.aktie, body: "Kurs " + fmt(p) + (z.broken ? ", över utbrottet " : ", i köpzonen vid ") + fmt(z.ref) + ". Stopp " + fmt(z.stopp) + (z.next ? " · Nästa motstånd " + fmt(z.next) : ""), tag: "kop-" + s.id, url: APP });
    }
  }
  // Egna aktier: stopp, mål, knock-out
  for (const t of trades || []) {
    const p = priceOf(t);
    if (p == null) continue;
    let key = "", title = "", body = "";
    if (t.stopp != null && p <= t.stopp) { key = "stopp"; title = "🔴 Sälj – " + t.aktie; body = "Stoppet " + fmt(t.stopp) + " är nått. Kurs " + fmt(p) + "."; }
    else if (t.knockout != null && t.instrument !== "Aktie" && p <= t.knockout * 1.03) { key = "ko"; title = "⚠️ Nära knock-out – " + t.aktie; body = "Kursen " + fmt(p) + " är nära certifikatets stopnivå " + fmt(t.knockout) + "."; }
    else if (t.mal2 != null && p >= t.mal2) { key = "mal2"; title = "🟢 Ta hem vinst – " + t.aktie; body = "Sista motståndet " + fmt(t.mal2) + " är nått. Överväg att sälja en del."; }
    else if (t.mal1 != null && p >= t.mal1) { key = "mal1"; title = "🔵 Flytta stopp – " + t.aktie; body = "Över motståndet " + fmt(t.mal1) + ". Flytta upp stoppet till ca " + fmt(t.mal1 * 0.985) + "."; }
    if (key && await once(t.user_id, key + ":" + t.id)) await send([t.user_id], { title, body, tag: key + "-" + t.id, url: APP });
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const m = await secrets();
  if (req.headers.get("x-hook-secret") !== m.hook) return new Response("forbidden", { status: 403 });
  const body = await req.json().catch(() => ({}));
  if (body.type === "signal" && body.id) await onSignal(String(body.id));
  if (body.type === "check") await check();
  if (body.type === "test" && body.user_id) await send([String(body.user_id)], { title: "✅ Notiser fungerar", body: "Du får nu besked från Tradeloggen här.", tag: "test", url: APP });
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
});
