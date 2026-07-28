// api/standings.js — returns the cached, auto-refreshed WNBA + MLB standings.
// The app falls back to its built-in table when data is empty.

export const config = { runtime: 'edge' };

export default async function handler() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=600, stale-while-revalidate=3600' };

  if (!supabaseUrl || !supabaseKey) {
    return new Response(JSON.stringify({ data: null }), { status: 200, headers });
  }

  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/app_cache?key=eq.standings&select=value,updated_at`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    });
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    return new Response(JSON.stringify({ data: (row && row.value) || null, updated_at: row && row.updated_at }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ data: null, error: String(err) }), { status: 200, headers });
  }
}
