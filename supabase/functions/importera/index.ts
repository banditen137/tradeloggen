// Läser skärmbilder från Avanza (innehav och/eller certifikatsidan) med Claude och returnerar fälten som JSON.
// Kräver hemligheten ANTHROPIC_API_KEY (Supabase → Edge Functions → Secrets). Bara inloggade användare.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const PROMPT = `Du läser skärmbilder från Avanza (svensk nätmäklare). De visar ett köpt certifikat (t.ex. "MINI L ABB AVA 16") eller en aktie, antingen i innehavslistan eller på instrumentets egen sida.
Svara ENBART med ett JSON-objekt, inga andra tecken:
{"namn": instrumentets namn som det står, "underliggande": den underliggande aktiens namn (t.ex. "ABB", "AMD", "AstraZeneca") eller null, "typ": "Mini L" | "Turbo L" | "Bull" | "Aktie" | "Annat", "antal": tal eller null, "inkopskurs": instrumentets inköpskurs/GAV i kr eller null, "kurs": instrumentets senaste kurs i kr eller null, "finansieringsniva": tal eller null, "stop_loss": tal eller null, "havstang": indikativ hävstång som tal eller null, "valuta": valutan för finansieringsnivå/stop loss ("SEK", "USD", "EUR") eller null}
Svenska tal: "1 313,92" = 1313.92. Hitta aldrig på värden: syns de inte, sätt null. Om flera bilder visar samma instrument, slå ihop uppgifterna.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data: u } = await sb.auth.getUser(token);
  if (!u?.user) return json({ error: "Inte inloggad" }, 401);

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "Bildläsning är inte aktiverad än (API-nyckel saknas)." }, 503);

  const body = await req.json().catch(() => ({}));
  const imgs: string[] = Array.isArray(body.images) ? body.images.slice(0, 3) : [];
  if (!imgs.length) return json({ error: "Ingen bild" }, 400);
  if (imgs.some((b) => typeof b !== "string" || b.length > 4_000_000)) return json({ error: "Bilden är för stor" }, 413);

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-5-5",
      max_tokens: 500,
      messages: [{ role: "user", content: [
        ...imgs.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })),
        { type: "text", text: PROMPT },
      ] }],
    }),
  });
  if (!r.ok) return json({ error: "Kunde inte läsa bilden just nu (" + r.status + ")." }, 502);
  const j = await r.json();
  const text = (j.content || []).map((c: { text?: string }) => c.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return json({ error: "Hittade inga uppgifter i bilden." }, 422);
  try { return json({ ok: true, data: JSON.parse(m[0]) }); }
  catch { return json({ error: "Hittade inga uppgifter i bilden." }, 422); }
});
