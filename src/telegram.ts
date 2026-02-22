import { Bot, Context } from "grammy";
import { runDigest, DigestResult } from "./digest";

/* ─── State ─── */

interface LastRun {
  time: Date;
  result: DigestResult;
}

let lastRun: LastRun | null = null;
let isRunning = false;

/* ─── Bot Factory ─── */

export function createBot(token: string, allowedUsers: number[]): Bot {
  const bot = new Bot(token);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !allowedUsers.includes(userId)) {
      console.warn(`[telegram] unauthorized access from user ${userId ?? "unknown"}`);
      return;
    }
    return next();
  });

  bot.command("help", (ctx) =>
    ctx.reply(
      "📋 Commands:\n" +
        "/digest — Run a full digest cycle\n" +
        "/status — Last digest run info\n" +
        "/help — Show this message",
    ),
  );

  bot.command("digest", handleDigest);
  bot.command("status", handleStatus);

  bot.catch((err) => {
    console.error("[telegram] unhandled error:", err.error);
  });

  return bot;
}

/* ─── Command Handlers ─── */

async function handleDigest(ctx: Context): Promise<void> {
  if (isRunning) {
    await ctx.reply("⏳ Digest is already in progress.");
    return;
  }

  await ctx.reply("🔄 Running digest...");
  isRunning = true;

  try {
    const result = await runDigest();
    lastRun = { time: new Date(), result };

    if (result.success) {
      await ctx.reply(`✅ ${result.message}`);
    } else {
      await ctx.reply(`❌ ${result.message}`);
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await ctx.reply(`❌ Digest failed: ${reason}`);
  } finally {
    isRunning = false;
  }
}

async function handleStatus(ctx: Context): Promise<void> {
  if (!lastRun) {
    await ctx.reply("ℹ️ No digest has run yet since last restart.");
    return;
  }

  const { time, result } = lastRun;
  const status = result.success ? "✅ Success" : "❌ Failed";
  const ago = formatAgo(time);

  await ctx.reply(
    `📊 Last digest:\n` +
      `• Status: ${status}\n` +
      `• Items: ${result.itemCount}\n` +
      `• Duration: ${result.elapsed}s\n` +
      `• When: ${ago}`,
  );
}

/* ─── Helpers ─── */

function formatAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

