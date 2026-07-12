import { describe, expect, it, vi } from "vitest";
import { DiscordNotifier } from "../src/notifier";

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
});
