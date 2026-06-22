import { useState, useEffect, useRef } from "react";

/* ─────────────────────────────────────────────────────────────
   KNOW YOUR GAME · light mode · ESPN-caliber sports companion
   ───────────────────────────────────────────────────────────── */

/* ─── DATE HELPERS — dynamic "today", not hardcoded ─────────── */
// All app data is dateKey'd as YYYY-MM-DD strings. These helpers
// compute the real current date so "Today" always means today.

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dateKey, n) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + n);
  const ny = date.getFullYear();
  const nm = String(date.getMonth() + 1).padStart(2, "0");
  const nd = String(date.getDate()).padStart(2, "0");
  return `${ny}-${nm}-${nd}`;
}

function dayLabel(dateKey) {
  const today = todayKey();
  if (dateKey === today) return "Today";
  if (dateKey === addDays(today, 1)) return "Tomorrow";
  const [y, m, d] = dateKey.split("-").map(Number);
  return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(y, m - 1, d).getDay()];
}

function weekdayShort(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return ["SUN","MON","TUE","WED","THU","FRI","SAT"][new Date(y, m - 1, d).getDay()];
}

function dayNum(dateKey) {
  return parseInt(dateKey.split("-")[2], 10);
}

function monthName(dateKey) {
  const [y, m] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long" });
}

function daysInMonth(year, month) { // month is 1-indexed
  return new Date(year, month, 0).getDate();
}

function firstWeekdayOfMonth(year, month) { // 0=Sun .. 6=Sat, returns Mon-first index
  const jsDay = new Date(year, month - 1, 1).getDay(); // 0=Sun
  return (jsDay + 6) % 7; // convert to Mon=0 .. Sun=6
}

/* ─── LIVE SCHEDULE (BallDontLie) ──────────────────────────────
   Fetches real game schedules so the calendar is accurate whenever
   you open the app — no manual updates needed. Falls back silently
   to the built-in schedule if the API is unreachable or keys aren't
   set yet, so the app always works.

   Free tier = games endpoint only (no live scores needed here, just
   the schedule). One free key per sport, set as Vercel env vars.
   ──────────────────────────────────────────────────────────────── */

// BallDontLie uses some abbreviations that differ from the app's.
// Map BDL → app abbreviations so colors/logos stay consistent.
const BDL_ABBR_FIX = {
  // WNBA
  "NY": "NYL", "LV": "LVA", "LA": "LAS", "WAS": "WAS", "GS": "GSV",
  "CONN": "CON", "PHO": "PHX",
  // (MLB and World Cup abbreviations mostly match already)
};

function fixAbbr(a) {
  if (!a) return a;
  return BDL_ABBR_FIX[a] || a;
}

// Convert a BallDontLie ISO-UTC datetime to { dateKey, time } in Central Time.
function bdlToLocal(iso) {
  const d = new Date(iso);
  // dateKey in America/Chicago
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t)?.value;
  const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true,
  }).format(d) + " CT";
  return { dateKey, time };
}

// Map one BallDontLie game object → the app's lightweight calendar-event shape.
function mapBdlGame(g, league) {
  const home = g.home_team || {};
  const visitor = g.visitor_team || {};
  const { dateKey, time } = bdlToLocal(g.date);
  return {
    league,
    home: home.full_name || home.name || "",
    homeAbbr: fixAbbr(home.abbreviation),
    away: visitor.full_name || visitor.name || "",
    awayAbbr: fixAbbr(visitor.abbreviation),
    time,
    dateKey,
    // The API doesn't rank importance, so default everything to a neutral
    // "good game" verdict. Our curated GAMES/CAL_EVENTS still override the
    // highlights; this just fills in the full slate so nothing's missing.
    verdict: 3,
    status: g.status,
    homeScore: g.home_score,
    awayScore: g.away_score,
    note: "",
    fromApi: true,
  };
}

// Fetch a sport's schedule for a date window. Returns [] on any failure.
async function fetchSchedule(sport, startDate, endDate) {
  try {
    const url = `/api/schedule?sport=${sport}&start_date=${startDate}&end_date=${endDate}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json.data) ? json.data : [];
  } catch {
    return [];
  }
}

// React hook: on mount, pull WNBA + MLB + World Cup schedules for a window
// around today, group them by dateKey, and hand back a CAL_EVENTS-shaped map.
// Components merge this over the built-in CAL_EVENTS so live data wins where
// present but the app still works before keys are configured.
function useLiveSchedule() {
  const [liveEvents, setLiveEvents] = useState(null); // null = not loaded yet
  const [status, setStatus] = useState("idle"); // idle | loading | done | empty
  const [counts, setCounts] = useState({ wnba: null, mlb: null });

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setStatus("loading");
      const today = todayKey();
      const start = addDays(today, -7);
      const end = addDays(today, 21);

      // WNBA + MLB are free. World Cup matches are paid-tier only, so those
      // games stay hand-curated in CAL_EVENTS and aren't fetched here.
      const [wnba, mlb] = await Promise.all([
        fetchSchedule("wnba", start, end),
        fetchSchedule("mlb", start, end),
      ]);

      if (cancelled) return;

      const grouped = {};
      const add = (rows, league) => {
        rows.forEach(g => {
          const ev = mapBdlGame(g, league);
          if (!ev.dateKey) return;
          (grouped[ev.dateKey] = grouped[ev.dateKey] || []).push(ev);
        });
      };
      add(wnba, "WNBA");
      add(mlb, "MLB");

      const total = wnba.length + mlb.length;
      setCounts({ wnba: wnba.length, mlb: mlb.length });
      setLiveEvents(grouped);
      setStatus(total > 0 ? "done" : "empty");
    };
    run();
    return () => { cancelled = true; };
  }, []);

  return { liveEvents, status, counts };
}

// Merge live events into the built-in CAL_EVENTS for a given dateKey.
// Curated events (with real verdicts/notes) come first; live API games
// that aren't already represented get appended so the slate is complete.
function mergeDayEvents(dateKey, liveEvents) {
  const curated = CAL_EVENTS[dateKey] || [];
  if (!liveEvents || !liveEvents[dateKey]) return curated;

  const seen = new Set(curated.map(e => `${e.league}:${e.homeAbbr || e.home}:${e.awayAbbr || e.away}`));
  const extras = liveEvents[dateKey].filter(e => {
    const key = `${e.league}:${e.homeAbbr || e.home}:${e.awayAbbr || e.away}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...curated, ...extras];
}


const C = {
  bg:       "#F4F6F8",
  surface:  "#FFFFFF",
  raised:   "#FFFFFF",
  ink:      "#15202B",
  inkMid:   "#46535F",
  inkDim:   "#6B7785",
  inkFaint: "#9AA5B1",
  line:     "#E3E8ED",
  lineSoft: "#EEF1F4",
  red:      "#C8102E",
  redSoft:  "#FBE9EC",
};

// League colors chosen for contrast on white
const LEAGUE_COLORS = {
  WNBA: "#E8590C",   // orange
  NBA:  "#1D5BBF",   // blue
  MLB:  "#1F7A4D",   // green
  NFL:  "#C0392B",   // red
  NHL:  "#0E7C9D",   // teal
  MLS:  "#6B4FBB",   // purple
  WC:   "#0E8C5A",   // World Cup green
};
const LEAGUE_SPORT = { WNBA:"Basketball", NBA:"Basketball", MLB:"Baseball", NFL:"Football", NHL:"Hockey", MLS:"Soccer", WC:"Soccer · World Cup" };

const VERDICT = {
  5: { label: "MUST WATCH",      bg: "#C8102E", text: "#fff" },
  4: { label: "WORTH YOUR TIME", bg: "#E8590C", text: "#fff" },
  3: { label: "GOOD GAME",       bg: "#E7EBEF", text: "#46535F" },
  2: { label: "CASUAL VIEWING",  bg: "#F0F3F6", text: "#9AA5B1" },
};

/* ─── DATA ────────────────────────────────────────────────── */

const GAMES = [
  // WNBA — real Sunday June 21 slate
  {
    id: "wnba-gsv-lva", league: "WNBA", city: "Las Vegas",
    home: "Las Vegas Aces", homeAbbr: "LVA", away: "Golden State Valkyries", awayAbbr: "GSV",
    time: "3:00 PM CT", day: "Today", dateKey: "2026-06-21",
    status: "upcoming", verdict: 4, winProb: { LVA: 60.7, GSV: 39.3 },
    tagline: "🏀 Aces host the league's newest team",
    summary: "Las Vegas is favored at home, but the Valkyries have been a fun surprise in their second season. Good Sunday afternoon basketball.",
    channel: "League Pass", channelUrl: "https://www.wnba.com/leaguepass",
    featured: true,
  },
  {
    id: "wnba-min-was", league: "WNBA", city: "Minneapolis",
    home: "Minnesota Lynx", homeAbbr: "MIN", away: "Washington Mystics", awayAbbr: "WAS",
    time: "5:00 PM CT", day: "Today", dateKey: "2026-06-21",
    status: "upcoming", verdict: 2, winProb: { MIN: 88.4, WAS: 11.6 },
    tagline: "🏀 Lynx heavily favored at home",
    summary: "Minnesota is one of the league's best teams this year. Washington is rebuilding — expect a lopsided one.",
    channel: "League Pass", channelUrl: "https://www.wnba.com/leaguepass",
  },
  {
    id: "wnba-las-nyl", league: "WNBA", city: "Los Angeles",
    home: "Los Angeles Sparks", homeAbbr: "LAS", away: "New York Liberty", awayAbbr: "NYL",
    time: "7:00 PM CT", day: "Today", dateKey: "2026-06-21",
    status: "upcoming", verdict: 4, winProb: { LAS: 36.8, NYL: 63.2 },
    tagline: "🏀 Liberty on the road out West",
    summary: "NY Liberty are championship contenders with a deep, veteran roster — a good game to see what title-level WNBA looks like.",
    channel: "ESPN2", channelUrl: "https://www.espn.com/watch/",
  },
  // FIFA World Cup 2026 — group stage, live tournament
  {
    id: "wc-esp-ksa", league: "WC", city: "USA",
    home: "Spain", homeAbbr: "ESP", away: "Saudi Arabia", awayAbbr: "KSA",
    time: "11:00 AM CT", day: "Today", dateKey: "2026-06-21",
    status: "upcoming", verdict: 4, winProb: { ESP: 89.4, KSA: 2.9 },
    tagline: "⚽ World Cup group stage",
    summary: "Spain is a heavy favorite and one of the tournament's best squads. Worth tuning in to see a contender in group play.",
    channel: "Fox Sports", channelUrl: "https://www.foxsports.com/live",
  },
  {
    id: "wc-bel-irn", league: "WC", city: "USA",
    home: "Belgium", homeAbbr: "BEL", away: "Iran", awayAbbr: "IRN",
    time: "2:00 PM CT", day: "Today", dateKey: "2026-06-21",
    status: "upcoming", verdict: 5, winProb: { BEL: 67.6, IRN: 12.4 },
    tagline: "⚽ World Cup — Belgium favored",
    summary: "The World Cup is happening right now, live in the US, Mexico, and Canada. Belgium is a strong European side — a great entry point if you've never watched soccer.",
    channel: "Fox Sports", channelUrl: "https://www.foxsports.com/live",
  },
  {
    id: "wc-uru-cpv", league: "WC", city: "USA",
    home: "Uruguay", homeAbbr: "URU", away: "Cape Verde", awayAbbr: "CPV",
    time: "5:00 PM CT", day: "Today", dateKey: "2026-06-21",
    status: "upcoming", verdict: 3, winProb: { URU: 65.8, CPV: 11.7 },
    tagline: "⚽ Cape Verde's World Cup debut run",
    summary: "Cape Verde is one of this World Cup's great underdog stories. Uruguay is favored, but a small nation chasing an upset is always fun to watch.",
    channel: "Fox Sports", channelUrl: "https://www.foxsports.com/live",
  },
  // MLB — real Sunday June 21 slate
  {
    id: "mlb-lad-bal", league: "MLB", city: "Los Angeles",
    home: "Los Angeles Dodgers", homeAbbr: "LAD", away: "Baltimore Orioles", awayAbbr: "BAL",
    time: "3:10 PM CT", day: "Today", dateKey: "2026-06-21",
    status: "upcoming", verdict: 3,
    tagline: "⚾ Dodgers at home — Ohtani watch",
    summary: "The Dodgers are baseball's biggest draw, and Shohei Ohtani alone is worth tuning in for, win or lose.",
    channel: "Apple TV+", channelUrl: "https://tv.apple.com",
  },
  {
    id: "mlb-chc-tor", league: "MLB", city: "Chicago",
    home: "Chicago Cubs", homeAbbr: "CHC", away: "Toronto Blue Jays", awayAbbr: "TOR",
    time: "1:20 PM CT", day: "Today", dateKey: "2026-06-21",
    status: "upcoming", verdict: 2,
    tagline: "⚾ Cubs host the Blue Jays",
    summary: "Regular-season interleague matchup at Wrigley. Low stakes, decent Sunday afternoon baseball.",
    channel: "Marquee", channelUrl: "https://www.marqueesportsnetwork.com",
  },
];

// NBA season has concluded — Knicks won the 2026 championship.
const NBA_SEASON_RESULT = {
  champion: "New York Knicks",
  runnerUp: "San Antonio Spurs",
  result: "Knicks won the Finals 4–1",
  note: "The Knicks beat the Spurs in 5 games to win their first championship in over 50 years. The NBA season is now over — next season tips off in October.",
};

// All other games today — the full slate, shown condensed in grey.
const OTHER_GAMES = [
  { id: "o-mlb-nyy-cin", league: "MLB", away: "Cincinnati Reds", home: "New York Yankees", time: "12:35 PM CT", day: "Today", city: "New York", verdict: 2, channel: "MLB.tv", channelUrl: "https://www.mlb.com/tv", note: "Sunday afternoon interleague matchup." },
  { id: "o-mlb-atl-mil", league: "MLB", away: "Milwaukee Brewers", home: "Atlanta Braves", time: "12:35 PM CT", day: "Today", city: "Atlanta", verdict: 2, channel: "MLB.tv", channelUrl: "https://www.mlb.com/tv", note: "NL contenders in a low-stakes June series finale." },
  { id: "o-mlb-mia-sf", league: "MLB", away: "San Francisco Giants", home: "Miami Marlins", time: "12:40 PM CT", day: "Today", city: "Miami", verdict: 2, channel: "MLB.tv", channelUrl: "https://www.mlb.com/tv", note: "NL series finale." },
  { id: "o-mlb-tb-wsh", league: "MLB", away: "Washington Nationals", home: "Tampa Bay Rays", time: "12:40 PM CT", day: "Today", city: "Tampa", verdict: 2, channel: "MLB.tv", channelUrl: "https://www.mlb.com/tv", note: "Interleague matchup." },
  { id: "o-mlb-det-cws", league: "MLB", away: "Chicago White Sox", home: "Detroit Tigers", time: "12:40 PM CT", day: "Today", city: "Detroit", verdict: 2, channel: "MLB.tv", channelUrl: "https://www.mlb.com/tv", note: "AL Central series finale." },
  { id: "o-mlb-hou-cle", league: "MLB", away: "Cleveland Guardians", home: "Houston Astros", time: "1:10 PM CT", day: "Today", city: "Houston", verdict: 2, channel: "MLB.tv", channelUrl: "https://www.mlb.com/tv", note: "AL series finale." },
  { id: "o-mlb-kc-stl", league: "MLB", away: "St. Louis Cardinals", home: "Kansas City Royals", time: "1:10 PM CT", day: "Today", city: "Kansas City", verdict: 2, channel: "MLB.tv", channelUrl: "https://www.mlb.com/tv", note: "I-70 rivalry series finale." },
  { id: "o-mlb-tex-sd", league: "MLB", away: "San Diego Padres", home: "Texas Rangers", time: "1:35 PM CT", day: "Today", city: "Arlington", verdict: 2, channel: "MLB.tv", channelUrl: "https://www.mlb.com/tv", note: "Interleague series finale." },
  { id: "o-mlb-col-pit", league: "MLB", away: "Pittsburgh Pirates", home: "Colorado Rockies", time: "2:10 PM CT", day: "Today", city: "Denver", verdict: 2, channel: "MLB.tv", channelUrl: "https://www.mlb.com/tv", note: "Coors Field — usually high-scoring." },
  { id: "o-mlb-az-min", league: "MLB", away: "Minnesota Twins", home: "Arizona Diamondbacks", time: "2:15 PM CT", day: "Today", city: "Phoenix", verdict: 2, channel: "MLB.tv", channelUrl: "https://www.mlb.com/tv", note: "Interleague series finale." },
  { id: "o-mlb-ath-laa", league: "MLB", away: "LA Angels", home: "Athletics", time: "3:05 PM CT", day: "Today", city: "Sacramento", verdict: 2, channel: "MLB.tv", channelUrl: "https://www.mlb.com/tv", note: "AL West series finale." },
  { id: "o-mlb-sea-bos", league: "MLB", away: "Boston Red Sox", home: "Seattle Mariners", time: "3:10 PM CT", day: "Today", city: "Seattle", verdict: 2, channel: "MLB.tv", channelUrl: "https://www.mlb.com/tv", note: "Interleague series finale." },
  { id: "o-mlb-phi-nym", league: "MLB", away: "New York Mets", home: "Philadelphia Phillies", time: "6:20 PM CT", day: "Today", city: "Philadelphia", verdict: 3, channel: "ESPN", channelUrl: "https://www.espn.com/watch/", note: "NL East rivalry on Sunday Night Baseball." },
];

// Condensed full slate per calendar day — every other game so nothing's missing.
const DAY_OTHER_GAMES = {
  "2026-06-21": [
    { league: "MLB", away: "Cincinnati Reds", home: "New York Yankees", time: "12:35 PM CT" },
    { league: "MLB", away: "Milwaukee Brewers", home: "Atlanta Braves", time: "12:35 PM CT" },
    { league: "MLB", away: "San Francisco Giants", home: "Miami Marlins", time: "12:40 PM CT" },
    { league: "MLB", away: "Washington Nationals", home: "Tampa Bay Rays", time: "12:40 PM CT" },
    { league: "MLB", away: "Chicago White Sox", home: "Detroit Tigers", time: "12:40 PM CT" },
    { league: "MLB", away: "Cleveland Guardians", home: "Houston Astros", time: "1:10 PM CT" },
    { league: "MLB", away: "St. Louis Cardinals", home: "Kansas City Royals", time: "1:10 PM CT" },
    { league: "MLB", away: "San Diego Padres", home: "Texas Rangers", time: "1:35 PM CT" },
    { league: "MLB", away: "Pittsburgh Pirates", home: "Colorado Rockies", time: "2:10 PM CT" },
    { league: "MLB", away: "Minnesota Twins", home: "Arizona Diamondbacks", time: "2:15 PM CT" },
    { league: "MLB", away: "LA Angels", home: "Athletics", time: "3:05 PM CT" },
    { league: "MLB", away: "Boston Red Sox", home: "Seattle Mariners", time: "3:10 PM CT" },
  ],
  "2026-06-22": [
    { league: "WNBA", away: "Chicago Sky", home: "Connecticut Sun", time: "6:00 PM CT" },
    { league: "WNBA", away: "Toronto Tempo", home: "Atlanta Dream", time: "6:30 PM CT" },
    { league: "MLB", away: "New York Yankees", home: "Detroit Tigers", time: "5:10 PM CT" },
    { league: "MLB", away: "Texas Rangers", home: "Miami Marlins", time: "5:40 PM CT" },
  ],
  "2026-06-23": [
    { league: "WC", away: "Algeria", home: "Jordan", time: "10:00 PM CT" },
    { league: "MLB", away: "Houston Astros", home: "Toronto Blue Jays", time: "3:07 PM CT" },
    { league: "MLB", away: "Seattle Mariners", home: "Pittsburgh Pirates", time: "5:40 PM CT" },
  ],
  "2026-06-24": [
    { league: "WNBA", away: "Phoenix Mercury", home: "Indiana Fever", time: "6:30 PM CT" },
    { league: "WNBA", away: "Minnesota Lynx", home: "Washington Mystics", time: "6:30 PM CT" },
  ],
  "2026-06-25": [
    { league: "WC", away: "Uzbekistan", home: "Portugal", time: "12:00 PM CT" },
    { league: "WNBA", away: "Portland Fire", home: "Chicago Sky", time: "7:00 PM CT" },
  ],
};

const CAL_EVENTS = {
  "2026-06-17": [
    { league: "WNBA", away: "Indiana Fever", home: "Las Vegas Aces", time: "9:00 PM CT", verdict: 4, channel: "ESPN", note: "Clark vs. the Aces' star core — a marquee national-TV matchup." },
  ],
  "2026-06-18": [
    { league: "WC",   away: "Canada", home: "Qatar", time: "5:00 PM CT", verdict: 2, channel: "Fox Sports", note: "World Cup group stage — host nation Canada in action." },
    { league: "WNBA", away: "Atlanta Dream", home: "Indiana Fever", time: "6:30 PM CT", verdict: 4, channel: "ESPN", note: "Fever fall in a tight one — Clark and company on national TV." },
  ],
  "2026-06-19": [
    { league: "WC",   away: "Australia", home: "USA", time: "2:00 PM CT", verdict: 5, channel: "Fox Sports", note: "USA opens at home in the World Cup — a huge national moment." },
    { league: "WC",   away: "Morocco", home: "Scotland", time: "5:00 PM CT", verdict: 3, channel: "Fox Sports", note: "Group stage action." },
    { league: "WNBA", away: "Toronto Tempo", home: "Connecticut Sun", time: "6:30 PM CT", verdict: 2, channel: "League Pass", note: "Two rebuilding teams." },
    { league: "WNBA", away: "Washington Mystics", home: "New York Liberty", time: "6:30 PM CT", verdict: 3, channel: "ESPN2", note: "Liberty stay hot at home." },
  ],
  "2026-06-20": [
    { league: "WC",   away: "Sweden", home: "Netherlands", time: "12:00 PM CT", verdict: 3, channel: "Fox Sports", note: "Netherlands roll 5-1 in group play." },
    { league: "WC",   away: "Ivory Coast", home: "Germany", time: "3:00 PM CT", verdict: 4, channel: "Fox Sports", note: "Germany survive a scare from Ivory Coast." },
    { league: "WNBA", away: "Indiana Fever", home: "Atlanta Dream", time: "12:00 PM CT", verdict: 4, channel: "ABC", note: "Sunday national TV window — Fever on the road." },
    { league: "WNBA", away: "Seattle Storm", home: "Phoenix Mercury", time: "2:00 PM CT", verdict: 2, channel: "League Pass", note: "Mercury handle Seattle at home." },
    { league: "MLB",  away: "Chicago Sky", home: "Dallas Wings", time: "7:00 PM CT", verdict: 3, channel: "League Pass", note: "Tight one — Wings edge Chicago." },
  ],
  "2026-06-21": [
    { league: "WNBA", away: "Golden State Valkyries", home: "Las Vegas Aces", time: "3:00 PM CT", verdict: 4, channel: "League Pass", note: "Aces host the WNBA's newest franchise — a fun Sunday matchup." },
    { league: "WNBA", away: "Washington Mystics", home: "Minnesota Lynx", time: "5:00 PM CT", verdict: 2, channel: "League Pass", note: "Lynx are one of the league's best — expect a lopsided game." },
    { league: "WNBA", away: "New York Liberty", home: "LA Sparks", time: "7:00 PM CT", verdict: 4, channel: "ESPN2", note: "Liberty on the road — championship-contender basketball." },
    { league: "WC",   away: "Saudi Arabia", home: "Spain", time: "11:00 AM CT", verdict: 4, channel: "Fox Sports", note: "Spain is one of the tournament's strongest sides." },
    { league: "WC",   away: "Iran", home: "Belgium", time: "2:00 PM CT", verdict: 5, channel: "Fox Sports", note: "World Cup group stage — Belgium favored, live now in the US." },
    { league: "WC",   away: "Cape Verde", home: "Uruguay", time: "5:00 PM CT", verdict: 3, channel: "Fox Sports", note: "Cape Verde is this World Cup's great underdog story." },
  ],
  "2026-06-22": [
    { league: "WC",   away: "Austria", home: "Argentina", time: "1:00 PM CT", verdict: 5, channel: "Fox", note: "Defending champions Argentina, with Messi, in group play. Big draw." },
    { league: "WC",   away: "Iraq", home: "France", time: "5:00 PM CT", verdict: 4, channel: "Fox", note: "France are heavy favorites and a tournament contender." },
    { league: "WC",   away: "Senegal", home: "Norway", time: "8:00 PM CT", verdict: 3, channel: "Fox", note: "Group I clash with knockout-round implications." },
    { league: "WC",   away: "Algeria", home: "Jordan", time: "11:00 PM CT", verdict: 2, channel: "FS1", note: "Late group-stage game." },
  ],
  "2026-06-23": [
    { league: "WC",   away: "Uzbekistan", home: "Portugal", time: "1:00 PM CT", verdict: 4, channel: "Fox", note: "Portugal — one of the tournament favorites — in group play." },
    { league: "WC",   away: "Ghana", home: "England", time: "4:00 PM CT", verdict: 4, channel: "FS1", note: "England, a top contender, faces Ghana." },
    { league: "WC",   away: "Croatia", home: "Panama", time: "7:00 PM CT", verdict: 3, channel: "Fox", note: "Croatia, 2018 finalists, in group action." },
    { league: "WC",   away: "DR Congo", home: "Colombia", time: "10:00 PM CT", verdict: 3, channel: "FS1", note: "Colombia favored in a Group K matchup." },
  ],
  "2026-06-24": [
    { league: "WC",   away: "Scotland", home: "Brazil", time: "6:00 PM CT", verdict: 5, channel: "Fox", note: "Brazil — five-time champions — are must-watch any time they play." },
    { league: "WC",   away: "Czechia", home: "Mexico", time: "9:00 PM CT", verdict: 4, channel: "Fox", note: "Co-hosts Mexico in a big group-stage finale at home." },
  ],
  "2026-06-25": [
    { league: "WC",   away: "Ecuador", home: "Germany", time: "4:00 PM CT", verdict: 4, channel: "Fox", note: "Germany, four-time champions, in a group-stage decider." },
    { league: "WC",   away: "Turkiye", home: "USA", time: "10:00 PM CT", verdict: 5, channel: "Fox", note: "🇺🇸 USA's final group game — host nation, huge national interest." },
  ],
};

// Season-context used by the AI rundown and the Sports 101 tab
const SEASON_CONTEXT = {
  WNBA: { phase: "Regular Season", pct: 32, detail: "Mid-season — 44-game schedule running May through September. Playoffs (8 teams) begin mid-September." },
  NBA:  { phase: "Off-season", pct: 0, detail: "The Knicks won the 2026 championship, beating the Spurs 4–1. The season is over — next season tips off in October." },
  MLB:  { phase: "Regular Season", pct: 44, detail: "Mid-season of a 162-game grind. Standings tighten in August; playoffs start in October." },
  NFL:  { phase: "Off-season", pct: 0, detail: "Nothing live yet. Preseason starts in August, regular season September 10." },
  WC:   { phase: "Group Stage", pct: 25, detail: "The 2026 World Cup is underway across the US, Mexico, and Canada — 48 teams competing. Knockout rounds begin in early July." },
};

// Sport emoji per league — used on headlines everywhere
const SPORT_EMOJI = { WNBA: "🏀", NBA: "🏀", MLB: "⚾", NFL: "🏈", NHL: "🏒", MLS: "⚽", WC: "⚽" };

// Team color accents for logo badges (monogram discs). Keyed by full team name.
const TEAM_COLORS = {
  "Indiana Fever": "#E03A3E", "Chicago Sky": "#5091CD", "New York Liberty": "#6ECEB2",
  "Atlanta Dream": "#E31837", "Las Vegas Aces": "#000000", "Seattle Storm": "#2C5234",
  "Minnesota Lynx": "#236192", "Connecticut Sun": "#E03A3E", "Phoenix Mercury": "#E56020",
  "Dallas Wings": "#0C2340", "Los Angeles Sparks": "#552583", "Golden State Valkyries": "#5A2D81",
  "Washington Mystics": "#0C2340", "Toronto Tempo": "#C8102E", "Portland Fire": "#D93A2B",
  "San Antonio Spurs": "#000000", "New York Knicks": "#006BB6", "Oklahoma City Thunder": "#007AC1",
  "Cleveland Cavaliers": "#860038", "Boston Celtics": "#007A33",
  "LA Dodgers": "#005A9C", "Los Angeles Dodgers": "#005A9C", "NY Yankees": "#003087", "New York Yankees": "#003087",
  "Kansas City Royals": "#004687", "Chicago Cubs": "#0E3386", "Chicago White Sox": "#27251F",
  "Colorado Rockies": "#333366", "Toronto Blue Jays": "#134A8E", "Houston Astros": "#EB6E1F",
  "Kansas City Chiefs": "#E31837", "Chicago Bears": "#0B162A",
};
const teamColor = name => TEAM_COLORS[name] || "#64748B";
const teamAbbr = name => {
  // crude 2-3 letter monogram from team's last word(s)
  const words = name.split(" ");
  const last = words[words.length - 1];
  return last.slice(0, 3).toUpperCase();
};

// Sports 101 external reading links per league
const SPORT_101_LINKS = {
  WNBA: { label: "WNBA.com — official site", url: "https://www.wnba.com" },
  NBA:  { label: "NBA.com — playoffs hub", url: "https://www.nba.com/playoffs" },
  MLB:  { label: "MLB.com — standings & schedule", url: "https://www.mlb.com" },
  NFL:  { label: "NFL.com — official site", url: "https://www.nfl.com" },
};

// NBA Finals bracket — the road to the 2026 title
const NBA_BRACKET = {
  rounds: [
    {
      name: "Conference Finals",
      series: [
        { conf: "West", teamA: "San Antonio Spurs", teamB: "Oklahoma City Thunder", scoreA: 4, scoreB: 3, winner: "A", done: true },
        { conf: "East", teamA: "New York Knicks", teamB: "Cleveland Cavaliers", scoreA: 4, scoreB: 0, winner: "A", done: true },
      ],
    },
    {
      name: "NBA Finals — Final",
      series: [
        { conf: "Championship", teamA: "New York Knicks", teamB: "San Antonio Spurs", scoreA: 4, scoreB: 1, winner: "A", done: true },
      ],
    },
  ],
};

// Standings for every league. `playoffCut` = how many teams make the playoffs (for the cut line).
// `status` set when a league isn't in active play, which renders a status card instead of a table.
const STANDINGS = {
  WNBA: {
    emoji: "🏀", label: "WNBA Playoff Picture", playoffCut: 8,
    blurb: "The top 8 teams make the playoffs — seeded by record across the whole league, not by conference. The dashed line marks the cut.",
    cols: ["W–L", "STRK"],
    rows: [
      { rank: 1,  team: "Las Vegas Aces",         conf: "W", w: 9, l: 2,  streak: "W4" },
      { rank: 2,  team: "New York Liberty",       conf: "E", w: 9, l: 3,  streak: "W2" },
      { rank: 3,  team: "Minnesota Lynx",         conf: "W", w: 8, l: 3,  streak: "W1" },
      { rank: 4,  team: "Indiana Fever",          conf: "E", w: 8, l: 4,  streak: "W3" },
      { rank: 5,  team: "Seattle Storm",          conf: "W", w: 7, l: 4,  streak: "L1" },
      { rank: 6,  team: "Connecticut Sun",        conf: "E", w: 6, l: 5,  streak: "W1" },
      { rank: 7,  team: "Phoenix Mercury",        conf: "W", w: 6, l: 6,  streak: "L2" },
      { rank: 8,  team: "Atlanta Dream",          conf: "E", w: 5, l: 6,  streak: "W1" },
      { rank: 9,  team: "Chicago Sky",            conf: "E", w: 5, l: 7,  streak: "L1" },
      { rank: 10, team: "Golden State Valkyries", conf: "W", w: 4, l: 7,  streak: "L3" },
      { rank: 11, team: "Los Angeles Sparks",     conf: "W", w: 4, l: 8,  streak: "W1" },
      { rank: 12, team: "Dallas Wings",           conf: "W", w: 3, l: 8,  streak: "L2" },
      { rank: 13, team: "Washington Mystics",     conf: "E", w: 3, l: 9,  streak: "L1" },
      { rank: 14, team: "Toronto Tempo",          conf: "E", w: 2, l: 9,  streak: "L4" },
      { rank: 15, team: "Portland Fire",          conf: "W", w: 2, l: 10, streak: "L2" },
    ],
  },
  NBA: {
    emoji: "🏀", label: "NBA — Season Complete", bracket: true,
    blurb: "The 2026 NBA season has ended. Here's the road to the title — each playoff series was best-of-7, first to 4 wins. Next season begins in October.",
  },
  MLB: {
    emoji: "⚾", label: "MLB Standings", playoffCut: 6, splitLabel: true,
    blurb: "Mid-season. Each league (American & National) sends its 3 division winners plus 3 wild-card teams — 6 per side — to October. Shown here: the National League race.",
    cols: ["W–L", "GB"],
    rows: [
      { rank: 1, team: "Los Angeles Dodgers", conf: "W", w: 44, l: 24, gb: "—" },
      { rank: 2, team: "Philadelphia Phillies", conf: "E", w: 42, l: 27, gb: "2.5" },
      { rank: 3, team: "Chicago Cubs",         conf: "C", w: 40, l: 28, gb: "4.0" },
      { rank: 4, team: "San Diego Padres",     conf: "W", w: 39, l: 29, gb: "5.0" },
      { rank: 5, team: "New York Mets",        conf: "E", w: 38, l: 30, gb: "6.0" },
      { rank: 6, team: "Milwaukee Brewers",    conf: "C", w: 37, l: 31, gb: "7.0" },
      { rank: 7, team: "Atlanta Braves",       conf: "E", w: 35, l: 33, gb: "9.0" },
      { rank: 8, team: "San Francisco Giants", conf: "W", w: 34, l: 34, gb: "10.0" },
      { rank: 9, team: "St. Louis Cardinals",  conf: "C", w: 33, l: 35, gb: "11.0" },
      { rank: 10, team: "Cincinnati Reds",     conf: "C", w: 31, l: 37, gb: "13.0" },
      { rank: 11, team: "Arizona Diamondbacks", conf: "W", w: 30, l: 38, gb: "14.0" },
      { rank: 12, team: "Pittsburgh Pirates",  conf: "C", w: 29, l: 39, gb: "15.0" },
      { rank: 13, team: "Washington Nationals", conf: "E", w: 28, l: 40, gb: "16.0" },
      { rank: 14, team: "Miami Marlins",       conf: "E", w: 26, l: 42, gb: "18.0" },
      { rank: 15, team: "Colorado Rockies",    conf: "W", w: 22, l: 46, gb: "22.0" },
    ],
  },
  NFL: {
    emoji: "🏈", label: "NFL", status: "Off-season",
    blurb: "The NFL isn't playing yet. Preseason kicks off in August; the regular season opens September 10. Standings reset to 0–0 for all 32 teams when the season starts.",
    next: "Regular season opener · September 10",
  },
  NHL: {
    emoji: "🏒", label: "NHL", status: "Off-season",
    blurb: "The NHL season just ended — the Stanley Cup was awarded in June. The next season begins in October, with training camps and preseason in September.",
    next: "2026–27 season begins · October",
  },
  MLS: {
    emoji: "⚽", label: "MLS Standings", playoffCut: 9, splitLabel: true, midSeason: true,
    blurb: "MLS is mid-season. The top 9 teams in each conference make the playoffs. Shown here: the Eastern Conference race.",
    cols: ["PTS", "PLAYED"],
    rows: [
      { rank: 1, team: "FC Cincinnati",      conf: "E", pts: 38, played: 18 },
      { rank: 2, team: "Inter Miami",        conf: "E", pts: 36, played: 18 },
      { rank: 3, team: "Columbus Crew",      conf: "E", pts: 33, played: 17 },
      { rank: 4, team: "Charlotte FC",       conf: "E", pts: 31, played: 18 },
      { rank: 5, team: "Orlando City",       conf: "E", pts: 29, played: 17 },
      { rank: 6, team: "Philadelphia Union", conf: "E", pts: 28, played: 18 },
      { rank: 7, team: "NYCFC",              conf: "E", pts: 27, played: 17 },
      { rank: 8, team: "Nashville SC",       conf: "E", pts: 25, played: 18 },
      { rank: 9, team: "Atlanta United",     conf: "E", pts: 23, played: 17 },
      { rank: 10, team: "Chicago Fire",      conf: "E", pts: 21, played: 18 },
      { rank: 11, team: "Toronto FC",        conf: "E", pts: 18, played: 17 },
      { rank: 12, team: "New York Red Bulls", conf: "E", pts: 17, played: 18 },
      { rank: 13, team: "CF Montréal",       conf: "E", pts: 15, played: 17 },
      { rank: 14, team: "DC United",         conf: "E", pts: 13, played: 18 },
      { rank: 15, team: "New England Revolution", conf: "E", pts: 11, played: 17 },
    ],
  },
  WC: {
    emoji: "⚽", label: "World Cup — Group Stage", status: "Group Stage",
    blurb: "The 2026 FIFA World Cup is happening right now, hosted across the US, Mexico, and Canada — 48 teams in 12 groups. Win the group (or finish well) and advance to the knockout rounds.",
    next: "Knockout rounds begin in early July",
  },
};

// Players per league. Each league has a coach list, marquee "stars" (with deep info),
// and a wider roster of role players shown after filtering by team.
const PLAYERS = {
  WNBA: {
    stars: [
      { name: "Caitlin Clark", team: "Indiana Fever", pos: "Guard", debut: 2024, note: "The biggest name in the sport. A deep-range shooter and electric passer who's brought millions of new fans to the WNBA.",
        stats: [["PPG", "19.2"], ["APG", "8.4"], ["3PM/G", "3.1"]],
        facts: ["NCAA all-time leading scorer (men's or women's) before turning pro.", "2024 WNBA Rookie of the Year.", "Set the WNBA single-season assist record as a rookie."],
        link: "https://en.wikipedia.org/wiki/Caitlin_Clark" },
      { name: "A'ja Wilson", team: "Las Vegas Aces", pos: "Forward", debut: 2018, note: "The league's most dominant all-around player and a multiple-time MVP. The gold standard at her position.",
        stats: [["PPG", "26.9"], ["RPG", "11.9"], ["BPG", "2.6"]],
        facts: ["Multiple-time WNBA MVP and champion.", "Set the WNBA single-season scoring record in 2024.", "Olympic gold medalist with Team USA."],
        link: "https://en.wikipedia.org/wiki/A%27ja_Wilson" },
      { name: "Breanna Stewart", team: "New York Liberty", pos: "Forward", debut: 2016, note: "A former MVP and champion, the centerpiece of a stacked Liberty title contender.",
        stats: [["PPG", "20.4"], ["RPG", "8.5"], ["APG", "3.8"]],
        facts: ["Won 4 straight NCAA titles at UConn.", "Two-time WNBA champion and two-time Finals MVP.", "Olympic gold medalist."],
        link: "https://en.wikipedia.org/wiki/Breanna_Stewart" },
      { name: "Angel Reese", team: "Chicago Sky", pos: "Forward", debut: 2024, note: "A rebounding machine and one of the league's most magnetic personalities — Clark's college rival turned pro rival.",
        stats: [["PPG", "13.6"], ["RPG", "13.1"], ["APG", "1.9"]],
        facts: ["Set a WNBA record with consecutive double-doubles as a rookie.", "Won an NCAA title at LSU in 2023.", "Known as 'the Bayou Barbie.'"],
        link: "https://en.wikipedia.org/wiki/Angel_Reese" },
      { name: "Paige Bueckers", team: "Dallas Wings", pos: "Guard", debut: 2025, note: "A polished young star carrying the rebuild in Dallas. One of the most skilled guards in the league.",
        stats: [["PPG", "18.5"], ["APG", "5.4"], ["FG%", "47.8"]],
        facts: ["No. 1 overall pick in the 2025 WNBA Draft.", "Won an NCAA championship at UConn.", "First freshman to win national player of the year."],
        link: "https://en.wikipedia.org/wiki/Paige_Bueckers" },
    ],
    roster: [
      { name: "Kelsey Mitchell", team: "Indiana Fever", pos: "Guard" },
      { name: "Aliyah Boston", team: "Indiana Fever", pos: "Center" },
      { name: "Jackie Young", team: "Las Vegas Aces", pos: "Guard" },
      { name: "Chelsea Gray", team: "Las Vegas Aces", pos: "Guard" },
      { name: "Sabrina Ionescu", team: "New York Liberty", pos: "Guard" },
      { name: "Jonquel Jones", team: "New York Liberty", pos: "Center" },
      { name: "Ariel Atkins", team: "Chicago Sky", pos: "Guard" },
      { name: "Arike Ogunbowale", team: "Dallas Wings", pos: "Guard" },
    ],
    coaches: [
      { name: "Stephanie White", team: "Indiana Fever", role: "Head Coach" },
      { name: "Becky Hammon", team: "Las Vegas Aces", role: "Head Coach" },
      { name: "Sandy Brondello", team: "New York Liberty", role: "Head Coach" },
      { name: "Tyler Marsh", team: "Chicago Sky", role: "Head Coach" },
      { name: "Chris Koclanes", team: "Dallas Wings", role: "Head Coach" },
    ],
  },
  NBA: {
    stars: [
      { name: "Victor Wembanyama", team: "San Antonio Spurs", pos: "Center", debut: 2023, note: "A 7'4\" once-in-a-generation talent who scores, passes, and blocks shots at a historic rate. The face of the Finals.",
        stats: [["PPG", "24.3"], ["RPG", "11.0"], ["BPG", "3.8"]],
        facts: ["No. 1 overall pick in 2023.", "2024 Rookie of the Year.", "Already among the best shot-blockers in NBA history."],
        link: "https://en.wikipedia.org/wiki/Victor_Wembanyama" },
      { name: "Jalen Brunson", team: "New York Knicks", pos: "Guard", debut: 2018, note: "The Knicks' clutch engine — a crafty scorer who's carried New York's championship run.",
        stats: [["PPG", "28.7"], ["APG", "7.3"], ["FG%", "48.1"]],
        facts: ["Won two NCAA titles at Villanova.", "Named to the All-NBA team.", "Son of former NBA player Rick Brunson."],
        link: "https://en.wikipedia.org/wiki/Jalen_Brunson" },
      { name: "Shai Gilgeous-Alexander", team: "Oklahoma City Thunder", pos: "Guard", debut: 2018, note: "A reigning MVP-caliber scorer whose Thunder pushed the Spurs to seven games in the West Finals.",
        stats: [["PPG", "32.7"], ["APG", "6.4"], ["SPG", "2.0"]],
        facts: ["Led the NBA in scoring.", "Canadian-born star and Olympic medalist.", "Known for an elite mid-range game."],
        link: "https://en.wikipedia.org/wiki/Shai_Gilgeous-Alexander" },
    ],
    roster: [
      { name: "Devin Vassell", team: "San Antonio Spurs", pos: "Guard" },
      { name: "Stephon Castle", team: "San Antonio Spurs", pos: "Guard" },
      { name: "Karl-Anthony Towns", team: "New York Knicks", pos: "Center" },
      { name: "Mikal Bridges", team: "New York Knicks", pos: "Forward" },
      { name: "Jalen Williams", team: "Oklahoma City Thunder", pos: "Forward" },
      { name: "Chet Holmgren", team: "Oklahoma City Thunder", pos: "Center" },
    ],
    coaches: [
      { name: "Mitch Johnson", team: "San Antonio Spurs", role: "Head Coach" },
      { name: "Tom Thibodeau", team: "New York Knicks", role: "Head Coach" },
      { name: "Mark Daigneault", team: "Oklahoma City Thunder", role: "Head Coach" },
    ],
  },
  MLB: {
    stars: [
      { name: "Shohei Ohtani", team: "LA Dodgers", pos: "DH / Pitcher", debut: 2018, note: "The most famous player in baseball — a global superstar who both hits home runs and pitches at an elite level. Nobody else does both.",
        stats: [["HR", "31"], ["AVG", ".302"], ["OPS", "1.012"]],
        facts: ["Multiple-time MVP in both leagues.", "First-ever 50 HR / 50 SB season in 2024.", "Signed the largest contract in sports history."],
        link: "https://en.wikipedia.org/wiki/Shohei_Ohtani" },
      { name: "Aaron Judge", team: "NY Yankees", pos: "Outfield", debut: 2016, note: "Baseball's premier power hitter. When he's at bat, a home run feels possible every swing.",
        stats: [["HR", "29"], ["AVG", ".322"], ["OPS", "1.084"]],
        facts: ["Set the AL single-season home run record with 62 in 2022.", "AL MVP.", "Yankees team captain."],
        link: "https://en.wikipedia.org/wiki/Aaron_Judge" },
      { name: "Bobby Witt Jr.", team: "Kansas City Royals", pos: "Shortstop", debut: 2022, note: "A dazzling young all-around talent — speed, power, and defense. The future of the sport.",
        stats: [["HR", "18"], ["AVG", ".310"], ["SB", "24"]],
        facts: ["Son of former MLB pitcher Bobby Witt.", "One of the fastest players in baseball.", "Signed a long-term deal with Kansas City."],
        link: "https://en.wikipedia.org/wiki/Bobby_Witt_Jr." },
    ],
    roster: [
      { name: "Mookie Betts", team: "LA Dodgers", pos: "Infield" },
      { name: "Freddie Freeman", team: "LA Dodgers", pos: "First Base" },
      { name: "Juan Soto", team: "NY Yankees", pos: "Outfield" },
      { name: "Gerrit Cole", team: "NY Yankees", pos: "Pitcher" },
      { name: "Vinnie Pasquantino", team: "Kansas City Royals", pos: "First Base" },
    ],
    coaches: [
      { name: "Dave Roberts", team: "LA Dodgers", role: "Manager" },
      { name: "Aaron Boone", team: "NY Yankees", role: "Manager" },
      { name: "Matt Quatraro", team: "Kansas City Royals", role: "Manager" },
    ],
  },
  NFL: {
    stars: [
      { name: "Patrick Mahomes", team: "Kansas City Chiefs", pos: "Quarterback", debut: 2017, note: "The best player in football and a multiple-time Super Bowl champion. Must-watch every Sunday in season.",
        stats: [["TD", "27"], ["YDS", "3,928"], ["RATING", "105.2"]],
        facts: ["Multiple-time Super Bowl MVP.", "Known for no-look passes and sidearm throws.", "Son of former MLB pitcher Pat Mahomes."],
        link: "https://en.wikipedia.org/wiki/Patrick_Mahomes" },
      { name: "Caleb Williams", team: "Chicago Bears", pos: "Quarterback", debut: 2024, note: "A dynamic young quarterback Chicago is building its future around.",
        stats: [["TD", "20"], ["YDS", "3,541"], ["RATING", "87.8"]],
        facts: ["No. 1 overall pick in 2024.", "Won the Heisman Trophy at USC.", "Known for improvising outside the pocket."],
        link: "https://en.wikipedia.org/wiki/Caleb_Williams" },
    ],
    roster: [
      { name: "Travis Kelce", team: "Kansas City Chiefs", pos: "Tight End" },
      { name: "Chris Jones", team: "Kansas City Chiefs", pos: "Defensive Tackle" },
      { name: "DJ Moore", team: "Chicago Bears", pos: "Wide Receiver" },
      { name: "Rome Odunze", team: "Chicago Bears", pos: "Wide Receiver" },
    ],
    coaches: [
      { name: "Andy Reid", team: "Kansas City Chiefs", role: "Head Coach" },
      { name: "Ben Johnson", team: "Chicago Bears", role: "Head Coach" },
    ],
  },
};

const STAR_TEAMS = {
  // 2026 WNBA — 15 teams. (E) Eastern, (W) Western conference.
  WNBA: [
    "Atlanta Dream","Chicago Sky","Connecticut Sun","Indiana Fever","New York Liberty","Toronto Tempo","Washington Mystics",
    "Dallas Wings","Golden State Valkyries","Las Vegas Aces","Los Angeles Sparks","Minnesota Lynx","Phoenix Mercury","Portland Fire","Seattle Storm",
  ],
  NBA:  [
    "Atlanta Hawks","Boston Celtics","Brooklyn Nets","Charlotte Hornets","Chicago Bulls","Cleveland Cavaliers","Dallas Mavericks","Denver Nuggets","Detroit Pistons","Golden State Warriors","Houston Rockets","Indiana Pacers","LA Clippers","LA Lakers","Memphis Grizzlies","Miami Heat","Milwaukee Bucks","Minnesota Timberwolves","New Orleans Pelicans","New York Knicks","Oklahoma City Thunder","Orlando Magic","Philadelphia 76ers","Phoenix Suns","Portland Trail Blazers","Sacramento Kings","San Antonio Spurs","Toronto Raptors","Utah Jazz","Washington Wizards",
  ],
  MLB:  [
    "Arizona Diamondbacks","Atlanta Braves","Baltimore Orioles","Boston Red Sox","Chicago Cubs","Chicago White Sox","Cincinnati Reds","Cleveland Guardians","Colorado Rockies","Detroit Tigers","Houston Astros","Kansas City Royals","LA Angels","LA Dodgers","Miami Marlins","Milwaukee Brewers","Minnesota Twins","NY Mets","NY Yankees","Oakland Athletics","Philadelphia Phillies","Pittsburgh Pirates","San Diego Padres","San Francisco Giants","Seattle Mariners","St. Louis Cardinals","Tampa Bay Rays","Texas Rangers","Toronto Blue Jays","Washington Nationals",
  ],
  NFL:  [
    "Arizona Cardinals","Atlanta Falcons","Baltimore Ravens","Buffalo Bills","Carolina Panthers","Chicago Bears","Cincinnati Bengals","Cleveland Browns","Dallas Cowboys","Denver Broncos","Detroit Lions","Green Bay Packers","Houston Texans","Indianapolis Colts","Jacksonville Jaguars","Kansas City Chiefs","Las Vegas Raiders","LA Chargers","LA Rams","Miami Dolphins","Minnesota Vikings","New England Patriots","New Orleans Saints","NY Giants","NY Jets","Philadelphia Eagles","Pittsburgh Steelers","San Francisco 49ers","Seattle Seahawks","Tampa Bay Buccaneers","Tennessee Titans","Washington Commanders",
  ],
  NHL:  [
    "Anaheim Ducks","Boston Bruins","Buffalo Sabres","Calgary Flames","Carolina Hurricanes","Chicago Blackhawks","Colorado Avalanche","Columbus Blue Jackets","Dallas Stars","Detroit Red Wings","Edmonton Oilers","Florida Panthers","LA Kings","Minnesota Wild","Montreal Canadiens","Nashville Predators","New Jersey Devils","NY Islanders","NY Rangers","Ottawa Senators","Philadelphia Flyers","Pittsburgh Penguins","San Jose Sharks","Seattle Kraken","St. Louis Blues","Tampa Bay Lightning","Toronto Maple Leafs","Utah Hockey Club","Vancouver Canucks","Vegas Golden Knights","Washington Capitals","Winnipeg Jets",
  ],
  MLS:  [
    "Atlanta United","Austin FC","Charlotte FC","Chicago Fire","FC Cincinnati","Colorado Rapids","Columbus Crew","DC United","FC Dallas","Houston Dynamo","Inter Miami","LA Galaxy","LAFC","Minnesota United","CF Montréal","Nashville SC","New England Revolution","New York City FC","New York Red Bulls","Orlando City","Philadelphia Union","Portland Timbers","Real Salt Lake","San Diego FC","San Jose Earthquakes","Seattle Sounders","Sporting Kansas City","St. Louis City","Toronto FC","Vancouver Whitecaps",
  ],
};

// WNBA conference map for the Sports 101 / future bracket features
const WNBA_CONFERENCES = {
  East: ["Atlanta Dream","Chicago Sky","Connecticut Sun","Indiana Fever","New York Liberty","Toronto Tempo","Washington Mystics"],
  West: ["Dallas Wings","Golden State Valkyries","Las Vegas Aces","Los Angeles Sparks","Minnesota Lynx","Phoenix Mercury","Portland Fire","Seattle Storm"],
};

const CITIES = ["Chicago","New York","Los Angeles","San Antonio","Indianapolis","Seattle","Denver","Toronto","Atlanta"];

/* ─── STORAGE ─────────────────────────────────────────────── */
const load = (k, fb) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : fb; } catch { return fb; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

/* ─── ATOMS ───────────────────────────────────────────────── */

function LeaguePill({ league, small }) {
  return (
    <span style={{
      display: "inline-block", background: LEAGUE_COLORS[league], color: "#fff",
      fontSize: small ? 9 : 10, fontWeight: 800, letterSpacing: "0.08em",
      padding: small ? "2px 6px" : "3px 8px", borderRadius: 3,
    }}>{league}</span>
  );
}

// Team logo badge — colored disc with the team's monogram. Always renders, no broken images.
function TeamLogo({ team, size = 26 }) {
  const c = teamColor(team);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      background: c, color: "#fff", fontSize: size * 0.34, fontWeight: 900,
      letterSpacing: "0.02em", border: "1.5px solid rgba(255,255,255,0.25)",
      boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
    }}>{teamAbbr(team)}</span>
  );
}

function VerdictChip({ level }) {
  const v = VERDICT[level] || VERDICT[2];
  return (
    <span style={{
      display: "inline-block", background: v.bg, color: v.text,
      fontSize: 9, fontWeight: 800, letterSpacing: "0.1em",
      padding: "3px 8px", borderRadius: 3, textTransform: "uppercase",
    }}>{v.label}</span>
  );
}

function Toggle({ on, onChange }) {
  return (
    <div onClick={() => onChange(!on)} style={{
      width: 44, height: 26, borderRadius: 13, position: "relative", cursor: "pointer",
      background: on ? "#1F7A4D" : "#D4DAE0", transition: "background 0.2s", flexShrink: 0,
    }}>
      <div style={{
        position: "absolute", top: 3, left: on ? 21 : 3, width: 20, height: 20,
        borderRadius: "50%", background: "#fff", transition: "left 0.2s",
        boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
      }} />
    </div>
  );
}

// Watch options: shows the primary channel + a "see all" expander when there are several.
function WatchOptions({ game, color, big }) {
  const [open, setOpen] = useState(false);
  const all = game.watchAll || [{ name: game.channel, url: game.channelUrl }];
  const primary = all[0];
  const extra = all.slice(1);
  const pad = big ? "10px 18px" : "7px 14px";
  const fs = big ? 13 : 12;

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <a href={primary.url} target="_blank" rel="noopener noreferrer" style={{
        display: "inline-flex", alignItems: "center", gap: 6, background: color, color: "#fff",
        padding: pad, borderRadius: big ? 7 : 6, fontSize: fs, fontWeight: 700, textDecoration: "none",
      }}>▶ Watch on {primary.name}</a>

      {extra.length > 0 && !open && (
        <button onClick={() => setOpen(true)} style={{
          background: "transparent", color: color, border: `1px solid ${color}`,
          padding: pad, borderRadius: big ? 7 : 6, fontSize: fs, fontWeight: 700,
          cursor: "pointer", fontFamily: "inherit",
        }}>+{extra.length} more way{extra.length > 1 ? "s" : ""} to watch</button>
      )}

      {open && extra.map(o => (
        <a key={o.name} href={o.url} target="_blank" rel="noopener noreferrer" style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          background: C.lineSoft, color: C.inkMid, padding: pad,
          borderRadius: big ? 7 : 6, fontSize: fs, fontWeight: 600, textDecoration: "none",
        }}>▶ {o.name}</a>
      ))}
      {open && (
        <button onClick={() => setOpen(false)} style={{
          background: "none", border: "none", color: C.inkFaint, cursor: "pointer",
          fontSize: fs, fontWeight: 600, fontFamily: "inherit", padding: "0 4px",
        }}>show less</button>
      )}
    </div>
  );
}

/* ─── FILTER BAR ──────────────────────────────────────────── */

function FilterBar({ filters, setFilters }) {
  const [open, setOpen] = useState(false);
  const activeCount = Object.values(filters).filter(v => v !== "ALL").length;

  const sportOpts = ["ALL", ...Object.keys(LEAGUE_COLORS)];
  const teamOpts = filters.sport === "ALL"
    ? ["ALL"]
    : ["ALL", ...(STAR_TEAMS[filters.sport] || [])];
  const cityOpts = ["ALL", ...CITIES];

  const Row = ({ label, value, options, onPick, accent }) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.1em", color: C.inkFaint, marginBottom: 7 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2 }}>
        {options.map(o => {
          const active = value === o;
          return (
            <button key={o} onClick={() => onPick(o)} style={{
              flexShrink: 0, padding: "7px 14px", borderRadius: 18, cursor: "pointer",
              fontSize: 12, fontWeight: 700, fontFamily: "inherit",
              border: `1px solid ${active ? (accent || C.red) : C.line}`,
              background: active ? (accent || C.red) : C.surface,
              color: active ? "#fff" : C.inkMid,
              whiteSpace: "nowrap",
            }}>
              {o === "ALL" ? `All ${label}s` : o}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div style={{ marginBottom: 18 }}>
      <button onClick={() => setOpen(!open)} style={{
        display: "inline-flex", alignItems: "center", gap: 8,
        background: activeCount ? C.redSoft : C.surface,
        border: `1px solid ${activeCount ? C.red : C.line}`,
        borderRadius: 20, padding: "8px 16px", cursor: "pointer",
        fontSize: 13, fontWeight: 700, fontFamily: "inherit",
        color: activeCount ? C.red : C.inkMid,
      }}>
        <span>⚙ Filters</span>
        {activeCount > 0 && (
          <span style={{
            background: C.red, color: "#fff", borderRadius: "50%",
            width: 18, height: 18, fontSize: 10, fontWeight: 800,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>{activeCount}</span>
        )}
        <span style={{ fontSize: 11, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▾</span>
      </button>

      {open && (
        <div style={{
          marginTop: 12, background: C.surface, border: `1px solid ${C.line}`,
          borderRadius: 12, padding: "16px 16px 10px",
          boxShadow: "0 4px 16px rgba(20,32,43,0.06)",
        }}>
          <Row label="Sport" value={filters.sport} options={sportOpts}
            accent={filters.sport !== "ALL" ? LEAGUE_COLORS[filters.sport] : C.red}
            onPick={v => setFilters(f => ({ ...f, sport: v, team: "ALL" }))} />
          <Row label="Team" value={filters.team} options={teamOpts}
            accent="#1D5BBF"
            onPick={v => setFilters(f => ({ ...f, team: v }))} />
          <Row label="City" value={filters.city} options={cityOpts}
            accent="#1F7A4D"
            onPick={v => setFilters(f => ({ ...f, city: v }))} />
          {activeCount > 0 && (
            <button onClick={() => setFilters({ sport: "ALL", team: "ALL", city: "ALL" })} style={{
              background: "none", border: "none", cursor: "pointer", padding: 0,
              fontSize: 12, fontWeight: 700, color: C.inkFaint, fontFamily: "inherit",
            }}>✕ Clear all filters</button>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── HERO ────────────────────────────────────────────────── */

function HeroCard({ game, alertOn, onAlert }) {
  const lc = LEAGUE_COLORS[game.league];
  return (
    <div style={{
      background: C.surface, borderRadius: 14, overflow: "hidden", marginBottom: 22,
      border: `1px solid ${C.line}`, boxShadow: "0 6px 24px rgba(20,32,43,0.08)",
    }}>
      <div style={{ background: lc, padding: "10px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: "#fff", letterSpacing: "0.14em" }}>★ EDITOR'S PICK</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.9)" }}>{game.day} · {game.time}</span>
      </div>
      <div style={{ padding: "22px 20px 24px" }}>
        <div style={{ fontSize: 28, fontWeight: 900, color: C.ink, lineHeight: 1.1, letterSpacing: "-0.02em", marginBottom: 6 }}>
          {game.away}<span style={{ fontSize: 17, color: C.inkFaint, fontWeight: 400, margin: "0 10px" }}>at</span>{game.home}
        </div>
        <div style={{ fontSize: 14, color: lc, fontWeight: 800, marginBottom: 14 }}>{SPORT_EMOJI[game.league]} {game.tagline}</div>
        <div style={{ marginBottom: 14 }}><VerdictChip level={game.verdict} /></div>
        <p style={{ fontSize: 14, color: C.inkMid, lineHeight: 1.6, margin: "0 0 20px", maxWidth: 500 }}>{game.summary}</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <WatchOptions game={game} color={lc} big />
          <button onClick={() => onAlert(game.id)} style={{
            display: "inline-flex", alignItems: "center", gap: 7,
            background: alertOn ? C.redSoft : C.surface,
            color: alertOn ? C.red : C.inkDim,
            border: `1px solid ${alertOn ? C.red : C.line}`,
            padding: "10px 16px", borderRadius: 7, cursor: "pointer",
            fontSize: 13, fontWeight: 700, fontFamily: "inherit",
          }}>{alertOn ? "🔔 Alert set" : "🔕 Remind me"}</button>
        </div>
      </div>
    </div>
  );
}

/* ─── GAME CARD ───────────────────────────────────────────── */

function GameCard({ game, alertOn, onAlert }) {
  const lc = LEAGUE_COLORS[game.league];
  const isLive = game.status === "live";
  return (
    <div style={{
      display: "flex", background: C.surface, borderRadius: 11, overflow: "hidden", marginBottom: 11,
      border: `1px solid ${isLive ? "#C8102E40" : C.line}`,
      boxShadow: "0 2px 8px rgba(20,32,43,0.04)",
    }}>
      <div style={{ width: 5, background: lc, flexShrink: 0 }} />
      <div style={{ flex: 1, padding: "14px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9, flexWrap: "wrap" }}>
          <LeaguePill league={game.league} />
          {isLive ? (
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.red, animation: "pulse 1.4s infinite" }} />
              <span style={{ fontSize: 11, fontWeight: 800, color: C.red, letterSpacing: "0.06em" }}>LIVE · {game.clock}</span>
            </span>
          ) : (
            <span style={{ fontSize: 11, color: C.inkDim, fontWeight: 600 }}>{game.day} · {game.time}</span>
          )}
          {game.seriesLine && <span style={{ fontSize: 11, color: lc, fontWeight: 700 }}>{game.seriesLine}</span>}
          <span style={{ marginLeft: "auto" }}><VerdictChip level={game.verdict} /></span>
        </div>

        {isLive && game.score ? (
          <div style={{ fontSize: 20, fontWeight: 900, color: C.ink, marginBottom: 4 }}>
            {game.homeAbbr} <span style={{ color: C.red }}>{game.score[game.homeAbbr]}</span>
            <span style={{ color: C.inkFaint, margin: "0 8px" }}>—</span>
            <span style={{ color: C.red }}>{game.score[game.awayAbbr]}</span> {game.awayAbbr}
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <TeamLogo team={game.away} size={24} />
              <span style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>{game.away}</span>
            </span>
            <span style={{ color: C.inkFaint, fontSize: 13, fontWeight: 400 }}>at</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <TeamLogo team={game.home} size={24} />
              <span style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>{game.home}</span>
            </span>
          </div>
        )}

        <div style={{ fontSize: 13, color: lc, fontWeight: 700, marginBottom: 6 }}>{SPORT_EMOJI[game.league]} {game.tagline}</div>
        <p style={{ fontSize: 13, color: C.inkDim, lineHeight: 1.55, margin: "0 0 12px" }}>{game.summary}</p>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <WatchOptions game={game} color={lc} />
          <button onClick={() => onAlert(game.id)} style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            background: alertOn ? C.redSoft : C.surface,
            color: alertOn ? C.red : C.inkDim,
            border: `1px solid ${alertOn ? C.red : C.line}`,
            padding: "7px 12px", borderRadius: 6, cursor: "pointer",
            fontSize: 12, fontWeight: 600, fontFamily: "inherit",
          }}>{alertOn ? "🔔 Alert set" : "🔕 Alert me"}</button>
        </div>
      </div>
    </div>
  );
}

/* ─── CALENDAR ────────────────────────────────────────────── */

function CalendarTab({ alerts, onAlert }) {
  const [view, setView] = useState("month");
  const today = todayKey();
  const [cursorMonth, setCursorMonth] = useState(() => today.slice(0, 7)); // "YYYY-MM", for month navigation
  const [selected, setSelected] = useState(today);
  const [calFilters, setCalFilters] = useState({ sport: "ALL" });

  const [cy, cm] = cursorMonth.split("-").map(Number);
  const monthDays = (() => {
    const days = [];
    const lead = firstWeekdayOfMonth(cy, cm);
    for (let i = 0; i < lead; i++) days.push(null);
    const total = daysInMonth(cy, cm);
    for (let d = 1; d <= total; d++) days.push(`${cy}-${String(cm).padStart(2,"0")}-${String(d).padStart(2,"0")}`);
    return days;
  })();

  // Filter calendar events by sport
  const filterEvents = evs => calFilters.sport === "ALL" ? evs : evs.filter(e => e.league === calFilters.sport);

  // Live schedule merged over curated highlights
  const { liveEvents, status: liveStatus, counts } = useLiveSchedule();
  const eventsFor = k => mergeDayEvents(k, liveEvents);

  const dayEvents = filterEvents(selected ? eventsFor(selected) : []);
  const selDayNum = selected ? dayNum(selected) : null;

  const topVerdict = k => {
    const evs = filterEvents(eventsFor(k));
    return evs.reduce((m, e) => Math.max(m, e.verdict), 0);
  };
  const dotColor = v => v >= 5 ? C.red : v === 4 ? "#E8590C" : v === 3 ? "#1D5BBF" : "#C2CAD2";

  return (
    <div>
      {liveStatus === "done" && (
        <div style={{
          display: "flex", alignItems: "center", gap: 6, marginBottom: 10,
          fontSize: 11, color: C.inkFaint, fontWeight: 600,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#21A35A", display: "inline-block", flexShrink: 0 }} />
          Live schedule connected
        </div>
      )}
      {/* Sport filter pills */}
      <div style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 14, paddingBottom: 2 }}>
        {["ALL", "WNBA", "NBA", "MLB", "WC", "NFL", "NHL", "MLS"].map(lg => (
          <button key={lg} onClick={() => setCalFilters(f => ({ ...f, sport: lg }))} style={{
            flexShrink: 0, padding: "6px 13px", borderRadius: 16, cursor: "pointer",
            background: calFilters.sport === lg ? (LEAGUE_COLORS[lg] || C.red) : C.surface,
            color: calFilters.sport === lg ? "#fff" : C.inkDim, fontSize: 12, fontWeight: 700,
            border: `1px solid ${calFilters.sport === lg ? (LEAGUE_COLORS[lg] || C.red) : C.line}`,
            fontFamily: "inherit",
          }}>{lg === "ALL" ? "All Sports" : `${SPORT_EMOJI[lg]} ${lg}`}</button>
        ))}
      </div>

      {/* view switch */}
      <div style={{ display: "flex", gap: 4, marginBottom: 18, background: C.lineSoft, borderRadius: 9, padding: 4 }}>
        {["week", "month"].map(v => (
          <button key={v} onClick={() => setView(v)} style={{
            flex: 1, padding: "9px 0", borderRadius: 6, border: "none", cursor: "pointer",
            background: view === v ? C.surface : "transparent",
            color: view === v ? C.ink : C.inkDim,
            fontSize: 13, fontWeight: 700, fontFamily: "inherit",
            boxShadow: view === v ? "0 1px 4px rgba(20,32,43,0.1)" : "none",
          }}>{v === "week" ? "This Week" : "This Month"}</button>
        ))}
      </div>

      {view === "month" && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <button onClick={() => {
              const prevMonth = addDays(`${cursorMonth}-01`, -1).slice(0, 7);
              setCursorMonth(prevMonth);
            }} style={{
              background: C.surface, border: `1px solid ${C.line}`, borderRadius: 8,
              width: 30, height: 30, cursor: "pointer", fontSize: 14, color: C.inkMid, fontFamily: "inherit",
            }}>‹</button>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flex: 1 }}>
              <span style={{ fontSize: 22, fontWeight: 900, color: C.ink, letterSpacing: "-0.01em" }}>{monthName(`${cursorMonth}-01`)}</span>
              <span style={{ fontSize: 15, color: C.inkFaint, fontWeight: 600 }}>{cy}</span>
            </div>
            <button onClick={() => {
              const nextMonth = addDays(`${cursorMonth}-01`, 32).slice(0, 7);
              setCursorMonth(nextMonth);
            }} style={{
              background: C.surface, border: `1px solid ${C.line}`, borderRadius: 8,
              width: 30, height: 30, cursor: "pointer", fontSize: 14, color: C.inkMid, fontFamily: "inherit",
            }}>›</button>
            {cursorMonth !== today.slice(0,7) && (
              <button onClick={() => { setCursorMonth(today.slice(0,7)); setSelected(today); }} style={{
                background: C.redSoft, border: `1px solid ${C.red}`, borderRadius: 8,
                padding: "6px 12px", cursor: "pointer", fontSize: 11, fontWeight: 700, color: C.red, fontFamily: "inherit",
              }}>Today</button>
            )}
          </div>

          {/* weekday header */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4, marginBottom: 6 }}>
            {["M","T","W","T","F","S","S"].map((d, i) => (
              <div key={i} style={{ textAlign: "center", fontSize: 10, fontWeight: 800, color: C.inkFaint, letterSpacing: "0.06em" }}>{d}</div>
            ))}
          </div>

          {/* month grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4, marginBottom: 22 }}>
            {monthDays.map((k, i) => {
              if (k === null) return <div key={i} />;
              const d = dayNum(k);
              const dayEvs = eventsFor(k);
              const hasEvents = dayEvs.length > 0;
              const isSelected = selected === k;
              const isToday = k === today;
              return (
                <button key={i} onClick={() => setSelected(k)} disabled={!hasEvents} style={{
                  aspectRatio: "1", border: `1px solid ${isSelected ? C.ink : isToday ? C.red : C.line}`,
                  borderWidth: isSelected ? 2 : 1,
                  borderRadius: 9, cursor: hasEvents ? "pointer" : "default",
                  background: isSelected ? C.ink : C.surface,
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4,
                  padding: 0, fontFamily: "inherit",
                  opacity: hasEvents || isToday ? 1 : 0.55,
                }}>
                  <span style={{
                    fontSize: 14, fontWeight: isToday || isSelected ? 800 : 600,
                    color: isSelected ? "#fff" : isToday ? C.red : C.ink,
                  }}>{d}</span>
                  {hasEvents && (
                    <div style={{ display: "flex", gap: 2 }}>
                      {dayEvs.slice(0, 3).map((e, j) => (
                        <span key={j} style={{
                          width: 5, height: 5, borderRadius: "50%",
                          background: isSelected ? "#fff" : dotColor(e.verdict),
                        }} />
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}

      {view === "week" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 5, marginBottom: 22 }}>
          {Array.from({ length: 7 }, (_, i) => addDays(today, i - 3)).map(k => {
            const evs = filterEvents(eventsFor(k));
            const isToday = k === today;
            const isSelected = selected === k;
            return (
              <button key={k} onClick={() => setSelected(k)} style={{
                border: `1px solid ${isSelected ? C.ink : isToday ? C.red : C.line}`,
                borderWidth: isSelected ? 2 : 1,
                borderRadius: 10, cursor: "pointer", padding: "10px 4px",
                background: isSelected ? C.ink : C.surface, fontFamily: "inherit",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
              }}>
                <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.05em", color: isSelected ? "rgba(255,255,255,0.7)" : C.inkFaint }}>{weekdayShort(k)}</span>
                <span style={{ fontSize: 15, fontWeight: 800, color: isSelected ? "#fff" : isToday ? C.red : C.ink }}>{dayNum(k)}</span>
                <div style={{ display: "flex", gap: 2, minHeight: 6 }}>
                  {evs.slice(0,3).map((e,j) => (
                    <span key={j} style={{ width: 5, height: 5, borderRadius: "50%", background: isSelected ? "#fff" : dotColor(e.verdict) }} />
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* selected day detail */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.12em", color: C.inkFaint, marginBottom: 12 }}>
          {selected === today ? "● TODAY" : "GAMES"} · {monthName(selected).toUpperCase()} {selDayNum}
        </div>
        {dayEvents.length === 0 ? (
          <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 24, textAlign: "center", color: C.inkDim, fontSize: 14 }}>
            No notable games this day. Tap a highlighted date to see what's on.
          </div>
        ) : (
          dayEvents.map((e, i) => {
            const aid = selected + "-" + i;
            const lc = LEAGUE_COLORS[e.league];
            const hasMatchup = e.away && e.home;
            return (
              <div key={i} style={{
                background: C.surface, border: `1px solid ${C.line}`,
                borderLeft: `4px solid ${e.verdict >= 5 ? C.red : lc}`,
                borderRadius: 10, padding: "15px 16px", marginBottom: 8,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                  <LeaguePill league={e.league} small />
                  <span style={{ fontSize: 11, color: C.inkDim, fontWeight: 600 }}>{e.time}</span>
                  <span style={{ marginLeft: "auto" }}><VerdictChip level={e.verdict} /></span>
                </div>

                {hasMatchup ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6, flexWrap: "wrap" }}>
                    <TeamLogo team={e.away} size={22} />
                    <span style={{ fontSize: 16, fontWeight: 800, color: C.ink }}>{e.away}</span>
                    <span style={{ color: C.inkFaint, fontSize: 12 }}>at</span>
                    <TeamLogo team={e.home} size={22} />
                    <span style={{ fontSize: 16, fontWeight: 800, color: C.ink }}>{e.home}</span>
                  </div>
                ) : (
                  <div style={{ fontSize: 17, fontWeight: 800, color: C.ink, marginBottom: 6 }}>{e.title}</div>
                )}

                <p style={{ fontSize: 13, color: C.inkDim, lineHeight: 1.55, margin: "0 0 12px" }}>{e.note}</p>

                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 5, background: C.lineSoft,
                    color: C.inkMid, padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600,
                  }}>📺 {e.channel}</span>
                  <button onClick={() => onAlert(aid)} style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    background: alerts.includes(aid) ? C.redSoft : C.surface,
                    color: alerts.includes(aid) ? C.red : C.inkDim,
                    border: `1px solid ${alerts.includes(aid) ? C.red : C.line}`,
                    padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit",
                  }}>{alerts.includes(aid) ? "🔔 Alert set" : "🔕 Alert me"}</button>
                </div>
              </div>
            );
          })
        )}

        {/* Everything else this day — condensed grey rows (respects sport filter) */}
        {(() => {
          const others = filterEvents(DAY_OTHER_GAMES[selected] || []);
          if (others.length === 0) return null;
          return (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.1em", color: C.inkFaint, marginBottom: 8 }}>
                EVERYTHING ELSE ON {monthName(selected).toUpperCase()} {selDayNum}
              </div>
              <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
                {others.map((g, i) => (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", gap: 9, padding: "10px 14px",
                    borderTop: i === 0 ? "none" : `1px solid ${C.lineSoft}`,
                  }}>
                    <span style={{ fontSize: 8, fontWeight: 800, color: "#fff", background: LEAGUE_COLORS[g.league], borderRadius: 3, padding: "2px 5px", flexShrink: 0 }}>{g.league}</span>
                    <TeamLogo team={g.away} size={18} />
                    <span style={{ fontSize: 12, color: C.inkMid, fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {g.away} at {g.home}
                    </span>
                    <span style={{ fontSize: 11, color: C.inkFaint, flexShrink: 0 }}>{g.time}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
      </div>

      {/* legend */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 20, padding: "14px 16px", background: C.surface, borderRadius: 10, border: `1px solid ${C.line}` }}>
        {[["Must watch", C.red],["Worth your time","#E8590C"],["Good game","#1D5BBF"],["Casual","#C2CAD2"]].map(([l,c]) => (
          <div key={l} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: c }} />
            <span style={{ fontSize: 11, color: C.inkDim, fontWeight: 600 }}>{l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── ALERTS ──────────────────────────────────────────────── */

/* ─── SAVE TO HOME SCREEN ─────────────────────────────────── */

/* ─── UPDATE CHECKER ──────────────────────────────────────── */
// Registers a no-op service worker (needed for some browsers' update
// lifecycle) and polls /version.json periodically. If the deployed
// version differs from the one loaded at app start, shows a banner
// prompting the user to refresh.

const CURRENT_VERSION_KEY = "kyg-app-version";

function registerServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Fails silently — update banner still works via polling even without SW
  });
}

function useUpdateChecker(intervalMs = 5 * 60 * 1000) {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const initialVersion = useRef(null);

  useEffect(() => {
    registerServiceWorker();

    let cancelled = false;

    const checkVersion = async () => {
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;

        if (initialVersion.current === null) {
          initialVersion.current = data.version;
          return;
        }
        if (data.version !== initialVersion.current) {
          setUpdateAvailable(true);
        }
      } catch {
        // Network hiccup — ignore, try again next interval
      }
    };

    checkVersion();
    const id = setInterval(checkVersion, intervalMs);

    // Also check whenever the tab becomes visible again —
    // catches the common case of someone reopening the home-screen app
    const onVisible = () => { if (!document.hidden) checkVersion(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);

  return updateAvailable;
}

function UpdateBanner({ visible, onRefresh, onDismiss }) {
  if (!visible) return null;
  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 500,
      background: "#15202B", color: "#fff",
      padding: "11px 18px", display: "flex", alignItems: "center", gap: 12,
      boxShadow: "0 2px 12px rgba(0,0,0,0.25)",
    }}>
      <span style={{ fontSize: 16, flexShrink: 0 }}>✦</span>
      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}>
        A new version of Know Your Game is ready.
      </div>
      <button onClick={onRefresh} style={{
        background: C.red, color: "#fff", border: "none", borderRadius: 7,
        padding: "8px 16px", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
        fontFamily: "inherit", flexShrink: 0, whiteSpace: "nowrap",
      }}>Refresh now</button>
      <button onClick={onDismiss} style={{
        background: "none", border: "none", color: "rgba(255,255,255,0.5)",
        fontSize: 18, cursor: "pointer", padding: "0 2px", flexShrink: 0, lineHeight: 1,
      }}>×</button>
    </div>
  );
}

function detectPlatform() {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const isChrome = /CriOS|Chrome/.test(ua);
  const isSafari = /Safari/.test(ua) && !isChrome;
  const isAndroid = /Android/.test(ua);
  if (isIOS && isChrome) return "ios-chrome";
  if (isIOS && isSafari) return "ios-safari";
  if (isIOS) return "ios-other";
  if (isAndroid) return "android";
  return "other";
}

const INSTALL_STEPS = {
  "ios-safari": [
    "Tap the Share icon (square with an upward arrow) in the toolbar",
    "Scroll down and tap Add to Home Screen",
    "Tap Add in the top-right corner",
  ],
  "ios-chrome": [
    "Tap the Share icon to the right of the address bar",
    "Scroll down and select Add to Home Screen",
    "Tap Add in the top-right corner",
  ],
  "ios-other": [
    "Open this site in Safari or Chrome for the best results",
    "Tap the Share icon in the toolbar",
    "Select Add to Home Screen",
  ],
  "android": [
    "Tap the ⋮ menu in the top-right corner",
    "Tap Add to Home Screen or Install app",
    "Confirm by tapping Add or Install",
  ],
  "other": [
    "Open this site on your phone in Safari or Chrome",
    "Use the Share or Menu button in your browser",
    "Look for Add to Home Screen or Install app",
  ],
};

function InstallPrompt({ compact }) {
  const [platform] = useState(detectPlatform);
  const [open, setOpen] = useState(false);
  const steps = INSTALL_STEPS[platform];

  if (compact) {
    return (
      <div style={{
        background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12,
        padding: "16px 18px", marginTop: 24,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, background: C.red, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontWeight: 900, fontSize: 17,
          }}>K</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: C.ink }}>Get this on your home screen</div>
            <div style={{ fontSize: 11, color: C.inkFaint }}>Opens full-screen like a real app — no App Store needed</div>
          </div>
          <button onClick={() => setOpen(!open)} style={{
            background: C.redSoft, color: C.red, border: "none", borderRadius: 7,
            padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
            flexShrink: 0,
          }}>{open ? "Hide" : "Show me"}</button>
        </div>
        {open && (
          <ol style={{ margin: "14px 0 0", paddingLeft: 20 }}>
            {steps.map((s, i) => (
              <li key={i} style={{ fontSize: 13, color: C.inkMid, lineHeight: 1.7, marginBottom: 4 }}>{s}</li>
            ))}
          </ol>
        )}
      </div>
    );
  }

  // Full version for the Alerts tab
  return (
    <div style={{
      background: "linear-gradient(135deg, #15202B 0%, #243240 100%)",
      borderRadius: 14, padding: "20px 20px 22px", marginBottom: 22, color: "#fff",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 11, background: C.red, flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#fff", fontWeight: 900, fontSize: 19,
        }}>K</div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 900 }}>Save to your home screen</div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>Get one-tap access, full-screen, like a real app</div>
        </div>
      </div>
      <ol style={{ margin: "0 0 4px", paddingLeft: 20 }}>
        {steps.map((s, i) => (
          <li key={i} style={{ fontSize: 13.5, color: "rgba(255,255,255,0.85)", lineHeight: 1.8, marginBottom: 2 }}>{s}</li>
        ))}
      </ol>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginTop: 10 }}>
        Detected: {platform.startsWith("ios") ? "iPhone/iPad" : platform === "android" ? "Android" : "your device"} — steps shown are for your browser.
      </div>
    </div>
  );
}

function AlertsTab({ prefs, onPrefChange, gameAlerts, calAlerts }) {
  const rows = [
    { key: "mustWatch", label: "Championship & finals games", desc: "Clinchers and elimination games across all sports." },
    { key: "myFeed",    label: "Big games in my followed teams", desc: "Worth-your-time games in your leagues and teams." },
    { key: "closeGame", label: "Close finishes — live now", desc: "When a live game is tied or within a score late." },
    { key: "morning",   label: "Morning-of reminders", desc: "A heads-up each morning you have a game alert." },
  ];
  const total = gameAlerts.length + calAlerts.length;
  return (
    <div>
      <InstallPrompt />
      <div style={{ background: C.redSoft, border: `1px solid ${C.red}`, borderRadius: 11, padding: "14px 16px", marginBottom: 22 }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: C.red, marginBottom: 4 }}>
          {total} alert{total !== 1 ? "s" : ""} set
        </div>
        <div style={{ fontSize: 12, color: C.inkMid, lineHeight: 1.55 }}>
          When on, you'll get a morning-of digest around 9am and a reminder ~30 minutes before tip-off. Saved to this device for now — sign in to sync across devices and turn on real push notifications.
        </div>
      </div>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: C.inkFaint, marginBottom: 12 }}>NOTIFY ME WHEN</div>
      {rows.map(r => (
        <div key={r.key} style={{
          display: "flex", alignItems: "center", gap: 14, background: C.surface,
          border: `1px solid ${C.line}`, borderRadius: 11, padding: "15px 16px", marginBottom: 8,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.ink, marginBottom: 3 }}>{r.label}</div>
            <div style={{ fontSize: 12, color: C.inkDim, lineHeight: 1.45 }}>{r.desc}</div>
          </div>
          <Toggle on={prefs[r.key]} onChange={v => onPrefChange(r.key, v)} />
        </div>
      ))}
    </div>
  );
}

/* ─── FEED ────────────────────────────────────────────────── */

function FeedTab({ stars, alerts, onAlert, onGoEdit }) {
  const feed = GAMES.filter(g =>
    (stars.leagues||[]).includes(g.league) ||
    (stars.teams||[]).some(t => t.league === g.league && (g.home === t.name || g.away === t.name))
  ).sort((a,b) => b.verdict - a.verdict);

  if (!stars.leagues?.length && !stars.teams?.length) return (
    <div style={{ textAlign: "center", padding: "56px 0" }}>
      <div style={{ fontSize: 40, marginBottom: 16 }}>🏟️</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 8 }}>Your feed is empty</div>
      <div style={{ fontSize: 14, color: C.inkDim, marginBottom: 22, lineHeight: 1.5 }}>Follow a league or team to build your feed.</div>
      <button onClick={onGoEdit} style={{
        background: C.red, color: "#fff", border: "none", borderRadius: 8,
        padding: "12px 28px", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
      }}>Set up my feed</button>
    </div>
  );

  return (
    <>
      <div style={{ fontSize: 12, color: C.inkDim, marginBottom: 14 }}>
        {feed.length} game{feed.length !== 1 ? "s" : ""} from your followed leagues & teams, ranked by importance.
      </div>
      {feed.length ? feed.map(g => <GameCard key={g.id} game={g} alertOn={alerts.includes(g.id)} onAlert={onAlert} />) : (
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 24, textAlign: "center", color: C.inkDim, fontSize: 14 }}>
          No games for your teams in the next few days.
        </div>
      )}
    </>
  );
}

/* ─── EDIT ────────────────────────────────────────────────── */

function EditTab({ stars, onToggleLeague, onToggleTeam }) {
  const [open, setOpen] = useState("WNBA");
  return (
    <div>
      <p style={{ fontSize: 13, color: C.inkDim, lineHeight: 1.6, marginBottom: 18 }}>
        Follow leagues or specific teams. Your feed and alerts are built from these choices.
      </p>
      {Object.keys(STAR_TEAMS).map(id => {
        const lc = LEAGUE_COLORS[id];
        const allStarred = stars.leagues?.includes(id);
        const isOpen = open === id;
        const teamCount = (stars.teams||[]).filter(t => t.league === id).length;
        return (
          <div key={id} style={{
            background: C.surface, borderRadius: 11, marginBottom: 8, overflow: "hidden",
            border: `1px solid ${allStarred ? lc : C.line}`,
          }}>
            <div onClick={() => setOpen(isOpen ? null : id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", cursor: "pointer" }}>
              <LeaguePill league={id} />
              <span style={{ fontSize: 13, color: C.inkDim, flex: 1 }}>
                {teamCount > 0 && <span style={{ color: lc, fontWeight: 700 }}>{teamCount} followed · </span>}
                {LEAGUE_SPORT[id]}
              </span>
              <button onClick={e => { e.stopPropagation(); onToggleLeague(id); }} style={{
                background: allStarred ? lc : C.surface, color: allStarred ? "#fff" : C.inkDim,
                border: `1px solid ${allStarred ? lc : C.line}`, borderRadius: 6,
                padding: "6px 14px", cursor: "pointer", fontSize: 11, fontWeight: 800, fontFamily: "inherit", letterSpacing: "0.03em",
              }}>{allStarred ? "★ Following" : "Follow all"}</button>
              <span style={{ color: C.inkFaint, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s", fontSize: 13 }}>▾</span>
            </div>
            {isOpen && (
              <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${C.lineSoft}`, paddingTop: 12, display: "flex", flexWrap: "wrap", gap: 7 }}>
                {STAR_TEAMS[id].map(team => {
                  const following = (stars.teams||[]).some(t => t.name === team && t.league === id);
                  return (
                    <button key={team} onClick={() => onToggleTeam(id, { name: team })} style={{
                      padding: "7px 14px", borderRadius: 18, cursor: "pointer",
                      background: following ? lc : C.surface,
                      border: `1px solid ${following ? lc : C.line}`,
                      color: following ? "#fff" : C.inkMid,
                      fontSize: 12, fontWeight: 600, fontFamily: "inherit",
                    }}>{following ? "★ " : ""}{team}</button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ─── LOGIN MODAL ─────────────────────────────────────────── */

function LoginModal({ onClose, onLogin }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const input = {
    width: "100%", padding: "12px 14px", background: C.bg, border: `1px solid ${C.line}`,
    borderRadius: 8, color: C.ink, fontSize: 14, fontFamily: "inherit", outline: "none", marginBottom: 10,
  };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,32,43,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surface, borderRadius: 14, padding: "28px", width: "100%", maxWidth: 400, boxShadow: "0 20px 60px rgba(20,32,43,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={{ fontSize: 20, fontWeight: 900, color: C.ink }}>{mode === "login" ? "Sign in" : "Create account"}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.inkFaint, fontSize: 22, cursor: "pointer" }}>×</button>
        </div>
        <p style={{ fontSize: 13, color: C.inkDim, marginBottom: 20, lineHeight: 1.5 }}>Save your feed and alerts across devices. Free, no spam.</p>
        {mode === "signup" && <input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" style={input} />}
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email address" type="email" style={input} />
        <input placeholder="Password" type="password" style={{ ...input, marginBottom: 18 }} />
        <button onClick={() => { if (email) { onLogin({ email, name: name || email.split("@")[0] }); onClose(); } }} style={{
          width: "100%", padding: "13px", background: C.red, color: "#fff", border: "none",
          borderRadius: 8, fontSize: 15, fontWeight: 800, cursor: "pointer", fontFamily: "inherit", marginBottom: 14,
        }}>{mode === "login" ? "Sign in" : "Create account"}</button>
        <div style={{ textAlign: "center", fontSize: 13, color: C.inkDim }}>
          {mode === "login"
            ? <>No account? <span onClick={() => setMode("signup")} style={{ color: C.red, cursor: "pointer", fontWeight: 700 }}>Sign up</span></>
            : <>Have one? <span onClick={() => setMode("login")} style={{ color: C.red, cursor: "pointer", fontWeight: 700 }}>Sign in</span></>}
        </div>
      </div>
    </div>
  );
}

/* ─── AI WEEK RUNDOWN ─────────────────────────────────────── */

function WeekRundown() {
  const [state, setState] = useState("idle"); // idle | loading | done | error
  const [text, setText] = useState("");

  // The next 7 days' notable games — used both for the prompt and the bullet list
  const today = todayKey();
  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i))
    .flatMap(d => (CAL_EVENTS[d] || []).map(e => ({ d, ...e })))
    .filter(e => e.verdict >= 3)
    .sort((a, b) => b.verdict - a.verdict || a.d.localeCompare(b.d));

  const dayName = iso => dayLabel(iso);

  const generate = async () => {
    setState("loading");
    const brief = week.map(e =>
      `${e.d.slice(5)}: ${e.away ? `${e.away} at ${e.home}` : e.title} (${e.league}, importance ${e.verdict}/5) — ${e.note}`
    ).join("\n");

    const prompt = `You are a friendly sports guide writing for a CASUAL fan who follows the WNBA but often misses games because they never know the schedule. Below is this week's slate of notable games. Write a warm, punchy 3-4 sentence rundown of what's worth watching this week and why. Lead with the single biggest can't-miss game. Mention day names. No jargon, no hype clichés, no bullet points (a separate list handles those) — just plain, flowing guidance like a knowledgeable friend texting them. Do not invent any games not listed.

This week's games:
${brief}`;

    try {
      const res = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await res.json();
      const out = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
      setText(out || "Couldn't generate a rundown right now.");
      setState("done");
    } catch (e) {
      setState("error");
    }
  };

  return (
    <div style={{
      background: "linear-gradient(135deg, #15202B 0%, #243240 100%)",
      borderRadius: 14, padding: "18px 20px", marginBottom: 20, color: "#fff",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: state === "done" ? 12 : 4 }}>
        <span style={{ fontSize: 16 }}>✦</span>
        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.12em", color: "rgba(255,255,255,0.85)" }}>
          YOUR WEEK IN SPORTS
        </span>
      </div>

      {state === "idle" && (
        <>
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", lineHeight: 1.55, margin: "0 0 14px" }}>
            Get a quick, personalized rundown of what's worth watching this week.
          </p>
          <button onClick={generate} style={{
            background: "#fff", color: C.ink, border: "none", borderRadius: 8,
            padding: "10px 18px", fontSize: 13, fontWeight: 800, cursor: "pointer", fontFamily: "inherit",
          }}>✦ Generate my rundown</button>
        </>
      )}

      {state === "loading" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
          <span style={{ width: 16, height: 16, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.8s linear infinite", display: "inline-block" }} />
          <span style={{ fontSize: 13, color: "rgba(255,255,255,0.75)" }}>Reading this week's slate…</span>
        </div>
      )}

      {state === "done" && (
        <>
          <p style={{ fontSize: 14.5, color: "#fff", lineHeight: 1.7, margin: 0, fontWeight: 500 }}>{text}</p>

          {/* Bulleted game list */}
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.12)" }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", color: "rgba(255,255,255,0.5)", marginBottom: 10 }}>
              THIS WEEK'S GAMES
            </div>
            {week.map((e, i) => (
              <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 9 }}>
                <span style={{
                  width: 7, height: 7, borderRadius: "50%", flexShrink: 0, marginTop: 5,
                  background: e.verdict >= 5 ? "#FF5A5A" : e.verdict === 4 ? "#FFA94D" : "#6BA4FF",
                }} />
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                  <span style={{ color: "rgba(255,255,255,0.55)", fontWeight: 700 }}>{dayName(e.d)} · {e.time}</span>
                  <span style={{ color: "#fff", fontWeight: 600 }}> — {e.away ? `${e.away} at ${e.home}` : e.title}</span>
                  <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 12 }}> ({e.league}, 📺 {e.channel})</span>
                </div>
              </div>
            ))}
          </div>

          <button onClick={generate} style={{
            background: "none", border: "none", color: "rgba(255,255,255,0.55)", cursor: "pointer",
            fontSize: 12, fontWeight: 600, fontFamily: "inherit", padding: 0, marginTop: 8,
          }}>↻ Refresh</button>
        </>
      )}

      {state === "error" && (
        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", margin: 0 }}>
          Couldn't reach the rundown service. <span onClick={generate} style={{ textDecoration: "underline", cursor: "pointer" }}>Try again</span>.
        </p>
      )}
    </div>
  );
}

/* ─── SPORTS 101 TAB ──────────────────────────────────────── */

const SPORT_101 = [
  {
    league: "WNBA",
    headline: "Women's pro basketball — booming right now",
    season: "May → September · 44 games",
    progress: "Just getting started (about a fifth of the way in)",
    sections: [
      { h: "How the season works", b: "13 teams each play 44 games from May into September. There are no conferences for scheduling — everyone's ranked in one big standings table." },
      { h: "Making the playoffs", b: "The top 8 teams make the playoffs in September, seeded 1–8 by record. It's a bracket from there." },
      { h: "How series work", b: "First round is best-of-3. Semifinals and the Finals are best-of-5 — first to 3 wins advances. So a Finals can run anywhere from 3 to 5 games." },
      { h: "Why people are watching now", b: "Caitlin Clark (Indiana Fever) brought a huge new audience. Star players and rivalries are getting national TV slots they never had before." },
    ],
  },
  {
    league: "NBA",
    headline: "Men's pro basketball — at its championship climax",
    season: "October → June · 82 games",
    progress: "The Finals — essentially over for the season",
    sections: [
      { h: "How the season works", b: "30 teams split into two conferences (East and West), 82 games each from October to April." },
      { h: "Conferences & playoffs", b: "The top teams in each conference make the playoffs. The bracket runs separately in the East and West until one champion emerges from each side." },
      { h: "How series work", b: "Every playoff round is best-of-7 — first to 4 wins. The two conference champions meet in the Finals. Right now the Spurs lead that Finals 3–1, so one more win takes the title." },
      { h: "The phrase 'clinch'", b: "When a team can win the series with their next victory, they can 'clinch.' That's why Game 5 is a big deal — San Antonio can close it out." },
    ],
  },
  {
    league: "MLB",
    headline: "Pro baseball — the long summer grind",
    season: "April → October · 162 games",
    progress: "Mid-season (about 40% through)",
    sections: [
      { h: "How the season works", b: "30 teams, a marathon 162 games each. No single game matters much on its own — it's about the long haul. That's why June baseball is low-stakes." },
      { h: "Divisions & leagues", b: "Teams are split into the American League (AL) and National League (NL), each with three divisions (East, Central, West)." },
      { h: "Making the playoffs", b: "12 teams make it: division winners plus wild-card teams. The bracket builds to the World Series — a best-of-7 between the AL and NL champions." },
      { h: "When to start caring", b: "August and September, when the standings tighten and playoff races heat up. October is the payoff." },
    ],
  },
  {
    league: "NFL",
    headline: "Pro football — not in season yet",
    season: "September → February · 17 games",
    progress: "Off-season — nothing live until fall",
    sections: [
      { h: "How the season works", b: "32 teams, just 17 games each. Because the season is so short, every single game matters — unlike baseball." },
      { h: "Conferences & playoffs", b: "Two conferences: the AFC and NFC. Seven teams from each make the playoffs in January." },
      { h: "How the playoffs work", b: "Single elimination — lose once and you're out (no series). It builds to the Super Bowl, the AFC champion vs. the NFC champion. It's the biggest single sporting event in the U.S." },
      { h: "When it starts", b: "Preseason in August, regular season kicks off September 10. Set an alert for opening weekend." },
    ],
  },
];

function Sports101Tab() {
  const [open, setOpen] = useState("WNBA");
  return (
    <div>
      <p style={{ fontSize: 13, color: C.inkDim, lineHeight: 1.6, marginBottom: 18 }}>
        New to a sport, or just fuzzy on how it all works? Here's the plain-English version — where each season stands right now, and how the playoffs and series actually work.
      </p>
      {SPORT_101.map(s => {
        const lc = LEAGUE_COLORS[s.league];
        const isOpen = open === s.league;
        const ctx = SEASON_CONTEXT[s.league];
        return (
          <div key={s.league} style={{
            background: C.surface, borderRadius: 12, marginBottom: 10, overflow: "hidden",
            border: `1px solid ${isOpen ? lc : C.line}`,
          }}>
            <div onClick={() => setOpen(isOpen ? null : s.league)} style={{ cursor: "pointer" }}>
              {/* colored header */}
              <div style={{ background: lc, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 900, color: "#fff", letterSpacing: "0.04em" }}>{s.league}</span>
                <span style={{ fontSize: 12, color: "rgba(255,255,255,0.85)", fontWeight: 600 }}>{s.season}</span>
                <span style={{ marginLeft: "auto", color: "#fff", fontSize: 13, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▾</span>
              </div>
              {/* progress bar + phase */}
              <div style={{ padding: "13px 16px" }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: C.ink, marginBottom: 8 }}>{s.headline}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <div style={{ flex: 1, height: 6, background: C.lineSoft, borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${ctx.pct}%`, height: "100%", background: lc, borderRadius: 3 }} />
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 800, color: lc, whiteSpace: "nowrap" }}>{ctx.phase}</span>
                </div>
                <div style={{ fontSize: 12, color: C.inkDim }}>{s.progress}</div>
              </div>
            </div>

            {isOpen && (
              <div style={{ padding: "4px 16px 16px", borderTop: `1px solid ${C.lineSoft}` }}>
                {s.sections.map((sec, i) => (
                  <div key={i} style={{ marginTop: 14 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: C.ink, marginBottom: 4 }}>{sec.h}</div>
                    <p style={{ fontSize: 13, color: C.inkMid, lineHeight: 1.6, margin: 0 }}>{sec.b}</p>
                  </div>
                ))}
                {SPORT_101_LINKS[s.league] && (
                  <a href={SPORT_101_LINKS[s.league].url} target="_blank" rel="noopener noreferrer" style={{
                    display: "inline-flex", alignItems: "center", gap: 6, marginTop: 16,
                    background: lc, color: "#fff", padding: "9px 15px", borderRadius: 7,
                    fontSize: 12, fontWeight: 700, textDecoration: "none",
                  }}>{SPORT_101_LINKS[s.league].label} ↗</a>
                )}
              </div>
            )}
          </div>
        );
      })}

      <SportsChatbot />
    </div>
  );
}

/* AI chatbot to ask follow-up questions about any sport */
function SportsChatbot() {
  const [messages, setMessages] = useState([
    { role: "bot", text: "Hi! Ask me anything about how a sport works — rules, playoffs, what a term means, why a game matters. I'll keep it simple." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const suggestions = ["What's a triple-double?", "How does WNBA overtime work?", "Why do MLB seasons have so many games?"];

  const send = async (text) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setInput("");
    const next = [...messages, { role: "user", text: q }];
    setMessages(next);
    setBusy(true);

    const prompt = `You are a friendly sports explainer for a casual fan who follows the WNBA but doesn't know much about sports in general. Answer this question simply and warmly in 2-4 sentences, no jargon. If you must use a technical term, define it. Question: ${q}`;

    try {
      const res = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await res.json();
      const out = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
      setMessages([...next, { role: "bot", text: out || "Sorry, I couldn't answer that one." }]);
    } catch (e) {
      setMessages([...next, { role: "bot", text: "I couldn't reach the answer service just now. Try again in a moment." }]);
    }
    setBusy(false);
  };

  return (
    <div style={{ marginTop: 24, background: "linear-gradient(135deg, #15202B 0%, #243240 100%)", borderRadius: 14, padding: "18px 18px 20px", color: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 16 }}>💬</span>
        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.1em", color: "rgba(255,255,255,0.85)" }}>ASK ABOUT ANY SPORT</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14, maxHeight: 320, overflowY: "auto" }}>
        {messages.map((m, i) => (
          <div key={i} style={{
            alignSelf: m.role === "user" ? "flex-end" : "flex-start",
            maxWidth: "85%",
            background: m.role === "user" ? C.red : "rgba(255,255,255,0.1)",
            color: "#fff", padding: "10px 14px", borderRadius: 12,
            borderBottomRightRadius: m.role === "user" ? 3 : 12,
            borderBottomLeftRadius: m.role === "bot" ? 3 : 12,
            fontSize: 13.5, lineHeight: 1.6,
          }}>{m.text}</div>
        ))}
        {busy && (
          <div style={{ alignSelf: "flex-start", background: "rgba(255,255,255,0.1)", padding: "10px 14px", borderRadius: 12, fontSize: 13 }}>
            <span style={{ display: "inline-block", animation: "spin 0.8s linear infinite", width: 12, height: 12, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%" }} />
          </div>
        )}
      </div>

      {messages.length <= 1 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {suggestions.map(s => (
            <button key={s} onClick={() => send(s)} style={{
              background: "rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.9)", border: "none",
              borderRadius: 14, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            }}>{s}</button>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && send()}
          placeholder="Type a question…"
          style={{
            flex: 1, background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: 8, padding: "11px 14px", color: "#fff", fontSize: 14, fontFamily: "inherit", outline: "none",
          }}
        />
        <button onClick={() => send()} disabled={busy} style={{
          background: "#fff", color: C.ink, border: "none", borderRadius: 8,
          padding: "0 18px", fontSize: 14, fontWeight: 800, cursor: busy ? "default" : "pointer",
          fontFamily: "inherit", opacity: busy ? 0.6 : 1,
        }}>Send</button>
      </div>
    </div>
  );
}

/* ─── STANDINGS / BRACKET TAB ─────────────────────────────── */

function SeriesBox({ s }) {
  const aWin = s.winner === "A";
  const bWin = s.winner === "B";
  const teamRow = (name, score, isWinner, isLoser) => (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 12px",
      background: isWinner ? "#15202B" : C.surface, opacity: isLoser ? 0.5 : 1,
    }}>
      <span style={{ fontSize: 13, fontWeight: isWinner ? 800 : 600, color: isWinner ? "#fff" : C.ink }}>{name}</span>
      <span style={{ fontSize: 15, fontWeight: 900, color: isWinner ? "#fff" : C.inkMid }}>{score}</span>
    </div>
  );
  return (
    <div style={{ border: `1px solid ${s.live ? C.red : C.line}`, borderRadius: 10, overflow: "hidden", marginBottom: 12 }}>
      <div style={{
        fontSize: 9, fontWeight: 800, letterSpacing: "0.1em", padding: "4px 12px",
        background: s.live ? C.red : C.lineSoft, color: s.live ? "#fff" : C.inkDim,
      }}>{s.live ? "● LIVE SERIES" : s.conf.toUpperCase()}</div>
      {teamRow(s.teamA, s.scoreA, aWin, bWin)}
      <div style={{ height: 1, background: C.line }} />
      {teamRow(s.teamB, s.scoreB, bWin, aWin)}
    </div>
  );
}

function StandingsTab() {
  const leagues = ["WNBA", "NBA", "MLB", "WC", "MLS", "NFL", "NHL"];
  const [view, setView] = useState("WNBA");
  const lc = LEAGUE_COLORS[view];
  const s = STANDINGS[view];

  // Shared table renderer — same layout as the loved WNBA table
  const renderTable = (rows, playoffCut, cols, footNote) => (
    <>
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden" }}>
        <div style={{ display: "flex", padding: "8px 14px", background: lc, fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", color: "#fff" }}>
          <span style={{ width: 28 }}>#</span>
          <span style={{ flex: 1 }}>TEAM</span>
          {cols.map(c => <span key={c} style={{ width: 56, textAlign: "right" }}>{c}</span>)}
        </div>
        {rows.map((t, i) => {
          const inPlayoffs = t.rank <= playoffCut;
          const isCut = t.rank === playoffCut;
          const statCells = cols.map(c => {
            if (c === "W–L") return `${t.w}–${t.l}`;
            if (c === "STRK") return t.streak;
            if (c === "GB")   return t.gb;
            if (c === "PTS")  return t.pts;
            if (c === "PLAYED") return t.played;
            return "";
          });
          return (
            <div key={t.team}>
              <div style={{
                display: "flex", alignItems: "center", padding: "11px 14px",
                background: inPlayoffs ? lc + "10" : C.surface,
                borderTop: i === 0 ? "none" : `1px solid ${C.lineSoft}`,
              }}>
                <span style={{ width: 28, fontSize: 14, fontWeight: 900, color: inPlayoffs ? lc : C.inkFaint }}>{t.rank}</span>
                <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 7 }}>
                  <TeamLogo team={t.team} size={22} />
                  <span style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{t.team}</span>
                  {t.conf && <span style={{ fontSize: 9, fontWeight: 700, color: C.inkFaint, border: `1px solid ${C.line}`, borderRadius: 3, padding: "1px 4px" }}>{t.conf}</span>}
                </span>
                {statCells.map((v, j) => {
                  const isStreak = cols[j] === "STRK";
                  return (
                    <span key={j} style={{
                      width: 56, textAlign: "right", fontSize: j === 0 ? 13 : 12,
                      fontWeight: 700,
                      color: isStreak
                        ? (v?.[0] === "W" ? "#1F7A4D" : "#C0392B")
                        : C.inkMid,
                    }}>{v}</span>
                  );
                })}
              </div>
              {isCut && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 14px", background: C.bg }}>
                  <div style={{ flex: 1, height: 0, borderTop: `2px dashed ${C.red}` }} />
                  <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.08em", color: C.red }}>PLAYOFF CUT LINE</span>
                  <div style={{ flex: 1, height: 0, borderTop: `2px dashed ${C.red}` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {footNote && <div style={{ fontSize: 12, color: C.inkFaint, marginTop: 10, lineHeight: 1.5 }}>{footNote}</div>}
    </>
  );

  return (
    <div>
      {/* League picker — scrollable pill row */}
      <div style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 20, paddingBottom: 4 }}>
        {leagues.map(lg => (
          <button key={lg} onClick={() => setView(lg)} style={{
            flexShrink: 0, padding: "8px 16px", borderRadius: 20, cursor: "pointer",
            background: view === lg ? LEAGUE_COLORS[lg] : C.surface,
            color: view === lg ? "#fff" : C.inkDim,
            fontSize: 13, fontWeight: 700, fontFamily: "inherit",
            border: `1px solid ${view === lg ? LEAGUE_COLORS[lg] : C.line}`,
            boxShadow: view === lg ? `0 2px 8px ${LEAGUE_COLORS[lg]}44` : "none",
          }}>
            {SPORT_EMOJI[lg]} {lg}
          </button>
        ))}
      </div>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 20, fontWeight: 900, color: C.ink }}>{s.emoji} {s.label}</span>
      </div>
      <p style={{ fontSize: 13, color: C.inkDim, lineHeight: 1.55, marginBottom: 18 }}>{s.blurb}</p>

      {/* NBA: bracket + "same table" wrapper */}
      {view === "NBA" && (
        <>
          {NBA_BRACKET.rounds.map(round => (
            <div key={round.name} style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", color: C.inkFaint, marginBottom: 10 }}>
                {round.name.toUpperCase()} · best-of-7
              </div>
              {round.series.map((sr, i) => <SeriesBox key={i} s={sr} />)}
            </div>
          ))}
          <div style={{ background: "#15202B", borderRadius: 12, padding: "16px 18px", color: "#fff" }}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>🏆 2026 NBA Champions</div>
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", lineHeight: 1.6, margin: 0 }}>
              The New York Knicks beat the San Antonio Spurs 4–1 to win the championship — their first title in over 50 years. The season is now over; next season tips off in October.
            </p>
          </div>
        </>
      )}

      {/* Off-season leagues: status card */}
      {s.status && (
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: "22px 20px" }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: C.ink, marginBottom: 6 }}>{s.status}</div>
          <div style={{ fontSize: 13, color: C.inkDim, lineHeight: 1.6, marginBottom: 14 }}>{s.blurb}</div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: lc + "15", border: `1px solid ${lc}40`, borderRadius: 8, padding: "9px 14px" }}>
            <span style={{ fontSize: 16 }}>{s.emoji}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: lc }}>{s.next}</span>
          </div>
        </div>
      )}

      {/* Live standings table leagues */}
      {s.rows && renderTable(
        s.rows,
        s.playoffCut,
        s.cols,
        view === "WNBA" ? "Green = currently in the playoffs. STRK is the current win/loss streak. Fever (Clark) sit 4th." :
        view === "MLB"  ? "GB = games behind the leader. NL shown here; the AL race is equally tight." :
        view === "MLS"  ? "PTS = points (3 for a win, 1 for a draw). Eastern Conference shown." : null
      )}
    </div>
  );
}

/* ─── PLAYERS TAB ─────────────────────────────────────────── */

function PlayerAvatar({ name, team, size = 56 }) {
  const c = teamColor(team);
  const initials = name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      background: `linear-gradient(135deg, ${c} 0%, ${c}AA 100%)`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.32, fontWeight: 900, color: "#fff",
      border: `2px solid ${c}55`,
    }}>{initials}</div>
  );
}

function StarPlayerCard({ p, lc }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.line}`,
      borderLeft: `4px solid ${teamColor(p.team)}`, borderRadius: 10, overflow: "hidden",
    }}>
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", padding: "14px 16px" }}>
        <PlayerAvatar name={p.name} team={p.team} size={54} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3, flexWrap: "wrap" }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: C.ink }}>{p.name}</span>
            <TeamLogo team={p.team} size={18} />
            <span style={{ fontSize: 12, color: teamColor(p.team), fontWeight: 700 }}>{p.team}</span>
            <span style={{ fontSize: 10, color: C.inkFaint, fontWeight: 600, border: `1px solid ${C.line}`, borderRadius: 3, padding: "1px 6px" }}>{p.pos}</span>
          </div>
          <p style={{ fontSize: 13, color: C.inkMid, lineHeight: 1.6, margin: "0 0 8px" }}>{p.note}</p>

          {/* quick stat strip */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
            {p.stats.map(([label, val]) => (
              <div key={label} style={{ background: lc + "12", borderRadius: 6, padding: "4px 10px", textAlign: "center" }}>
                <div style={{ fontSize: 14, fontWeight: 900, color: lc, lineHeight: 1 }}>{val}</div>
                <div style={{ fontSize: 9, fontWeight: 700, color: C.inkFaint, letterSpacing: "0.04em" }}>{label}</div>
              </div>
            ))}
          </div>

          <button onClick={() => setOpen(!open)} style={{
            background: "none", border: "none", cursor: "pointer", padding: 0,
            fontSize: 12, fontWeight: 700, color: lc, fontFamily: "inherit",
          }}>{open ? "Show less ▴" : "See more ▾"}</button>
        </div>
      </div>

      {open && (
        <div style={{ padding: "0 16px 16px 16px", borderTop: `1px solid ${C.lineSoft}`, paddingTop: 14 }}>
          <div style={{ fontSize: 12, color: C.inkDim, marginBottom: 10 }}>
            <span style={{ fontWeight: 700, color: C.ink }}>In the league since:</span> {p.debut}
          </div>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", color: C.inkFaint, marginBottom: 8 }}>GOOD TO KNOW</div>
          {p.facts.map((f, i) => (
            <div key={i} style={{ display: "flex", gap: 9, marginBottom: 7 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: lc, flexShrink: 0, marginTop: 6 }} />
              <span style={{ fontSize: 13, color: C.inkMid, lineHeight: 1.5 }}>{f}</span>
            </div>
          ))}
          <a href={p.link} target="_blank" rel="noopener noreferrer" style={{
            display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8,
            background: lc, color: "#fff", padding: "8px 14px", borderRadius: 6,
            fontSize: 12, fontWeight: 700, textDecoration: "none",
          }}>Read full profile ↗</a>
        </div>
      )}
    </div>
  );
}

function PlayersTab() {
  const leagues = Object.keys(PLAYERS);
  // null = home screen (all leagues collapsed/expanded), string = drilled into a league
  const [openLeague, setOpenLeague] = useState("WNBA"); // WNBA pre-expanded on home
  const [teamFilter, setTeamFilter] = useState("ALL");
  const [selectedPlayer, setSelectedPlayer] = useState(null); // for detail overlay

  const drillInto = (lg) => {
    setOpenLeague(lg === openLeague ? null : lg);
    setTeamFilter("ALL");
  };

  return (
    <div>
      <p style={{ fontSize: 13, color: C.inkDim, lineHeight: 1.6, marginBottom: 18 }}>
        The names worth knowing. Tap a league to explore teams and players.
      </p>

      {leagues.map(lg => {
        const lc = LEAGUE_COLORS[lg];
        const isOpen = openLeague === lg;
        const data = PLAYERS[lg];
        const allTeams = [...new Set([
          ...data.stars.map(p => p.team),
          ...data.roster.map(p => p.team),
        ])].sort();
        const stars = data.stars.filter(p => teamFilter === "ALL" || p.team === teamFilter);
        const roster = data.roster.filter(p => teamFilter === "ALL" || p.team === teamFilter);
        const coaches = data.coaches.filter(c => teamFilter === "ALL" || c.team === teamFilter);

        return (
          <div key={lg} style={{
            background: C.surface, borderRadius: 12, marginBottom: 10, overflow: "hidden",
            border: `1px solid ${isOpen ? lc : C.line}`,
            boxShadow: isOpen ? `0 2px 12px ${lc}18` : "0 1px 4px rgba(20,32,43,0.04)",
          }}>
            {/* League header — always visible, click to expand */}
            <div onClick={() => drillInto(lg)} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "14px 16px",
              cursor: "pointer", background: isOpen ? lc : C.surface,
              transition: "background 0.2s",
            }}>
              <span style={{ fontSize: 22 }}>{SPORT_EMOJI[lg]}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 900, color: isOpen ? "#fff" : C.ink, letterSpacing: "0.02em" }}>{lg}</div>
                <div style={{ fontSize: 11, color: isOpen ? "rgba(255,255,255,0.75)" : C.inkFaint, fontWeight: 600 }}>
                  {LEAGUE_SPORT[lg]} · {data.stars.length} featured players · {allTeams.length} teams
                </div>
              </div>
              {/* Star previews — show 3 avatar monograms on the collapsed row */}
              {!isOpen && (
                <div style={{ display: "flex", gap: -4 }}>
                  {data.stars.slice(0, 3).map(p => (
                    <div key={p.name} style={{ marginLeft: -6 }}>
                      <PlayerAvatar name={p.name} team={p.team} size={28} />
                    </div>
                  ))}
                </div>
              )}
              <span style={{
                color: isOpen ? "#fff" : C.inkFaint, fontSize: 13,
                transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s",
              }}>▾</span>
            </div>

            {isOpen && (
              <div style={{ padding: "14px 16px 18px" }}>
                {/* Team filter strip */}
                <div style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 18, paddingBottom: 2 }}>
                  {["ALL", ...allTeams].map(t => (
                    <button key={t} onClick={() => setTeamFilter(t)} style={{
                      flexShrink: 0, padding: "6px 12px", borderRadius: 16, cursor: "pointer",
                      display: "inline-flex", alignItems: "center", gap: 5,
                      background: teamFilter === t ? lc + "18" : "transparent",
                      color: teamFilter === t ? lc : C.inkFaint, fontSize: 12, fontWeight: 600,
                      border: `1px solid ${teamFilter === t ? lc : C.line}`, fontFamily: "inherit",
                    }}>
                      {t !== "ALL" && <TeamLogo team={t} size={14} />}
                      {t === "ALL" ? "All Teams" : t}
                    </button>
                  ))}
                </div>

                {/* Stars */}
                {stars.length > 0 && (
                  <>
                    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.1em", color: C.inkFaint, marginBottom: 10 }}>⭐ STARS TO WATCH</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
                      {stars.map(p => <StarPlayerCard key={p.name} p={p} lc={lc} />)}
                    </div>
                  </>
                )}

                {/* Coaches */}
                {coaches.length > 0 && (
                  <>
                    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.1em", color: C.inkFaint, marginBottom: 10 }}>🎯 COACHES</div>
                    <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden", marginBottom: 20 }}>
                      {coaches.map((c, i) => (
                        <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 14px", borderTop: i === 0 ? "none" : `1px solid ${C.lineSoft}` }}>
                          <TeamLogo team={c.team} size={26} />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{c.name}</div>
                            <div style={{ fontSize: 11, color: C.inkFaint }}>{c.team}</div>
                          </div>
                          <span style={{ fontSize: 10, color: C.inkDim, fontWeight: 700, background: C.lineSoft, borderRadius: 4, padding: "3px 8px" }}>{c.role}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* Rest of roster */}
                {roster.length > 0 && (
                  <>
                    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.1em", color: C.inkFaint, marginBottom: 10 }}>
                      {teamFilter === "ALL" ? "👥 MORE ROSTER NAMES" : `👥 REST OF THE ROSTER`}
                    </div>
                    <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
                      {roster.map((p, i) => (
                        <div key={p.name} style={{
                          display: "flex", alignItems: "center", gap: 11, padding: "10px 14px",
                          borderTop: i === 0 ? "none" : `1px solid ${C.lineSoft}`,
                          cursor: "pointer",
                        }} onClick={() => setSelectedPlayer({ ...p, league: lg })}>
                          <PlayerAvatar name={p.name} team={p.team} size={30} />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{p.name}</div>
                            <div style={{ fontSize: 11, color: C.inkFaint }}>{p.team}</div>
                          </div>
                          <span style={{ fontSize: 10, color: C.inkDim, fontWeight: 600, border: `1px solid ${C.line}`, borderRadius: 3, padding: "2px 7px" }}>{p.pos}</span>
                          <span style={{ fontSize: 11, color: C.inkFaint }}>›</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Player detail overlay — tapping a roster player shows what we know */}
      {selectedPlayer && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(20,32,43,0.55)",
          display: "flex", alignItems: "flex-end", justifyContent: "center",
          zIndex: 200, padding: "0 0 0 0",
        }} onClick={() => setSelectedPlayer(null)}>
          <div onClick={e => e.stopPropagation()} style={{
            background: C.surface, borderRadius: "16px 16px 0 0", padding: "24px 22px 36px",
            width: "100%", maxWidth: 600,
            boxShadow: "0 -8px 32px rgba(20,32,43,0.2)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
              <PlayerAvatar name={selectedPlayer.name} team={selectedPlayer.team} size={52} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 18, fontWeight: 900, color: C.ink }}>{selectedPlayer.name}</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 3 }}>
                  <TeamLogo team={selectedPlayer.team} size={18} />
                  <span style={{ fontSize: 13, color: LEAGUE_COLORS[selectedPlayer.league], fontWeight: 700 }}>{selectedPlayer.team}</span>
                  <span style={{ fontSize: 11, color: C.inkFaint, border: `1px solid ${C.line}`, borderRadius: 3, padding: "1px 6px" }}>{selectedPlayer.pos}</span>
                </div>
              </div>
              <button onClick={() => setSelectedPlayer(null)} style={{ background: "none", border: "none", fontSize: 22, color: C.inkFaint, cursor: "pointer" }}>×</button>
            </div>
            <p style={{ fontSize: 13, color: C.inkDim, lineHeight: 1.6, margin: 0 }}>
              {selectedPlayer.note || `${selectedPlayer.name} plays ${selectedPlayer.pos} for the ${selectedPlayer.team}. Full bio coming in the next update when we connect to live player data.`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── MAIN ────────────────────────────────────────────────── */

export default function App() {
  const [tab, setTab] = useState("today");
  const [stars, setStars] = useState(() => load("kyg-stars-v5", { leagues: ["WNBA"], teams: [] }));
  const [gameAlerts, setGameAlerts] = useState(() => load("kyg-galerts-v3", []));
  const [calAlerts, setCalAlerts] = useState(() => load("kyg-calerts-v2", []));
  const [prefs, setPrefs] = useState(() => load("kyg-prefs-v3", { mustWatch: true, myFeed: true, closeGame: false, morning: true }));
  const [filters, setFilters] = useState({ sport: "ALL", team: "ALL", city: "ALL" });
  const [user, setUser] = useState(() => load("kyg-user", null));
  const [showLogin, setShowLogin] = useState(false);
  const [toast, setToast] = useState(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const updateAvailable = useUpdateChecker();

  const flash = m => { setToast(m); setTimeout(() => setToast(null), 2300); };
  const prefChange = (k, v) => setPrefs(p => { const n = { ...p, [k]: v }; save("kyg-prefs-v3", n); return n; });
  const toggleLeague = id => setStars(p => { const has = p.leagues?.includes(id); const n = { ...p, leagues: has ? p.leagues.filter(l=>l!==id) : [...(p.leagues||[]), id] }; save("kyg-stars-v5", n); flash(has?`Unfollowed ${id}`:`Following ${id}`); return n; });
  const toggleTeam = (lg, t) => setStars(p => { const ex = (p.teams||[]).some(x=>x.name===t.name&&x.league===lg); const n = { ...p, teams: ex ? p.teams.filter(x=>!(x.name===t.name&&x.league===lg)) : [...(p.teams||[]), {...t, league:lg}] }; save("kyg-stars-v5", n); flash(ex?`Unfollowed ${t.name}`:`Following ${t.name}`); return n; });
  const toggleGameAlert = id => setGameAlerts(p => { const n = p.includes(id)?p.filter(x=>x!==id):[...p,id]; save("kyg-galerts-v3", n); flash(p.includes(id)?"Alert removed":"🔔 We'll remind you"); return n; });
  const toggleCalAlert = id => setCalAlerts(p => { const n = p.includes(id)?p.filter(x=>x!==id):[...p,id]; save("kyg-calerts-v2", n); flash(p.includes(id)?"Alert removed":"🔔 Alert set"); return n; });
  const handleLogin = u => { save("kyg-user", u); setUser(u); flash(`Welcome, ${u.name}!`); };
  const handleLogout = () => { save("kyg-user", null); setUser(null); flash("Signed out"); };

  // Apply filters
  const matches = g =>
    (filters.sport === "ALL" || g.league === filters.sport) &&
    (filters.team === "ALL" || g.home === filters.team || g.away === filters.team) &&
    (filters.city === "ALL" || g.city === filters.city);

  // Live schedule for today (WNBA + MLB). World Cup stays curated.
  const { liveEvents: appLiveEvents, status: appLiveStatus } = useLiveSchedule();
  const todayK = todayKey();
  const liveToday = (appLiveEvents && appLiveEvents[todayK]) ? appLiveEvents[todayK] : [];

  // Curated games for today (with verdicts, blurbs, featured flags)
  const curatedToday = GAMES.filter(g => g.dateKey === todayK);
  const curatedKeys = new Set(curatedToday.map(g => `${g.league}:${g.homeAbbr || g.home}:${g.awayAbbr || g.away}`));

  // Live games not already covered by a curated entry → fill the slate
  const liveExtras = liveToday
    .filter(e => !curatedKeys.has(`${e.league}:${e.homeAbbr || e.home}:${e.awayAbbr || e.away}`))
    .map(e => ({
      id: `live-${e.league}-${e.homeAbbr}-${e.awayAbbr}`,
      league: e.league, city: e.home, // city best-effort
      home: e.home, homeAbbr: e.homeAbbr, away: e.away, awayAbbr: e.awayAbbr,
      time: e.time, day: "Today", dateKey: e.dateKey,
      status: "upcoming", verdict: e.verdict || 3,
      tagline: "", summary: "",
      channel: "", channelUrl: "",
      fromApi: true,
    }));

  // Build the Today sections from curated + live, then filter
  // Curated World Cup games for today come from CAL_EVENTS (WC is paid-tier
  // on the API, so it's hand-maintained). Convert to the Today game shape.
  const curatedWCToday = (CAL_EVENTS[todayK] || [])
    .filter(e => e.league === "WC")
    .map(e => ({
      id: `wc-${e.homeAbbr || e.home}-${e.awayAbbr || e.away}`,
      league: "WC", city: e.home,
      home: e.home, homeAbbr: e.homeAbbr, away: e.away, awayAbbr: e.awayAbbr,
      time: e.time, day: "Today", dateKey: todayK,
      status: "upcoming", verdict: e.verdict || 3,
      tagline: "", summary: e.note || "",
      channel: e.channel || "", channelUrl: "",
    }));

  const allToday = [...GAMES, ...curatedWCToday, ...liveExtras];
  const visible = allToday.filter(matches);
  let hero = visible.find(g => g.featured && g.dateKey === todayK);
  const live = visible.filter(g => g.status === "live" && g.dateKey === todayK);
  const todayNonHero = visible.filter(g => g.dateKey === todayK && g !== hero && g.status !== "live");

  // If no curated Editor's Pick exists for today, promote the highest-verdict
  // game (live or curated) so the Today tab always has a hero.
  if (!hero) {
    const candidates = visible
      .filter(g => g.dateKey === todayK && g.status !== "live")
      .sort((a,b) => b.verdict - a.verdict);
    hero = candidates[0] || null;
  }
  const restPool = visible.filter(g => g.dateKey === todayK && g !== hero && g.status !== "live");
  const rest = restPool.filter(g => g.verdict >= 3).sort((a,b)=>b.verdict-a.verdict);

  // The full remaining slate — condensed grey one-liners (lower-stakes games)
  const otherMatches = g =>
    (filters.sport === "ALL" || g.league === filters.sport) &&
    (filters.team === "ALL" || g.home === filters.team || g.away === filters.team) &&
    (filters.city === "ALL" || g.city === filters.city);
  const otherGames = restPool.filter(g => g.verdict <= 2).filter(otherMatches);

  const starCount = (stars.leagues?.length||0) + (stars.teams?.length||0);
  const alertCount = gameAlerts.length + calAlerts.length;

  const TABS = [
    { id: "today", label: "Today" },
    { id: "calendar", label: "Calendar" },
    { id: "standings", label: "Standings" },
    { id: "players", label: "Players" },
    { id: "alerts", label: `Alerts${alertCount?` · ${alertCount}`:""}` },
    { id: "edit", label: "Follow ★" },
    { id: "101", label: "Sports 101" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif" }}>
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(0.85)} }
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        button:hover { filter: brightness(0.97); }
        a:hover { opacity: 0.9; }
        input:focus { border-color: ${C.red} !important; }
        ::-webkit-scrollbar { height: 0; }
        @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
      `}</style>

      <UpdateBanner
        visible={updateAvailable && !updateDismissed}
        onRefresh={() => window.location.reload()}
        onDismiss={() => setUpdateDismissed(true)}
      />

      <header style={{ background: C.red, position: "sticky", top: 0, zIndex: 100, boxShadow: "0 2px 10px rgba(200,16,46,0.2)" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, paddingTop: 13, paddingBottom: 9 }}>
            <div>
              <div style={{ fontSize: 21, fontWeight: 900, color: "#fff", letterSpacing: "-0.03em", lineHeight: 1 }}>KNOW YOUR GAME</div>
              <div style={{ fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,0.75)", letterSpacing: "0.12em", marginTop: 2 }}>SPORTS FOR THE REST OF US</div>
            </div>
            {live.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(0,0,0,0.2)", borderRadius: 20, padding: "4px 12px" }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#fff", animation: "pulse 1.4s infinite" }} />
                <span style={{ fontSize: 11, fontWeight: 800, color: "#fff", letterSpacing: "0.08em" }}>{live.length} LIVE</span>
              </div>
            )}
            <div style={{ marginLeft: "auto" }}>
              {user ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 32, height: 32, borderRadius: "50%", background: "rgba(255,255,255,0.25)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 800, color: "#fff" }}>{user.name?.[0]?.toUpperCase()}</div>
                  <button onClick={handleLogout} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.4)", color: "#fff", borderRadius: 6, padding: "5px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Sign out</button>
                </div>
              ) : (
                <button onClick={() => setShowLogin(true)} style={{ background: "#fff", color: C.red, border: "none", borderRadius: 6, padding: "7px 16px", fontSize: 13, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>Sign in</button>
              )}
            </div>
          </div>
          <nav style={{ display: "flex", overflowX: "auto" }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                padding: "10px 16px 11px", background: "none", border: "none", cursor: "pointer",
                fontSize: 13, fontWeight: 700, fontFamily: "inherit",
                color: tab === t.id ? "#fff" : "rgba(255,255,255,0.62)",
                borderBottom: tab === t.id ? "3px solid #fff" : "3px solid transparent", whiteSpace: "nowrap",
              }}>{t.label}</button>
            ))}
          </nav>
        </div>
      </header>

      <main style={{ maxWidth: 760, margin: "0 auto", padding: "22px 18px 80px" }}>
        {tab === "today" && (
          <>
            <WeekRundown />
            <FilterBar filters={filters} setFilters={setFilters} />
            {appLiveStatus === "done" && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14, fontSize: 11, color: C.inkFaint, fontWeight: 600 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#21A35A", display: "inline-block", flexShrink: 0 }} />
                Live schedule connected
              </div>
            )}
            {hero && <HeroCard game={hero} alertOn={gameAlerts.includes(hero.id)} onAlert={toggleGameAlert} />}
            {live.length > 0 && (
              <div style={{ marginBottom: 22 }}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.12em", color: C.red, marginBottom: 12 }}>● HAPPENING NOW</div>
                {live.map(g => <GameCard key={g.id} game={g} alertOn={gameAlerts.includes(g.id)} onAlert={toggleGameAlert} />)}
              </div>
            )}
            <div>
              {(hero || live.length > 0) && <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.12em", color: C.inkFaint, marginBottom: 12 }}>REST OF THE SLATE</div>}
              {rest.length ? rest.map(g => <GameCard key={g.id} game={g} alertOn={gameAlerts.includes(g.id)} onAlert={toggleGameAlert} />)
                : !hero && live.length === 0 && otherGames.length === 0 && (
                  <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 32, textAlign: "center", color: C.inkDim, fontSize: 14 }}>
                    No games match your filters. <span onClick={() => setFilters({sport:"ALL",team:"ALL",city:"ALL"})} style={{ color: C.red, fontWeight: 700, cursor: "pointer" }}>Clear filters</span>
                  </div>
                )}
            </div>

            {/* Everything else — condensed grey one-liners */}
            {otherGames.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.12em", color: C.inkFaint, marginBottom: 4 }}>
                  EVERYTHING ELSE ON
                </div>
                <div style={{ fontSize: 12, color: C.inkFaint, marginBottom: 12 }}>
                  The rest of the slate — lower-stakes games, so you don't miss your team.
                </div>
                <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
                  {otherGames.map((g, i) => (
                    <a key={g.id} href={g.channelUrl} target="_blank" rel="noopener noreferrer" style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "11px 14px",
                      borderTop: i === 0 ? "none" : `1px solid ${C.lineSoft}`, textDecoration: "none",
                    }}>
                      <span style={{ fontSize: 8, fontWeight: 800, color: "#fff", background: LEAGUE_COLORS[g.league], borderRadius: 3, padding: "2px 5px", flexShrink: 0 }}>{g.league}</span>
                      <span style={{ fontSize: 13, color: C.inkMid, fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {g.away} at {g.home}
                      </span>
                      <span style={{ fontSize: 11, color: C.inkFaint, flexShrink: 0 }}>{g.time}</span>
                      <span style={{ fontSize: 11, color: C.inkFaint, flexShrink: 0 }}>›</span>
                    </a>
                  ))}
                </div>
              </div>
            )}

            <InstallPrompt compact />
          </>
        )}
        {tab === "calendar" && <CalendarTab alerts={calAlerts} onAlert={toggleCalAlert} />}
        {tab === "standings" && <StandingsTab />}
        {tab === "players" && <PlayersTab />}
        {tab === "alerts" && <AlertsTab prefs={prefs} onPrefChange={prefChange} gameAlerts={gameAlerts} calAlerts={calAlerts} />}
        {tab === "edit" && <EditTab stars={stars} onToggleLeague={toggleLeague} onToggleTeam={toggleTeam} />}
        {tab === "101" && <Sports101Tab />}
      </main>

      {showLogin && <LoginModal onClose={() => setShowLogin(false)} onLogin={handleLogin} />}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: C.ink, color: "#fff", borderRadius: 8, padding: "11px 22px", fontSize: 13, fontWeight: 600, boxShadow: "0 10px 40px rgba(20,32,43,0.25)", whiteSpace: "nowrap", zIndex: 300 }}>{toast}</div>
      )}
    </div>
  );
}
