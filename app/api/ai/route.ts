// AI assistant endpoint. It only ever receives table schemas and aggregated numbers from the
// browser, never raw rows, and forwards them to a free-tier LLM (Groq or Gemini).

type Provider = "groq" | "gemini";
type Task = "sql" | "insights" | "explain";

const PROVIDERS: Record<Provider, { url: string; envKey: string; envModel: string; model: string }> = {
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    envKey: "GROQ_API_KEY",
    envModel: "GROQ_MODEL",
    model: "openai/gpt-oss-120b",
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    envKey: "GEMINI_API_KEY",
    envModel: "GEMINI_MODEL",
    model: "gemini-2.5-flash",
  },
};

const SYSTEM: Record<Task, string> = {
  sql: `You translate questions about data into a single DuckDB SQL SELECT query.
Rules:
- Use only the tables and columns in the schema. Quote every identifier with double quotes.
- Return ONE read-only SELECT (or WITH … SELECT). Never modify data, never read files or URLs.
- Prefer readable output: aggregate, give columns clear aliases, ORDER BY the main measure, LIMIT 50 unless asked for more.
- For dates use date_trunc, year(), month(), strftime(). Growth = (later - earlier) / earlier.
Respond as JSON: {"sql": "...", "explanation": "one plain-English sentence about what the query does"}`,
  insights: `You are a data analyst. From the precomputed statistics you are given (aggregates only), write the 5 most useful, specific insights.
Each insight: one sentence with concrete numbers, then why it matters. Prefer surprises, big gaps, trends and data-quality risks.
Respond as JSON: {"insights": [{"title": "short headline", "detail": "one or two sentences"}]}`,
  explain: `You explain a chart to a non-technical reader in 2-4 short sentences: the main pattern, the biggest/smallest values with numbers, and one caveat.
Respond as JSON: {"explanation": "..."}`,
};

// Best-effort per-IP limit (per server instance). Set UPSTASH_REDIS_REST_URL/TOKEN for a global limit.
const LIMIT = Number(process.env.AI_RATE_LIMIT_PER_HOUR ?? 30);
const hits = new Map<string, number[]>();

async function rateLimited(ip: string): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const key = `datamorph:ai:${ip}:${Math.floor(Date.now() / 3_600_000)}`;
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([["INCR", key], ["EXPIRE", key, "3600"]]),
    });
    const [{ result }] = (await res.json()) as { result: number }[];
    return result > LIMIT;
  }
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > LIMIT;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

// Vercel stops functions at their duration limit with a bare 504; give up on the provider first and say why.
export const maxDuration = 30;
const PROVIDER_TIMEOUT_MS = 25_000;

export async function POST(request: Request) {
  let body: { task?: Task; payload?: unknown; provider?: Provider };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON." }, 400);
  }
  const task = body.task;
  if (!task || !(task in SYSTEM)) return json({ error: "Unknown task." }, 400);
  const payload = JSON.stringify(body.payload ?? {});
  if (payload.length > 60_000) return json({ error: "Request too large." }, 413);

  // Visitors can bring their own key; otherwise use the server's free-tier key.
  const userKey = request.headers.get("x-user-key")?.trim();
  const requested = (request.headers.get("x-provider") ?? body.provider) as Provider | null;
  const provider: Provider =
    requested && requested in PROVIDERS ? requested : process.env.GROQ_API_KEY ? "groq" : process.env.GEMINI_API_KEY ? "gemini" : "groq";
  const cfg = PROVIDERS[provider];
  const key = userKey || process.env[cfg.envKey];
  if (!key)
    return json(
      { error: "AI isn't configured. Add GROQ_API_KEY (or GEMINI_API_KEY) to the server, or paste your own key in AI settings.", code: "no_key" },
      501,
    );

  if (!userKey) {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
    if (await rateLimited(ip)) return json({ error: "Hourly AI limit reached. Try again later or use your own API key." }, 429);
  }

  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env[cfg.envModel] || cfg.model,
        temperature: task === "sql" ? 0 : 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM[task] },
          { role: "user", content: payload },
        ],
      }),
    });
  } catch (e) {
    const timedOut = (e as Error).name === "TimeoutError";
    return json({ error: timedOut ? "The AI provider took too long to answer. Try again." : "Couldn't reach the AI provider." }, 504);
  }
  if (!res.ok) {
    const detail = await res.text();
    // Surface the provider's own message (e.g. "model ... does not exist"), which says what to fix.
    let reason = "";
    try {
      reason = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? "";
    } catch {}
    return json({ error: `The AI provider returned ${res.status}${reason ? `: ${reason}` : "."}`, detail: detail.slice(0, 300) }, 502);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? "{}";
  try {
    return json(JSON.parse(content));
  } catch {
    return json({ error: "The AI returned an unreadable answer. Try rephrasing." }, 502);
  }
}
