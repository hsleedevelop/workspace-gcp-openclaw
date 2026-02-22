import express from "express";
import { webhookCallback } from "grammy";
import { runDigest } from "./digest";
import { createBot } from "./telegram";

const app = express();
app.use(express.json());

/* ─── Routes ─── */

app.get("/health", (_, res) => {
  res.send("ok");
});

app.get("/run-digest", async (_, res) => {
  const result = await runDigest();
  if (result.success) {
    res.send(result.message);
  } else {
    res.status(500).send(result.message);
  }
});

/* ─── Telegram Bot (optional) ─── */

const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (botToken) {
  const allowedUsers = (process.env.TELEGRAM_ALLOWED_USERS || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => !isNaN(n) && n > 0);

  if (!allowedUsers.length) {
    console.warn("[telegram] TELEGRAM_ALLOWED_USERS is empty — bot will reject all messages");
  }

  const bot = createBot(botToken, allowedUsers);
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
  const webhookOpts = webhookSecret ? { secretToken: webhookSecret } : {};
  app.post("/telegram/webhook", webhookCallback(bot, "express", webhookOpts));
  console.log(`[telegram] bot enabled on POST /telegram/webhook (secret=${webhookSecret ? "yes" : "no"})`);
} else {
  console.log("[telegram] TELEGRAM_BOT_TOKEN not set — bot disabled");
}

/* ─── Server ─── */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`digest-worker listening on :${PORT}`);
});
