---
name: auth-guide
description: Guide to choosing and setting up authentication against a third-party service that a Notion Worker needs to read or write data from. Covers API keys / personal access tokens and OAuth. Auto-loads when third-party auth work is detected. Not about Notion authentication itself — the worker runtime handles that.
user-invocable: false
---

## What this guide is for

This guide is about authenticating against the **third-party service** your worker integrates with — the place data is coming from or going to (GitHub, Stripe, Salesforce, Google, Slack, etc.). It is not about Notion authentication: the worker runtime already handles the Notion side.

Most workers have to authenticate against an external service before they can read or write its data. This guide helps you pick the right approach for that service, walk the user through setup, and avoid the most common mistakes.

The user should be part of this decision — the right answer depends on what the service offers, how comfortable they are with operational tradeoffs, and what they're trying to ship. Don't pick silently. Surface the options, recommend one, and let them confirm or override.

## The two approaches

There are two patterns you'll generally choose between. Each has a clear sweet spot and clear downsides.

| Approach | When it fits | Main downside |
|---|---|---|
| **API key / personal token** | Service offers a personal API key or PAT | Long-lived credential — broad scope, hard to rotate, full access if leaked |
| **OAuth** | Service has a real OAuth app flow, or you want short-lived tokens | More setup — register an OAuth app, configure redirect URL, exchange tokens |

### API key / personal token

**Pros:**
- Fastest to set up — paste a token into `.env`, you're done.
- Easiest to test locally — `process.env.MY_API_TOKEN` works the same locally and remotely.
- No app registration, no redirect URL, no flow to debug.

**Cons:**
- Long-lived credential. If it leaks, the attacker has full access until it's manually rotated.
- Usually broad scope — a personal API key often grants everything the user can do, with no way to narrow it.
- Some services don't issue API keys at all, or only for paid tiers.
- Rotation is manual and visible to the user — there's no refresh mechanism.

**Pick this when:** the service offers personal API keys and the user accepts the long-lived-credential tradeoff.

### OAuth

**Pros:**
- Short-lived access tokens with refresh tokens — leaked tokens expire on their own.
- Granular scopes — the user explicitly grants only the permissions the worker needs.
- Some providers only support OAuth (Google, Slack, HubSpot, Salesforce, etc.) — you don't get to pick.
- Tokens are managed by the runtime via `worker.oauth()` and `accessToken()`; you don't store or refresh them yourself.

**Cons:**
- More setup work. You have to register an OAuth app with the provider, configure the redirect URL, list scopes, and store the client ID and secret.
- Can't be tested before the first deploy + OAuth — `accessToken()` reads a token env var that's only populated after a real OAuth flow completes on the deployed worker. After that initial deploy, you can pull the token down with `ntn workers env pull` and run locally.
- More moving parts means more failure modes — wrong scope, wrong redirect URL, expired refresh tokens, consent screens, etc.
- Some providers have approval processes (verified apps, OAuth review) that take days or weeks for production use.

**Pick this when:** the provider requires OAuth, or the user wants short-lived tokens for security reasons.

## Decision framework

The decision hinges on two facts about the service: (1) does it offer personal API keys / PATs? (2) does it support OAuth (and is OAuth required)? **These are public, googleable facts — research them yourself before asking the user.**

If the user has named a specific service, do the lookup first:

- For well-known services you already have knowledge of (GitHub, Stripe, Linear, Jira, Google, Slack, HubSpot, Salesforce, etc.), proceed directly with what you know about their auth options.
- For services you're less sure about, use WebSearch / WebFetch to check the service's developer docs for "API keys", "personal access tokens", "OAuth", or "authentication". Confirm before recommending.
- Only ask the user "does the service offer X?" when you genuinely can't find out — the user usually doesn't know this any better than you can look up.

Once you know what the service offers, the decision is mechanical:

1. **Service offers personal API keys / PATs?** That's usually the simplest fit — recommend API key unless the user has a specific reason to want short-lived tokens.
2. **Service is OAuth-only** (no PATs — common for Google, Slack, HubSpot, Salesforce, Atlassian Cloud for new apps)? OAuth is the only choice — the user will need to register their own OAuth app with the provider (see OAuth section below).
3. **Service has neither?** See "When neither option is available" at the end of this guide.

Default recommendation by service type:

- **Developer-facing SaaS with PATs** (GitHub, Linear, Jira, Stripe restricted keys) → API key
- **Consumer-facing OAuth-only providers** (Google Workspace, Slack, HubSpot, Salesforce) → OAuth

Always state your recommendation with one-line reasoning ("Stripe issues restricted API keys, so API key is the simplest fit") and let the user override.

## Setup: API key

Pattern: store the credential in `.env` (or directly in the deployed worker's secrets), read it from `process.env` inside the capability's `execute`, push to the deployed worker before going live.

> **A note on handling secrets.** Real API tokens are sensitive credentials. **Prefer that the user adds the token themselves** rather than pasting it into the chat. The token only needs to land in `.env` - they can put it there directly without it ever passing through this conversation, conversation logs, or model providers.
>
> Walk the user through *what* to do — share the variable name, the file or command, where to paste — and let them do the actual paste themselves. If they offer to share the token directly, gently steer them to setting it themselves: "I can write the code that reads `process.env.GITHUB_API_TOKEN` — you just add the value to `.env` (or run `ntn workers env set` for the deployed worker) so the secret never has to pass through me." However if they share the secret to you then you should proceed to set it for them.

1. Walk the user through getting the token from the service. Be specific — link to or describe the exact settings page. It is almost always better to use WebSearch or WebFetch for this information as it can change without warning on most services.

2. **Have the user add the token to `.env` themselves** (create the file if it doesn't exist). Tell them the variable name to use:

   ```
   GITHUB_API_TOKEN=<paste your token here>
   ```

   `.env` is automatically loaded for local execution (`--local`).

3. Read the token inside `execute` (this is the part you write):

   ```ts
   const token = process.env.GITHUB_API_TOKEN ?? "";

   const res = await fetch("https://api.github.com/user", {
     headers: { Authorization: `Bearer ${token}` },
   });
   ```

4. Test locally with `ntn workers exec <capability> --local`. Confirm auth works before deploying.

5. **Push the secret to the deployed worker.** Once the token is already in `.env`, you can run this for the user — `ntn workers env push` reads `.env` directly, so the value never has to pass through the chat:

   ```shell
   ntn workers env push
   ```

   If the user prefers not to keep the token in `.env` at all (shared workstation, repo concerns), they should run the direct-set form themselves so the value doesn't transit the chat:

   ```shell
   ntn workers env set GITHUB_API_TOKEN=<paste token>
   ```

6. Tell the user how to rotate: revoke the old token at the service, generate a new one, update `.env` (or `ntn workers env set` directly), and re-push if needed.

## Setup: OAuth

`worker.oauth()` declares an OAuth capability. The runtime handles the authorization redirect, token exchange, and refresh — you call `accessToken()` inside `execute` to get a fresh token.

The user has to register an OAuth app with the provider, then plug the credentials in:

```ts
const myAuth = worker.oauth("myAuth", {
  name: "my-provider",
  authorizationEndpoint: "https://provider.example.com/oauth/authorize",
  tokenEndpoint: "https://provider.example.com/oauth/token",
  scope: "read write",
  clientId: process.env.MY_OAUTH_CLIENT_ID ?? "",
  clientSecret: process.env.MY_OAUTH_CLIENT_SECRET ?? "",
  // Optional: extra params the provider needs on the auth URL
  authorizationParams: { ... },
});
```

> **A note on handling the OAuth client secret.** The `clientSecret` is a sensitive credential — same handling as an API token. **Prefer that the user adds it themselves** rather than pasting it into the chat. You write the `worker.oauth()` declaration that *reads* `process.env.MY_OAUTH_CLIENT_SECRET`; the user puts the actual value into `.env` (or `ntn workers env set`) so it never passes through this conversation.

Setup steps:

1. **Register an OAuth app with the provider.** This is provider-specific. The user typically goes to the provider's developer console, creates an app, and gets back a client ID and client secret. Note the scopes they request — only ask for what's needed.

2. **Have the user add credentials to `.env` themselves.** Tell them which variable names to use:

   ```
   MY_OAUTH_CLIENT_ID=<paste client id>
   MY_OAUTH_CLIENT_SECRET=<paste client secret>
   ```

   (The client ID alone isn't really sensitive, but the client secret is. Same handling.)

3. **Add the `worker.oauth()` declaration** to `src/index.ts`. Read `clientId`/`clientSecret` from `process.env`.

4. **Create the worker (if not already created) and push secrets before deploying.** The deployed worker reads `clientSecret` from environment variables during capability registration, so the secret must be present remotely before `deploy`. Have the user run these themselves:

   ```shell
   ntn workers create --name <name>    # if not already created
   ntn workers env push                  # push .env to remote
   # or, to set values directly without putting them in .env:
   # ntn workers env set MY_OAUTH_CLIENT_SECRET=<paste secret>
   ntn workers deploy
   ```

   **Important:** any time the client ID or client secret changes, you must redeploy (`ntn workers deploy`) — the OAuth capability binds these values at registration time, so updating env vars alone won't take effect.

5. **Configure the redirect URL on the provider side.** The deployed worker is assigned a redirect URL by Notion. Get it with:

   ```shell
   ntn workers oauth show-redirect-url
   ```

   The user must paste this URL into their OAuth app's "redirect URI" (or "authorized redirect URL", or "callback URL") setting at the provider. **Always remind the user of this step — OAuth will fail with a redirect mismatch error if it's missing or wrong.**

6. **Start the OAuth flow:**

   ```shell
   ntn workers oauth start <oauthCapabilityKey>
   ```

   This opens the user's browser, walks them through the provider's consent screen, and stores the resulting tokens.

7. **Use the token inside `execute`:**

   ```ts
   const token = await myAuth.accessToken();
   const res = await fetch("https://provider.example.com/v1/things", {
     headers: { Authorization: `Bearer ${token}` },
   });
   ```

   `accessToken()` returns a valid, refreshed access token. The runtime handles refresh automatically — you don't need to track expiry yourself.

### Local testing with OAuth

OAuth capabilities can be tested locally, but only after a one-time bootstrap — the access token has to exist somewhere before `accessToken()` can read it. The flow:

1. Deploy the worker and complete the OAuth flow once (steps 4–6 above).
2. Pull the deployed worker's env vars (which now include the OAuth access token) into local `.env`:

   ```shell
   ntn workers env pull
   ```

3. Now `ntn workers exec <key> --local` works — `accessToken()` reads the token from local `.env`.

Caveats:

- Access tokens expire. The deployed runtime auto-refreshes; your local `.env` does not. When the local token goes stale, run `ntn workers env pull` again (or, if the refresh token has also expired, redo `ntn workers oauth start <key>` then `env pull`).
- Until that first deploy + OAuth completes, you can't `--local`. Run `npm run check` for type validation, or mock `accessToken()` in a test file if you need to exercise the rest of the logic.

## Common pitfalls

1. **Hardcoded credentials in source.** Tokens and secrets must come from `process.env` — never inline them in `src/index.ts`. Even in personal repos, committed secrets get scraped.

2. **Forgetting `ntn workers env push`.** Local works, deploy fails with auth errors. Always push secrets after changing `.env`. The deployed worker doesn't see local `.env`.

3. **Pushing secrets after `ntn workers deploy` for OAuth.** OAuth `clientId` is read from `process.env` during capability registration — push secrets *before* `deploy`, or use the `create` → `env push` → `deploy` sequence.

4. **Wrong redirect URL for OAuth.** `redirect_uri_mismatch` is the #1 OAuth failure mode. Always run `ntn workers oauth show-redirect-url` and verify the user has set the exact URL at the provider.

5. **Asking for too many OAuth scopes.** Request the narrowest set that works. Scope creep makes the consent screen scary and slows OAuth review for production apps.

6. **Not telling the user about manual rotation.** API keys don't refresh themselves. Tell the user up front that they'll need to rotate, and how.

## CLI reference

```shell
# Push .env secrets to the deployed worker (run after any .env change)
ntn workers env push

# Pull remote env vars into local .env (useful for OAuth: brings access tokens
# down so `ntn workers exec --local` can read them)
ntn workers env pull

# List remote env vars (without values)
ntn workers env list

# Set a single env var
ntn workers env set KEY=value

# OAuth: get the redirect URL to configure at the provider
ntn workers oauth show-redirect-url

# OAuth: start the authorization flow (opens browser)
ntn workers oauth start <oauthCapabilityKey>

# OAuth: inspect token state
ntn workers oauth token <oauthCapabilityKey>
```

## When neither option is available

If the service offers neither an API key nor an OAuth flow, the honest first answer is often that the integration isn't viable on that service.

Before giving up, there are a few **indirect paths** worth considering.

- **OAuth into a related service that already has the data.** Sometimes the data flows downstream into a place you *can* reach with proper auth — a calendar provider, file storage, a shared workspace. Following the data to a sanctioned interface is preferable to forcing a connection at the original source.
- **Have the user export and upload.** If the service offers a manual data export (CSV/JSON), the user can drop files somewhere the worker can read (S3, Drive, etc.) and the worker syncs from there. Higher-friction but unambiguously sanctioned.
- **Pull data out of the user's own email.** If the service sends the user emails containing the data (digests, notifications, exports, receipts), OAuth into the user's own email account (Gmail, etc.) and parse those messages. The user owns the inbox, the service is sending them the data on purpose, and the email provider has a real OAuth API. Indirect but stable.
- **Use the service's own internal/frontend endpoints** (the JSON routes its web app calls). Sometimes the only thing the service exposes is the API its own UI talks to — you can authenticate as the logged-in user (session cookie, captured bearer token) and call those routes from the worker. Honest caveats: it's often flaky (the routes can change with any frontend release), it relies on credentials that probably weren't intended for programmatic use, and **the user needs to confirm this doesn't violate the service's terms of service** before doing it. Reasonable for a personal tool or hobby integration; not something to lean on for serious production use. Don't recommend it as a first choice — but if the user goes this way knowingly, help them do it carefully (sane pacers, descriptive `User-Agent`, manual credential rotation, no rate-limit evasion).

   **Tip for discovery:** ask the user to export a `.har` file from their browser's devtools (Network tab → right-click → "Save all as HAR with content"). HAR files capture every request/response the page made — URLs, methods, headers, bodies — which lets you see the exact endpoint shape without the user having to describe it.
