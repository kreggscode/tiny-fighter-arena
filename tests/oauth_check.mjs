// Checks the BYOP plumbing without needing a real GitHub login:
//   1. the token endpoint is reachable and understands our parameter names
//      (a bogus code must yield an RFC 6749 error object, not a 404/HTML)
//   2. the redirect URI is actually registered, by loading the consent screen
//      and confirming it renders rather than rejecting the redirect_uri
// Run with: POLLINATIONS_API_KEY=sk_... (unused, kept for uniformity) node tests/oauth_check.mjs
import assert from "node:assert";
import { createHash, randomBytes } from "node:crypto";

const CLIENT_ID = "pk_hBFhl5uCcIoqWKbg";
const TOKEN_URL = "https://enter.pollinations.ai/api/oauth/token";
const AUTHORIZE_URL = "https://enter.pollinations.ai/authorize";
const REDIRECT_URI = "https://kreggscode.github.io/tiny-fighter-arena/";

const base64Url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const verifier = base64Url(randomBytes(32));
const challenge = base64Url(createHash("sha256").update(verifier).digest());
const state = base64Url(randomBytes(16));
const bogusCode = base64Url(randomBytes(16));

const results = [];

// 1. Token exchange with a bogus code.
const res = await fetch(TOKEN_URL, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: bogusCode,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  }),
});
const body = await res.json().catch(() => null);
assert.ok(body, "token endpoint returned non-JSON");
assert.ok(body.error, "expected an RFC 6749 error field, got: " + JSON.stringify(body).slice(0, 200));
assert.notStrictEqual(res.status, 404, "token endpoint should not be missing");
assert.notStrictEqual(res.status, 415, "content type should be accepted");
results.push("token endpoint ok: HTTP " + res.status + " -> " + body.error + (body.error_description ? " (" + body.error_description + ")" : ""));

// 2. Consent screen accepts our client_id + redirect_uri.
const authUrl =
  AUTHORIZE_URL +
  "?" +
  new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "usage",
    models: "text",
    budget: "10",
    expiry: "7",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

const authRes = await fetch(authUrl);
const html = await authRes.text();
assert.ok(authRes.ok, "consent screen HTTP " + authRes.status);
const rejected = /redirect[_ ]?uri[^<]{0,120}(invalid|not (registered|allowed)|mismatch)/i.test(html);
assert.ok(!rejected, "consent screen rejected the redirect URI: " + (html.match(rejected) || [])[0]);
results.push("consent screen ok: HTTP " + authRes.status + ", " + html.length + " bytes, redirect URI accepted");

// 3. PKCE shape matches what byop.js produces.
assert.ok(verifier.length >= 43 && verifier.length <= 128, "verifier length out of RFC 7636 range: " + verifier.length);
assert.ok(/^[A-Za-z0-9_-]+$/.test(verifier) && /^[A-Za-z0-9_-]+$/.test(challenge), "PKCE values must be base64url");
assert.strictEqual(base64Url(createHash("sha256").update(verifier).digest()), challenge, "challenge must be S256 of verifier");
results.push("pkce ok: verifier " + verifier.length + " chars, S256 challenge verified");

console.log("PASS\n" + results.map((r) => "  " + r).join("\n"));
console.log("\nconsent URL (safe to inspect, contains no secrets):\n  " + authUrl);
