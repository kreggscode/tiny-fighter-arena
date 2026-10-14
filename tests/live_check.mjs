// Live check for the arena's model contract. Run with:
//   POLLINATIONS_API_KEY=sk_... node tests/live_check.mjs
// Verifies the two schemas the game depends on actually come back as parseable
// JSON from the model, with the clamps the client applies.
import assert from "node:assert";

const KEY = process.env.POLLINATIONS_API_KEY;
if (!KEY) {
  console.error("POLLINATIONS_API_KEY is required");
  process.exit(1);
}

const API = "https://gen.pollinations.ai/v1/chat/completions";
const MODEL = "nova-fast";

const FIGHTER_SYSTEM =
  "You design fighting-game characters. Reply with ONLY a JSON object, no prose, no code fences. " +
  'Schema: {"name":string,"epithet":string,"look":string,"style":string,"quirk":string,' +
  '"abilities":string[3],"stats":{"power":1-10,"defense":1-10,"speed":1-10,"wit":1-10}}. ' +
  "Keep look under 30 words. abilities are short combat moves, not adjectives.";

// Mirrors app.js: the fight is decided by a seeded engine, the model narrates.
const BATTLE_SYSTEM =
  "You are the arena commentator of a tiny fighting arena. The fight is decided by a seeded rules engine before " +
  "you ever see it: you describe what happened, you never decide it. Reply with ONLY a JSON object, no prose, no code fences. " +
  'Schema: {"playerAction":string,"enemyAction":string,"commentary":string}. ' +
  "The referee hands you an outcome and the resulting HP totals. Reflect it exactly as given: the damage numbers and " +
  "who is winning are not yours to change, and you never declare the result of the fight yourself. " +
  "Both fighters act every round and you are told which moved first - show that in the commentary. " +
  "Ground the action in the fighters' designs, abilities and quirks, so a clever one-line brief visibly pays off. " +
  "playerAction and enemyAction are the single move that fighter used. commentary is one or two punchy sentences. " +
  "Keep it fun and clean.";

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rollDamage(attacker, defender, rng) {
  const attack = attacker.stats.power + attacker.stats.wit * 0.3;
  const mitigation = defender.stats.defense * 0.55;
  const variance = rng() * 5 - 2;
  const crit = rng() < attacker.stats.wit / 40 ? 3 : 0;
  return clamp(Math.round(attack - mitigation + variance + crit), 0, 18);
}

function initiative(fighter) {
  return fighter.stats.speed + fighter.stats.wit / 2;
}

async function chat(system, user) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 700,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const data = await res.json();
  assert.ok(res.ok, "HTTP " + res.status + ": " + JSON.stringify(data).slice(0, 200));
  const content = data.choices?.[0]?.message?.content;
  assert.ok(content, "empty content");
  return content;
}

// Mirrors app.js extractJson: fences stripped, first object taken.
function extractJson(text) {
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  assert.ok(first !== -1 && last > first, "no JSON object found in reply");
  return JSON.parse(s.slice(first, last + 1));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, f) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : f);

const results = [];

// 1. Fighter design from a one-line brief
const LINE = "a rusty clockwork knight who fights with falling clock hands";
const fighterRaw = extractJson(
  await chat(FIGHTER_SYSTEM, "Design this fighter from the line below. Make the abilities and stats a direct consequence of it.\n\nLine: " + LINE),
);
for (const field of ["name", "epithet", "look", "style", "quirk"]) {
  assert.strictEqual(typeof fighterRaw[field], "string", "fighter." + field + " not a string: " + JSON.stringify(fighterRaw).slice(0, 200));
}
assert.ok(Array.isArray(fighterRaw.abilities) && fighterRaw.abilities.length >= 3, "abilities missing");
assert.ok(typeof fighterRaw.stats === "object", "stats missing");
for (const s of ["power", "defense", "speed", "wit"]) {
  const v = clamp(num(fighterRaw.stats[s], 5), 1, 10);
  assert.ok(v >= 1 && v <= 10, "stat " + s + " out of range: " + fighterRaw.stats[s]);
}
results.push("fighter schema OK -> " + fighterRaw.name);

// 2. Enemy design
const enemyRaw = extractJson(await chat(FIGHTER_SYSTEM, 'Design a seasoned contender for ladder rung 2 of 5. Counterpoint to: "' + LINE + '". Escalate stats.'));
assert.strictEqual(typeof enemyRaw.name, "string");
results.push("enemy schema OK   -> " + enemyRaw.name);

// 3. Three battle rounds: the engine decides, the model only narrates.
let playerHp = 100;
let enemyHp = 100;
const RUNG = 2;
const SEED = 0x5eed1234;
const rng = mulberry32((SEED ^ Math.imul(RUNG, 0x9e3779b1)) >>> 0);
const dealtSeen = [];
const takenSeen = [];

for (let round = 1; round <= 3; round++) {
  const playerFirst = initiative(fighterRaw) >= initiative(enemyRaw);
  const dealt = rollDamage(fighterRaw, enemyRaw, rng);
  const taken = rollDamage(enemyRaw, fighterRaw, rng);
  assert.ok(dealt >= 0 && dealt <= 18, "engine damage out of range: " + dealt);
  assert.ok(taken >= 0 && taken <= 18, "engine damage out of range: " + taken);

  enemyHp = Math.max(0, enemyHp - dealt);
  playerHp = Math.max(0, playerHp - taken);

  const user =
    "Round " + round + "\n\nDECIDED OUTCOME - describe this, do not alter it:\n" +
    "- " + (playerFirst ? fighterRaw.name : enemyRaw.name) + " moved first\n" +
    "- " + fighterRaw.name + " dealt " + dealt + " damage\n" +
    "- " + enemyRaw.name + " dealt " + taken + " damage\n" +
    "- " + fighterRaw.name + " is now on " + playerHp + "/100 hp\n" +
    "- " + enemyRaw.name + " is now on " + enemyHp + "/100 hp\n\n" +
    "PLAYER LINE: " + LINE + "\n\nPLAYER FIGHTER: " + JSON.stringify(fighterRaw) +
    "\n\nENEMY FIGHTER: " + JSON.stringify(enemyRaw) + "\n\nLadder rung " + RUNG + " of 5.";

  const b = extractJson(await chat(BATTLE_SYSTEM, user));

  // Narration only. The model must not carry damage fields of its own.
  assert.strictEqual(typeof b.playerAction, "string", "playerAction missing");
  assert.strictEqual(typeof b.enemyAction, "string", "enemyAction missing");
  assert.strictEqual(typeof b.commentary, "string", "commentary missing");
  assert.strictEqual(b.playerDealt, undefined, "model returned playerDealt - it must not referee");
  assert.strictEqual(b.enemyDealt, undefined, "model returned enemyDealt - it must not referee");

  dealtSeen.push(dealt);
  takenSeen.push(taken);
  results.push("round " + round + " engine dealt=" + dealt + " taken=" + taken + " | " + String(b.commentary).slice(0, 80));
}

// 4. Determinism: the same seed replays the same fight, in the same order.
const replay = mulberry32((SEED ^ Math.imul(RUNG, 0x9e3779b1)) >>> 0);
const replayed = [];
for (let i = 0; i < 3; i++) {
  replayed.push(rollDamage(fighterRaw, enemyRaw, replay), rollDamage(enemyRaw, fighterRaw, replay));
}
const expected = dealtSeen.flatMap((d, i) => [d, takenSeen[i]]);
assert.deepStrictEqual(replayed, expected, "same seed did not reproduce the same fight");
results.push("determinism ok: seed replayed " + dealtSeen.join(",") + "/" + takenSeen.join(","));

results.push("final HP player=" + playerHp + " enemy=" + enemyHp);
console.log("PASS\n" + results.map((r) => "  " + r).join("\n"));
