import type { HarvestResult } from "../../../src/phantom/types.ts";
import type { DynafetchFramework } from "./types";

function hasScriptUrl(harvest: HarvestResult, pattern: RegExp): boolean {
  return harvest.scripts.some((script) => Boolean(script.url && pattern.test(script.url)));
}

export function detectFramework(harvest: HarvestResult): DynafetchFramework {
  const html = harvest.html;
  const lower = html.toLowerCase();

  if (
    "__NEXT_DATA__" in harvest.initialState ||
    lower.includes("__next_data__") ||
    lower.includes("/_next/") ||
    hasScriptUrl(harvest, /\/_next\//i)
  ) {
    return "nextjs";
  }

  if (
    "__NUXT__" in harvest.initialState ||
    lower.includes("__nuxt") ||
    hasScriptUrl(harvest, /\/_nuxt\//i)
  ) {
    return "nuxt";
  }

  if (
    lower.includes("window.__remixcontext") ||
    lower.includes("remix-context") ||
    hasScriptUrl(harvest, /\/build\/.*entry\.client/i)
  ) {
    return "remix";
  }

  if (
    lower.includes("data-page=") ||
    hasScriptUrl(harvest, /inertia-[^/]+\.js/i) ||
    hasScriptUrl(harvest, /\/vite\/assets\//i)
  ) {
    return "inertia";
  }

  if (
    lower.includes("astro-island") ||
    lower.includes("__astro") ||
    hasScriptUrl(harvest, /\/_astro\//i)
  ) {
    return "astro";
  }

  if (
    lower.includes("__sveltekit") ||
    hasScriptUrl(harvest, /\/_app\/immutable\//i)
  ) {
    return "sveltekit";
  }

  if (lower.includes("hx-get=") || lower.includes("hx-post=") || lower.includes("hx-trigger=")) {
    return "htmx";
  }

  if (harvest.scripts.length > 0) {
    return "generic-spa";
  }

  return "static";
}
