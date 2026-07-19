import { CORRECTIONS_DOMAIN, recordCorrection } from "./corrections";
import { D1MemoryStore } from "./memory";
import { constantTimeEqual } from "./settings";

// ADR-0026's IM face growing from push into converse: the user replies to the bot
// where the pings arrive, and what they say becomes memory the triage judge reads
// next cycle. The write path is zero-LLM — capture verbatim, ack, done — so the
// webhook stays fast and the pipeline stays LLM-optional (ADR-0015).

export interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  DB: D1Database;
}

interface TelegramUpdate {
  message?: {
    chat?: { id?: number | string };
    text?: string;
  };
}

const HELP_TEXT = [
  "Reply with anything you want me to remember when triaging:",
  '"FIT2099 quizzes don\'t count", "stop pinging me about tutorial threads".',
  "I apply it from the next sync cycle. Manage notes via the MCP memory tools.",
].join("\n");

export async function handleTelegramWebhook(request: Request, env: TelegramEnv): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !env.TELEGRAM_WEBHOOK_SECRET) {
    return Response.json({ error: "telegram_not_configured" }, { status: 404 });
  }
  const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!constantTimeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return new Response(null, { status: 200 });
  }

  const chatId = update.message?.chat?.id;
  const text = update.message?.text?.trim();
  // Single-user product: silently ack anything that is not the owner's text
  // message (other chats, edits, stickers) so Telegram never retries it.
  if (chatId === undefined || String(chatId) !== env.TELEGRAM_CHAT_ID || !text) {
    return new Response(null, { status: 200 });
  }

  if (text === "/start" || text === "/help") {
    return reply(chatId, HELP_TEXT);
  }
  if (text === "/memory") {
    const note = await new D1MemoryStore(env.DB).get(CORRECTIONS_DOMAIN);
    return reply(chatId, note.content || "No corrections remembered yet.");
  }

  try {
    const result = await recordCorrection(new D1MemoryStore(env.DB), text);
    if (result === "duplicate") {
      return reply(chatId, "Already noted.");
    }
    return reply(chatId, "Noted — I'll apply that from the next cycle.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.error(JSON.stringify({ event: "telegram_correction_failed", message: message.slice(0, 200) }));
    return reply(chatId, "Couldn't save that — please try again.");
  }
}

// Telegram lets a webhook answer with a bot API method in the response body:
// zero extra subrequests, and the ack doubles as the reply.
function reply(chatId: number | string, text: string): Response {
  return Response.json({ method: "sendMessage", chat_id: chatId, text });
}
