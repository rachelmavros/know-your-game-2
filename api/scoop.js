// api/scoop.js — "The Scoop": 1-2 fun, casual-fan storyline bullets for a team
// (rivalries, personalities, culture/podcasts, big moments). AI-generated, cached
// in Supabase (key `scoop:<league>:<team>`). Grounded in widely-reported info —
// no invented rumors, controversies, or private-life claims.

export const config = { maxDuration: 20 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=604800');
  const league = String(req.query.league || '').toUpperCase();
  const team = String(req.query.team || '');
  if (!league || !team) return res.status(400).json({ ok: false, error: 'missing league/team' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const cacheKey = `scoop:${league}:${team}`.toLowerCase();

  if (supabaseUrl && supabaseKey) {
    try {
      const r = await fetch(`${supabaseUrl}/rest/v1/app_cache?key=eq.${encodeURIComponent(cacheKey)}&select=value`, {
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      });
      const rows = await r.json();
      if (Array.isArray(rows) && rows[0] && rows[0].value && Array.isArray(rows[0].value.bullets)) {
        return res.status(200).json({ ok: true, cached: true, bullets: rows[0].value.bullets });
      }
    } catch { /* fall through */ }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(200).json({ ok: false, error: 'no api key' });

  const prompt = `Give 1-2 fun "scoop" bullets about the ${league} team the ${team}, for a casual fan who wants to sound in-the-know. Think: notable storylines, rivalries, star personalities, team culture, a popular podcast or media presence, or a big well-known moment. Each bullet: one punchy, friendly sentence.

Rules:
- Only include things that are WIDELY KNOWN and PUBLICLY REPORTED.
- Do NOT invent or speculate about rumors, controversies, scandals, injuries, or anyone's private life or relationships. If you're not confident it's widely and publicly known, leave it out.
- If there's genuinely nothing notable, return fewer bullets or an empty list.

Respond ONLY as raw JSON: {"bullets":["...","..."]}. No markdown, no extra text.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: 400,
        thinking: { type: 'disabled' },
        system: 'You output only raw JSON. You never fabricate rumors, controversies, or private-life claims about real people.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await r.json();
    const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s === -1 || e === -1) return res.status(200).json({ ok: false, error: 'no json' });
    const val = JSON.parse(raw.slice(s, e + 1));
    const bullets = Array.isArray(val.bullets) ? val.bullets.slice(0, 2).map(String) : [];

    if (supabaseUrl && supabaseKey) {
      fetch(`${supabaseUrl}/rest/v1/app_cache?on_conflict=key`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`,
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({ key: cacheKey, value: { bullets }, updated_at: new Date().toISOString() }),
      }).catch(() => {});
    }
    return res.status(200).json({ ok: true, bullets });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err) });
  }
}
