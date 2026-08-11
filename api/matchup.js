// api/matchup.js — on-demand, concrete matchup briefing for one game. Fast
// (no web search — that blew the serverless timeout). Instead we inject the
// teams' REAL current records from our standings cache, then let the model add
// player/rookie/style context from its knowledge. Concrete + quick.

export const config = { maxDuration: 20 };

async function recordFor(supabaseUrl, supabaseKey, league, home, away) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/app_cache?key=eq.standings&select=value`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    });
    const rows = await r.json();
    const val = Array.isArray(rows) && rows[0] && rows[0].value;
    if (!val) return {};
    const table = league === 'MLB' ? (val.mlb || []) : (val.wnba || []);
    const find = name => {
      const n = String(name).toLowerCase();
      const hit = table.find(t => {
        const tn = String(t.team).toLowerCase();
        return tn === n || tn.includes(n) || n.includes(tn) || tn.split(' ').pop() === n.split(' ').pop();
      });
      return hit ? `${hit.w}-${hit.l}` : null;
    };
    return { home: find(home), away: find(away) };
  } catch { return {}; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { league, home, away } = body || {};
  if (!home || !away) return res.status(400).json({ error: 'Missing teams' });

  // Pull real current records from our standings cache to anchor the briefing.
  const rec = await recordFor(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, league, home, away);
  const recLine = (rec.home || rec.away)
    ? `Current records (use these exact numbers): ${away} ${rec.away || 'n/a'}, ${home} ${rec.home || 'n/a'}.`
    : '';

  const prompt = `Write a tight, CONCRETE briefing for a casual fan about the ${league || ''} game ${away} at ${home} — not flowery hype.

${recLine}

In 4-6 short sentences (plain text: no headers, no markdown, no bullet symbols):
- Where each team stands and whether they're good right now (use the records above if given).
- Each team's key player(s), and specifically call out notable rookies or young players.
- One concrete point about a team's style — an offensive or defensive strength or weakness.
- The storyline that makes this game matter (rivalry, playoff race, a star to watch).

Be specific and substantive. Do NOT invent exact stats or records beyond the ones provided above — if you're unsure of a number, describe it qualitatively instead. Warm but informative, like a knowledgeable friend catching them up.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: 900,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await r.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!text) return res.status(200).json({ ok: false, error: 'No text in response' });
    return res.status(200).json({ ok: true, text });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err) });
  }
}
