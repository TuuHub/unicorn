import { CORRECTIONS_DOMAIN, recordCorrection } from "./corrections";
import { D1MemoryStore } from "./memory";
import { constantTimeEqual } from "./settings";

// Telegram is the primary conversation surface. Model turns are dispatched through
// the same Durable Object as /agent, while explicit /remember writes stay zero-LLM.

export interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  AGENT_SESSIONS: DurableObjectNamespace;
  DB: D1Database;
}

interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    chat?: { id?: number | string };
    text?: string;
  };
}

const HELP_TEXT = [
  "Ask me about deadlines, recent changes, stored items, memory, or sync status.",
  "/remember <text> — save a correction for future reasoning and triage",
  "/memory — show the correction note",
  "/reset — clear this chat history without deleting world state or memory",
].join("\n");

export async function handleTelegramWebhook(
  request: Request,
  env: TelegramEnv,
  context?: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
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
  // Check ownership before touching message content. Other chats are silently
  // acknowledged so Telegram never retries them.
  if (chatId === undefined || String(chatId) !== env.TELEGRAM_CHAT_ID) {
    return new Response(null, { status: 200 });
  }
  const text = update.message?.text?.trim();
  if (!text) {
    return new Response(null, { status: 200 });
  }

  if (text === "/start" || text === "/help") {
    return reply(chatId, HELP_TEXT);
  }
  if (text === "/memory") {
    const note = await new D1MemoryStore(env.DB).get(CORRECTIONS_DOMAIN);
    return reply(chatId, note.content || "No corrections remembered yet.");
  }
  const conversationId = `telegram:${chatId}`;
  if (text === "/reset") {
    const response = await agentStub(env, conversationId).fetch(
      new Request(`https://agent-session/conversation?conversationId=${encodeURIComponent(conversationId)}`, {
        method: "DELETE",
      }),
    );
    return reply(chatId, response.ok ? "Conversation history cleared." : "Couldn't reset the conversation — please try again.");
  }

  if (text === "/remember" || text.startsWith("/remember ")) {
    const correction = text.slice("/remember".length).trim();
    if (!correction) {
      return reply(chatId, "Usage: /remember <text>");
    }
    try {
      const result = await recordCorrection(new D1MemoryStore(env.DB), correction);
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

  const idempotencyKey = `telegram:${update.update_id ?? update.message?.message_id ?? crypto.randomUUID()}`;
  const turn = runAgentTurn(env, conversationId, text, idempotencyKey);
  if (!context) {
    return reply(chatId, await turn);
  }
  context.waitUntil(
    turn
      .then((answer) => sendTelegramAnswer(env.TELEGRAM_BOT_TOKEN!, chatId, answer))
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : "unknown";
        console.error(JSON.stringify({ event: "telegram_agent_reply_failed", message: message.slice(0, 200) }));
        try {
          await sendTelegramAnswer(env.TELEGRAM_BOT_TOKEN!, chatId, "I couldn't answer that right now — please try again.");
        } catch {
          console.error(JSON.stringify({ event: "telegram_agent_fallback_failed", code: "send_failed" }));
        }
      }),
  );
  return new Response(null, { status: 200 });
}

// Telegram lets a webhook answer with a bot API method in the response body:
// zero extra subrequests, and the ack doubles as the reply.
function reply(chatId: number | string, text: string): Response {
  return Response.json({ method: "sendMessage", chat_id: chatId, text });
}

async function runAgentTurn(
  env: TelegramEnv,
  conversationId: string,
  message: string,
  idempotencyKey: string,
): Promise<string> {
  const response = await agentStub(env, conversationId).fetch(
    new Request("https://agent-session/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, message, idempotencyKey }),
    }),
  );
  const body = (await response.json()) as { answer?: string; error?: string };
  if (response.ok && body.answer) {
    return body.answer;
  }
  return agentErrorText(body.error);
}

function agentStub(env: TelegramEnv, conversationId: string): DurableObjectStub {
  return env.AGENT_SESSIONS.get(env.AGENT_SESSIONS.idFromName(conversationId));
}

function agentErrorText(code: string | undefined): string {
  if (code === "disabled") {
    return "The resident agent is disabled. Enable the resident-agent job first.";
  }
  if (code === "not_configured") {
    return "The resident agent has no model credentials configured.";
  }
  if (code === "budget_exhausted") {
    return "The resident agent has reached its monthly token cap.";
  }
  if (code === "timed_out") {
    return "The model timed out — please try again.";
  }
  return "I couldn't answer that right now — please try again.";
}

async function sendTelegramAnswer(botToken: string, chatId: number | string, answer: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: clipTelegram(answer) }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`Telegram returned HTTP ${response.status}.`);
  }
}

function clipTelegram(value: string): string {
  return value.length > 4_096 ? `${value.slice(0, 4_095)}…` : value;
}
