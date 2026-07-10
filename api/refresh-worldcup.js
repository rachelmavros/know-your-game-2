// api/refresh-worldcup.js — daily Vercel Cron. Asks Claude for the upcoming
// World Cup slate and caches it in Supabase (app_cache key='worldcup'), since
// the live FIFA feed is paywalled. The app reads it via /api/worldcup.

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!apiKey || !supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  const fmt = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const today = fmt(new Date());
  const end = fmt(new Date(Date.now() + 8 * 86400000));

  const prompt = `You maintain a 2026 FIFA World Cup schedule for a casual-fan sports app. The 2026 World Cup (hosted by USA/Canada/Mexico, June 11 – July 19, 2026) is in progress. Today is ${today} (US Central Time).

Output ONLY a JSON array (no prose, no markdown fences) of the World Cup matches scheduled from ${today} through ${end}. Each object must have exactly these fields:
- "date": "YYYY-MM-DD" (in US Central Time)
- "away": away team/country name
- "home": home team/country name
- "time": kickoff in US Central Time, formatted like "2:00 PM CT"
- "verdict": integer 2–5 (5 = marquee/knockout/host-nation must-watch, 2 = minor)
- "channel": US broadcaster, e.g. "Fox", "FS1", or "Telemundo"
- "note": one friendly plain-English sentence for a casual fan

Use your best knowledge of the actual tournament stage and fixtures for these dates. Return [] if there are no matches in this window.`;

  let arr;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 3000,
        system: 'You output only raw JSON. Never include prose, explanations, apologies, or markdown code fences.',
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: '[' }, // prefill forces a JSON array, no hedging
        ],
      }),
    });
    const data = await r.json();
    const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    // We prefilled "[", so prepend it and parse up to the last closing bracket.
    const text = '[' + raw;
    const last = text.lastIndexOf(']');
    if (last === -1) throw new Error('No JSON array — API said: ' + JSON.stringify(data).slice(0, 300));
    arr = JSON.parse(text.slice(0, last + 1));
    if (!Array.isArray(arr)) throw new Error('Parsed value is not an array');
    // Keep only well-formed rows, tag league + source.
    arr = arr
      .filter(g => g && g.date && g.home && g.away)
      .map(g => ({ league: 'WC', date: g.date, away: String(g.away), home: String(g.home), time: g.time || '', verdict: Number(g.verdict) || 3, channel: g.channel || 'Fox', note: g.note || '' }));
  } catch (err) {
    // Don't overwrite a good cache with garbage — just report.
    return res.status(200).json({ ok: false, error: String(err) });
  }

  const up = await fetch(`${supabaseUrl}/rest/v1/app_cache?on_conflict=key`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ key: 'worldcup', value: arr, updated_at: new Date().toISOString() }),
  });
  if (!up.ok) return res.status(500).json({ ok: false, error: await up.text() });

  return res.status(200).json({ ok: true, count: arr.length });
}
