// api/matchup.js — on-demand, web-searched matchup briefing for one game.
// Casual-fan focused but CONCRETE: real form, key players/rookies, a tactical
// note, and current storylines — not rosy filler. Uses web search for accuracy.

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { league, home, away } = body || {};
  if (!home || !away) return res.status(400).json({ error: 'Missing teams' });

  const today = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date());

  const prompt = `Today is ${today}. Use web search to research the ${league || ''} game ${away} at ${home}, then write a tight, CONCRETE briefing for a casual fan who wants to actually understand what's going on — not flowery hype.

In 4-6 short sentences (plain text: no headers, no markdown, no bullet symbols):
- Where each team stands this season in real terms (record/form) and whether they're good right now.
- Each team's key player(s), and specifically call out any notable rookies or recent player developments.
- One concrete tactical point — a team's offensive or defensive identity, strength, or weakness.
- Any current storyline or news that matters for this game (injuries, win/loss streaks, playoff or standings stakes).

Be specific and accurate using what you find in search. Do NOT invent stats, records, or scores — if something isn't verifiable, leave it out. Warm but substantive, like a knowledgeable friend catching them up.`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 55000);
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-5', max_tokens: 1200,
          thinking: { type: 'disabled' },
          tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 2 }],
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } finally { clearTimeout(timer); }
    const data = await r.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!text) return res.status(200).json({ ok: false, error: 'No text in response' });
    return res.status(200).json({ ok: true, text });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err) });
  }
}
