import { describe, expect, it, vi } from "vitest";
import { DiscordNotifier, TelegramNotifier } from "../src/notifier";

describe("DiscordNotifier", () => {
  it("sends a compact notification without binding the fetch receiver", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const strictFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== undefined) {
        throw new TypeError("Illegal fetch receiver");
      }
      return request(input, init);
    } as typeof fetch;
    const notifier = new DiscordNotifier("https://discord.example/webhook", strictFetch);

    await notifier.send({ title: "Sync complete", body: "Moodle created 2 items." });

    expect(request).toHaveBeenCalledWith(
      "https://discord.example/webhook",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ content: "**Sync complete**\nMoodle created 2 items." }),
      }),
    );
  });

  it("truncates a body past the Discord 2000-character limit", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const notifier = new DiscordNotifier("https://discord.example/webhook", ((i: RequestInfo | URL, n?: RequestInit) =>
      request(i, n)) as typeof fetch);

    await notifier.send({ title: "t", body: "x".repeat(5000) });

    const body = JSON.parse(request.mock.calls[0][1].body) as { content: string };
    expect(body.content.length).toBeLessThanOrEqual(2000);
    expect(body.content.endsWith("…")).toBe(true);
  });
});

describe("TelegramNotifier", () => {
  it("escapes MarkdownV2 and never leaves a dangling escape after truncation", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const notifier = new TelegramNotifier("bot", "chat", ((i: RequestInfo | URL, n?: RequestInit) =>
      request(i, n)) as typeof fetch);

    // A body of reserved characters becomes all `\X` pairs; truncation must not split one.
    await notifier.send({ title: "t", body: ".".repeat(5000) });

    const body = JSON.parse(request.mock.calls[0][1].body) as { text: string };
    expect(body.text.length).toBeLessThanOrEqual(4096);
    expect(/\\$/.test(body.text)).toBe(false);
  });
});
