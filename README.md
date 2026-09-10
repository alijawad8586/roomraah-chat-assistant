# RoomRaah Chat Assistant

An Angular library that adds a hostel-search chatbot to a RoomRaah-style application:
somebody types "mere nazdeek 25k tak boys hostel chahiye wifi ke sath" and gets back a
handful of real listings, ranked, with a reason for each — in Roman Urdu, English, or a mix
of both.

Extracted from the [RoomRaah frontend](https://github.com/alijawad8586/RoomRaah-frontend) as
a standalone, reusable package.

## Why it is built this way

A language model is asked to do exactly two things: read the sentence, and write the reply.
Everything in between — filtering, measuring distance, scoring, ranking, retrying when
nothing matched — is ordinary, deterministic TypeScript. Ranking in particular is arithmetic,
not a prompt: a model asked to order five hostels by price and distance answers differently
on a second run and cannot be unit tested, while `ranker.ts` does it in microseconds and is
pinned to exact scores in its test suite.

```
message → parse (LLM) → locate → resolve facilities → search → rank → enrich → compose (LLM)
```

## What is in the package

```
src/
  lib/
    chat-config.ts          the one thing a host app configures: the API base URL
    models/                 SearchIntent, PropertyCard and the rest of the shared shapes
    utils/geo.util.ts       haversine distance — the only function with zero dependencies
    services/                PropertyService, ReferenceService, GeolocationService
    chat/
      ranker.ts              pure scoring: budget, distance, facilities, availability, trust
      intent.parser.ts       POST /ai/parse, and never believes the response
      location.resolver.ts   the person's position, or a named place, or a question
      reference.resolver.ts  "wifi" -> facility id, through a cached catalogue
      candidate.fetcher.ts   one search, filtered as far as the server can go
      chat.service.ts        the orchestrator, and the one retry when nothing matched
    ui/
      chat-widget.component.*   the bubble and the panel
      button/, spinner/, empty-state/   the three primitives it renders with
  demo/demo.component.ts     a page to run the widget against a real API
  main.ts                    the demo's bootstrap
  public-api.ts              everything the package exports

AI_ENDPOINTS_CONTRACT.md      the API contract this package is built against
```

## Requirements

The two endpoints this package calls — `POST /ai/parse` and `POST /ai/compose` — are
specified in full in [`AI_ENDPOINTS_CONTRACT.md`](./AI_ENDPOINTS_CONTRACT.md): request and
response shapes, the behavioural rules a backend must follow (never inventing a listing,
writing "maloom nahi" for a field it does not have, stripping owner contact info from its own
output before returning it), and worked examples. A backend that does not yet exist can still
be developed against that document; everything in this package's own test suite is written
against it rather than against a running server.

## Getting started

```bash
npm install
npm start        # serves the demo at http://localhost:4200
npm test         # runs the unit tests
npm run build    # production build of the demo
```

## Using it in another application

```ts
import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideRoomRaahChat, ChatWidgetComponent } from 'roomraah-chat-assistant';

bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(),
    provideRoomRaahChat('https://your-api.example.com/api/v1'),
  ],
});
```

```html
<!-- anywhere in the shell, ideally behind @defer so it costs nothing until it is opened -->
@defer (on idle) {
  <app-chat-widget />
}
```

`provideRoomRaahChat` is the only thing a host application configures — the package has no
`environment.ts` of its own and no opinion about where the API lives. It expects the same
`PropertyCard` / `PropertyFilters` shapes and the same `/properties`, `/locations`,
`/facilities` endpoints as the RoomRaah API; see `AI_ENDPOINTS_CONTRACT.md` §2 for the exact
fields.

### Design tokens

The three UI primitives (`button`, `spinner`, `empty-state`) and the widget's own styles are
written against SCSS tokens in `src/styles/_tokens.scss` and `_mixins.scss` — deep navy
(`#123B5D`), green (`#16A36A`), a soft background (`#F7F9FA`), and Inter. A host application
using the same design system can point its `stylePreprocessorOptions.includePaths` at
`src/styles` and the components pick up its palette; otherwise the bundled tokens are used
as-is.

## What is deliberately not in here

- **No AI/LLM calls of its own.** `intent.parser.ts` and `chat.service.ts` call the two
  documented endpoints and nothing else — no API key, no model SDK, no prompt.
- **No RAG, no vector store.** A recommendation is built from five real, already-fetched
  listings; there is nothing to retrieve that HTTP does not already fetch.
- **No new UI primitives.** The widget renders with a button, a spinner and an empty state —
  the same three components almost any admin/dashboard-style app already has.

## License

MIT — see [`LICENSE`](./LICENSE).
