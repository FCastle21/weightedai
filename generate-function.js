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
  const res = await httpsRequest(options, bodyStr);
  console.log(`Supabase ${method} ${path} → ${res.status}: ${res.body.slice(0,200)}`);
  return res;
}

exports.handler = async function(event, context) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const parsed = JSON.parse(event.body);
    const { action, prompt, email, profileData, logEntry, historyEntry } = parsed;
    
    console.log("Action:", action, "Email:", email || "(none)");
    console.log("SUPABASE_URL:", process.env.SUPABASE_URL ? "SET" : "MISSING");
    console.log("SUPABASE_ANON_KEY:", process.env.SUPABASE_ANON_KEY ? "SET" : "MISSING");

    if (action === "loadProfile") {
      const res = await supabase("GET", `profiles?email=eq.${encodeURIComponent(email)}&select=*`);
      const data = JSON.parse(res.body);
      return { statusCode: 200, headers, body: JSON.stringify(data.length > 0 ? data[0] : null) };
    }

    if (action === "saveProfile") {
      console.log("Saving profile for:", email, "Data keys:", Object.keys(profileData || {}).join(", "));
      const res = await supabase("POST", "profiles", { ...profileData, email, updated_at: new Date().toISOString() });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status: res.status }) };
    }

    if (action === "loadLog") {
      const res = await supabase("GET", `workout_log?email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=20`);
      return { statusCode: 200, headers, body: res.body };
    }

    if (action === "saveLog") {
      const res = await supabase("POST", "workout_log", { ...logEntry, email });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status: res.status }) };
    }

    if (action === "loadHistory") {
      const res = await supabase("GET", `workout_history?email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=5`);
      return { statusCode: 200, headers, body: res.body };
    }

    if (action === "saveHistory") {
      const res = await supabase("POST", "workout_history", { ...historyEntry, email });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status: res.status }) };
    }

    if (action === "generate" || prompt) {
      const postData = JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 2000,
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

      return { statusCode: 200, headers, body: res.body };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action" }) };

  } catch (err) {
    console.error("Function error:", err.message, err.stack);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
