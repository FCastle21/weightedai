// netlify/functions/generate-background/index.js
//
// Background Function version of workout generation. Exists because the synchronous "generate"
// action in generate-function.js was hitting Netlify's synchronous execution ceiling (504 Gateway
// Timeout errors), especially for paid-tier plans with detailed nutrition/progression content.
// Background Functions get a 15-minute execution limit instead - but the tradeoff is they can't
// return a response directly to the client (Netlify discards the return value and only sends an
// immediate 202 Accepted). So this writes its result to the generation_jobs table instead, and the
// client polls for it via the checkGenerationStatus action (added to generate-function.js).
//
// SETUP REQUIRED:
// 1. Run add-generation-jobs-table.sql and add-rate-limits-table.sql against Supabase before
//    deploying this.
// 2. Deploy this file to netlify/functions/generate-background/index.js.
// 3. Background Functions require at least the Pro plan - confirm this is available on your plan
//    (WeightedAI is already on Netlify Pro per prior setup, so this should already be covered).
//
// IMPORTANT: if this function throws an uncaught error, Netlify automatically retries it (once
// after 1 minute, again after 2 more minutes if it fails again) - which would mean duplicate
// Claude API calls for the same job. Every code path below is wrapped so nothing throws uncaught;
// failures are always written to the job row as status "failed" instead.

const https = require("https");

// Max generation requests allowed per email within the rolling window below. This is deliberately
// generous - a real user might generate a workout, rebuild it once or twice, and try a different
// muscle group in one sitting, easily reaching 5-8 calls. This exists to stop a script hitting the
// endpoint directly and repeatedly (bypassing the app's UI, and with it the tier-based checks that
// only apply inside the normal generation flow), not to constrain ordinary use.
const RATE_LIMIT_MAX_REQUESTS = 15;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      // Collect raw Buffer chunks and join them at the byte level before converting to a string
      // just once at the end. Converting each chunk to a string individually (e.g. `data +=
      // chunk`, which implicitly calls chunk.toString('utf8') per chunk) corrupts any multi-byte
      // UTF-8 character - like an em dash, used throughout this app's exercise formatting - that
      // happens to be split across a chunk boundary, since each incomplete half gets
      // independently misread as invalid UTF-8 and rendered as a replacement character. This is
      // the function that generates every workout's actual text, so this bug likely affected a
      // meaningful share of generations before being fixed here.
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function supabase(method, path, body) {
  const url = new URL(process.env.SUPABASE_URL);
  const options = {
    hostname: url.hostname,
    path: `/rest/v1/${path}`,
    method,
    headers: {
      "Content-Type": "application/json",
      "apikey": process.env.SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${process.env.SUPABASE_ANON_KEY}`,
      "Prefer": method === "POST" ? "resolution=merge-duplicates,return=minimal" : "return=representation"
    }
  };
  const bodyStr = body ? JSON.stringify(body) : null;
  if (bodyStr) options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
  return await httpsRequest(options, bodyStr);
}

async function writeJobResult(jobId, status, extra) {
  try {
    await supabase("POST", "generation_jobs", { job_id: jobId, status, ...extra });
  } catch (e) {
    // If even the failure-write fails, there's nothing further we can do here - the client's
    // own poll-timeout (not this function) is the last line of defense in that case.
    console.error("Failed to write job result:", jobId, e);
  }
}

// Checks and updates the rate-limit counter for this email. Returns true if the request should be
// BLOCKED (limit exceeded), false if it should proceed. Fails open (returns false, allowing the
// request through) on any error talking to Supabase - a rate limiter that accidentally blocks
// everyone during a database hiccup is a worse failure mode than one that occasionally
// under-enforces during a genuine outage.
async function checkAndUpdateRateLimit(email) {
  if (!email) return false; // no identifier to rate-limit by - let it through rather than guess
  try {
    const res = await supabase(
      "GET",
      `rate_limits?email=eq.${encodeURIComponent(email)}&select=id,request_count,window_start&order=window_start.desc&limit=1`
    );
    const rows = JSON.parse(res.body);
    const existing = rows?.[0];

    const now = Date.now();
    const windowExpired = !existing || (now - new Date(existing.window_start).getTime()) > RATE_LIMIT_WINDOW_MS;

    if (windowExpired) {
      // No active window, or the previous one has rolled over - start a fresh one.
      await supabase("POST", "rate_limits", { email, request_count: 1, window_start: new Date().toISOString() });
      return false;
    }

    if (existing.request_count >= RATE_LIMIT_MAX_REQUESTS) {
      return true; // blocked - still within the window and already at the cap
    }

    // Still within the window and under the cap - increment and allow through.
    await supabase("PATCH", `rate_limits?id=eq.${existing.id}`, { request_count: existing.request_count + 1 });
    return false;
  } catch (e) {
    console.error("Rate limit check failed, failing open:", e.message);
    return false;
  }
}

exports.config = {
  background: true
};

exports.handler = async function(event, context) {
  let jobId;
  try {
    const parsed = JSON.parse(event.body);
    jobId = parsed.jobId;
    const prompt = parsed.prompt;
    const email = parsed.email;

    if (!jobId || !prompt) {
      console.error("Missing jobId or prompt in background generation request");
      return; // nothing to write a failure to without a jobId
    }

    // Mark the job as pending immediately, in case the client starts polling before the Anthropic
    // call below finishes (checkGenerationStatus already treats a missing row as pending too, so
    // this is a belt-and-suspenders row rather than strictly required).
    await writeJobResult(jobId, "pending", {});

    const isBlocked = await checkAndUpdateRateLimit(email);
    if (isBlocked) {
      await writeJobResult(jobId, "failed", { error: "You're generating workouts faster than we can keep up - please wait a bit and try again." });
      return;
    }

    const postData = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 3500,
      messages: [{ role: "user", content: prompt }]
    });

    const res = await httpsRequest({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(postData)
      }
    }, postData);

    if (res.status < 200 || res.status >= 300) {
      console.error("Anthropic API returned non-2xx:", res.status, res.body.slice(0, 500));
      await writeJobResult(jobId, "failed", { error: "The AI service returned an error. Please try again." });
      return;
    }

    // Store the raw Anthropic response body - the client reconstructs the exact same
    // {content:[...]} shape it always expected from the old synchronous call, so none of the
    // downstream prompt-processing/safety-net logic needs to change.
    await writeJobResult(jobId, "completed", { result: res.body });
  } catch (err) {
    console.error("generate-background error:", err.message, err.stack);
    if (jobId) {
      await writeJobResult(jobId, "failed", { error: "Something went wrong generating your workout. Please try again." });
    }
  }
};
