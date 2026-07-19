import { describe, expect, it, vi } from "vitest";
import { CORRECTIONS_DOMAIN, recordCorrection } from "../src/corrections";
import { handleTelegramWebhook } from "../src/telegram";
import { MemoryCapExceededError, MemoryConflictError, type MemoryNote, type MemoryStore } from "../src/memory";

const NOW = new Date("2026-07-19T12:00:00.000Z");

describe("recordCorrection", () => {
  it("appends a dated line to the corrections inbox", async () => {
    const store = memoryStore("");
    await expect(recordCorrection(store, "FIT2099 quizzes don't count", NOW)).resolves.toBe("saved");
    expect(store.save).toHaveBeenCalledWith(
      CORRECTIONS_DOMAIN,
      "- [2026-07-19] FIT2099 quizzes don't count",
      undefined,
    );
  });

  it("dedupes a webhook replay by text", async () => {
    const store = memoryStore("- [2026-07-19] FIT2099 quizzes don't count");
    await expect(recordCorrection(store, "FIT2099 quizzes don't count", NOW)).resolves.toBe("duplicate");
    expect(store.save).not.toHaveBeenCalled();
  });

  it("drops the oldest corrections when the inbox is full rather than rejecting input", async () => {
    const existing = Array.from({ length: 3 }, (_, i) => `- [2026-07-0${i + 1}] old rule ${i}`).join("\n");
    const store = memoryStore(existing);
    // First save attempt hits the cap; retry after shifting must succeed.
    (store.save as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new MemoryCapExceededError(4200))
      .mockResolvedValueOnce({ domain: CORRECTIONS_DOMAIN, content: "", updatedAt: NOW.toISOString() });

    await expect(recordCorrection(store, "new rule", NOW)).resolves.toBe("saved");

    const finalContent = (store.save as ReturnType<typeof vi.fn>).mock.calls[1][1] as string;
    expect(finalContent).not.toContain("old rule 0");
    expect(finalContent).toContain("new rule");
  });

  it("retries once when a concurrent write invalidates the read", async () => {
    const store = memoryStore("");
    (store.save as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new MemoryConflictError(NOW.toISOString()))
      .mockResolvedValueOnce({ domain: CORRECTIONS_DOMAIN, content: "", updatedAt: NOW.toISOString() });

    await expect(recordCorrection(store, "rule", NOW)).resolves.toBe("saved");
    expect(store.get).toHaveBeenCalledTimes(2);
  });

  it("ignores empty input", async () => {
    const store = memoryStore("");
    await expect(recordCorrection(store, "   ", NOW)).resolves.toBe("empty");
  });
});

describe("handleTelegramWebhook", () => {
  const env = (db: D1Database) => ({
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "42",
    TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    DB: db,
  });

  it("404s when telegram is not configured", async () => {
    const response = await handleTelegramWebhook(webhookRequest("hi", "hook-secret"), {
      DB: {} as D1Database,
    });
    expect(response.status).toBe(404);
  });

  it("rejects a wrong webhook secret", async () => {
    const response = await handleTelegramWebhook(webhookRequest("hi", "wrong"), env(fakeDb()));
    expect(response.status).toBe(401);
  });

  it("saves an owner message as a correction and replies inline", async () => {
    const db = fakeDb();
    const response = await handleTelegramWebhook(webhookRequest("quizzes don't count", "hook-secret"), env(db));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { method: string; text: string };
    expect(body.method).toBe("sendMessage");
    expect(body.text).toContain("Noted");
  });

  it("silently acks messages from other chats", async () => {
    const db = fakeDb();
    const response = await handleTelegramWebhook(
      webhookRequest("spam", "hook-secret", 999),
      env(db),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});

function webhookRequest(text: string, secret: string, chatId = 42): Request {
  return new Request("https://unicorn.example/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify({ message: { chat: { id: chatId }, text } }),
  });
}

function memoryStore(content: string): MemoryStore & { get: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> } {
  const note: MemoryNote = { domain: CORRECTIONS_DOMAIN, content, updatedAt: content ? "2026-07-18T00:00:00.000Z" : "" };
  return {
    get: vi.fn().mockResolvedValue(note),
    list: vi.fn().mockResolvedValue(content ? [note] : []),
    save: vi.fn().mockImplementation(async (domain: string, next: string) => ({
      domain,
      content: next,
      updatedAt: NOW.toISOString(),
    })),
  };
}

function fakeDb(): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      };
    },
  } as unknown as D1Database;
}
