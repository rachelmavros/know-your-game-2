// api/team-star.js — the single most notable/best-known player on a team, for
// teams without a curated star. AI-picked (fast, no tools) and cached in
// Supabase app_cache (key `star:<league>:<team>`) so each team is computed once.

export const config = { maxDuration: 20 };

const LEAGUE_PATH = { WNBA: 'basketball/wnba', NBA: 'basketball/nba', MLB: 'baseball/mlb', NFL: 'football/nfl', NHL: 'hockey/nhl' };

// Current roster player names for a team, so the AI can only pick a real,
// current player (which also guarantees we have their headshot).
async function rosterNames(league, team) {
  const path = LEAGUE_PATH[league];
  if (!path) return [];
  try {
    const tr = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/teams`);
    const tj = await tr.json();
    const list = ((((tj.sports || [])[0] || {}).leagues || [])[0] || {}).teams || [];
    const n = team.toLowerCase();
    const match = list.find(t => {
      const dn = String(t.team.displayName).toLowerCase();
      return dn === n || dn.includes(n) || n.includes(dn);
    });
    if (!match) return [];
    const rr = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/teams/${match.team.id}/roster`);
    const rj = await rr.json();
    const names = [];
    for (const node of (rj.athletes || [])) {
      const items = Array.isArray(node.items) ? node.items : [node];
      for (const p of items) { const nm = p.fullName || p.displayName; if (nm) names.push(nm); }
    }
    return names;
  } catch { return []; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=86400');
  const league = String(req.query.league || '').toUpperCase();
  const team = req.query.team ? String(req.query.team) : '';
  if (!league || !team) return res.status(400).json({ ok: false, error: 'missing league/team' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const cacheKey = `star2:${league}:${team}`.toLowerCase(); // v2 = roster-constrained

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

  const names = await rosterNames(league, team);
  const rosterClause = names.length
    ? `Choose ONLY from this current roster (use the exact name as written): ${names.join(', ')}.`
    : '';
  const prompt = `From the ${league} team the ${team}, name the single most notable, best-known player for a casual fan. ${rosterClause} Respond ONLY as raw JSON: {"name":"Full Name","blurb":"one short sentence on who they are and why they matter"}. No markdown, no extra text.`;

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
