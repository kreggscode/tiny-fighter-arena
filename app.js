"use strict";

const API_BASE = "https://gen.pollinations.ai/v1/chat/completions";
const MODEL = "nova-fast";
const LADDER_SIZE = 5;
const MAX_HP = 100;

// One seed drives the whole run: recorded so a shared link replays it exactly.
const RUN_SEED = newSeed();

const state = {
  pasteKey: localStorage.getItem("tfa_key") || "",
  player: null,
  enemy: null,
  playerHp: MAX_HP,
  enemyHp: MAX_HP,
  round: 1,
  rung: 0,
  auto: false,
  busy: false,
  finished: false,
  seed: RUN_SEED,
  rng: mulberry32(RUN_SEED),
  rounds: [],
  voice: localStorage.getItem("tfa_voice") !== "off",
};

const $ = (id) => document.getElementById(id);
const screens = ["screenKey", "screenCreate", "screenCard", "screenBattle", "screenResult"];

function show(name) {
  screens.forEach((s) => $(s).classList.toggle("hidden", s !== name));
}

function setError(id, message) {
  const el = $(id);
  el.textContent = message || "";
  el.classList.toggle("hidden", !message);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Pulls the first JSON object out of a model reply, tolerating code fences
// and prose around it.
function extractJson(text) {
  if (typeof text !== "string") return null;
  let s = text.trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    return JSON.parse(s.slice(first, last + 1));
  } catch (e) {
    return null;
  }
}

// The user-authorized BYOP token wins; a pasted key is the developer fallback.
function effectiveKey() {
  return window.BYOP.token() || state.pasteKey || "";
}

function isAuthed() {
  return effectiveKey() !== "";
}

function syncAccountUi() {
  const signedIn = window.BYOP.isSignedIn();
  $("keyBtn").textContent = signedIn ? "Sign out" : "Account";
}

async function chat(system, user) {
  const res = await fetch(API_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + effectiveKey(),
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 700,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || "Request failed (" + res.status + ")";
    // A rejected user key means it expired or was revoked: drop it so the
    // player is sent back to sign in rather than retrying a dead token.
    if (res.status === 401 && window.BYOP.isSignedIn()) {
      window.BYOP.signOut();
      syncAccountUi();
      throw new Error(msg + " Your Pollen key expired or was revoked, so please sign in again.");
    }
    throw new Error(msg);
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message.content;
  if (!content) throw new Error("Empty reply from the model");
  return content;
}

async function chatJson(system, user) {
  const raw = await chat(system, user);
  const parsed = extractJson(raw);
  if (!parsed) throw new Error("The model did not return usable JSON");
  return parsed;
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function number(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

// --- Deterministic fight engine ---------------------------------------------
// The round is decided here, from the two designs and a seeded RNG. The model
// only narrates the result, so it cannot hand itself a win and the same seed
// always replays the same fight.

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

function newSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
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

// Pure given the RNG state: replaying from the same seed reproduces the fight.
function resolveRound() {
  const rng = state.rng;
  const playerFirst = initiative(state.player) >= initiative(state.enemy);
  const playerDealt = rollDamage(state.player, state.enemy, rng);
  const enemyDealt = rollDamage(state.enemy, state.player, rng);
  return { playerFirst, playerDealt, enemyDealt };
}

// --- Screens ----------------------------------------------------------------

function renderCard(fighter) {
  const s = fighter.stats || {};
  $("cardPanel").innerHTML =
    '<div class="card">' +
    "<h3>" + escapeHtml(fighter.name) + "</h3>" +
    '<div class="epithet">' + escapeHtml(fighter.epithet || "") + "</div>" +
    '<div class="look">' + escapeHtml(fighter.look || "") + "</div>" +
    '<div class="stats">' +
    statBox("Power", s.power) + statBox("Defense", s.defense) +
    statBox("Speed", s.speed) + statBox("Wit", s.wit) +
    "</div>" +
    '<div class="tags">' +
    tag(fighter.style) + tag(fighter.quirk) +
    (fighter.abilities || []).map(tag).join("") +
    "</div></div>";
}

function statBox(label, value) {
  return '<div class="stat"><b>' + clamp(number(value, 5), 1, 10) + "</b><span>" + label + "</span></div>";
}

function tag(value) {
  if (!value) return "";
  return '<span class="tag">' + escapeHtml(value) + "</span>";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderCombatant(el, fighter, hp, enemy) {
  const pct = clamp((hp / MAX_HP) * 100, 0, 100);
  el.className = "fighter" + (enemy ? " enemy" : "");
  el.innerHTML =
    "<h3>" + escapeHtml(fighter.name) + "</h3>" +
    '<div class="epithet">' + escapeHtml(fighter.epithet || "") + "</div>" +
    '<div class="hpbar"><div class="hpfill' + (pct <= 30 ? " low" : "") + '" style="width:' + pct + '%"></div></div>' +
    '<div class="hptext">' + Math.max(0, hp) + " / " + MAX_HP + " hp</div>";
}

function renderBattle() {
  renderCombatant($("fighterA"), state.player, state.playerHp, false);
  renderCombatant($("fighterB"), state.enemy, state.enemyHp, true);
  $("turnLabel").textContent = "Round " + state.round;
  $("ladderLabel").textContent = "Challenger " + (state.rung + 1) + " / " + LADDER_SIZE;
  $("ladderLabel").classList.remove("hidden");
}

function log(html, className) {
  const p = document.createElement("p");
  if (className) p.className = className;
  p.innerHTML = html;
  $("log").appendChild(p);
  $("log").scrollTop = $("log").scrollHeight;
}

function speak(text) {
  if (!state.voice || !("speechSynthesis" in window)) return;
  const clean = String(text).replace(/<[^>]*>/g, "");
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.rate = 1.05;
  utterance.pitch = 1.1;
  window.speechSynthesis.speak(utterance);
}

// --- Game flow --------------------------------------------------------------

const FIGHTER_SYSTEM =
  "You design fighting-game characters. Reply with ONLY a JSON object, no prose, no code fences. " +
  'Schema: {"name":string,"epithet":string,"look":string,"style":string,"quirk":string,' +
  '"abilities":string[3],"stats":{"power":1-10,"defense":1-10,"speed":1-10,"wit":1-10}}. ' +
  "Keep look under 30 words. abilities are short combat moves, not adjectives.";

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

function buildBattleUser(outcome) {
  const first = outcome.playerFirst ? state.player.name : state.enemy.name;
  return (
    "Round " + state.round + "\n\n" +
    "DECIDED OUTCOME - describe this, do not alter it:\n" +
    "- " + first + " moved first\n" +
    "- " + state.player.name + " dealt " + outcome.playerDealt + " damage\n" +
    "- " + state.enemy.name + " dealt " + outcome.enemyDealt + " damage\n" +
    "- " + state.player.name + " is now on " + state.playerHp + "/" + MAX_HP + " hp\n" +
    "- " + state.enemy.name + " is now on " + state.enemyHp + "/" + MAX_HP + " hp\n\n" +
    "PLAYER LINE (the design brief): " + state.playerLine + "\n\n" +
    "PLAYER FIGHTER: " + JSON.stringify(state.player) + "\n\n" +
    "ENEMY FIGHTER: " + JSON.stringify(state.enemy) + "\n\n" +
    "Ladder rung " + (state.rung + 1) + " of " + LADDER_SIZE + "."
  );
}

async function forgeFighter(line) {
  return chatJson(
    FIGHTER_SYSTEM,
    "Design this fighter from the line below. Make the abilities and stats a direct consequence of it.\n\nLine: " + line,
  );
}

async function forgeEnemy(rung) {
  const difficulty = ["a warm-up rival", "a seasoned contender", "a feared veteran", "a champion", "the undefeated final boss"][rung] || "a challenger";
  return chatJson(
    FIGHTER_SYSTEM,
    "Design " + difficulty + " for the player to fight at ladder rung " + (rung + 1) + " of " + LADDER_SIZE + ". " +
      "Make it a real stylistic counterpoint to this player line: " +
      JSON.stringify(state.playerLine) +
      ". Escalate stats as the rung rises.",
  );
}

function normaliseFighter(raw) {
  const stats = raw.stats || {};
  return {
    name: String(raw.name || "Unnamed"),
    epithet: String(raw.epithet || ""),
    look: String(raw.look || ""),
    style: String(raw.style || ""),
    quirk: String(raw.quirk || ""),
    abilities: Array.isArray(raw.abilities) ? raw.abilities.slice(0, 4).map(String) : [],
    stats: {
      power: clamp(number(stats.power, 5), 1, 10),
      defense: clamp(number(stats.defense, 5), 1, 10),
      speed: clamp(number(stats.speed, 5), 1, 10),
      wit: clamp(number(stats.wit, 5), 1, 10),
    },
  };
}

async function startBattle() {
  $("log").innerHTML = "";
  state.playerHp = MAX_HP;
  state.enemyHp = MAX_HP;
  state.round = 1;
  state.finished = false;
  state.rounds = [];
  // Same seed and rung always produce the same rounds, in the same order.
  state.rng = mulberry32((state.seed ^ Math.imul(state.rung + 1, 0x9e3779b1)) >>> 0);
  renderBattle();
  show("screenBattle");
  log(escapeHtml(state.enemy.name) + " steps into the ring. " + escapeHtml(state.enemy.epithet || ""), "round");
  await nextRound();
}

async function nextRound() {
  if (state.busy || state.finished) return;
  state.busy = true;
  $("nextBtn").disabled = true;
  $("autoBtn").disabled = true;

  try {
    // The round is decided here, before the model sees anything.
    const outcome = resolveRound();
    const dealt = outcome.playerDealt;
    const taken = outcome.enemyDealt;

    state.enemyHp = Math.max(0, state.enemyHp - dealt);
    state.playerHp = Math.max(0, state.playerHp - taken);

    const narration = await chatJson(BATTLE_SYSTEM, buildBattleUser(outcome));

    log('<span class="round">Round ' + state.round + "</span>");
    log(escapeHtml(narration.playerAction || "Your fighter strikes."), dealt >= 12 ? "crit" : "");
    log(escapeHtml(narration.enemyAction || "The challenger answers."), taken >= 12 ? "crit" : "");
    log(escapeHtml(narration.commentary || ""));
    speak(narration.commentary || narration.playerAction || "");

    // Kept so a shared link can replay the fight verbatim, with no API calls.
    state.rounds.push({
      round: state.round,
      playerDealt: dealt,
      enemyDealt: taken,
      playerAction: narration.playerAction || "Your fighter strikes.",
      enemyAction: narration.enemyAction || "The challenger answers.",
      commentary: narration.commentary || "",
    });

    renderBattle();
    state.round += 1;

    if (state.enemyHp <= 0 || state.playerHp <= 0) {
      await finishRound();
      return;
    }

    if (state.auto) {
      await sleep(700);
      state.busy = false;
      $("nextBtn").disabled = false;
      $("autoBtn").disabled = false;
      await nextRound();
      return;
    }
  } catch (err) {
    log("Something went wrong: " + escapeHtml(err.message), "crit");
    state.auto = false;
    $("autoBtn").textContent = "Auto";
  }

  state.busy = false;
  $("nextBtn").disabled = false;
  $("autoBtn").disabled = false;
}

async function finishRound() {
  const playerWon = state.enemyHp <= 0;
  state.finished = true;

  if (playerWon) {
    log(escapeHtml(state.enemy.name) + " goes down!", "win");
    speak(state.enemy.name + " goes down!");
    await sleep(900);

    if (state.rung + 1 >= LADDER_SIZE) {
      showResult("Champion of the Arena", "You cleared all " + LADDER_SIZE + " challengers with " + Math.max(0, state.playerHp) + " hp left.", true);
      return;
    }
    state.rung += 1;
    await loadEnemy();
    await startBattle();
    return;
  }

  log(escapeHtml(state.player.name) + " falls.", "crit");
  speak(state.player.name + " falls.");
  await sleep(900);
  showResult("Knocked Out", "Defeated by " + state.enemy.name + " on challenger " + (state.rung + 1) + " of " + LADDER_SIZE + ".", false);
}

function showResult(title, text, won) {
  $("resultTitle").textContent = title;
  $("resultText").textContent = text;
  const btn = $("resultBtn");
  if (won) {
    btn.textContent = "Forge a new fighter";
    btn.dataset.action = "restart";
  } else {
    btn.textContent = "Rematch " + state.enemy.name;
    btn.dataset.action = "rematch";
  }
  $("ladderLabel").classList.add("hidden");
  show("screenResult");
}

async function loadEnemy() {
  const raw = await forgeEnemy(state.rung);
  state.enemy = normaliseFighter(raw);
}

// Renders a battle from demo.json, which is produced from a real model run by
// tests/make_demo.mjs. Lets someone see the arena without an API key.
async function loadDemo() {
  const res = await fetch("demo.json");
  if (!res.ok) throw new Error("demo.json missing");
  const demo = await res.json();

  state.playerLine = demo.playerLine;
  state.player = normaliseFighter(demo.player);
  state.enemy = normaliseFighter(demo.enemy);
  state.rung = demo.rung || 0;
  state.seed = number(demo.seed, state.seed);
  state.playerHp = demo.playerHp;
  state.enemyHp = demo.enemyHp;
  state.round = (demo.rounds.length || 0) + 1;
  state.rounds = demo.rounds || [];
  state.finished = false;

  renderRecordedRounds();
}

// --- Sharing ----------------------------------------------------------------
// A shared link carries both fighters, the seed and every round already narrated,
// so opening it replays the identical fight with no API calls at all.

function encodeFight() {
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

function renderRecordedRounds() {
  $("log").innerHTML = "";
  show("screenBattle");
  log(escapeHtml(state.enemy.name) + " steps into the ring. " + escapeHtml(state.enemy.epithet || ""), "round");
  for (const r of state.rounds) {
    log('<span class="round">Round ' + r.round + "</span>");
    log(escapeHtml(r.playerAction), r.playerDealt >= 12 ? "crit" : "");
    log(escapeHtml(r.enemyAction), r.enemyDealt >= 12 ? "crit" : "");
    log(escapeHtml(r.commentary));
  }
  renderBattle();
}

async function shareFight() {
  if (!state.player || !state.enemy) return;
  const url = location.origin + location.pathname + "?fight=" + encodeFight();
  try {
    await navigator.clipboard.writeText(url);
    log('<span class="round">Link copied. Anyone opening it replays this exact fight, for free.</span>');
  } catch (err) {
    window.prompt("Copy this link to share the fight:", url);
  }
}

function loadSharedFight(token) {
  const d = decodeFight(token);
  state.playerLine = String(d.l || "a challenger from a shared link");
  state.player = normaliseFighter(d.p);
  state.enemy = normaliseFighter(d.e);
  state.rung = number(d.r, 0);
  state.seed = number(d.s, RUN_SEED);
  state.playerHp = number(d.hp && d.hp[0], MAX_HP);
  state.enemyHp = number(d.hp && d.hp[1], MAX_HP);
  state.rounds = Array.isArray(d.n) ? d.n : [];
  state.round = state.rounds.length + 1;
  state.finished = false;
  state.rng = mulberry32((state.seed ^ Math.imul(state.rung + 1, 0x9e3779b1)) >>> 0);
  renderRecordedRounds();
}

// --- Wiring -----------------------------------------------------------------

async function busy(button, label, work) {
  if (state.busy) return;
  state.busy = true;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  setError(button.id === "keySave" ? "keyError" : "createError", "");
  try {
    await work();
  } catch (err) {
    setError(button.id === "keySave" ? "keyError" : "createError", err.message);
  } finally {
    state.busy = false;
    button.disabled = false;
    button.textContent = original;
  }
}

async function init() {
  $("keyInput").value = state.pasteKey;
  syncAccountUi();

  // A shared link replays a fight exactly, with no key and no generation cost.
  const shared = new URLSearchParams(location.search).get("fight");
  if (shared) {
    try {
      loadSharedFight(shared);
      return;
    } catch (err) {
      setError("keyError", err.message);
    }
  }

  if (new URLSearchParams(location.search).get("demo") === "1") {
    loadDemo().catch(() => show("screenCreate"));
    return;
  }

  // Finish the OAuth exchange when we have just come back from consent.
  if (window.BYOP.isCallback()) {
    show("screenCreate");
    try {
      await window.BYOP.handleCallback();
      syncAccountUi();
    } catch (err) {
      setError("keyError", err.message);
    }
  }

  if (isAuthed()) {
    show("screenCreate");
  } else {
    show("screenKey");
  }

  $("signInBtn").addEventListener("click", () => window.BYOP.signIn());

  $("keyToggle").addEventListener("click", () => {
    const box = $("keyManual");
    box.classList.toggle("hidden");
    if (!box.classList.contains("hidden")) $("keyInput").focus();
  });

  $("keyBtn").addEventListener("click", () => {
    if (window.BYOP.isSignedIn()) {
      window.BYOP.signOut();
      syncAccountUi();
    }
    show("screenKey");
  });

  $("keySave").addEventListener("click", () =>
    busy($("keySave"), "Checking...", async () => {
      const value = $("keyInput").value.trim();
      if (!value) throw new Error("Paste an API key first.");
      state.pasteKey = value;
      localStorage.setItem("tfa_key", value);
      const reply = await chat("Reply with only OK.", "ping");
      if (!/ok/i.test(reply)) throw new Error("The key was accepted but the reply was unexpected.");
      show("screenCreate");
    }),
  );

  document.querySelectorAll(".example").forEach((b) =>
    b.addEventListener("click", () => {
      $("lineInput").value = b.textContent.trim();
    }),
  );

  $("createBtn").addEventListener("click", () =>
    busy($("createBtn"), "Forging...", async () => {
      const line = $("lineInput").value.trim();
      if (!line) throw new Error("Describe your fighter in one line.");
      state.playerLine = line;
      state.player = normaliseFighter(await forgeFighter(line));
      state.rung = 0;
      await loadEnemy();
      renderCard(state.player);
      show("screenCard");
    }),
  );

  $("toBattleBtn").addEventListener("click", startBattle);
  $("nextBtn").addEventListener("click", nextRound);

  $("autoBtn").addEventListener("click", () => {
    state.auto = !state.auto;
    $("autoBtn").textContent = state.auto ? "Stop" : "Auto";
    if (state.auto && !state.busy) nextRound();
  });

  $("voiceBtn").addEventListener("click", () => {
    state.voice = !state.voice;
    localStorage.setItem("tfa_voice", state.voice ? "on" : "off");
    $("voiceBtn").textContent = "Voice: " + (state.voice ? "on" : "off");
    if (!state.voice && "speechSynthesis" in window) window.speechSynthesis.cancel();
  });

  $("shareBtn").addEventListener("click", () => {
    shareFight().catch((err) => log('<span class="round">Could not copy the link: ' + escapeHtml(err.message) + "</span>"));
  });

  $("resultBtn").addEventListener("click", async () => {
    if ($("resultBtn").dataset.action === "rematch") {
      await startBattle();
    } else {
      show("screenCreate");
    }
  });

  $("voiceBtn").textContent = "Voice: " + (state.voice ? "on" : "off");
}

init().catch((err) => console.error("arena failed to start", err));
