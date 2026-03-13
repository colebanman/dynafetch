# dynafetch

Fetch any website like a real browser. One function call.

dynafetch emulates Chrome at the network level — TLS fingerprinting, header ordering, JavaScript execution, and full request interception — so you get the same HTML and data a real user would see.

```ts
import { dynafetch } from "dynafetch";

const page = await dynafetch("https://example.com");
console.log(page.html);       // fully rendered HTML
console.log(page.framework);  // "nextjs", "inertia", "nuxt", ...
console.log(page.status);     // 200
```

## Why dynafetch?

Most scrapers either get blocked by bot protection or miss data that loads via JavaScript. dynafetch solves both:

- **Chrome TLS fingerprint** — indistinguishable from a real browser at the network layer
- **Full JS execution** — SPAs, client-rendered content, lazy-loaded data all work
- **Request interception** — every `fetch()`, XHR, and WebSocket the page makes is captured
- **Framework detection** — automatically identifies Next.js, Nuxt, Inertia, Remix, Astro, SvelteKit, and more
- **Fast** — parallel module resolution and batch network calls. A complex Vite app with 700+ modules renders in under 5 seconds

## Hyper-Proxying

dynafetch doesn't just support proxies — it lets you choose exactly which requests go through them.

```ts
// Proxy everything
const page = await dynafetch({
  url: "https://example.com",
  proxy: "http://user:pass@ip:port",
});

// Only proxy the page and API calls — save bandwidth on static assets
const page = await dynafetch({
  url: "https://example.com",
  proxy: {
    url: "http://user:pass@ip:port",
    only: ["page", "api"],
  },
});
```

Three scopes you can mix and match:

| Scope | What it covers |
|-|-|
| `"page"` | The initial HTML document fetch |
| `"api"` | `fetch()` and XHR calls made by page scripts |
| `"assets"` | JS scripts, ES modules, static resources |

Use `"page"` and `"api"` to protect the requests that actually get blocked, while letting static CDN assets load directly.

## Custom headers and cookies

Chrome 146 headers are used by default. Anything you set merges on top — your values override the defaults, everything else stays.

```ts
const page = await dynafetch({
  url: "https://example.com",
  headers: { "Accept-Language": "fr-FR" },
  cookies: { session: "abc123" },
});
```

## Tuning speed

dynafetch waits for the page to "settle" — all async requests finish, then a quiet period confirms nothing else is coming. You can tune this:

```ts
// Fast — return as soon as possible
const page = await dynafetch({
  url: "https://example.com",
  maxWaitMs: 1000,
  idleWaitMs: 50,
});

// Thorough — wait longer for slow APIs
const page = await dynafetch({
  url: "https://example.com",
  maxWaitMs: 5000,
  idleWaitMs: 200,
});
```

| Option | Default | What it does |
|-|-|-|
| `minWaitMs` | `75` | Min ms before checking if idle |
| `idleWaitMs` | `100` | Ms of silence before considering settled |
| `maxWaitMs` | `2000` | Hard cap — return regardless of activity |
| `moduleWaitMs` | `6000` | Max wait for ES module bundling |
| `timeoutMs` | none | Overall operation timeout |

## How it works

1. **Harvest** — fetches the HTML through a Go-based TLS client that impersonates Chrome's exact handshake. Parses scripts, modulepreloads, and SSR state.

2. **Module graph resolution** — recursively discovers and batch-fetches the entire JS dependency tree in parallel. 700+ modules resolve in ~5 batch rounds instead of 700 sequential requests.

3. **Execute** — runs scripts in a sandboxed environment with full browser API shims. Every network call is intercepted and routed through the TLS proxy.

4. **Settle** — waits for async activity to complete, then returns rendered HTML, framework metadata, and timing breakdown.

## Requirements

- Node.js 18+
- Go 1.21+ (for the TLS proxy)

## License

MIT
