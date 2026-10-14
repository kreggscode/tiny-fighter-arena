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
const num = (v, f) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : f);

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

for (let round = 1; round <= 3 && playerHp > 0 && enemyHp > 0; round++) {
  const user =
    "Round " + round + "\n\nPLAYER LINE: " + playerLine + "\n\nPLAYER FIGHTER: " + JSON.stringify(player) +
    "\nPlayer HP: " + playerHp + "/100\n\nENEMY FIGHTER: " + JSON.stringify(enemy) +
    "\nEnemy HP: " + enemyHp + "/100\n\nLadder rung 2 of 5.";
  const b = extractJson(await chat(BATTLE_SYSTEM, user));
  const dealt = clamp(num(b.playerDealt, 0), 0, 18);
  const taken = clamp(num(b.enemyDealt, 0), 0, 18);
  enemyHp = Math.max(0, enemyHp - dealt);
  playerHp = Math.max(0, playerHp - taken);
  rounds.push({ round, playerDealt: dealt, enemyDealt: taken, playerAction: b.playerAction, enemyAction: b.enemyAction, commentary: b.commentary });
}

const demo = { playerLine, player, enemy, rung: 1, playerHp, enemyHp, rounds };
writeFileSync("demo.json", JSON.stringify(demo, null, 2) + "\n");

console.log("wrote demo.json");
console.log("  " + player.name + " vs " + enemy.name);
console.log("  rounds: " + rounds.length + "   hp: player=" + playerHp + " enemy=" + enemyHp);
