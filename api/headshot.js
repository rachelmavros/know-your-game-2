// api/headshot.js — one player's ESPN headshot URL, by league + team + name.
// Lets star cards show real photos even before a full roster is loaded.

export const config = { maxDuration: 15 };

const LEAGUE_PATH = { WNBA: 'basketball/wnba', NBA: 'basketball/nba', MLB: 'baseball/mlb', NFL: 'football/nfl', NHL: 'hockey/nhl' };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=172800');
  const league = String(req.query.league || '').toUpperCase();
  const team = String(req.query.team || '');
  const name = String(req.query.name || '');
  const path = LEAGUE_PATH[league];
  if (!path || !team || !name) return res.status(200).json({ headshot: '' });

  try {
    const tr = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/teams`);
    const tj = await tr.json();
    const list = ((((tj.sports || [])[0] || {}).leagues || [])[0] || {}).teams || [];
    const tn = team.toLowerCase();
    const match = list.find(t => {
      const dn = String(t.team.displayName).toLowerCase();
      return dn === tn || dn.includes(tn) || tn.includes(dn);
    });
    if (!match) return res.status(200).json({ headshot: '' });

    const rr = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/teams/${match.team.id}/roster`);
    const rj = await rr.json();
    const nn = name.toLowerCase();
    for (const node of (rj.athletes || [])) {
      const items = Array.isArray(node.items) ? node.items : [node];
      for (const p of items) {
        const pn = (p.fullName || p.displayName || '').toLowerCase();
        if (pn === nn || pn.includes(nn) || nn.includes(pn)) {
          return res.status(200).json({ headshot: (p.headshot && p.headshot.href) || '' });
        }
      }
    }
    return res.status(200).json({ headshot: '' });
  } catch (err) {
    return res.status(200).json({ headshot: '', error: String(err) });
  }
}
