export class BlockedByBotProtectionError extends Error {
  readonly kind = "blocked" as const
  readonly url: string

  constructor(url: string, message?: string) {
    super(message || `Blocked by bot protection while fetching: ${url}`)
    this.url = url
    this.name = "BlockedByBotProtectionError"
  }
}

