// Hämtar senaste kurs för en eller flera Yahoo-symboler, t.ex. /api/quote?symbols=ABB.ST,GOOGL
// Körs på Vercel som serverfunktion, så webbläsaren slipper CORS-problem.
const SYMBOL = /^[A-Z0-9.\-^=]{1,20}$/i;

module.exports = async (req, res) => {
  const list = String((req.query && req.query.symbols) || "")
    .split(",").map(s => s.trim()).filter(s => SYMBOL.test(s)).slice(0, 40);
  const out = {};
  await Promise.all(list.map(async s => {
    try {
      const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(s) + "?range=6mo&interval=1d", {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Tradeloggen/1.0)", "Accept": "application/json" }
      });
      if (!r.ok) { out[s] = null; return; }
      const j = await r.json();
      const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
      if (!m || typeof m.regularMarketPrice !== "number") { out[s] = null; return; }
      const closes = (j.chart.result[0].indicators.quote[0].close || []).filter(v => typeof v === "number");
      const prev = closes.length >= 2 ? closes[closes.length - 2] : (m.chartPreviousClose || m.previousClose || null);
      const last50 = closes.slice(-50);
      const sma50 = last50.length >= 40 ? last50.reduce((a, b) => a + b, 0) / last50.length : null;
      out[s] = { price: m.regularMarketPrice, prev, sma50, currency: m.currency || null, time: m.regularMarketTime || null };
    } catch (e) { out[s] = null; }
  }));
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
  res.status(200).json(out);
};
