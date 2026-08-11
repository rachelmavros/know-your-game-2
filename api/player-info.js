// api/player-info.js — a casual-fan bio + a few bullet-point facts for one
// player. AI-generated (fast, no tools), cached in Supabase app_cache
// (key `pinfo:<league>:<team>:<name>`) so each player is generated once.

export const config = { maxDuration: 20 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=604800');
  const league = String(req.query.league || '').toUpperCase();
  const team = String(req.query.team || '');
  const name = String(req.query.name || '');
  if (!name) return res.status(400).json({ ok: false, error: 'missing name' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const cacheKey = `pinfo:${league}:${team}:${name}`.toLowerCase();

  if (supabaseUrl && supabaseKey) {
    try {
      const r = await fetch(`${supabaseUrl}/rest/v1/app_cache?key=eq.${encodeURIComponent(cacheKey)}&select=value`, {
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      });
      const rows = await r.json();
      if (Array.isArray(rows) && rows[0] && rows[0].value && rows[0].value.blurb) {
        return res.status(200).json({ ok: true, cached: true, ...rows[0].value });
      }
    } catch { /* fall through */ }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(200).json({ ok: false, error: 'no api key' });

  const prompt = `For a casual sports fan, describe ${name}${team ? `, who plays for the ${team}` : ''}${league ? ` (${league})` : ''}. Respond ONLY as raw JSON: {"blurb":"2-3 warm, concrete sentences on who they are, their playing style, and why they matter","facts":["short interesting fact","another short fact","another"]}. Give 2-4 facts, each a short phrase (accolades, background, signature skill, fun trivia). Use real, well-known information; do NOT invent specific stats or numbers. No markdown, no extra text.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: 500,
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
    if (!val.blurb) return res.status(200).json({ ok: false });
    const clean = { blurb: String(val.blurb), facts: Array.isArray(val.facts) ? val.facts.slice(0, 4).map(String) : [] };

    if (supabaseUrl && supabaseKey) {
      fetch(`${supabaseUrl}/rest/v1/app_cache?on_conflict=key`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`,
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({ key: cacheKey, value: clean, updated_at: new Date().toISOString() }),
      }).catch(() => {});
    }
    return res.status(200).json({ ok: true, ...clean });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err) });
  }
}
