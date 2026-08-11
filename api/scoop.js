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
  const cacheKey = `scoop2:${league}:${team}`.toLowerCase(); // v2 = specific/juicy

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

  const prompt = `Give 1-2 SPECIFIC, juicy "scoop" bullets about the ${league} team the ${team}, for a casual fan who wants the real gossip and storylines — the stuff people actually talk about.

Be concrete and name names + specific moments. Great examples of the RIGHT kind of specificity:
- Real rivalries and feuds with the actual details (e.g. the Caitlin Clark–Angel Reese rivalry: the "you can't see me" taunt, the hard fouls, the playoff trash talk).
- Iconic moments, memorable beefs, on-court altercations, viral plays, famous trash talk or quotes.
- Star personalities, a popular team podcast or media presence, a big trade or drama that dominated headlines.

Each bullet: one punchy, specific sentence that references the actual moment/person — not vague ("became a hot storyline"). Lead with the specifics.

Rules:
- Everything must be REAL and WIDELY REPORTED in mainstream sports media. Public on-court feuds, trash talk, rivalries, trades, and viral moments are all fair game.
- Do NOT fabricate. Do NOT speculate about anyone's private life, relationships/dating, medical details, or unverified rumors. If you're not confident it actually happened and was widely covered, leave it out.
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
