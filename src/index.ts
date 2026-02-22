import express from "express";
import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const app = express();

/* ─── Environment ─── */

interface Env {
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  REFRESH_TOKEN: string;
  EMAIL_FROM: string;
  EMAIL_TO: string;
  IMPORTANT_SENDERS: string;
  NANOCLAW_URL: string;
}

function requireEnv(): Env {
  const required: (keyof Env)[] = [
    "CLIENT_ID",
    "CLIENT_SECRET",
    "REFRESH_TOKEN",
    "EMAIL_FROM",
    "EMAIL_TO",
    "IMPORTANT_SENDERS",
    "NANOCLAW_URL",
  ];

  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error("Missing env vars: " + missing.join(", "));

  const env = {} as Record<string, string>;
  for (const k of required) env[k] = process.env[k]!;
  return env as unknown as Env;
}

/* ─── Cloud Run Service-to-Service Auth ─── */

const gcpAuth = new GoogleAuth();
let idTokenClient: Awaited<ReturnType<GoogleAuth["getIdTokenClient"]>> | null =
  null;


async function getAuthHeaders(
  audience: string,
): Promise<Record<string, string>> {
  if (!process.env.K_SERVICE) return {};
  const aud = new URL(audience).origin;
  if (!idTokenClient) {
    idTokenClient = await gcpAuth.getIdTokenClient(aud);
  }
  const headers = await idTokenClient.getRequestHeaders();
  return headers as unknown as Record<string, string>;
}

/* ─── Utilities ─── */

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildRawEmail(
  from: string,
  to: string,
  subject: string,
  body: string,
): string {
  return (
    `From: ${from}\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    `Content-Type: text/plain; charset="UTF-8"\r\n\r\n` +
    body
  );
}

function extractLinks(text: string): string[] {
  const regex = /(https?:\/\/[^\s<>"')\]]+)/g;
  return Array.from(new Set(text.match(regex) || []));
}

function isImportantSender(from: string, whitelist: string[]): boolean {
  return whitelist.some((s) => from.toLowerCase().includes(s.toLowerCase()));
}

function extractBody(payload: Record<string, unknown>): string {
  if (!payload) return "";

  const mime = payload.mimeType as string | undefined;
  const bodyData = (payload.body as Record<string, unknown>)?.data as
    | string
    | undefined;

  if (mime === "text/plain" && bodyData) {
    return Buffer.from(bodyData, "base64").toString("utf8");
  }

  const parts = payload.parts as Record<string, unknown>[] | undefined;
  if (parts) {
    for (const part of parts) {
      const text = extractBody(part);
      if (text) return text;
    }
  }

  return "";
}

// threshold: <500 chars body + links present → scrape links; otherwise summarize body
function classifyEmail(
  bodyLength: number,
  linkCount: number,
): "CONTENT" | "LINK" {
  if (linkCount === 0) return "CONTENT";
  if (bodyLength < 500 && linkCount > 0) return "LINK";
  return "CONTENT";
}

/* ─── Link Scraping (jsdom + @mozilla/readability) ─── */

const SCRAPE_TIMEOUT_MS = 10_000;
const MAX_SCRAPED_LENGTH = 5_000;
const MAX_LINKS_PER_EMAIL = 3;

async function scrapeLink(url: string): Promise<string> {
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; DigestWorker/1.0; +mailto:fadeguy@gmail.com)",
      },
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
      redirect: "follow",
    });

    if (!resp.ok) return "";

    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return "";

    const html = await resp.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    return article?.textContent?.slice(0, MAX_SCRAPED_LENGTH) || "";
  } catch {
    return "";
  }
}

/* ─── NanoClaw Summarizer ─── */

async function summarizeWithNanoClaw(
  nanoclawUrl: string,
  title: string,
  source: string,
  content: string,
  links: string[],
): Promise<string> {
  const authHeaders = await getAuthHeaders(nanoclawUrl);

  const resp = await fetch(`${nanoclawUrl}/summarize`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({ title, source, content, links }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`nanoclaw ${resp.status}: ${body}`);
  }

  const data = (await resp.json()) as { summary: string };
  return data.summary;
}

/* ─── Deduplication via Gmail Label ─── */

const DIGEST_LABEL = "DIGESTED";

async function getOrCreateLabelId(
  gmail: ReturnType<typeof google.gmail>,
): Promise<string> {
  const resp = await gmail.users.labels.list({ userId: "me" });
  const existing = resp.data.labels?.find((l) => l.name === DIGEST_LABEL);
  if (existing?.id) return existing.id;

  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name: DIGEST_LABEL,
      labelListVisibility: "labelHide",
      messageListVisibility: "hide",
    },
  });
  return created.data.id!;
}

async function markDigested(
  gmail: ReturnType<typeof google.gmail>,
  messageId: string,
  labelId: string,
): Promise<void> {
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
}

/* ─── Routes ─── */

app.get("/health", (_, res) => {
  res.send("ok");
});

app.get("/run-digest", async (_, res) => {
  const start = Date.now();
  console.log("[digest] run started");

  try {
    const env = requireEnv();
    const senders = env.IMPORTANT_SENDERS.split(/[|,]/)
      .map((s) => s.trim())
      .filter(Boolean);


    const oauth = new google.auth.OAuth2(
      env.CLIENT_ID,
      env.CLIENT_SECRET,
      "http://localhost",
    );
    oauth.setCredentials({ refresh_token: env.REFRESH_TOKEN });
    const gmail = google.gmail({ version: "v1", auth: oauth });

    let labelId: string | null = null;
    try {
      labelId = await getOrCreateLabelId(gmail);
    } catch (e) {
      console.warn("[digest] dedup label unavailable (gmail.modify scope needed):", (e as Error).message);
    }
    const senderQuery = senders.map((s) => `from:${s}`).join(" OR ");
    const dedupFilter = labelId ? ` -label:${DIGEST_LABEL}` : "";
    const query = `(${senderQuery}) newer_than:1d${dedupFilter}`;
    console.log("[digest] query:", query);

    const list = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 10,
    });

    if (!list.data.messages?.length) {
      console.log("[digest] no new messages");
      return res.send("No new messages");
    }

    console.log(`[digest] found ${list.data.messages.length} candidate(s)`);
    const results: string[] = [];

    for (const msg of list.data.messages) {
      const m = await gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "full",
      });

      const headers = m.data.payload?.headers || [];
      const subject =
        headers.find((h) => h.name === "Subject")?.value || "(no subject)";
      const from = headers.find((h) => h.name === "From")?.value || "";

      if (!isImportantSender(from, senders)) continue;

      const body = extractBody(
        m.data.payload as unknown as Record<string, unknown>,
      );
      const snippet = m.data.snippet || "";
      const text = body || snippet;
      const links = extractLinks(text);
      const emailType = classifyEmail(text.length, links.length);

      console.log(
        `[digest] "${subject}" type=${emailType} links=${links.length} bodyLen=${text.length}`,
      );

      let summary = "";

      try {
        if (emailType === "LINK" && links.length > 0) {

          const scraped = await Promise.allSettled(
            links.slice(0, MAX_LINKS_PER_EMAIL).map((l) => scrapeLink(l)),
          );

          const linkContents = scraped
            .map((r, i) => {
              const content =
                r.status === "fulfilled" && r.value ? r.value : "";
              return content
                ? `[${links[i]}]\n${content.slice(0, 2000)}`
                : "";
            })
            .filter(Boolean)
            .join("\n\n");

          const enriched = linkContents
            ? `${text}\n\n--- Scraped Link Content ---\n${linkContents}`
            : text;

          summary = await summarizeWithNanoClaw(
            env.NANOCLAW_URL,
            subject,
            from,
            enriched,
            links,
          );
        } else {

          summary = await summarizeWithNanoClaw(
            env.NANOCLAW_URL,
            subject,
            from,
            text,
            links,
          );
        }
      } catch (e) {
        console.error(`[digest] summarize failed for "${subject}":`, e);
        summary = snippet;
      }

      results.push(`### ${subject}\n${summary}`);

      if (labelId) {
        await markDigested(gmail, msg.id!, labelId).catch((e) =>
          console.warn(`[digest] failed to mark digested: ${(e as Error).message}`),
        );
      }
    }

    if (!results.length) {
      console.log("[digest] no important messages after filtering");
      return res.send("No important messages");
    }


    const digest = results.join("\n\n---\n\n");
    const raw = buildRawEmail(
      env.EMAIL_FROM,
      env.EMAIL_TO,
      `📬 Daily Research Digest (${results.length})`,
      digest,
    );

    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: base64UrlEncode(raw) },
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[digest] sent ${results.length} item(s) in ${elapsed}s`);
    res.send(`Digest sent (${results.length} items, ${elapsed}s)`);
  } catch (e) {
    console.error("[digest] fatal:", e);
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).send(`Error: ${message}`);
  }
});

/* ─── Server ─── */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`digest-worker listening on :${PORT}`);
});
