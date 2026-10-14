// Generates demo.json from a real model run so ?demo=1 renders genuine output.
// Run with: POLLINATIONS_API_KEY=sk_... node tests/make_demo.mjs
import { writeFileSync } from "node:fs";

const KEY = process.env.POLLINATIONS_API_KEY;
if (!KEY) {
  console.error("POLLINATIONS_API_KEY is required");
  process.exit(1);
}

const API = "https://gen.pollinations.ai/v1/chat/completions";
const MODEL = "nova-fast";
const MAX_HP = 100;

const FIGHTER_SYSTEM =
  "You design fighting-game characters. Reply with ONLY a JSON object, no prose, no code fences. " +
  'Schema: {"name":string,"epithet":string,"look":string,"style":string,"quirk":string,' +
  '"abilities":string[3],"stats":{"power":1-10,"defense":1-10,"speed":1-10,"wit":1-10}}. ' +
  "Keep look under 30 words. abilities are short combat moves, not adjectives.";

// Mirrors app.js: the round is decided by a seeded engine, the model only narrates it.
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

const initiative = (f) => f.stats.speed + f.stats.wit / 2;

async function chat(system, user) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: JSON.stringify({ model: MODEL, max_tokens: 700, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("HTTP " + res.status + ": " + JSON.stringify(data).slice(0, 200));
  return data.choices?.[0]?.message?.content || "";
}

function extractJson(text) {
  let s = String(text).trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last <= first) throw new Error("no JSON in reply");
  return JSON.parse(s.slice(first, last + 1));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const playerLine = "a shy storm cloud that apologises before it strikes";

const player = extractJson(
  await chat(FIGHTER_SYSTEM, "Design this fighter from the line below. Make the abilities and stats a direct consequence of it.\n\nLine: " + playerLine),
);
const enemy = extractJson(
  await chat(FIGHTER_SYSTEM, 'Design a seasoned contender for ladder rung 2 of 5. Counterpoint to: "' + playerLine + '". Escalate stats.'),
);

let playerHp = MAX_HP;
let enemyHp = MAX_HP;
const rounds = [];
const RUNG = 2;
const SEED = (Math.random() * 0xffffffff) >>> 0;
const rng = mulberry32((SEED ^ Math.imul(RUNG, 0x9e3779b1)) >>> 0);

for (let round = 1; round <= 3 && playerHp > 0 && enemyHp > 0; round++) {
  const playerFirst = initiative(player) >= initiative(enemy);
  const dealt = rollDamage(player, enemy, rng);
  const taken = rollDamage(enemy, player, rng);
  enemyHp = Math.max(0, enemyHp - dealt);
  playerHp = Math.max(0, playerHp - taken);

  const user =
    "Round " + round + "\n\nDECIDED OUTCOME - describe this, do not alter it:\n" +
    "- " + (playerFirst ? player.name : enemy.name) + " moved first\n" +
    "- " + player.name + " dealt " + dealt + " damage\n" +
    "- " + enemy.name + " dealt " + taken + " damage\n" +
    "- " + player.name + " is now on " + playerHp + "/" + MAX_HP + " hp\n" +
    "- " + enemy.name + " is now on " + enemyHp + "/" + MAX_HP + " hp\n\n" +
    "PLAYER LINE: " + playerLine + "\n\nPLAYER FIGHTER: " + JSON.stringify(player) +
    "\n\nENEMY FIGHTER: " + JSON.stringify(enemy) + "\n\nLadder rung " + RUNG + " of 5.";

  const b = extractJson(await chat(BATTLE_SYSTEM, user));
  rounds.push({ round, playerDealt: dealt, enemyDealt: taken, playerAction: b.playerAction, enemyAction: b.enemyAction, commentary: b.commentary });
}

const demo = { playerLine, player, enemy, rung: 1, seed: SEED, playerHp, enemyHp, rounds };
writeFileSync("demo.json", JSON.stringify(demo, null, 2) + "\n");

console.log("wrote demo.json");
console.log("  " + player.name + " vs " + enemy.name);
console.log("  rounds: " + rounds.length + "   hp: player=" + playerHp + " enemy=" + enemyHp);
