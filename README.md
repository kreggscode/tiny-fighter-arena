# Tiny Fighter Arena

Describe a fighter in one line. The AI designs it, then sends it into a short,
commentated battle against a challenger, up a five-rung ladder.

[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

## Play

Open the deployed game:

**https://kreggscode.github.io/tiny-fighter-arena/**

Click **Sign in with Pollinations**, approve the key, and fight. Type one line and
the arena does the rest.

## Bring your own Pollen

The arena never holds a shared key. Players authorize their own spend through
[BYOP](https://github.com/pollinations/pollinations/blob/main/BRING_YOUR_OWN_POLLEN.md)
using the OAuth authorization-code flow with PKCE, which works from a static page
because PKCE replaces the client secret.

The consent screen shows exactly what is being granted, and the authorize link
requests the narrowest thing the game needs:

| Param | Value | Why |
| --- | --- | --- |
| `scope` | `usage` | generation only, no account admin |
| `models` | `text` | the arena uses text models and nothing else |
| `budget` | `10` | hard Pollen cap for the session |
| `expiry` | `7` | key lifetime in days, revocable any time |

The user-authorized key lands in `sessionStorage` and is sent only to
`gen.pollinations.ai`. It is never written to `localStorage`, a URL, an
analytics call, or a log. Expired or revoked keys are dropped and the player is
returned to the sign-in screen.

Developers can still paste their own key from
<https://enter.pollinations.ai/keys> under **Use your own key instead**.

## How it plays

1. **One line in.** `a shy storm cloud that apologises before it strikes` becomes a
   complete fighter: name, epithet, look, style, quirk, three abilities, four stats.
2. **The line is a design brief.** Damage is computed from the two designs, so a
   concrete advantage in your line against *this specific* enemy pays off as higher
   numbers. A vague line underperforms, so clever descriptions genuinely win more
   fights.
3. **The model narrates; it does not referee.** A seeded rules engine decides each
   round before the model sees anything. The prompt hands it a decided outcome and
   asks it to describe what happened. The commentary is vivid, but it can never
   change a damage number or declare itself the winner.
4. **Ladder.** Five challengers, each generated as a stylistic counterpoint to your
   fighter, escalating to an undefeated final boss.

Voice commentary uses the browser's speech synthesis and can be toggled off.

## Share a fight

**Share fight** copies a link that replays the exact battle. The token carries both
fighters, the seed, and every round already narrated, so a friend watches the same
fight with no sign-in and no generation cost.

Because damage is a pure function of `(fighters, seed, rung)`, the link is honest
about more than the saved rounds: anyone who keeps fighting past them reaches the
same result you would have.

The token is base64url over a small JSON blob - about 1.5 KB, URL-safe, and
entirely client-side. No key or credential ever travels in it.

```
https://kreggscode.github.io/tiny-fighter-arena/?fight=<token>
```

## Run locally

Static site, no build step.

```bash
git clone https://github.com/kreggscode/tiny-fighter-arena.git
cd tiny-fighter-arena
npx http-server -p 8080
# or: python -m http.server 8080
```

Open <http://localhost:8080>.

Sign in with the BYOP flow, which supports localhost as a redirect origin. To
skip the consent screen while hacking, click **Use your own key instead** and
paste a key from <https://enter.pollinations.ai/keys>.

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

# share-link contract, no key needed
node tests/share_check.mjs

# BYOP plumbing: no key needed, no user login needed
node tests/oauth_check.mjs
```

`tests/live_check.mjs` asserts the contract the game depends on:

- fighter design comes back with string fields, at least three abilities, and
  stats clamped to 1-10
- battle narration comes back with both actions and commentary, and carries no
  damage fields of its own - damage is the engine's to decide
- the same seed reproduces the same damage sequence, round for round

`tests/share_check.mjs` asserts the share token round-trips losslessly, stays
URL-safe and short, reproduces the original fight from the decoded state alone,
diverges for a different seed, and rejects malformed links instead of rendering a
blank screen.

`tests/oauth_check.mjs` verifies the sign-in plumbing without a GitHub login:
the token endpoint understands the request and answers a bogus code with an RFC
6749 `invalid_grant` rather than a 404 or HTML, the consent screen accepts the
registered redirect URI, and the PKCE verifier/challenge pair is valid S256.

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
| `index.html` | Screens: sign-in, creation, fighter card, arena, result |
| `byop.js` | OAuth code + PKCE sign-in, scoped user key handling |
| `app.js` | State machine, API client, seeded damage engine, share links |
| `style.css` | Arena layout, HP bars, combat log |
| `tests/live_check.mjs` | Live contract check: schemas, narration, determinism |
| `tests/share_check.mjs` | Share-token round trip and replay fidelity |
| `tests/oauth_check.mjs` | Sign-in plumbing check, no login required |
| `tests/make_demo.mjs` | Writes `demo.json` from a real model run |
| `demo.json` | Real output used by `?demo=1` |

## Design notes

- **The engine owns damage.** `resolveRound()` derives damage from both designs and
  a seeded RNG, clamped to 0-18. The model narrates a result it cannot alter, so a
  round can never be talked into a bigger number.
- **One seed, one fight.** Rounds are a pure function of `(seed, rung)`, which is
  what lets a shared link replay a battle for free instead of re-generating it.
- **The model owns flavour, only.** Names, looks, abilities and commentary all come
  from Pollinations. The things a model is bad at - arithmetic, and being honest
  about who is winning - never leave the engine.
- **Distrust is contained.** JSON extraction lives in one function, so a malformed
  reply degrades a single round's commentary instead of the whole run.
- **No shared key, and no server.** Users authorize their own spend through
  OAuth + PKCE; the app only ever holds a scoped, budget-capped user key in
  `sessionStorage`. The whole game is four static files.
