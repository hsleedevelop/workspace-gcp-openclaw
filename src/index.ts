// src/index.ts (v1.1: subject + snippet + plain-text body extract)
// - Gmail API로 최근 메일 목록 조회
// - 각 메일에서 Subject + Snippet + text/plain 본문을 추출
// - Digest 메일로 전송 (Gmail API send)
// Notes:
// - HTML만 있는 메일은 text/plain이 없을 수 있으니 fallback 로직 포함
// - 너무 긴 본문은 잘라서 digest 크기/비용을 통제

import express, { Request, Response } from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json());

type Env = {
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  REFRESH_TOKEN: string;
  EMAIL_FROM: string;
  EMAIL_TO: string;
};

function requireEnv(): Env {
  const { CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, EMAIL_FROM, EMAIL_TO } = process.env;
  const missing = [
    ["CLIENT_ID", CLIENT_ID],
    ["CLIENT_SECRET", CLIENT_SECRET],
    ["REFRESH_TOKEN", REFRESH_TOKEN],
    ["EMAIL_FROM", EMAIL_FROM],
    ["EMAIL_TO", EMAIL_TO],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);

  return {
    CLIENT_ID: CLIENT_ID!,
    CLIENT_SECRET: CLIENT_SECRET!,
    REFRESH_TOKEN: REFRESH_TOKEN!,
    EMAIL_FROM: EMAIL_FROM!,
    EMAIL_TO: EMAIL_TO!,
  };
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecodeToUtf8(data: string): string {
  // Gmail payload body uses base64url (RFC 4648) without padding
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (b64.length % 4)) % 4;
  const padded = b64 + "=".repeat(padLen);
  return Buffer.from(padded, "base64").toString("utf8");
}

function buildRawEmail(opts: { from: string; to: string; subject: string; bodyText: string }): string {
  const { from, to, subject, bodyText } = opts;
  return (
    `From: ${from}\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    `Content-Type: text/plain; charset="UTF-8"\r\n` +
    `\r\n` +
    `${bodyText}\r\n`
  );
}

function makeGmailClient(env: Env) {
  const oauth2Client = new google.auth.OAuth2(env.CLIENT_ID, env.CLIENT_SECRET, "http://localhost:8080");
  oauth2Client.setCredentials({ refresh_token: env.REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth: oauth2Client });
}

type MailDigestItem = {
  id: string;
  subject: string;
  from?: string;
  date?: string;
  snippet?: string;
  bodyText?: string;
};

// 깊이 우선으로 text/plain 찾기
function findPlainTextPart(payload: any): string | null {
  if (!payload) return null;

  const mimeType: string | undefined = payload.mimeType;
  const bodyData: string | undefined = payload.body?.data;

  if (mimeType === "text/plain" && bodyData) {
    return base64UrlDecodeToUtf8(bodyData);
  }

  const parts: any[] | undefined = payload.parts;
  if (!parts?.length) return null;

  for (const p of parts) {
    const found = findPlainTextPart(p);
    if (found) return found;
  }
  return null;
}

function compactText(s: string, maxLen: number): string {
  const normalized = s
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  if (normalized.length <= maxLen) return normalized;
  return normalized.slice(0, maxLen).trimEnd() + "\n…(truncated)";
}

async function listRecentMessageIds(gmail: ReturnType<typeof google.gmail>, q: string, maxResults: number) {
  const res = await gmail.users.messages.list({
    userId: "me",
    q,
    maxResults,
  });
  return (res.data.messages ?? []).map((m) => m.id).filter(Boolean) as string[];
}

async function getDigestItem(gmail: ReturnType<typeof google.gmail>, id: string): Promise<MailDigestItem> {
  const m = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "full",
  });

  const headers = m.data.payload?.headers ?? [];
  const subject = headers.find((h) => h.name === "Subject")?.value ?? "(no subject)";
  const from = headers.find((h) => h.name === "From")?.value;
  const date = headers.find((h) => h.name === "Date")?.value;

  const snippet = m.data.snippet ?? "";

  // text/plain 추출 (없으면 null)
  const bodyText = findPlainTextPart(m.data.payload);

  return {
    id,
    subject,
    from,
    date,
    snippet,
    bodyText: bodyText ? compactText(bodyText, 1800) : undefined, // 본문 너무 길면 절단
  };
}

function formatDigest(items: MailDigestItem[]): string {
  const lines: string[] = [];
  lines.push(`오늘 메일 Digest (${new Date().toISOString().slice(0, 10)})`);
  lines.push("");

  items.forEach((it, idx) => {
    lines.push(`${idx + 1}. ${it.subject}`);
    if (it.from) lines.push(`   From: ${it.from}`);
    if (it.date) lines.push(`   Date: ${it.date}`);
    if (it.snippet) lines.push(`   Snippet: ${compactText(it.snippet, 240)}`);

    if (it.bodyText) {
      lines.push("   Body:");
      // 들여쓰기 정리
      const bodyIndented = it.bodyText
        .split("\n")
        .map((l) => `   ${l}`)
        .join("\n");
      lines.push(bodyIndented);
    } else {
      lines.push("   Body: (no text/plain part found)");
    }

    lines.push(""); // blank line between items
  });

  return lines.join("\n");
}

async function sendDigestViaGmailApi(
  gmail: ReturnType<typeof google.gmail>,
  env: Env,
  subject: string,
  bodyText: string
) {
  const raw = buildRawEmail({
    from: env.EMAIL_FROM,
    to: env.EMAIL_TO, // 안전장치: 고정 수신자
    subject,
    bodyText,
  });

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: base64UrlEncode(raw) },
  });
}

app.get("/run-digest", async (_req: Request, res: Response) => {
  try {
    const env = requireEnv();
    const gmail = makeGmailClient(env);

    // 필터는 필요하면 전하께서 조정하시면 됩니다.
    const q = "newer_than:1d -category:promotions -category:social";
    const ids = await listRecentMessageIds(gmail, q, 10);

    if (ids.length === 0) return res.status(200).send("No new messages");

    const items: MailDigestItem[] = [];
    for (const id of ids) {
      items.push(await getDigestItem(gmail, id));
    }

    const digestText = formatDigest(items);

    await sendDigestViaGmailApi(gmail, env, "📬 Daily AI Digest (body+snippet)", digestText);

    // 응답은 짧게 (운영 시 불필요 노출 방지)
    return res.status(200).send("Digest sent");
  } catch (e) {
    console.error(e);
    return res.status(500).send("Error");
  }
});

app.get("/healthz", (_req: Request, res: Response) => res.status(200).send("ok"));

const PORT = Number(process.env.PORT ?? "8080");
app.listen(PORT, () => console.log("running"));