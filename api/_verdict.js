// api/_verdict.js — data-driven "is this game worth watching?" scorer.
// IMPORT HELPER, not an endpoint: does NOT count toward the Vercel Hobby
// 12-function limit (same pattern as _push.js).
//
// Scores an ESPN scoreboard competition 0-100 from signals ESPN gives us free,
// then maps to the app's 4 verdict tiers. Every signal is optional — leagues
// expose different fields (only college has curatedRank, only CFB has odds),
// so each contributor returns 0 when its data is missing rather than skewing
// the result. Records + national TV are the universal backbone.

// National-broadcast tiers. A game the networks chose to put on ABC is, by
// revealed preference, a game somebody thought was worth watching.
const BIG_FOUR = ['ABC', 'CBS', 'NBC', 'FOX'];
const MAJOR_CABLE = ['ESPN', 'ESPN2', 'TNT', 'TBS', 'FS1', 'USA', 'ION', 'NFLN', 'NBA TV', 'MLB Network', 'CBSSN', 'BTN', 'SECN', 'ACCN'];

// Is this an actual TV network, as opposed to a streaming-only add-on tier
// (ESPN+, SECN+, ACC Network Extra/"ACCNX", conference "digital networks",
// a school's own YouTube feed)? Those exist for nearly every college game, so
// treating them as "televised" would defeat the point of filtering by it.
// Exact-match only — a substring match would let "ACCNX" pass on "ACCN".
export function isNationalTv(network) {
  if (!network) return false;
  const n = String(network).toUpperCase().trim();
  if (n.includes('+')) return false;               // ESPN+, SECN+, B1G+, MW+
  if (BIG_FOUR.some(x => n === x || n.startsWith(x + ' '))) return true;
  return MAJOR_CABLE.some(x => n === x || n.startsWith(x + ' ') || n.endsWith(' ' + x));
}

function winPct(competitor) {
  const recs = (competitor && competitor.records) || [];
  const overall = recs.find(r => r.type === 'total') || recs[0];
  const summary = overall && overall.summary;
  if (!summary) return null;
  const m = String(summary).match(/^(\d+)-(\d+)/);
  if (!m) return null;
  const w = Number(m[1]), l = Number(m[2]);
  if (w + l === 0) return null;            // preseason 0-0 tells us nothing
  return w / (w + l);
}

function apRank(competitor) {
  const r = competitor && competitor.curatedRank && competitor.curatedRank.current;
  // ESPN uses 99 as the "unranked" sentinel.
  return (typeof r === 'number' && r > 0 && r < 99) ? r : null;
}

// 0-30: how good are these teams? Rewards two strong teams over one strong
// team beating up on a weak one.
function qualityPoints(hp, ap) {
  if (hp == null && ap == null) return 0;
  if (hp == null || ap == null) {
    const only = hp == null ? ap : hp;
    return Math.round(Math.max(0, (only - 0.4)) / 0.6 * 15);
  }
  const avg = (hp + ap) / 2;
  const weaker = Math.min(hp, ap);
  // Weight the weaker team heavily: a mismatch shouldn't score like a clash.
  const blended = avg * 0.45 + weaker * 0.55;
  return Math.round(Math.max(0, (blended - 0.35)) / 0.65 * 30);
}

// 0-25: AP ranking. Two ranked teams is the single best "this matters" signal
// college sports offers a casual fan.
function rankPoints(hr, ar) {
  if (hr == null && ar == null) return 0;
  if (hr == null || ar == null) {
    const only = hr == null ? ar : hr;
    return Math.round(12 * (1 - (only - 1) / 25));   // #1 alone ≈ 12, #25 ≈ 0.5
  }
  const best = Math.min(hr, ar), worst = Math.max(hr, ar);
  let pts = 25 * (1 - (best - 1) / 25) * 0.6 + 25 * (1 - (worst - 1) / 25) * 0.4;
  if (best <= 10 && worst <= 10) pts += 4;           // top-10 showdown
  return Math.round(Math.min(25, pts));
}

// 0-14: playoff pressure. Late in a season, a game between two teams scrapping
// for the last postseason spot is worth more than the same two teams in May.
// Scales with how far into the season we are, so it stays quiet in the spring
// and gets loud in the stretch run.
function racePoints(hp, ap, seasonPct) {
  if (hp == null || ap == null || seasonPct == null) return 0;
  if (seasonPct < 0.55) return 0;                    // too early to matter
  // "In the mix" = hovering around .500, where playoff spots are actually
  // decided. Runaway leaders and lottery teams aren't racing anyone.
  const contention = v => 1 - Math.min(1, Math.abs(v - 0.5) / 0.28);
  const both = Math.min(contention(hp), contention(ap));
  const lateness = Math.min(1, (seasonPct - 0.55) / 0.45);
  return Math.round(14 * both * lateness);
}

// 0-20: is it likely to be CLOSE? Blowouts aren't fun to watch.
// Prefers the betting spread; falls back to how similar the records are.
function closenessPoints(spread, hp, ap) {
  if (typeof spread === 'number' && isFinite(spread)) {
    const s = Math.abs(spread);
    if (s <= 3) return 20;
    if (s >= 24) return 0;
    return Math.round(20 * (1 - (s - 3) / 21));
  }
  if (hp == null || ap == null) return 0;
  const gap = Math.abs(hp - ap);                     // 0 = evenly matched
  return Math.round(Math.max(0, 14 * (1 - gap / 0.5)));
}

// 0-15: national TV placement.
function tvPoints(network) {
  if (!network) return 0;
  const n = String(network).toUpperCase();
  if (BIG_FOUR.some(x => n === x || n.startsWith(x + ' '))) return 15;
  if (MAJOR_CABLE.some(x => n.includes(x.toUpperCase()))) return 11;
  return 3;                                          // streaming/regional
}

// 0-15: explicit stakes. ESPN puts "Rivalry Week", bowl names, and playoff
// round names in competition notes / event name.
// Deliberately narrow. Early-season college schedules are wall-to-wall
// "Invitational" and "Classic" tournaments that carry no real stakes, so
// matching those words flags half the slate as a big deal. Only postseason
// and genuine rivalry language counts.
const STAKES = [
  [/national championship|championship game|title game/i, 15],
  [/playoff|elimination game|clinch/i, 14],
  [/final four|semifinal|elite eight|sweet sixteen|super regional/i, 13],
  [/\bbowl\b/i, 10],
  [/rivalry week|derby/i, 9],
];
function stakesPoints(notes, eventName) {
  const text = [
    ...(Array.isArray(notes) ? notes.map(n => n && n.headline) : []),
    eventName || '',
  ].filter(Boolean).join(' ');
  if (!text) return 0;
  for (const [re, pts] of STAKES) if (re.test(text)) return pts;
  return 0;
}

/**
 * Score one ESPN competition. Returns { verdict, score, reasons }.
 * verdict: 5 MUST WATCH | 4 WORTH YOUR TIME | 3 GOOD GAME | 2 CASUAL VIEWING
 */
// Regular-season length per ESPN league path, used to tell how deep into the
// season a game sits. College is left out: its short seasons and poll-driven
// stakes are already captured by the ranking signal.
const SEASON_LENGTH = {
  'basketball/wnba': 44, 'basketball/nba': 82,
  'baseball/mlb': 162, 'football/nfl': 17, 'hockey/nhl': 82,
};

function gamesPlayed(competitor) {
  const recs = (competitor && competitor.records) || [];
  const overall = recs.find(r => r.type === 'total') || recs[0];
  const m = overall && overall.summary && String(overall.summary).match(/^(\d+)-(\d+)/);
  return m ? Number(m[1]) + Number(m[2]) : null;
}

export function scoreCompetition(comp, ev, network, leaguePath) {
  const cs = (comp && comp.competitors) || [];
  const H = cs.find(c => c.homeAway === 'home') || cs[0];
  const A = cs.find(c => c.homeAway === 'away') || cs[1];

  const hp = winPct(H), ap = winPct(A);
  const hr = apRank(H), ar = apRank(A);

  // ESPN's odds array can contain null entries (the Premier League feed does),
  // so find the first usable one rather than assuming odds[0] is an object.
  let spread = null;
  const odds = (comp && comp.odds) || [];
  const line = odds.find(o => o && typeof o.spread === 'number');
  if (line) spread = line.spread;

  // How far into the regular season are we? Drives the playoff-race signal.
  const seasonLen = SEASON_LENGTH[leaguePath];
  let seasonPct = null;
  if (seasonLen) {
    const gp = Math.max(gamesPlayed(H) || 0, gamesPlayed(A) || 0);
    if (gp > 0) seasonPct = Math.min(1, gp / seasonLen);
  }

  const parts = {
    quality:   qualityPoints(hp, ap),
    ranking:   rankPoints(hr, ar),
    closeness: closenessPoints(spread, hp, ap),
    tv:        tvPoints(network),
    stakes:    stakesPoints(comp && comp.notes, ev && ev.name),
    race:      racePoints(hp, ap, seasonPct),
  };

  // Normalize against the points ACTUALLY AVAILABLE for this game, because
  // leagues expose different signals and the same league exposes different
  // ones at different times of year. Only college has AP ranks; only CFB has
  // spreads; in week 1 every record is 0-0. Scoring against a fixed 100-point
  // max would shove whole leagues into "casual" for reasons that say nothing
  // about the game. A percentage of what we could learn keeps the scale
  // meaningful everywhere.
  const hasRecords = hp != null || ap != null;
  let max = 15;                                    // TV is always in play
  if (hasRecords) max += 30;                       // quality
  if (hr != null || ar != null) max += 25;         // ranking
  if (spread != null) max += 20;                   // closeness via odds
  else if (hp != null && ap != null) max += 14;    // closeness via records
  if (parts.race > 0 || (seasonPct != null && seasonPct >= 0.55)) max += 14;  // playoff race

  // Floor the denominator. When we know almost nothing about a game (early
  // season: no records, no rank, no line) the only signal left is TV, and
  // dividing by 15 would turn "it's on ESPN+" into a 90% must-watch. The floor
  // says: with this little evidence, a game cannot climb very high.
  // Do we actually know anything about how good these teams are? In week 1
  // every record is 0-0 and nobody's ranked, so the only signals left are the
  // TV slot and the betting line — enough to say "this looks watchable", not
  // enough to crown a must-watch. Hold such games to a higher bar.
  const knowsTeams = hasRecords || hr != null || ar != null;
  max = Math.max(max, knowsTeams ? 45 : 58);

  const earned = parts.quality + parts.ranking + parts.closeness + parts.tv + parts.race;
  // Stakes is a bonus on top rather than part of the denominator — a game with
  // no playoff/rivalry note shouldn't be penalized for the note's absence.
  const pct = Math.max(0, Math.min(1, (earned + parts.stakes) / Math.max(1, max)));
  const score = Math.round(pct * 100);

  // Human-readable "why", surfaced under the badge in the UI.
  const reasons = [];
  if (hr != null && ar != null) reasons.push(`#${Math.min(hr, ar)} vs #${Math.max(hr, ar)}`);
  else if (hr != null || ar != null) reasons.push(`Ranked team (#${hr != null ? hr : ar})`);
  if (parts.stakes >= 9) reasons.push('High stakes');
  if (parts.race >= 7) reasons.push('Playoff race');
  if (parts.closeness >= 15 || (spread == null && parts.closeness >= 11)) reasons.push('Expected to be close');
  if (parts.tv >= 15) reasons.push(`National TV${network ? ` (${network})` : ''}`);
  else if (parts.tv >= 11) reasons.push(network || 'National TV');
  if (parts.quality >= 22) reasons.push('Two strong teams');

  let verdict;
  if (score >= 62) verdict = 5;
  else if (score >= 45) verdict = 4;
  else if (score >= 28) verdict = 3;
  else verdict = 2;
  // "Must watch" is a claim about the teams, so don't make it when we have no
  // read on them at all — cap at "worth your time" instead.
  if (!knowsTeams && verdict > 4) verdict = 4;

  return { verdict, score, reasons, parts };
}
