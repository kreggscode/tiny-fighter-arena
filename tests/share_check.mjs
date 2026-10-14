// No API key needed. Verifies the share-link contract in app.js:
//   1. encode -> decode returns the identical payload
//   2. the decoded fighters and seed reproduce the same damage sequence
//      (this is what makes "replays the exact fight, for free" true)
// encodeFight/decodeFight below mirror app.js verbatim.

import assert from "node:assert/strict";

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

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function rollDamage(attacker, defender, rng) {
  const attack = attacker.stats.power + attacker.stats.wit * 0.3;
  const mitigation = defender.stats.defense * 0.55;
  const variance = rng() * 5 - 2;
  const crit = rng() < attacker.stats.wit / 40 ? 3 : 0;
  return clamp(Math.round(attack - mitigation + variance + crit), 0, 18);
}

const rungStream = (seed, rung) => mulberry32((seed ^ Math.imul(rung + 1, 0x9e3779b1)) >>> 0);

function fightSequence(player, enemy, seed, rung, rounds) {
  const rng = rungStream(seed, rung);
  const out = [];
  for (let i = 0; i < rounds; i++) {
    out.push(rollDamage(player, enemy, rng), rollDamage(enemy, player, rng));
  }
  return out;
}

// --- mirrors app.js -------------------------------------------------------

function encodeFight(state) {
  const payload = {
    l: state.playerLine,
    p: state.player,
    e: state.enemy,
    r: state.rung,
    s: state.seed,
    hp: [state.playerHp, state.enemyHp],
    n: state.rounds,
  };
  let bin = "";
  for (const b of new TextEncoder().encode(JSON.stringify(payload))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeFight(token) {
  const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const d = JSON.parse(new TextDecoder().decode(bytes));
  if (!d || typeof d !== "object" || !d.p || !d.e) throw new Error("that is not a shared fight");
  return d;
}

// --- fixtures -------------------------------------------------------------

const player = {
  name: "Rusty Clockwork Knight",
  epithet: "the apologetic automaton",
  look: "a rust-flecked knight whose hands are clock hands",
  style: "tempo control",
  quirk: "bows before every strike",
  abilities: ["Time Swing", "Gear Grapple", "Precision Enforcer"],
  stats: { power: 7, defense: 6, speed: 4, wit: 8 },
};

const enemy = {
  name: "Clockwork Sentinel",
  epithet: "warden of the second hand",
  look: "a looming brass guardian with a pendulum arm",
  style: "attrition",
  quirk: "counts aloud before it swings",
  abilities: ["Pendulum Sweep", "Brace", "Hour of Reckoning"],
  stats: { power: 6, defense: 8, speed: 5, wit: 6 },
};

const state = {
  playerLine: "a shy storm cloud that apologises before it strikes",
  player,
  enemy,
  rung: 1,
  seed: 0x5eed1234,
  playerHp: 81,
  enemyHp: 75,
  rounds: [
    { round: 1, playerDealt: 9, enemyDealt: 4, playerAction: "Time Swing", enemyAction: "Brace", commentary: "The Knight bows, then swings." },
    { round: 2, playerDealt: 8, enemyDealt: 8, playerAction: "Gear Grapple", enemyAction: "Pendulum Sweep", commentary: "Even trade in the ring." },
    { round: 3, playerDealt: 8, enemyDealt: 7, playerAction: "Precision Enforcer", enemyAction: "Hour of Reckoning", commentary: "The clock runs down." },
  ],
};

const results = [];

// 1. Round trip is lossless.
const token = encodeFight(state);
const back = decodeFight(token);

assert.equal(back.l, state.playerLine, "playerLine lost in transit");
assert.deepEqual(back.p, state.player, "player fighter lost in transit");
assert.deepEqual(back.e, state.enemy, "enemy fighter lost in transit");
assert.equal(back.r, state.rung, "rung lost in transit");
assert.equal(back.s, state.seed, "seed lost in transit");
assert.deepEqual(back.hp, [state.playerHp, state.enemyHp], "hp lost in transit");
assert.deepEqual(back.n, state.rounds, "narrated rounds lost in transit");
results.push("round trip lossless, token " + token.length + " chars");

// 2. The token is URL-safe, so it survives being pasted anywhere.
assert.ok(/^[A-Za-z0-9_-]+$/.test(token), "token contains URL-unsafe characters");
const url = "https://example.github.io/arena/?fight=" + token;
assert.ok(url.length < 2100, "share URL is long enough to trip link handlers: " + url.length);
results.push("token is URL-safe, share URL " + url.length + " chars");

// 3. Damage is a pure function of (fighters, seed, rung) - so a friend replaying
//    the link gets the same fight even if they continue past the saved rounds.
const original = fightSequence(state.player, state.enemy, state.seed, state.rung, 6);
const replayed = fightSequence(back.p, back.e, back.s, back.r, 6);
assert.deepEqual(replayed, original, "decoded state did not reproduce the original fight");
results.push("replay reproduces the fight: " + replayed.slice(0, 6).join(","));

// 4. A different seed gives a different fight - the engine is not collapsing
//    every run onto one script.
const other = fightSequence(state.player, state.enemy, state.seed ^ 1, state.rung, 6);
assert.notDeepEqual(other, original, "different seed produced an identical fight");
results.push("different seed diverges, as it should");

// 5. Garbage is rejected rather than crashing into a blank screen.
assert.throws(() => decodeFight("not-a-real-token"), "malformed token was accepted");
assert.throws(() => decodeFight(btoa(JSON.stringify({ l: "no fighters here" }))), "payload without fighters was accepted");
results.push("malformed tokens rejected");

console.log("PASS");
for (const r of results) console.log("  " + r);
