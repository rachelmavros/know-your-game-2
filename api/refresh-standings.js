// api/refresh-standings.js — daily Vercel Cron. Asks Claude (with web search)
// for the CURRENT WNBA + MLB standings and caches them in Supabase
// (app_cache key='standings'), since BallDontLie's standings endpoint is
// paid-tier. The app reads it via /api/standings and falls back to its
// built-in table if the cache is empty. Web search keeps the numbers real.

// The Claude + web-search call runs long; allow up to the Hobby-plan max so the
// function isn't killed at the default 10s (which left the cache empty).
export const config = { maxDuration: 60 };

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

  const today = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: 'long', day: 'numeric',
  }).format(new Date());

  const prompt = `You maintain a live standings widget for a casual-fan sports app. Today is ${today}. Use web search to look up the CURRENT, up-to-date standings for these two leagues, then output ONLY a JSON object (no prose, no markdown fences) with exactly this shape:

{
  "wnba": [ { "rank": 1, "team": "Full Team Name", "conf": "E", "w": 18, "l": 6 }, ... ],
  "mlb":  [ { "rank": 1, "team": "Full Team Name", "conf": "E", "w": 58, "l": 31 }, ... ]
}

Rules:
- "wnba": ALL WNBA teams, ranked 1..N by win-loss record across the whole league (single table, no conferences for seeding). "conf" is "E" or "W" for the team's conference.
- "mlb": ONLY the National League teams (15 of them), ranked 1..15 by win-loss record. "conf" is the division: "E", "C", or "W".
- Use the teams' full names (e.g. "Minnesota Lynx", "Los Angeles Dodgers").
- "w" and "l" are integers (wins and losses). Do NOT include a games-back field — the app computes it.
- Return the freshest standings you can find as of ${today}.`;

  let parsed;
  try {
    // Hard 50s cap so the request fails cleanly with a reason instead of the
    // function being killed at the platform limit (which just spins forever).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 50000);
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 8000,
          thinking: { type: 'disabled' }, // faster + all tokens go to the answer
          system: 'You output only raw JSON. Never include prose, explanations, apologies, or markdown code fences.',
          tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    const data = await r.json();
    const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object — API said: ' + JSON.stringify(data).slice(0, 300));
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    // Don't overwrite a good cache with garbage — just report.
    return res.status(200).json({ ok: false, error: String(err) });
  }

  // Normalize + recompute rank and games-back per league. Keeps only well-formed
  // rows so a malformed league can't poison the table.
  const clean = (rows) => {
    if (!Array.isArray(rows)) return [];
    const out = rows
      .filter(t => t && t.team && Number.isFinite(Number(t.w)) && Number.isFinite(Number(t.l)))
      .map(t => ({ team: String(t.team), conf: t.conf ? String(t.conf) : '', w: Number(t.w), l: Number(t.l) }))
      .sort((a, b) => (b.w - b.l) - (a.w - a.l) || b.w - a.w);
    if (out.length === 0) return [];
    const lead = out[0];
    return out.map((t, i) => ({
      rank: i + 1,
      team: t.team,
      conf: t.conf,
      w: t.w,
      l: t.l,
      // Standard GB formula vs the leader; "—" for the leader.
      gb: i === 0 ? '—' : (((lead.w - t.w) + (t.l - lead.l)) / 2).toFixed(1),
    }));
  };

  const value = { wnba: clean(parsed.wnba), mlb: clean(parsed.mlb) };
  if (value.wnba.length === 0 && value.mlb.length === 0) {
    return res.status(200).json({ ok: false, error: 'Both leagues empty after cleaning' });
  }

  const up = await fetch(`${supabaseUrl}/rest/v1/app_cache?on_conflict=key`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ key: 'standings', value, updated_at: new Date().toISOString() }),
  });
  if (!up.ok) return res.status(500).json({ ok: false, error: await up.text() });

  return res.status(200).json({ ok: true, wnba: value.wnba.length, mlb: value.mlb.length });
}
