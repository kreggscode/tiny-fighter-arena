"use strict";

// Bring Your Own Pollen: OAuth authorization-code flow with PKCE.
// Static browser apps can do the whole exchange themselves because PKCE
// replaces the client secret. The resulting user key is scoped and
// budget-limited by the parameters below, so a player never hands over an
// unrestricted sk_ key.
//
// The App Key (pk_...) is publishable by design, like an OAuth client_id.
// The user-authorized sk_ token lives in sessionStorage only, per
// BRING_YOUR_OWN_POLLEN.md: never localStorage, URL, analytics, or logs.

const CLIENT_ID = "pk_hBFhl5uCcIoqWKbg";
const AUTHORIZE_URL = "https://enter.pollinations.ai/authorize";
const TOKEN_URL = "https://enter.pollinations.ai/api/oauth/token";

const STORE = {
  verifier: "tfa_pkce_verifier",
  state: "tfa_pkce_state",
  token: "tfa_byop_token",
  expires: "tfa_byop_expires",
};

// Must exactly match a registered Redirect URI, query string included.
// Derived at runtime so localhost and the deployed host both work.
function redirectUri() {
  return location.origin + location.pathname;
}

function randomBase64Url(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

// Sends the player to the consent screen. The verifier and CSRF state are
// parked in sessionStorage so the callback in this tab can finish the exchange.
async function signIn() {
  const verifier = randomBase64Url(32);
  const state = randomBase64Url(16);
  sessionStorage.setItem(STORE.verifier, verifier);
  sessionStorage.setItem(STORE.state, state);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    // Scoped and budget-limited: text models only, capped spend, 7 day expiry.
    scope: "usage",
    models: "text",
    budget: "10",
    expiry: "7",
    state,
    code_challenge: await sha256Base64Url(verifier),
    code_challenge_method: "S256",
  });

  location.href = AUTHORIZE_URL + "?" + params.toString();
}

// Returns true when the page was loaded on the OAuth callback.
function isCallback() {
  return new URLSearchParams(location.search).has("code");
}

// Exchanges the callback code for a user key. Resolves to the token, or
// throws with a message safe to show the player.
async function handleCallback() {
  const url = new URLSearchParams(location.search);
  const code = url.get("code");
  const returnedState = url.get("state");

  const savedState = sessionStorage.getItem(STORE.state);
  const verifier = sessionStorage.getItem(STORE.verifier);
  sessionStorage.removeItem(STORE.state);
  sessionStorage.removeItem(STORE.verifier);

  // Drop the code from the address bar either way.
  history.replaceState(null, "", redirectUri());

  const fail = (message) => {
    throw new Error(message);
  };

  if (!savedState || !verifier) {
    return fail("That sign-in link opened in a new tab. Start again from the arena.");
  }
  if (!returnedState || returnedState !== savedState) {
    return fail("Sign-in could not be confirmed (state mismatch). Try again.");
  }
  if (!code) {
    return fail("Pollinations did not return an authorisation code.");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data && data.error_description ? data.error_description : data && data.error ? data.error : "HTTP " + res.status;
    return fail("Could not finish signing in: " + detail);
  }
  if (!data.access_token) {
    return fail("Pollinations returned no access token.");
  }

  sessionStorage.setItem(STORE.token, data.access_token);
  const lifetime = Number(data.expires_in) || 7 * 24 * 3600;
  sessionStorage.setItem(STORE.expires, String(Date.now() + lifetime * 1000));
  return data.access_token;
}

// The user-authorized token, or null when absent or expired.
function token() {
  const value = sessionStorage.getItem(STORE.token);
  if (!value) return null;
  const expires = Number(sessionStorage.getItem(STORE.expires)) || 0;
  if (expires && Date.now() > expires) {
    signOut();
    return null;
  }
  return value;
}

function signOut() {
  sessionStorage.removeItem(STORE.token);
  sessionStorage.removeItem(STORE.expires);
}

function isSignedIn() {
  return token() !== null;
}

window.BYOP = { signIn, signOut, token, isSignedIn, handleCallback, isCallback };
