# dynafetch

Fetch any website like a real browser. One function call.

dynafetch provides Chrome-level TLS fingerprinting, JavaScript execution, and full network interception. The response includes fully rendered HTML and all captured requests.

## Install

```bash
npm i @grabbit-labs/dynafetch
```

## Usage

```ts
import { dynafetch } from "@grabbit-labs/dynafetch";

const page = await dynafetch("https://example.com");
console.log(page.html);       // fully rendered HTML
console.log(page.framework);  // "nextjs", "inertia", "nuxt", ...
console.log(page.status);     // 200
```

## Features

- **Chrome TLS fingerprint**: indistinguishable from a real browser at the network layer
- **Full JS execution**: SPAs, client-rendered content, and lazy-loaded data
- **Request interception**: captures every `fetch()`, XHR, and WebSocket call
- **Framework detection**: identifies Next.js, Nuxt, Inertia, Remix, Astro, SvelteKit, and more
- **Performance**: parallel module resolution and batch network calls; 700+ module Vite apps render in under 5 seconds

## Hyper-Proxying

Route specific request types through your proxy while letting others connect directly. This reduces proxy bandwidth and latency for requests that don't need it.

```ts
// Proxy all requests
const page = await dynafetch({
  url: "https://example.com",
  proxy: "http://user:pass@ip:port",
});

// Only proxy the page fetch and API calls, not static assets
const page = await dynafetch({
  url: "https://example.com",
  proxy: {
    url: "http://user:pass@ip:port",
    only: ["page", "api"],
  },
});
```

| Scope | Covers |
|-|-|
| `"page"` | Initial HTML document fetch |
| `"api"` | `fetch()` and XHR calls from page scripts |
| `"assets"` | JS scripts, ES modules, static resources |

## Headers and cookies

Chrome 146 headers are included by default. Custom headers merge on top; your values override the defaults, everything else is preserved.

```ts
const page = await dynafetch({
  url: "https://example.com",
  headers: { "Accept-Language": "fr-FR" },
  cookies: { session: "abc123" },
});
```

## AI SDK tool

Use dynafetch as a tool in the [Vercel AI SDK](https://sdk.vercel.ai):

```ts
import { z } from "zod";
import { generateText, tool } from "ai";
import { dynafetch } from "@grabbit-labs/dynafetch";

const result = await generateText({
  model: yourModel,
  tools: {
    fetchPage: tool({
      description: "Fetch a web page with full browser emulation and return the rendered HTML",
      parameters: z.object({
        url: z.string().url().describe("The URL to fetch"),
      }),
      execute: async ({ url }) => {
        const page = await dynafetch(url);
        return { html: page.html, status: page.status, framework: page.framework };
      },
    }),
  },
  prompt: "Get the homepage of example.com and summarize it",
});
```

## Quiescence tuning

dynafetch waits for async network activity to complete before returning. These options control that behavior:

```ts
// Return quickly
const page = await dynafetch({
  url: "https://example.com",
  maxWaitMs: 1000,
  idleWaitMs: 50,
});

// Wait longer for slow endpoints
const page = await dynafetch({
  url: "https://example.com",
  maxWaitMs: 5000,
  idleWaitMs: 200,
});
```

| Option | Default | Description |
|-|-|-|
| `minWaitMs` | `75` | Minimum ms before checking idle state |
| `idleWaitMs` | `100` | Ms of zero pending requests to consider settled |
| `maxWaitMs` | `3000` | Hard cap on wait time |
| `moduleWaitMs` | `6000` | Max wait for ES module bundling |
| `timeoutMs` | none | Overall operation timeout |

## Architecture

1. **Harvest**: fetches the HTML document through a TLS client matching Chrome's handshake. Parses scripts, modulepreloads, and SSR state.

2. **Module graph resolution**: recursively discovers and batch-fetches the full JS dependency tree in parallel. 700+ modules resolve in approximately 5 batch rounds.

3. **Execute**: runs scripts in a sandboxed environment with browser API shims. All network calls are intercepted and routed through the TLS proxy.

4. **Settle**: waits for async activity to complete, then returns rendered HTML, framework metadata, and timing breakdown.

## Requirements

- Node.js 18+

The TLS proxy ships as precompiled binaries for macOS (arm64, x64), Linux (arm64, x64), and Windows (x64). No additional toolchain required.

## License

MIT
