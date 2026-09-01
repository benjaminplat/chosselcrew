/**
 * GEGL Chosselcrew — Cloudflare Worker backend
 *
 * De 8 spelers staan vast (hieronder). Opslag: één JSON-object in KV onder "state".
 * Endpoints:
 *   GET  /state   -> spelers, ronde-uitslagen, timer en stem-aggregaten
 *   POST /vote    -> { voter, first: [2 ids], last: [2 ids] } — 4 stemmen ("nooit op 1 paard wedden"), wijzigen mag
 *   POST /round   -> { round: 1..10, ranking: [8 playerIds] }              (admin)
 *   POST /timer   -> { round, seconds } gedeelde countdown; seconds 0 stopt (admin)
 *   POST /reveal  -> { revealed: true|false } ont-/vergrendelt de app       (admin)
 *   POST /reset   -> wist stemmen, rondes, timer en vergrendelt weer        (admin)
 *
 * Admin-endpoints vereisen de header X-Admin-Code, gelijk aan het Worker-secret
 * ADMIN_CODE (zet met: wrangler secret put ADMIN_CODE). De code staat dus nooit
 * in de code of de frontend-repo.
 */

const PLAYERS = [
  { id: "doedelzakje", name: "Mr. Doedelzakje" },
  { id: "piraatlarzz", name: "Piraatlarzz" },
  { id: "rikcement", name: "RikCement" },
  { id: "nabil", name: "Nabil Amzieb" },
  { id: "ekteboyas", name: "EkteBoyas" },
  { id: "regenmortel", name: "Regenmortel-Solutions" },
  { id: "demanager", name: "De manager" },
  { id: "appno", name: "Appno" },
];
const PLAYER_IDS = new Set(PLAYERS.map((p) => p.id));

const NUM_ROUNDS = 10;
const MAX_NAME_LENGTH = 20;
const MAX_VOTERS = 100;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Code",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

async function loadState(env) {
  const raw = await env.GEGL_KV.get("state");
  const empty = { votes: {}, rounds: {}, timer: null, revealed: false };
  if (!raw) return empty;
  try {
    const state = JSON.parse(raw);
    return {
      votes: state.votes && typeof state.votes === "object" ? state.votes : {},
      rounds: state.rounds && typeof state.rounds === "object" ? state.rounds : {},
      timer: state.timer && typeof state.timer === "object" ? state.timer : null,
      revealed: state.revealed === true,
    };
  } catch {
    return empty;
  }
}

async function saveState(env, state) {
  state.updatedAt = new Date().toISOString();
  await env.GEGL_KV.put("state", JSON.stringify(state));
}

function isAdmin(request, env) {
  const code = request.headers.get("X-Admin-Code") || "";
  return Boolean(env.ADMIN_CODE) && code === env.ADMIN_CODE;
}

/* Alleen aggregaten naar buiten: wie wat stemde blijft geheim. */
function votingSummary(votes) {
  const firstCounts = {};
  const lastCounts = {};
  for (const p of PLAYERS) { firstCounts[p.id] = 0; lastCounts[p.id] = 0; }
  const voters = [];
  for (const v of Object.values(votes)) {
    if (!v) continue;
    const firsts = Array.isArray(v.first) ? v.first : [v.first];
    const lasts = Array.isArray(v.last) ? v.last : [v.last];
    for (const id of firsts) if (PLAYER_IDS.has(id)) firstCounts[id]++;
    for (const id of lasts) if (PLAYER_IDS.has(id)) lastCounts[id]++;
    if (v.name) voters.push(v.name);
  }
  return { firstCounts, lastCounts, total: voters.length, voters };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // ---- GET /state ----------------------------------------------------
      if (request.method === "GET" && path === "/state") {
        const state = await loadState(env);
        return json({
          players: PLAYERS,
          rounds: state.rounds,
          timer: state.timer,
          revealed: state.revealed,
          voting: votingSummary(state.votes),
        });
      }

      // ---- POST /vote (open) ----------------------------------------------
      if (request.method === "POST" && path === "/vote") {
        const body = await request.json().catch(() => ({}));
        const voter = String(body.voter || "").trim().slice(0, MAX_NAME_LENGTH);
        const first = Array.isArray(body.first) ? body.first.map(String) : [];
        const last = Array.isArray(body.last) ? body.last.map(String) : [];
        if (!voter) return error("Vul eerst je naam in.");
        const validPair = (arr) =>
          arr.length === 2 && new Set(arr).size === 2 && arr.every((id) => PLAYER_IDS.has(id));
        if (!validPair(first) || !validPair(last)) {
          return error("Kies bij beide vragen precies 2 geldige namen.");
        }
        if (first.some((id) => last.includes(id))) {
          return error("Je kunt niet op dezelfde persoon voor eerste én laatste wedden.");
        }
        const state = await loadState(env);
        const key = voter.toLowerCase();
        if (!state.votes[key] && Object.keys(state.votes).length >= MAX_VOTERS) {
          return error("Het maximum aantal stemmers is bereikt.", 409);
        }
        state.votes[key] = { name: voter, first, last, at: new Date().toISOString() };
        await saveState(env, state);
        return json({ ok: true, voting: votingSummary(state.votes) });
      }

      // ---- Admin-endpoints -------------------------------------------------
      if (request.method === "POST" && ["/round", "/timer", "/reveal", "/reset"].includes(path)) {
        if (!isAdmin(request, env)) {
          return error("Ongeldige admin-code.", 401);
        }

        const state = await loadState(env);

        if (path === "/reset") {
          await saveState(env, { votes: {}, rounds: {}, timer: null, revealed: false });
          return json({ ok: true });
        }

        const body = await request.json().catch(() => ({}));

        if (path === "/reveal") {
          state.revealed = body.revealed === true;
          await saveState(env, state);
          return json({ ok: true, revealed: state.revealed });
        }

        if (path === "/timer") {
          const round = Number(body.round);
          const seconds = Number(body.seconds);
          if (!Number.isInteger(round) || round < 1 || round > NUM_ROUNDS) {
            return error(`Ronde moet tussen 1 en ${NUM_ROUNDS} liggen.`);
          }
          if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) {
            return error("Seconden moeten tussen 0 en 3600 liggen.");
          }
          state.timer = seconds > 0
            ? { round, endsAt: Date.now() + seconds * 1000 }
            : null;
          await saveState(env, state);
          return json({ ok: true, timer: state.timer });
        }

        if (path === "/round") {
          const round = Number(body.round);
          const ranking = Array.isArray(body.ranking) ? body.ranking.map(String) : [];

          if (!Number.isInteger(round) || round < 1 || round > NUM_ROUNDS) {
            return error(`Ronde moet tussen 1 en ${NUM_ROUNDS} liggen.`);
          }
          const unique = new Set(ranking);
          if (
            ranking.length !== PLAYERS.length ||
            unique.size !== ranking.length ||
            !ranking.every((id) => PLAYER_IDS.has(id))
          ) {
            return error(`Ranking moet alle ${PLAYERS.length} spelers precies één keer bevatten.`);
          }

          state.rounds[String(round)] = ranking;
          if (state.timer && state.timer.round === round) state.timer = null;
          await saveState(env, state);
          return json({ ok: true, round, ranking });
        }
      }

      return error("Niet gevonden.", 404);
    } catch (err) {
      return error("Serverfout: " + (err && err.message ? err.message : "onbekend"), 500);
    }
  },
};
