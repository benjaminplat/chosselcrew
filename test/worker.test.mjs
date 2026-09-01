import worker from "../worker/worker.js";
import assert from "node:assert";

// Mini KV-mock
const kv = new Map();
const env = {
  GEGL_KV: {
    get: async (k) => kv.get(k) ?? null,
    put: async (k, v) => kv.set(k, v),
  },
  ADMIN_CODE: "1301",
};

async function call(method, path, { body, admin } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (admin) headers["X-Admin-Code"] = admin === true ? env.ADMIN_CODE : admin;
  const req = new Request("https://x.test" + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env);
  return { status: res.status, data: await res.json().catch(() => null) };
}

// 1. Beginstand: 8 vaste spelers, vergrendeld, geen stemmen
let r = await call("GET", "/state");
assert.equal(r.status, 200);
assert.equal(r.data.players.length, 8);
assert.equal(r.data.revealed, false);
assert.equal(r.data.voting.total, 0);
const ids = r.data.players.map((p) => p.id);

// 2. Stemmen: 2 per vraag, zichtbaar in aggregaten (zonder individuele keuzes)
r = await call("POST", "/vote", { body: { voter: "Ben", first: [ids[0], ids[1]], last: [ids[6], ids[7]] } });
assert.equal(r.status, 200, JSON.stringify(r.data));
r = await call("POST", "/vote", { body: { voter: "Daan", first: [ids[0], ids[2]], last: [ids[5], ids[7]] } });
assert.equal(r.status, 200);
r = await call("GET", "/state");
assert.equal(r.data.voting.total, 2);
assert.equal(r.data.voting.firstCounts[ids[0]], 2);
assert.equal(r.data.voting.firstCounts[ids[1]], 1);
assert.equal(r.data.voting.lastCounts[ids[7]], 2);
assert.ok(r.data.voting.voters.includes("Ben"));
assert.ok(!("votes" in r.data)); // individuele keuzes lekken niet naar buiten

// 3. Stem wijzigen: zelfde naam overschrijft (totaal blijft 2)
r = await call("POST", "/vote", { body: { voter: "ben", first: [ids[1], ids[2]], last: [ids[6], ids[7]] } });
assert.equal(r.status, 200);
r = await call("GET", "/state");
assert.equal(r.data.voting.total, 2);
assert.equal(r.data.voting.firstCounts[ids[0]], 1);
assert.equal(r.data.voting.firstCounts[ids[1]], 1);
assert.equal(r.data.voting.firstCounts[ids[2]], 2);

// 4. Ongeldige stemmen geweigerd
r = await call("POST", "/vote", { body: { voter: "", first: [ids[0], ids[1]], last: [ids[2], ids[3]] } });
assert.equal(r.status, 400);
r = await call("POST", "/vote", { body: { voter: "Tim", first: [ids[0]], last: [ids[2], ids[3]] } });
assert.equal(r.status, 400); // maar 1 naam bij "eerste"
r = await call("POST", "/vote", { body: { voter: "Tim", first: [ids[0], ids[0]], last: [ids[2], ids[3]] } });
assert.equal(r.status, 400); // 2x dezelfde binnen één vraag
r = await call("POST", "/vote", { body: { voter: "Tim", first: [ids[0], ids[1]], last: [ids[1], ids[3]] } });
assert.equal(r.status, 400); // zelfde persoon bij eerste én laatste
r = await call("POST", "/vote", { body: { voter: "Tim", first: ["nep", ids[1]], last: [ids[2], ids[3]] } });
assert.equal(r.status, 400);

// 5. Reveal: alleen admin, aan en uit
r = await call("POST", "/reveal", { body: { revealed: true } });
assert.equal(r.status, 401);
r = await call("POST", "/reveal", { body: { revealed: true }, admin: "fout" });
assert.equal(r.status, 401);
r = await call("POST", "/reveal", { body: { revealed: true }, admin: true });
assert.equal(r.status, 200);
r = await call("GET", "/state");
assert.equal(r.data.revealed, true);
r = await call("POST", "/reveal", { body: { revealed: false }, admin: true });
assert.equal(r.status, 200);
r = await call("GET", "/state");
assert.equal(r.data.revealed, false);

// 6. Ronde: alleen admin, volledige permutatie van de 8 vaste ids
r = await call("POST", "/round", { body: { round: 1, ranking: ids } });
assert.equal(r.status, 401);
r = await call("POST", "/round", { body: { round: 1, ranking: ids.slice(0, 5) }, admin: true });
assert.equal(r.status, 400);
r = await call("POST", "/round", { body: { round: 1, ranking: [...ids.slice(1), ids[0]] }, admin: true });
assert.equal(r.status, 200);
r = await call("POST", "/round", { body: { round: 0, ranking: [] }, admin: true });
assert.equal(r.status, 400); // ook de admin-code-check van de frontend

// 7. Ronde overschrijven mag
const reversed = [...ids].reverse();
r = await call("POST", "/round", { body: { round: 1, ranking: reversed }, admin: true });
assert.equal(r.status, 200);
r = await call("GET", "/state");
assert.deepEqual(r.data.rounds["1"], reversed);

// 8. Puntberekening (zelfde logica als frontend): 2/1/…/1/2
function computeScores(players, rounds) {
  const scores = Object.fromEntries(players.map((id) => [id, 0]));
  for (const ranking of Object.values(rounds)) {
    const n = ranking.length;
    if (n < 4) continue;
    ranking.forEach((id, i) => {
      const pos = i + 1;
      if (pos === 1 || pos === n) scores[id] += 2;
      else if (pos === 2 || pos === n - 1) scores[id] += 1;
    });
  }
  return scores;
}
let scores = computeScores(ids, { 1: reversed });
assert.equal(scores[ids[7]], 2); // eerste
assert.equal(scores[ids[6]], 1); // tweede
assert.equal(scores[ids[1]], 1); // zevende
assert.equal(scores[ids[0]], 2); // laatste
assert.equal(scores[ids[3]], 0); // veilig midden

// 9. Timer: starten, ongeldig geweigerd, ronde-invoer wist hem, 0 = stop
r = await call("POST", "/timer", { body: { round: 3, seconds: 60 }, admin: true });
assert.equal(r.status, 200);
assert.ok(r.data.timer.endsAt > Date.now());
r = await call("POST", "/timer", { body: { round: 3, seconds: 9999 }, admin: true });
assert.equal(r.status, 400);
r = await call("POST", "/timer", { body: { round: 3, seconds: 30 } });
assert.equal(r.status, 401);
r = await call("POST", "/round", { body: { round: 3, ranking: ids }, admin: true });
assert.equal(r.status, 200);
r = await call("GET", "/state");
assert.equal(r.data.timer, null);
r = await call("POST", "/timer", { body: { round: 4, seconds: 30 }, admin: true });
assert.equal(r.status, 200);
r = await call("POST", "/timer", { body: { round: 4, seconds: 0 }, admin: true });
assert.equal(r.status, 200);
r = await call("GET", "/state");
assert.equal(r.data.timer, null);

// 10. Reset: wist stemmen/rondes/timer en vergrendelt weer; spelers blijven
r = await call("POST", "/reveal", { body: { revealed: true }, admin: true });
r = await call("POST", "/reset", { admin: true });
assert.equal(r.status, 200);
r = await call("GET", "/state");
assert.equal(r.data.voting.total, 0);
assert.deepEqual(r.data.rounds, {});
assert.equal(r.data.revealed, false);
assert.equal(r.data.players.length, 8);

console.log("✅ Alle tests geslaagd (stemmen, reveal, rondes, timer, reset)");
