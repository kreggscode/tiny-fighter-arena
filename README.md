# Tiny Fighter Arena

Describe a fighter in one line. The AI designs it, then sends it into a short,
commentated battle against a challenger, up a five-rung ladder.

[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

## Play

Open the deployed game:

**https://kreggscode.github.io/tiny-fighter-arena/**

Paste a Pollinations key from <https://enter.pollinations.ai/keys>, type one line,
and fight. The key is kept in `localStorage` and is only ever sent to
`gen.pollinations.ai`.

## How it plays

1. **One line in.** `a shy storm cloud that apologises before it strikes` becomes a
   complete fighter: name, epithet, look, style, quirk, three abilities, four stats.
2. **The line is a design brief.** The referee model is told to reward a concrete
   advantage in your line against *this specific* enemy. A vague line underperforms,
   so clever descriptions genuinely win more fights.
3. **Turn by turn.** Both fighters act every round. Damage is derived from the two
   designs and their abilities rather than rolled randomly, and the commentary
   explains the exchange.
4. **Ladder.** Five challengers, each generated as a stylistic counterpoint to your
   fighter, escalating to an undefeated final boss.

Voice commentary uses the browser's speech synthesis and can be toggled off.

## Run locally

Static site, no build step.

```bash
git clone https://github.com/kreggscode/tiny-fighter-arena.git
cd tiny-fighter-arena
npx http-server -p 8080
# or: python -m http.server 8080
```

Open <http://localhost:8080>.

To play, click **API key** and paste a key from
<https://enter.pollinations.ai/keys>.

## See the arena without a key

`?demo=1` renders a real battle from `demo.json`:

```
http://localhost:8080/?demo=1
```

`demo.json` is not hand-written; it is written by `tests/make_demo.mjs` from an
actual model run.

## Tests

```bash
# end-to-end contract check against the live API
POLLINATIONS_API_KEY=sk_... node tests/live_check.mjs

# regenerate demo.json from a real run
POLLINATIONS_API_KEY=sk_... node tests/make_demo.mjs
```

`tests/live_check.mjs` asserts the two schemas the game depends on:

- fighter design comes back with string fields, at least three abilities, and
  stats clamped to 1-10
- battle rounds come back with both actions, commentary, and damage in 0-18

## API

Single endpoint, direct from the browser (CORS is open on
`gen.pollinations.ai`):

```
POST https://gen.pollinations.ai/v1/chat/completions
Authorization: Bearer <your key>
Content-Type: application/json

{ "model": "nova-fast", "max_tokens": 700,
  "messages": [ { "role": "system", "content": "..." },
                { "role": "user", "content": "..." } ] }
```

Model replies are requested as JSON only, then parsed defensively: code fences
are stripped and the first `{...}` object is taken, so a chatty reply still
plays.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Screens: key, creation, fighter card, arena, result |
| `app.js` | State machine, API client, JSON extraction, damage clamps |
| `style.css` | Arena layout, HP bars, combat log |
| `tests/live_check.mjs` | Live schema contract check |
| `tests/make_demo.mjs` | Writes `demo.json` from a real model run |
| `demo.json` | Real output used by `?demo=1` |

## Design notes

- **Client owns HP.** The model reports damage; the client applies it and clamps
  it to 0-18. State can never drift because a model miscounted.
- **Distrust is contained.** JSON extraction and field clamping live in one
  function each, so a malformed reply degrades a single round instead of the run.
- **Bring your own key.** No server, no proxy, no shared key to leak. The game is
  three static files.
