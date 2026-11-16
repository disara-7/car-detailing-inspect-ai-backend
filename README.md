# car-detailing-inspect-ai-backend

A Cloudflare Worker API (Hono, Zod and TypeScript) for a car-detailing assessment web app. Customers upload photos grouped by car part. Gemini scores how much detailing each part needs and recommends services. The overall score, label and service ranking are calculated in code, not by the AI.

The frontend lives in a separate repo. This repo is self-contained and runs on the **free** Cloudflare Workers plan.

## Project layout

```
src/
  index.ts      Hono app: routes, CORS, body limit, error handling
  schema.ts     API contract (Zod), shared with the frontend
  config.ts     Weights, label thresholds, service menu, disclaimer, limits
  prompt.ts     Gemini system instruction and response JSON schema
  gemini.ts     Gemini REST call, output parsing and validation, retry
  scoring.ts    Overall score, label and service ranking
  turnstile.ts  Cloudflare Turnstile verification
test/           Vitest tests (scoring, schema, Gemini parsing, API)
```

## Endpoints

| Method | Path          | Description                       |
| ------ | ------------- | --------------------------------- |
| GET    | `/health`     | Returns `{ "ok": true }`          |
| POST   | `/api/assess` | Assesses the photos (see below)   |

### `POST /api/assess`

Request (see `src/schema.ts`):

```json
{
  "turnstileToken": "<token from the Turnstile widget>",
  "parts": [
    { "category": "door",  "images": ["<base64 JPEG>", "<base64 JPEG>"] },
    { "category": "wheel", "images": ["<base64 JPEG>"] }
  ]
}
```

- Categories: `door`, `wheel`, `bonnet`, `roof`, `bumper`, `boot`, `glass`, `interior`. Each category may appear only once.
- Limits: 1 to 8 categories and 1 to 4 images per category. The whole body must be 8 MB or less.

Response:

```json
{
  "overallScore": 57,
  "overallLabel": "moderate",
  "parts": [
    { "category": "door", "score": 65, "issues": ["Swirl marks across panel"], "services": ["Single-stage paint correction"], "photoQuality": "good" },
    { "category": "wheel", "score": 45, "issues": ["Brake dust on spokes"], "services": ["Wheel deep clean"], "photoQuality": "good" }
  ],
  "recommendedServices": ["Single-stage paint correction", "Wheel deep clean"],
  "disclaimer": "These scores are an AI estimate based only on the photos provided. A final quote requires an in-person inspection of the vehicle."
}
```

Every error uses the same shape: `{ "error": { "code": "...", "message": "..." } }`.

| Status | Code                | When                                                         |
| ------ | ------------------- | ------------------------------------------------------------ |
| 400    | `INVALID_REQUEST`   | Body is not JSON, fails the schema, or the route is unknown (404) |
| 403    | `BOT_CHECK_FAILED`  | Turnstile verification failed                                |
| 413    | `PAYLOAD_TOO_LARGE` | Body is over 8 MB                                            |
| 429    | `RATE_LIMITED`      | Reserved for when rate limiting is added (see below)         |
| 502    | `AI_FAILED`         | Gemini failed or returned invalid output twice               |
| 500    | `INTERNAL`          | Missing secrets or an unexpected error                       |

### How a request is processed

1. CORS allows only origins in `ALLOWED_ORIGINS`. OPTIONS preflight is handled.
2. The body size is checked (8 MB), then the JSON is validated with `AssessRequestSchema`.
3. The Turnstile token is verified with `siteverify`, sending the `CF-Connecting-IP` header value.
4. Gemini is called **once** with all parts. Each part is sent as a `Category: <name>` text label followed by its images.
5. Gemini's JSON is validated against `PartResultSchema`. Every requested category must appear exactly once. If anything is wrong, the call is retried once and then fails with `502 AI_FAILED`. Scores are never invented or filled in.
6. The overall score is a weighted average using the weights in `src/config.ts`. Parts with `photoQuality: "poor"` count at half weight. The result is rounded. Labels: 0-20 clean, 21-50 light, 51-80 moderate, 81-100 heavy.
7. `recommendedServices` is the deduplicated union of the parts' services. Services needed by more parts come first. Ties follow the order of the service menu.
8. A fixed disclaimer is added, and the response is validated with `AssessResponseSchema`.

## Local development

Requirements: Node.js 20 or later.

```sh
npm install
cp .dev.vars.example .dev.vars   # then put your Gemini key in .dev.vars
npm run dev                      # wrangler dev, http://localhost:8787
```

`.dev.vars` holds local secrets and vars and is git-ignored:

| Name               | Kind   | Notes                                                                                       |
| ------------------ | ------ | ------------------------------------------------------------------------------------------- |
| `GEMINI_KEY`       | secret | Google AI Studio API key                                                                    |
| `TURNSTILE_SECRET` | secret | For local dev, use Cloudflare's always-pass test secret `1x0000000000000000000000000000000AA` |
| `ALLOWED_ORIGINS`  | var    | Comma-separated, for example `http://localhost:3000,https://app.example.com`                |
| `GEMINI_MODEL`     | var    | Defaults to `gemini-3.8-flash`                                                              |

With the always-pass test secret, any non-empty `turnstileToken` works. On the frontend, use the matching test site key `1x00000000000000000000AA`. See [Turnstile testing](https://developers.cloudflare.com/turnstile/troubleshooting/testing/).

Other scripts:

```sh
npm test            # vitest run
npm run typecheck   # tsc --noEmit
```

### curl example

```sh
# Encode a JPEG as base64 with no line breaks and no "data:" prefix
IMG=$(base64 -w0 door.jpg)          # macOS: base64 -i door.jpg

curl -s http://localhost:8787/api/assess \
  -H "Content-Type: application/json" \
  -d @- <<EOF
{
  "turnstileToken": "test-token",
  "parts": [
    { "category": "door", "images": ["$IMG"] }
  ]
}
EOF
```

For several large images, write the JSON to a file and use `-d @body.json` so you do not hit shell argument limits.

## Deploy

```sh
npx wrangler login
npx wrangler secret put GEMINI_KEY
npx wrangler secret put TURNSTILE_SECRET     # your real Turnstile secret
npm run deploy                               # wrangler deploy
```

Before deploying, add your production frontend origin to `ALLOWED_ORIGINS` in `wrangler.jsonc` (for example `"http://localhost:3000,https://app.example.com"`). You can also change it in the Cloudflare dashboard.

## Changing the Gemini model

The model ID comes from the `GEMINI_MODEL` var. The default is in `wrangler.jsonc`, with a fallback in `DEFAULT_GEMINI_MODEL` in `src/config.ts`. To switch models:

- Production: edit `GEMINI_MODEL` in `wrangler.jsonc` and redeploy, or change the variable in the dashboard (Workers > your worker > Settings > Variables).
- Local: set `GEMINI_MODEL` in `.dev.vars`.

You can find model IDs at <https://ai.google.dev/gemini-api/docs/models>. Prefer a pinned stable ID over an alias like `gemini-flash-latest`, so scoring behaviour does not change without warning.

## Customising

All business settings live in `src/config.ts`:

- **`SERVICES`** is a **placeholder** service menu. Replace it with your real service names. Gemini may only recommend items from this list. Unknown names are dropped, and matching ignores case.
- **`CATEGORY_WEIGHTS`**, `POOR_PHOTO_WEIGHT_FACTOR` and `LABEL_THRESHOLDS` control scoring.
- **`DISCLAIMER`** is the text returned with every result.

The scoring rubric and prompt text are in `src/prompt.ts`.

## Logging and privacy

Logs are JSON lines containing only categories, counts, status codes, timings and failure reasons. Image data, the API key and Gemini's raw output are never logged. Error responses never include stack traces. Workers Logs are enabled through `observability` in `wrangler.jsonc`.

## Adding rate limiting later (optional)

Turnstile stops basic bots, but it does not limit how often a real user can call the API. Each call costs Gemini tokens. Options:

- **Workers Rate Limiting binding**: add a `ratelimits` entry in `wrangler.jsonc`, call `env.RATE_LIMITER.limit({ key: ip })` at the start of `/api/assess`, and return `429 RATE_LIMITED` (the error code is already in the contract). See <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>.
- **WAF rate limiting rules** on a custom domain in the Cloudflare dashboard. No code changes are needed.

## Defaults chosen where the spec was open

- **Gemini model**: `gemini-3.8-flash`. It was the newest stable Flash model on Google's models page when this was built (November 2026). Change it with `GEMINI_MODEL`.
- **Response schema**: the request sets `generationConfig.responseJsonSchema`, using only keywords Gemini supports, and limits categories and services to enums. If the first call returns HTTP 400 (for example because a model rejects the schema), the retry is sent without the schema. The output is still validated with Zod either way.
- **System instruction** goes in Gemini's `systemInstruction` field, and the labelled images follow in one user turn.
- **Retry policy**: at most 2 Gemini calls per request. HTTP errors, timeouts (60 s per attempt), malformed JSON and schema mismatches all count as a failed attempt.
- **Service names** from Gemini are matched to the menu ignoring case. Names not on the menu are dropped instead of failing the request.
- **Response part order** follows the request order.
- **`data:` prefix**: the contract says not to send one, but a `data:image/...;base64,` prefix is stripped if present rather than being sent to Gemini.
- **Turnstile** fails closed: if `siteverify` cannot be reached, the request gets `403 BOT_CHECK_FAILED`.
- **CORS**: requests from origins not on the list get no CORS headers, so the browser blocks them. The server does not reject them itself, and Turnstile is the real gate. Allowed headers: `Content-Type`. Allowed methods: GET, POST and OPTIONS.
- **Unknown routes** return `404` with code `INVALID_REQUEST`, because the contract has no `NOT_FOUND` code.
- **Free-plan CPU budget**: the free plan allows about 10 ms of CPU time per request. Time spent waiting on Gemini does not count, but parsing and re-serialising a multi-megabyte body does. The frontend should resize and compress photos before uploading, for example to about 1600 px on the long edge at JPEG quality 0.8 (roughly 200-400 KB each). This keeps requests fast and well under the limit. If you regularly send near-8 MB bodies, consider the Workers Paid plan.
