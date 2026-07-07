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
// 1. Run add-generation-jobs-table.sql against Supabase before deploying this.
// 2. Deploy this file to netlify/functions/generate-background/index.js.
// 3. Background Functions require at least the Pro plan - confirm this is available on your plan
//    (WeightedAI is already on Netlify Pro per prior setup, so this should already be covered).
//
// IMPORTANT: if this function throws an uncaught error, Netlify automatically retries it (once
// after 1 minute, again after 2 more minutes if it fails again) - which would mean duplicate
// Claude API calls for the same job. Every code path below is wrapped so nothing throws uncaught;
// failures are always written to the job row as status "failed" instead.

const https = require("https");

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
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

exports.config = {
  background: true
};

exports.handler = async function(event, context) {
  let jobId;
  try {
    const parsed = JSON.parse(event.body);
    jobId = parsed.jobId;
    const prompt = parsed.prompt;

    if (!jobId || !prompt) {
      console.error("Missing jobId or prompt in background generation request");
      return; // nothing to write a failure to without a jobId
    }

    // Mark the job as pending immediately, in case the client starts polling before the Anthropic
    // call below finishes (checkGenerationStatus already treats a missing row as pending too, so
    // this is a belt-and-suspenders row rather than strictly required).
    await writeJobResult(jobId, "pending", {});

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
