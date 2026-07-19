export interface Notification {
  title: string;
  body: string;
}

export interface Notifier {
  send(notification: Notification): Promise<void>;
}

export type NotifierChannel = "discord" | "telegram" | "email";

export interface NotifierEnv {
  NOTIFIER_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  EMAIL_FROM?: string;
  EMAIL_TO?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

// Each channel rejects messages over a hard length limit, which would otherwise make
// a long digest deterministically fail and burn every retry. Truncate to fit.
function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function bindFetch(fetcher?: typeof fetch): typeof fetch {
  if (fetcher) {
    return (input, init) => fetcher(input, init);
  }
  return globalThis.fetch.bind(globalThis);
}

export class DiscordNotifier implements Notifier {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly webhookUrl: string,
    fetcher?: typeof fetch,
  ) {
    this.fetcher = bindFetch(fetcher);
  }

  async send(notification: Notification): Promise<void> {
    // Discord caps a message at 2000 characters.
    const content = truncate(`**${notification.title}**\n${notification.body}`, 2000);
    const response = await this.fetcher(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // allowed_mentions:{parse:[]} disarms @everyone/@here/role pings, so ingested
      // post text rendered into the message can't trigger a mass notification.
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Notifier returned HTTP ${response.status}.`);
    }
  }
}

export class TelegramNotifier implements Notifier {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    fetcher?: typeof fetch,
  ) {
    this.fetcher = bindFetch(fetcher);
  }

  async send(notification: Notification): Promise<void> {
    // Telegram caps a message at 4096 characters; escape then truncate the assembled
    // MarkdownV2 text so a trailing half-escaped sequence can't break parsing.
    const text = stripDanglingEscape(
      truncate(`*${escapeMarkdown(notification.title)}*\n${escapeMarkdown(notification.body)}`, 4096),
    );
    const response = await this.fetcher(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: "MarkdownV2",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Telegram returned HTTP ${response.status}.`);
    }
  }
}

export class EmailNotifier implements Notifier {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly from: string,
    private readonly to: string,
    fetcher?: typeof fetch,
  ) {
    this.fetcher = bindFetch(fetcher);
  }

  async send(notification: Notification): Promise<void> {
    const response = await this.fetcher("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: this.to }] }],
        from: { email: this.from, name: "unicorn" },
        subject: notification.title,
        content: [{ type: "text/plain", value: notification.body }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Email relay returned HTTP ${response.status}.`);
    }
  }
}

// Telegram MarkdownV2 reserves these characters; escape them so titles and bodies
// containing course codes or brackets don't reject the whole message.
function escapeMarkdown(value: string): string {
  return value.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (character) => `\\${character}`);
}

// Drop a dangling escape backslash left by truncating in the middle of a `\X` pair,
// which would otherwise be an invalid trailing escape MarkdownV2 rejects.
function stripDanglingEscape(value: string): string {
  const match = /\\+$/.exec(value);
  return match && match[0].length % 2 === 1 ? value.slice(0, -1) : value;
}

export function resolveNotifier(
  env: NotifierEnv,
  channel: NotifierChannel,
  fetcher?: typeof fetch,
): Notifier | null {
  if (channel === "discord") {
    return env.NOTIFIER_URL ? new DiscordNotifier(env.NOTIFIER_URL, fetcher) : null;
  }
  if (channel === "telegram") {
    return env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
      ? new TelegramNotifier(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, fetcher)
      : null;
  }
  return env.EMAIL_FROM && env.EMAIL_TO ? new EmailNotifier(env.EMAIL_FROM, env.EMAIL_TO, fetcher) : null;
}

// The first channel whose secrets are present. Discord first for continuity with v1
// deployments, then Telegram (the ADR-0026 primary face), then email.
export function configuredChannels(env: NotifierEnv): NotifierChannel[] {
  const channels: NotifierChannel[] = [];
  if (env.NOTIFIER_URL) {
    channels.push("discord");
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    channels.push("telegram");
  }
  if (env.EMAIL_FROM && env.EMAIL_TO) {
    channels.push("email");
  }
  return channels;
}
