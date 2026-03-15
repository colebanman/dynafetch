import type { ScriptAsset } from './types.ts';

export type ThirdPartyPolicy = 'execute-all' | 'skip-noncritical';

export type ScriptCategory =
  | 'application'
  | 'telemetry'
  | 'ads'
  | 'chat'
  | 'widget'
  | 'bot-defense'
  | 'unknown';

const TELEMETRY_URL_PATTERNS = [
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /googleadservices\.com/i,
  /doubleclick\.net/i,
  /googleads\.g\.doubleclick\.net/i,
  /posthog/i,
  /segment\./i,
  /segmentcdn/i,
  /analytics/i,
  /mixpanel/i,
  /amplitude/i,
  /fullstory/i,
  /hotjar/i,
  /clarity\.ms/i,
  /newrelic/i,
  /datadog/i,
  /bugsnag/i,
  /sentry/i,
  /logrocket/i,
  /heap/i,
  /rudderstack/i,
  /gtag\/js/i,
];

const AD_URL_PATTERNS = [
  /doubleclick/i,
  /adservice/i,
  /adsystem/i,
  /adnxs/i,
  /taboola/i,
  /outbrain/i,
  /criteo/i,
  /ads-twitter\.com/i,
  /connect\.facebook\.net.*fbevents/i,
];

const CHAT_URL_PATTERNS = [
  /intercom/i,
  /drift/i,
  /crisp\.chat/i,
  /zendesk/i,
  /olark/i,
  /livechat/i,
  /tawk\.to/i,
];

const WIDGET_URL_PATTERNS = [
  /maps\.googleapis\.com\/maps\/api\/js/i,
  /maps-api-v3/i,
  /recaptcha/i,
  /hcaptcha/i,
  /player\.vimeo/i,
  /youtube\.com\/iframe_api/i,
  /static\.zdassets\.com/i,
];

const BOT_DEFENSE_PATTERNS = [
  /perimeterx/i,
  /kasada/i,
  /kpsdk/i,
  /datadome/i,
  /px-cdn/i,
];

const TELEMETRY_INLINE_PATTERNS = [
  /GoogleAnalyticsObject/i,
  /\bgtag\s*\(/i,
  /\bga\s*\(\s*['"]create['"]/i,
  /\bposthog\b/i,
  /\bmixpanel\b/i,
  /\bclarity\s*\(/i,
  /\bfbq\s*\(/i,
  /\bhj\s*\(/i,
  /\bnewrelic\b/i,
  /\bdatadog\b/i,
  /\bSentry\.(?:init|capture|captureException|configureScope|withScope)\b/i,
  /\bLogRocket\.(?:init|identify|track)\b/i,
];

const INLINE_APPLICATION_PATTERNS = [
  /\bwebpackChunk\w*/i,
  /\b__webpack_require__\b/i,
  /\b__SCRIPTS_LOADED__\b/i,
  /\b__LOADABLE_LOADED_CHUNKS__\b/i,
  /\bparcelRequire\b/i,
  /\bwindow\.__[A-Z0-9_]{3,}\s*=/i,
  /\bglobalThis\.__[A-Z0-9_]{3,}\s*=/i,
  /\bself\.__[A-Z0-9_]{3,}\s*=/i,
  /\bperformance\.mark\s*\(/i,
];

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function siteKey(hostname: string): string {
  const parts = hostname.split('.').filter(Boolean);
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join('.');
}

export function isLikelySameSite(candidateUrl: string, pageUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    const page = new URL(pageUrl);
    if (candidate.origin === page.origin) return true;
    return siteKey(candidate.hostname.toLowerCase()) === siteKey(page.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function matchesAny(input: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(input));
}

export function classifyScriptAsset(script: Pick<ScriptAsset, 'url' | 'content' | 'scriptKind' | 'type'>, pageUrl: string): ScriptCategory {
  const url = script.url || '';
  const content = script.content || '';

  if (url && matchesAny(url, BOT_DEFENSE_PATTERNS)) return 'bot-defense';
  if (!url && matchesAny(content, BOT_DEFENSE_PATTERNS)) return 'bot-defense';

  if (url) {
    if (matchesAny(url, TELEMETRY_URL_PATTERNS)) return 'telemetry';
    if (matchesAny(url, AD_URL_PATTERNS)) return 'ads';
    if (matchesAny(url, CHAT_URL_PATTERNS)) return 'chat';
    if (matchesAny(url, WIDGET_URL_PATTERNS)) return 'widget';
    if (isLikelySameSite(url, pageUrl)) return 'application';
    if (script.scriptKind === 'module') return 'application';
    return 'unknown';
  }

  if (matchesAny(content, INLINE_APPLICATION_PATTERNS)) return 'application';
  if (matchesAny(content, TELEMETRY_INLINE_PATTERNS)) return 'telemetry';
  return 'application';
}

export function shouldSkipScriptCategory(category: ScriptCategory, policy: ThirdPartyPolicy): boolean {
  if (category === 'bot-defense') return true;
  if (policy === 'execute-all') return false;
  return category === 'telemetry' || category === 'ads' || category === 'chat' || category === 'widget';
}

export function shouldSkipScriptAsset(
  script: Pick<ScriptAsset, 'url' | 'content' | 'scriptKind' | 'type'>,
  pageUrl: string,
  policy: ThirdPartyPolicy,
): boolean {
  return shouldSkipScriptCategory(classifyScriptAsset(script, pageUrl), policy);
}

export function shouldSkipDynamicScriptUrl(url: string, pageUrl: string, policy: ThirdPartyPolicy): boolean {
  return shouldSkipScriptAsset({ url, content: '', scriptKind: 'classic', type: 'external' }, pageUrl, policy);
}
