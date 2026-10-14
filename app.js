"use strict";

const API_BASE = "https://gen.pollinations.ai/v1/chat/completions";
const MODEL = "nova-fast";
const LADDER_SIZE = 5;
const MAX_HP = 100;

const state = {
  key: localStorage.getItem("tfa_key") || "",
  player: null,
  enemy: null,
  playerHp: MAX_HP,
  enemyHp: MAX_HP,
  round: 1,
  rung: 0,
  auto: false,
  busy: false,
  finished: false,
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

async function chat(system, user) {
  const res = await fetch(API_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + state.key,
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
  "You are the commentator and referee of a tiny fighting arena. Reply with ONLY a JSON object, no prose, no code fences. " +
  'Schema: {"playerDealt":integer,"enemyDealt":integer,"playerAction":string,"enemyAction":string,"commentary":string}. ' +
  "playerDealt is damage the player's fighter DEALT to the enemy; enemyDealt is the reverse. " +
  "Each is 0 to 18. Both fighters act every round; the faster one acts first, which you show in commentary. " +
  "Damage must follow from the fighters' designs and abilities, not random numbers. " +
  "The player's one-line description is a real design brief: when it suggests a concrete advantage " +
  "against this particular enemy, let it pay off with higher damage and say why. Vague descriptions underperform. " +
  "commentary is one or two punchy sentences of arena commentary. Keep it fun and clean.";

function buildBattleUser() {
  return (
    "Round " + state.round + "\n\n" +
    "PLAYER LINE (the design brief): " + state.playerLine + "\n\n" +
    "PLAYER FIGHTER: " + JSON.stringify(state.player) + "\n" +
    "Player HP: " + state.playerHp + "/" + MAX_HP + "\n\n" +
    "ENEMY FIGHTER: " + JSON.stringify(state.enemy) + "\n" +
    "Enemy HP: " + state.enemyHp + "/" + MAX_HP + "\n\n" +
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
    const result = await chatJson(BATTLE_SYSTEM, buildBattleUser());

    const dealt = clamp(number(result.playerDealt, 0), 0, 18);
    const taken = clamp(number(result.enemyDealt, 0), 0, 18);

    state.enemyHp = Math.max(0, state.enemyHp - dealt);
    state.playerHp = Math.max(0, state.playerHp - taken);

    log('<span class="round">Round ' + state.round + "</span>");
    log(escapeHtml(result.playerAction || "Your fighter strikes."), dealt >= 12 ? "crit" : "");
    log(escapeHtml(result.enemyAction || "The challenger answers."), taken >= 12 ? "crit" : "");
    log(escapeHtml(result.commentary || ""));
    speak(result.commentary || result.playerAction || "");

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
  state.playerHp = demo.playerHp;
  state.enemyHp = demo.enemyHp;
  state.round = (demo.rounds.length || 0) + 1;
  state.finished = false;

  $("log").innerHTML = "";
  show("screenBattle");
  log(escapeHtml(state.enemy.name) + " steps into the ring. " + escapeHtml(state.enemy.epithet || ""), "round");

  for (const r of demo.rounds) {
    log('<span class="round">Round ' + r.round + "</span>");
    log(escapeHtml(r.playerAction), r.playerDealt >= 12 ? "crit" : "");
    log(escapeHtml(r.enemyAction), r.enemyDealt >= 12 ? "crit" : "");
    log(escapeHtml(r.commentary));
  }

  renderBattle();
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

function init() {
  $("keyInput").value = state.key;

  if (new URLSearchParams(location.search).get("demo") === "1") {
    loadDemo().catch((err) => show("screenCreate"));
    return;
  }

  if (state.key) {
    show("screenCreate");
  } else {
    show("screenKey");
  }

  $("keyBtn").addEventListener("click", () => show("screenKey"));

  $("keySave").addEventListener("click", () =>
    busy($("keySave"), "Checking...", async () => {
      const value = $("keyInput").value.trim();
      if (!value) throw new Error("Paste an API key first.");
      state.key = value;
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

  $("resultBtn").addEventListener("click", async () => {
    if ($("resultBtn").dataset.action === "rematch") {
      await startBattle();
    } else {
      show("screenCreate");
    }
  });

  $("voiceBtn").textContent = "Voice: " + (state.voice ? "on" : "off");
}

init();
