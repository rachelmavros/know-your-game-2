// api/team-star.js — the single most notable/best-known player on a team, for
// teams without a curated star. AI-picked (fast, no tools) and cached in
// Supabase app_cache (key `star:<league>:<team>`) so each team is computed once.

export const config = { maxDuration: 20 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=86400');
  const league = String(req.query.league || '').toUpperCase();
  const team = req.query.team ? String(req.query.team) : '';
  if (!league || !team) return res.status(400).json({ ok: false, error: 'missing league/team' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const cacheKey = `star:${league}:${team}`.toLowerCase();

  // Serve from cache when present.
  if (supabaseUrl && supabaseKey) {
    try {
      const r = await fetch(`${supabaseUrl}/rest/v1/app_cache?key=eq.${encodeURIComponent(cacheKey)}&select=value`, {
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      });
      const rows = await r.json();
      if (Array.isArray(rows) && rows[0] && rows[0].value && rows[0].value.name) {
        return res.status(200).json({ ok: true, cached: true, ...rows[0].value });
      }
    } catch { /* fall through to generate */ }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(200).json({ ok: false, error: 'no api key' });

  const prompt = `Name the single most notable, best-known player on the ${league} team the ${team} right now, for a casual fan. Respond ONLY as raw JSON: {"name":"Full Name","blurb":"one short sentence on who they are and why they matter"}. No markdown, no extra text.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: 300,
        thinking: { type: 'disabled' },
        system: 'You output only raw JSON.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await r.json();
    const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s === -1 || e === -1) return res.status(200).json({ ok: false, error: 'no json' });
    const val = JSON.parse(raw.slice(s, e + 1));
    if (!val.name) return res.status(200).json({ ok: false });

    // Cache for next time (fire and forget).
    if (supabaseUrl && supabaseKey) {
      fetch(`${supabaseUrl}/rest/v1/app_cache?on_conflict=key`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`,
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({ key: cacheKey, value: { name: val.name, blurb: val.blurb || '' }, updated_at: new Date().toISOString() }),
      }).catch(() => {});
    }
    return res.status(200).json({ ok: true, name: val.name, blurb: val.blurb || '' });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err) });
  }
}
