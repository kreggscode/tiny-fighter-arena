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

const BATTLE_SYSTEM =
  "You are the commentator and referee of a tiny fighting arena. Reply with ONLY a JSON object, no prose, no code fences. " +
  'Schema: {"playerDealt":integer,"enemyDealt":integer,"playerAction":string,"enemyAction":string,"commentary":string}. ' +
  "playerDealt is damage the player's fighter DEALT to the enemy; enemyDealt is the reverse. " +
  "Each is 0 to 18. Both fighters act every round; the faster one acts first, which you show in commentary. " +
  "Damage must follow from the fighters' designs and abilities, not random numbers. " +
  "The player's one-line description is a real design brief: when it suggests a concrete advantage " +
  "against this particular enemy, let it pay off with higher damage and say why. Vague descriptions underperform. " +
  "commentary is one or two punchy sentences of arena commentary. Keep it fun and clean.";

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

// 3. Three battle rounds
let playerHp = 100;
let enemyHp = 100;
for (let round = 1; round <= 3; round++) {
  const user =
    "Round " + round + "\n\nPLAYER LINE: " + LINE + "\n\nPLAYER FIGHTER: " + JSON.stringify(fighterRaw) +
    "\nPlayer HP: " + playerHp + "/100\n\nENEMY FIGHTER: " + JSON.stringify(enemyRaw) +
    "\nEnemy HP: " + enemyHp + "/100\n\nLadder rung 2 of 5.";
  const b = extractJson(await chat(BATTLE_SYSTEM, user));

  const dealt = clamp(num(b.playerDealt, 0), 0, 18);
  const taken = clamp(num(b.enemyDealt, 0), 0, 18);
  assert.strictEqual(typeof b.playerAction, "string", "playerAction missing");
  assert.strictEqual(typeof b.enemyAction, "string", "enemyAction missing");
  assert.strictEqual(typeof b.commentary, "string", "commentary missing");
  assert.ok(dealt >= 0 && dealt <= 18, "playerDealt out of range: " + b.playerDealt);
  assert.ok(taken >= 0 && taken <= 18, "enemyDealt out of range: " + b.enemyDealt);

  enemyHp = Math.max(0, enemyHp - dealt);
  playerHp = Math.max(0, playerHp - taken);
  results.push("round " + round + " dealt=" + dealt + " taken=" + taken + " | " + String(b.commentary).slice(0, 90));
}

results.push("final HP player=" + playerHp + " enemy=" + enemyHp);
console.log("PASS\n" + results.map((r) => "  " + r).join("\n"));
