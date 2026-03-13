export type HeaderOrder = string[];

const CHROME_146_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const CHROME_146_SEC_CH_UA =
  "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Google Chrome\";v=\"146\"";

// Chrome-like request headers tuned for HTML document navigation.
// Keep this in sync with the active Go TLS profile and browser signature.
export function chromeDocumentHeaders(): { headers: Record<string, string>; order: HeaderOrder } {
  const headers: Record<string, string> = {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "max-age=0",
    priority: "u=0, i",
    "sec-ch-ua": CHROME_146_SEC_CH_UA,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"macOS\"",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    "user-agent": CHROME_146_USER_AGENT,
  };

  const order: HeaderOrder = [
    "accept",
    "accept-language",
    "cache-control",
    "priority",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
    "upgrade-insecure-requests",
    "user-agent",
  ];

  return { headers, order };
}

export function chromeSubresourceHeaders(referer: string): { headers: Record<string, string>; order: HeaderOrder } {
  const headers: Record<string, string> = {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "sec-ch-ua": CHROME_146_SEC_CH_UA,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"macOS\"",
    referer,
    "user-agent": CHROME_146_USER_AGENT,
  };
  const order: HeaderOrder = [
    "accept",
    "accept-language",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "referer",
    "user-agent",
  ];
  return { headers, order };
}
