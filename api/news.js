// api/news.js — real aggregated news headlines from ESPN's free feed (no key,
// no AI — straight aggregation). Node function (ESPN blocks Vercel's edge
// egress). Cached at the CDN. Returns recent articles per league.

const LEAGUE_PATH = { WNBA: 'basketball/wnba', MLB: 'baseball/mlb', NBA: 'basketball/nba', NFL: 'football/nfl', NHL: 'hockey/nhl', EPL: 'soccer/eng.1' };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  const league = String(req.query.league || '').toUpperCase();
  const path = LEAGUE_PATH[league];
  if (!path) return res.status(400).json({ articles: [] });

  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/news`);
    if (!r.ok) return res.status(200).json({ articles: [], _status: r.status });
    const j = await r.json();
    const articles = (j.articles || []).map(a => ({
      headline: a.headline || '',
      description: a.description || '',
      published: a.published || '',
      link: (a.links && a.links.web && a.links.web.href) || (a.links && a.links.mobile && a.links.mobile.href) || '',
      image: (a.images && a.images[0] && a.images[0].url) || '',
      type: a.type || '',
    })).filter(a => a.headline && a.link).slice(0, 24);
    return res.status(200).json({ articles });
  } catch (err) {
    return res.status(200).json({ articles: [], error: String(err) });
  }
}
