# AI chatbot endpoints — backend contract

**Status:** specification for implementation. No implementation exists yet.
**Owner:** backend developer (separate repository).
**Consumer:** the Angular frontend in this repository, `app/src/app/core/chat/`.

This document is the agreement. Where it disagrees with anything said in conversation, this
document wins. Every JSON schema below was taken field-for-field from the TypeScript the
frontend actually compiles against, with file and line references, so that a mismatch is a
bug in one of two named files rather than a difference of memory.

---

## 1. Base URL and versioning

Both endpoints live under the **same base URL and the same version prefix as every existing
RoomRaah endpoint**. They are part of the existing API, not a separate service.

Evidence, from this repository:

| Source | Value |
|---|---|
| `app/src/environments/environment.ts:3` | `apiBaseUrl: 'http://52.72.119.254:8080/api/v1'` |
| `app/src/environments/environment.development.ts:3` | `apiBaseUrl: 'http://52.72.119.254:8080/api/v1'` |
| `contract/RoomRaah.openapi.json` | all 68 existing paths are keyed `/api/v1/...` |

Verified live at time of writing: `GET http://52.72.119.254:8080/api/v1/facilities` and
`GET http://52.72.119.254:8080/api/v1/locations/cities` both answer `200`.

**Final paths:**

```
POST  /api/v1/ai/parse
POST  /api/v1/ai/compose
```

Absolute, against the current deployment:

```
http://52.72.119.254:8080/api/v1/ai/parse
http://52.72.119.254:8080/api/v1/ai/compose
```

No evidence was found for any other prefix, and no separate AI host is proposed. Because
these sit under `apiBaseUrl`, the frontend needs **no new environment variable** and **no
interceptor change** — `authInterceptor` already attaches a bearer token to every request
whose URL starts with `apiBaseUrl`.

### CORS

Same requirement as the rest of the API: the browser calls these directly from
`http://localhost:4200`, so they must be covered by the existing CORS policy. No wildcard —
the policy already sends credentials.

### Authentication

**Both endpoints are public.** Browsing is public in RoomRaah (Brief §1.3), and the chatbot
is a browsing aid: a signed-out visitor must be able to use it. The frontend will send an
`Authorization: Bearer` header when a session happens to exist, so the endpoints must
tolerate one, but must not require it and must not behave differently with it.

### Rate limiting

Each call costs a paid LLM request, so both endpoints need a rate limit. Suggested: per-IP,
and stricter than the rest of the API. The exact policy is the backend's to choose; the
frontend will treat `429` as a retryable failure (see error tables).

---

## 2. Shared types

These are **not** new types. They are what the frontend already compiles against, and the
backend must serialise exactly these names, casings and nullabilities.

### 2.1 `SearchIntent`

Source of truth: `app/src/app/core/models/chat.model.ts:24-47`. Reproduced verbatim:

```ts
export interface SearchIntent {
  budgetMax?: number;
  nearMe?: boolean;
  cityName?: string;
  areaName?: string;
  landmarkName?: string;
  genderPolicy?: string | null;
  facilityNames: string[];
  roomType?: string;
  language: 'roman-ur' | 'en';
  missingField: string | null;
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `budgetMax` | `number` | no | Rupees per month, as an integer. `"25k"`, `"25 hazar"`, `"pchees hazar"` all become `25000`. |
| `nearMe` | `boolean` | no | `true` only when the person asked for somewhere near *them*, not near a named place. |
| `cityName` | `string` | no | As written by the person. The backend does **not** resolve it to an id. |
| `areaName` | `string` | no | As written. Not resolved to an id. |
| `landmarkName` | `string` | no | A university or workplace by name. Not resolved to an id. |
| `genderPolicy` | `string` \| `null` | no | **Deliberately not an enum.** See §2.1.1. |
| `facilityNames` | `string[]` | **yes** | Always present. Empty array when none were named — never `null`, never omitted. |
| `roomType` | `string` | no | **Deliberately not an enum.** See §2.1.1. |
| `language` | `"roman-ur"` \| `"en"` | **yes** | Exactly these two values. See §2.1.2. |
| `missingField` | `string` \| `null` | **yes** | Always present. `null` means "search now". See §3.3. |

#### 2.1.1 Why `genderPolicy` and `roomType` are strings, not enums

The backend must **not** validate or normalise these two. They are typed as plain strings
because they come out of a language model, which can return `"boys"`, `"Boys"`, `"BOYS"`,
`"male"` or `"larkon"`. The frontend validates them against the catalogue enumerations and
silently drops anything that does not match
(`app/src/app/core/chat/candidate.fetcher.ts`, `matchEnum`).

Return whatever the model produced. Returning `null` for an unrecognised value is also
acceptable. Do **not** return a 400 because the model said `"male"`.

For reference, the values the frontend can use, from `app/src/app/core/models/catalog.model.ts:19-20`:

```ts
export type RoomType = 'Private' | 'Shared';
export type GenderPolicy = 'Boys' | 'Girls' | 'Family';
```

#### 2.1.2 `language`

Only two values. `"roman-ur"` covers Urdu written in Latin script and mixed
Urdu/English — which is the common case — and `"en"` covers plain English. Urdu in Arabic
script should also be reported as `"roman-ur"`, because the reply is composed in Roman Urdu
either way. There is no third value; do not add one without amending this document.

### 2.2 `PropertyCard`

Source of truth: `app/src/app/core/models/catalog.model.ts:78-101`. Reproduced verbatim:

```ts
export interface PropertyCard {
  id: number;
  title: string;
  areaId: number;
  areaName: string;
  cityId: number;
  cityName: string;
  roomType: RoomType;
  genderPolicy: GenderPolicy;
  totalBeds: number;
  availableBeds: number;
  monthlyRent: number;
  securityDeposit: number;
  utilitiesCharge: number;
  messCharge: number;
  latitude: number;
  longitude: number;
  primaryThumbnailUrl: string | null;
  photoCount: number;
  hasInspectionBadge: boolean;
  availabilityConfirmedAt: string | null;
  distanceKm: number | null;
}
```

This is the **same shape `GET /api/v1/properties` already returns**, so the backend does not
need a new DTO for it — but see the two notes below, because the frontend does not send it
back untouched.

#### 2.2.1 `distanceKm` is not the API's distance

On `GET /properties`, `distanceKm` is measured from a seeded landmark and is `null` unless
the search named one.

In an `/ai/compose` request body it means something different: **straight-line kilometres
from the person's own browser position**, computed client-side with a haversine over
`latitude`/`longitude` (`app/src/app/core/utils/geo.util.ts`). It is `null` when the browser
gave no position — which is the ordinary case over plain http, where geolocation is withheld
entirely.

The backend must treat it as an input value like any other, and must render `null` as
"maloom nahi" rather than omitting the distance line or guessing at it.

#### 2.2.2 `PropertyCard` carries no owner contact

There is no `phone`, `email`, `whatsapp`, `ownerName` or `ownerPhone` field on this shape,
by design (Brief §1.1 — owner contact never appears anywhere). The output guard in §4.3 is
therefore defence in depth, not a filter on an expected field. It is still mandatory: it
exists to catch a model that hallucinates a phone number, or a future payload change that
adds one.

---

## 3. `POST /api/v1/ai/parse`

Turns one free-text message into a `SearchIntent`. This endpoint does no searching, touches
no listing data, and returns no prose.

### 3.1 Request

```jsonc
{
  "text": "string"   // required, 1..2000 characters
}
```

| Field | Type | Required | Constraint |
|---|---|---|---|
| `text` | `string` | yes | Non-empty after trimming; at most 2000 characters. |

The 2000 limit mirrors the message-body limit the rest of the API already enforces
(Brief §7).

### 3.2 Response — `200 OK`

A `SearchIntent` object exactly as specified in §2.1, and **nothing else**. No wrapper, no
`data` envelope, no confidence score, no echo of the input.

### 3.3 Behavioural rules the backend MUST implement

**R1 — `missingField` is `"budget"` if and only if no budget amount could be extracted.**

This is a biconditional, and both directions are load-bearing:

- If no budget amount could be extracted → `missingField` **must** be `"budget"`.
- If a budget amount was extracted → `missingField` **must** be `null`.

`missingField` must never take any other value. A missing city, a missing gender, a missing
facility list, an ambiguous message — none of these may set it. The frontend asks the person
exactly one follow-up question and only when `missingField === "budget"`; any other value
would produce a question it has no wording for.

**R2 — every other field is optional and must not trigger a follow-up.**

Absent means "no opinion", which the frontend turns into a wider search, never into a
question and never into an error. Omit the field or send `null`; both are read the same way.

**R3 — `facilityNames`, `language` and `missingField` are always present.**

`facilityNames` is `[]` when none were named, never `null` and never omitted. `language` is
always one of the two literals. `missingField` is always present, `null` or `"budget"`.

**R4 — normalise numbers, do not normalise words.**

`budgetMax` must be an integer number of rupees: `"25k"` → `25000`, `"25 hazar"` → `25000`,
`"pchees hazar"` → `25000`, `"20 se 30 hazar"` → `30000` (the ceiling; there is no
`budgetMin` in this shape). Every other field is passed through as the person said it — see
§2.1.1.

**R5 — the endpoint must not search.**

Parsing produces an intent. It must not call the property API, read the database, or return
listings.

### 3.4 Examples

**A. Everything present**

Request:
```json
{ "text": "mere nazdeek 25k ke andar boys hostel chahiye wifi aur mess ke sath" }
```

Response `200`:
```json
{
  "budgetMax": 25000,
  "nearMe": true,
  "cityName": null,
  "areaName": null,
  "landmarkName": null,
  "genderPolicy": "Boys",
  "facilityNames": ["wifi", "mess"],
  "roomType": null,
  "language": "roman-ur",
  "missingField": null
}
```

**B. No budget → the one follow-up**

Request:
```json
{ "text": "mere near koi boys hostel hai?" }
```

Response `200`:
```json
{
  "budgetMax": null,
  "nearMe": true,
  "cityName": null,
  "areaName": null,
  "landmarkName": null,
  "genderPolicy": "Boys",
  "facilityNames": [],
  "roomType": null,
  "language": "roman-ur",
  "missingField": "budget"
}
```

**C. English, named landmark, no gender — still `missingField: null`**

Request:
```json
{ "text": "I need a room under 18000 near Punjab University" }
```

Response `200`:
```json
{
  "budgetMax": 18000,
  "nearMe": false,
  "cityName": null,
  "areaName": null,
  "landmarkName": "Punjab University",
  "genderPolicy": null,
  "facilityNames": [],
  "roomType": null,
  "language": "en",
  "missingField": null
}
```

Note that a missing `genderPolicy` does **not** set `missingField`. That is R1 and R2 working
together.

### 3.5 Errors

| Status | When | Body | Frontend behaviour |
|---|---|---|---|
| `400` | `text` absent, empty/whitespace, not a string, or over 2000 chars | `{ "error": "string" }` | Shows a short "I didn't catch that" message. Does not retry. |
| `429` | Rate limit exceeded | `{ "error": "string" }` | Shows "one moment" and lets the person retry. |
| `502` | LLM provider returned an error, or returned unparseable JSON | `{ "error": "string" }` | Shows a service-unavailable message. Does not retry automatically. |
| `504` | LLM call exceeded the server's timeout | `{ "error": "string" }` | Same as `502`. |

The backend must **never** return a partial or invented `SearchIntent` when the LLM fails. A
failure is an error status, not a default-filled object — a fabricated intent would silently
search for the wrong thing.

Recommended server-side LLM timeout: **10 seconds**. The frontend will give up at 30.

---

## 4. `POST /api/v1/ai/compose`

Turns a ranked shortlist into a natural-language recommendation. The frontend has already
searched, filtered and ranked; this endpoint only writes the reply.

### 4.1 Request

```jsonc
{
  "hostels": [ /* ComposeHostel, see §2.2 and §6.1 */ ],  // required, 1..5 objects
  "language": "roman-ur" | "en",                          // required
  "mode": "normal" | "fallback"                           // optional, defaults to "normal"
}
```

| Field | Type | Required | Constraint |
|---|---|---|---|
| `hostels` | `ComposeHostel[]` | yes | At least 1, at most 5. Already ranked — index 0 is the best match. `ComposeHostel` is `PropertyCard` plus `averageRating` — see §6.1. |
| `language` | `"roman-ur"` \| `"en"` | yes | Same two literals as §2.1.2. |
| `mode` | `"normal"` \| `"fallback"` | no | Defaults to `"normal"` when absent. |

**Order is meaningful.** The array arrives sorted best-first by the frontend's ranker. The
reply must present them in the order received and must not reorder them — the backend has no
access to the signals the order was computed from.

### 4.2 Response — `200 OK`

```jsonc
{
  "reply": "string"   // natural language, in the requested language
}
```

Plain text. No markdown tables. Light markdown (bold, bullets) is acceptable; the frontend
renders it as text.

### 4.3 Behavioural rules the backend MUST implement

**C1 — no database, no repository, no property service. Enforced in code, not by prompting.**

The handler for this endpoint **must not inject or call** any `DbContext`, repository, query
service, or anything else that can read property, listing, owner or user data. Its only
source of listing information is the `hostels` array in the request body.

This is a structural constraint, not a style preference: it is what makes it impossible for
this endpoint to leak a listing the person was not shown, or an owner's details, no matter
what the model is asked to write. If implementing it appears to require a data dependency,
that is a signal to change this document — not to add the dependency.

A test must assert this. See §5.

**C2 — a null or missing field is written as "maloom nahi", never guessed.**

| `language` | Wording for a null/missing field |
|---|---|
| `"roman-ur"` | `maloom nahi` |
| `"en"` | `not available` |

This applies to every nullable field on `PropertyCard`, and in practice most often to:

- `distanceKm` — `null` whenever the browser gave no position (§2.2.1)
- `availabilityConfirmedAt` — `null` when the owner has never confirmed availability
- `primaryThumbnailUrl` — `null` when the listing has no photo

- `averageRating` — `null` when the listing has no reviews, or the frontend's reviews call
  failed (§6.2)

The model must never estimate a distance, infer a rating, or describe a facility that is not
in the object. A rating may only ever be the `averageRating` value it was given.

**C3 — owner contact must never appear in the output, and the backend must check its own output.**

Two parts, both required:

1. The system prompt must forbid emitting any phone number, email address, WhatsApp
   reference, or personal contact link, and must instruct the model to direct the person to
   RoomRaah's in-app messaging and visit requests instead.
2. **After** the model responds and **before** the response is returned, the backend must run
   an automated scan over the generated text on **every call**. This is not optional, not
   sampled, and not skippable by configuration.

Suggested patterns for the scan — Pakistani mobile formats, generic international, email,
and messaging links:

```
\b03\d{2}[\s-]?\d{7}\b                 03XX-XXXXXXX
\b\+?92[\s-]?3\d{2}[\s-]?\d{7}\b       +92 3XX XXXXXXX
\b0092[\s-]?3\d{2}[\s-]?\d{7}\b        0092 3XX XXXXXXX
\b\d{4}[\s-]?\d{7}\b                   landline-ish 11-digit runs
[\w.+-]+@[\w-]+\.[\w.]+                email
\b(wa\.me|whatsapp|w[\s-]?app)\b       WhatsApp references (case-insensitive)
\b\d{5}-\d{7}-\d\b                     CNIC, which must never appear either
```

On a match, the backend must **either** strip the offending span and return the remaining
text, **or** reject and return `502`. It must never return the text unmodified. Whichever is
chosen, the incident should be logged server-side — a match means either the model
hallucinated a number or a payload started carrying one, and both are worth knowing about.

The frontend runs its own mechanical guard over its source (`tools/check-rules.mjs`, the
`contact` rule), but it cannot inspect text generated on the server. This scan is the only
thing standing between a hallucinated phone number and the screen.

**C4 — `mode: "fallback"` must say so explicitly.**

When `mode` is `"fallback"`, the frontend has already failed to find an exact match and has
re-run the search with relaxed filters. The reply **must** open by saying plainly that no
exact match was found and that these are the closest alternatives, before listing anything.
It must not present them as though they met the person's requirements.

When `mode` is `"normal"` or absent, the reply must not say anything of the kind.

**C5 — never invent a hostel.**

Every listing named in the reply must correspond to an object in `hostels`. No additions, no
composites, no "you might also like". The reply may name fewer than were sent if some are
poor matches, but never more.

### 4.4 Examples

**A. `mode: "normal"`, one null field**

Request:
```json
{
  "hostels": [
    {
      "id": 12, "title": "Al-Madina Boys Hostel",
      "areaId": 7, "areaName": "Gulberg", "cityId": 1, "cityName": "Lahore",
      "roomType": "Shared", "genderPolicy": "Boys",
      "totalBeds": 8, "availableBeds": 3,
      "monthlyRent": 23000, "securityDeposit": 20000,
      "utilitiesCharge": 1500, "messCharge": 0,
      "latitude": 31.5312, "longitude": 74.3489,
      "primaryThumbnailUrl": "http://.../thumb.jpg", "photoCount": 6,
      "hasInspectionBadge": true, "availabilityConfirmedAt": null,
      "distanceKm": 1.4
    }
  ],
  "language": "roman-ur",
  "mode": "normal"
}
```

Response `200`:
```json
{
  "reply": "**Al-Madina Boys Hostel** — Gulberg, Lahore\n- Rs. 23,000/month (+ Rs. 1,500 utilities)\n- 1.4 km aapse\n- 3 beds khaali (8 mein se)\n- Inspection badge ✓\n- Availability aakhri baar kab confirm hui: maloom nahi\n\nAapke budget ke andar hai aur sabse qareeb bhi."
}
```

Note `availabilityConfirmedAt: null` became **maloom nahi**, not an omitted line and not a
guessed date.

**B. `mode: "fallback"`, no position**

Request (abridged — `hostels` as above but with `"distanceKm": null` and
`"monthlyRent": 27000`):
```json
{ "hostels": [ /* 2 cards */ ], "language": "roman-ur", "mode": "fallback" }
```

Response `200`:
```json
{
  "reply": "Aapki exact requirements ke mutabiq koi hostel nahi mila. Yeh sabse qareeb options hain:\n\n**Al-Madina Boys Hostel** — Gulberg, Lahore\n- Rs. 27,000/month — aapke budget se thora zyada\n- Distance: maloom nahi\n- 3 beds khaali"
}
```

The reply opens by saying no exact match was found (C4), and the `null` distance is
**maloom nahi** (C2).

**C. `language: "en"`**

Same payload as A with `"language": "en"` produces the same content in English, and a null
field is written **not available**.

### 4.5 Errors

| Status | When | Body | Frontend behaviour |
|---|---|---|---|
| `400` | `hostels` absent, not an array, empty, or more than 5 | `{ "error": "string" }` | Bug in the frontend; logged, generic failure shown. |
| `400` | `language` absent or not one of the two literals | `{ "error": "string" }` | As above. |
| `400` | `mode` present but not one of the two literals | `{ "error": "string" }` | As above. |
| `400` | Any `hostels[i]` missing a required field of §2.2 | `{ "error": "string" }` | As above. |
| `429` | Rate limit exceeded | `{ "error": "string" }` | "One moment", retryable. |
| `502` | LLM error, **or** the §4.3 C3 output scan rejected the reply | `{ "error": "string" }` | Service-unavailable message. |
| `504` | LLM timeout | `{ "error": "string" }` | As `502`. |

**An empty `hostels` array is a `400`, not a `200` with an apology.** The frontend already
handles "nothing found" itself — it re-runs the search with relaxed filters and calls this
endpoint with `mode: "fallback"`, or tells the person directly without calling at all. If
this endpoint receives zero hostels, the frontend has a bug and should be told so.

On any error the frontend shows a failure message. It never falls back to composing a reply
locally, because doing so would mean rendering listing data through a path that has not been
through the §4.3 C3 scan.

---

## 5. Tests the backend must have

Framework is the backend repository's own — match whatever is already there (xUnit or NUnit),
do not introduce a second one. The LLM HTTP call must be mocked in all of these; none of them
may make a real provider call.

| # | Test | Asserts |
|---|---|---|
| 1 | Parse, complete message | A full message yields the right `SearchIntent`, `missingField: null` |
| 2 | Parse, no budget | `missingField === "budget"` |
| 3 | Parse, budget present but city/gender absent | `missingField === null` — R1's second direction |
| 4 | Parse, empty/whitespace `text` | `400`, no LLM call made |
| 5 | Parse, LLM failure | `502`, and **no** partially-filled intent in the body |
| 6 | Compose, null field | Reply contains `maloom nahi` for `roman-ur`, `not available` for `en` |
| 7 | Compose, contact leak | A mocked LLM reply containing `0300-1234567` is stripped or `502`'d — never returned as-is |
| 8 | Compose, `mode: "fallback"` | Reply explicitly states no exact match was found |
| 9 | Compose, empty `hostels` | `400` |
| 10 | Compose, 6 hostels | `400` |
| 11 | **Compose handler has no data dependency** | See below |

Test 11 is the one that enforces C1 structurally. Implement it as a reflection or
architecture test over the compose controller/handler type: assert that its constructor
parameters (and any injected fields) include no `DbContext`, no type whose name ends in
`Repository`, and no property/listing service. A convention test over the assembly is
acceptable; a comment is not.

---

## 6. Ratings — `averageRating`, supplied by the frontend

**Decided and implemented.** Ratings appear in chatbot replies, and the frontend supplies
them. `/ai/compose` must never fetch a rating itself — doing so would need a data dependency
in the compose handler, which C1 forbids outright.

`PropertyCard` has no rating field of its own. Ratings live on
`GET /api/v1/properties/{id}/reviews`, which returns `averageRating` alongside the review page
(`app/src/app/core/models/catalog.model.ts:150`, `ReviewPage`). The frontend calls that
endpoint once per listing it is about to show — the top 5 ranked candidates — and merges the
result in before calling `/ai/compose`.

### 6.1 The shape `/ai/compose` receives

Each element of `hostels` is a `PropertyCard` (§2.2) with one field added:

```ts
ComposeHostel = PropertyCard & { averageRating: number | null }
```

Implemented in `app/src/app/core/chat/chat.service.ts` as the exported `ComposeHostel`
interface. This supersedes the plain `PropertyCard[]` named in §4.1: the array is
`ComposeHostel[]`, which is a `PropertyCard` in every other respect.

| Field | Type | Required | Notes |
|---|---|---|---|
| `averageRating` | `number` \| `null` | **yes, always present** | The listing's mean review score, or `null`. Never omitted. |

### 6.2 `null` is expected, not an error

`averageRating` is `null` in two ordinary situations:

1. The listing has no reviews yet.
2. The reviews request failed, and the frontend chose `null` over guessing.

**Neither is an error case, and neither may be rejected with a `400`.** A `null` here is
exactly like a `null` `distanceKm` or `availabilityConfirmedAt`: it falls under **§4.3 C2**,
so it must be written as `maloom nahi` (or `not available` for `language: "en"`) and must
never be estimated, rounded to zero, or silently dropped from the reply.

A rating of `0` is not the same as `null` and should not be produced by the frontend; if one
arrives, render it as the number it is.

### 6.3 What this costs

Five extra `GET /api/v1/properties/{id}/reviews` requests per query, made by the frontend,
against the existing endpoint. Nothing is added to the backend's work beyond reading one more
field off each object it was already given.

---

## 7. Frontend integration summary

For the frontend developer, so nothing is assumed twice:

| Question | Answer |
|---|---|
| New environment variable? | **No.** Both live under `environment.apiBaseUrl`. |
| `authInterceptor` change? | **No.** URLs start with `apiBaseUrl`, so a token is attached automatically when a session exists. |
| Auth required? | No. Public, like `GET /properties`. |
| Which module calls `/ai/parse`? | `core/chat/intent.parser.ts` (not yet written). |
| Which module calls `/ai/compose`? | `core/chat/chat.service.ts` orchestrator (not yet written). |
| Frontend LLM timeout | 30 s, against a recommended 10 s server-side timeout. |
| Who computes `distanceKm`? | The frontend, via `core/utils/geo.util.ts`. See §2.2.1. |
| Who does ranking? | The frontend, in `core/chat/ranker.ts`. The backend must not reorder. |
