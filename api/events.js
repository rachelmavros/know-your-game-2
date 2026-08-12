// api/events.js — upcoming big sports events, AI-generated and cached in
// Supabase (app_cache key='events-list'). Regenerates ONLY when a visitor opens
// the tab and the cache is older than ~14 days — so it self-refreshes with no
// cron. Merged with the app's curated list on the frontend.

export const config = { maxDuration: 20 };

const FRESH_MS = 14 * 86400000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const cacheKey = 'events-list';

  let stale = null;
  if (supabaseUrl && supabaseKey) {
    try {
      const r = await fetch(`${supabaseUrl}/rest/v1/app_cache?key=eq.${cacheKey}&select=value,updated_at`, {
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      });
      const rows = await r.json();
      if (Array.isArray(rows) && rows[0] && Array.isArray(rows[0].value)) {
        const age = Date.now() - new Date(rows[0].updated_at).getTime();
        if (age < FRESH_MS) return res.status(200).json({ events: rows[0].value, cached: true });
        stale = rows[0].value; // fall back to this if regeneration fails
      }
    } catch { /* generate */ }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(200).json({ events: stale || [] });

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const prompt = `Today is ${today}. List the 8-12 biggest upcoming US sports events over roughly the next 6 months that a CASUAL fan would care about — drafts, All-Star games, trade deadlines, playoff starts, championships/finals, and season openers across WNBA, NBA, MLB, NFL, and NHL.

For each event output an object with EXACTLY these fields:
- "dateKey": "YYYY-MM-DD" (best known or approximate scheduled date; must be today or later)
- "league": one of "WNBA","NBA","MLB","NFL","NHL"
- "title": short event name
- "span": human-friendly timing like "Late October" or "Saturday, Feb 14"
- "where": venue/city if known, else ""
- "tv": US network if well known, else ""
- "note": one warm, plain-English sentence on why a casual fan should care

Only include real, scheduled or clearly recurring events. Order earliest first. Output ONLY a JSON array, no markdown.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: 2000,
        thinking: { type: 'disabled' },
        system: 'You output only a raw JSON array. Never include prose or markdown.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await r.json();
    const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const s = raw.indexOf('['), e = raw.lastIndexOf(']');
    if (s === -1 || e === -1) return res.status(200).json({ events: stale || [] });
    let arr = JSON.parse(raw.slice(s, e + 1));
    if (!Array.isArray(arr)) return res.status(200).json({ events: stale || [] });
    arr = arr
      .filter(x => x && x.dateKey && x.title && x.league && x.dateKey >= today)
      .map(x => ({ dateKey: String(x.dateKey), league: String(x.league).toUpperCase(), title: String(x.title), span: x.span || '', where: x.where || '', tv: x.tv || '', note: x.note || '' }))
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
      .slice(0, 14);
    if (!arr.length) return res.status(200).json({ events: stale || [] });

    if (supabaseUrl && supabaseKey) {
      fetch(`${supabaseUrl}/rest/v1/app_cache?on_conflict=key`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`,
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({ key: cacheKey, value: arr, updated_at: new Date().toISOString() }),
      }).catch(() => {});
    }
    return res.status(200).json({ events: arr });
  } catch (err) {
    return res.status(200).json({ events: stale || [], error: String(err) });
  }
}
