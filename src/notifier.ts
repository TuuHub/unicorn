export interface Notification {
  title: string;
  body: string;
}

export interface Notifier {
  send(notification: Notification): Promise<void>;
}

export class DiscordNotifier implements Notifier {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly webhookUrl: string,
    fetcher?: typeof fetch,
  ) {
    if (fetcher) {
      this.fetcher = (input, init) => fetcher(input, init);
    } else {
      this.fetcher = globalThis.fetch.bind(globalThis);
    }
  }

  async send(notification: Notification): Promise<void> {
    const response = await this.fetcher(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `**${notification.title}**\n${notification.body}` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Notifier returned HTTP ${response.status}.`);
    }
  }
}
