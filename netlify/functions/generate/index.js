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
    const { action, prompt, email, profileData, logEntry, historyEntry, accessToken } = parsed;
    
    console.log("Action:", action, "Email:", email || "(none)");
    console.log("SUPABASE_URL:", process.env.SUPABASE_URL ? "SET" : "MISSING");
    console.log("SUPABASE_ANON_KEY:", process.env.SUPABASE_ANON_KEY ? "SET" : "MISSING");

    if (action === "getOAuthUser") {
      const res = await new Promise((resolve, reject) => {
        const urlObj = new URL(process.env.SUPABASE_URL);
        const options = {
          hostname: urlObj.hostname,
          path: '/auth/v1/user',
          method: 'GET',
          headers: {
            'Authorization': 'Bearer ' + accessToken,
            'apikey': process.env.SUPABASE_ANON_KEY
          }
        };
        const req = https.request(options, (r) => {
          let data = '';
          r.on('data', chunk => data += chunk);
          r.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
        });
        req.on('error', reject);
        req.end();
      });
      return { statusCode: 200, headers, body: JSON.stringify(res) };
    }

    if (action === "deleteAccount") {
      if (!email) return { statusCode: 400, headers, body: JSON.stringify({ error: "Email required" }) };
      
      // Delete from workout_history
      await supabase("DELETE", `workout_history?email=eq.${encodeURIComponent(email)}`);
      // Delete from workout_log
      await supabase("DELETE", `workout_log?email=eq.${encodeURIComponent(email)}`);
      // Delete from profiles
      await supabase("DELETE", `profiles?email=eq.${encodeURIComponent(email)}`);
      
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    if (action === "createCheckoutSession") {
      const { priceId, mode, email: checkoutEmail, successUrl, cancelUrl } = parsed;
      if (!priceId) return { statusCode: 400, headers, body: JSON.stringify({ error: "priceId required" }) };

      const params = new URLSearchParams();
      params.append("line_items[0][price]", priceId);
      params.append("line_items[0][quantity]", "1");
      params.append("mode", mode === "subscription" ? "subscription" : "payment");
      params.append("success_url", successUrl || "https://weightedai.net?payment=success&session_id={CHECKOUT_SESSION_ID}");
      params.append("cancel_url", cancelUrl || "https://weightedai.net?payment=cancelled");
      if (checkoutEmail) params.append("customer_email", checkoutEmail);

      const postData = params.toString();
      const res = await httpsRequest({
        hostname: "api.stripe.com",
        path: "/v1/checkout/sessions",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": "Bearer " + process.env.STRIPE_SECRET_KEY,
          "Content-Length": Buffer.byteLength(postData)
        }
      }, postData);

      const sessionData = JSON.parse(res.body);
      if (sessionData.error) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: sessionData.error.message }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ url: sessionData.url, id: sessionData.id }) };
    }

    if (action === "verifyCheckoutSession") {
      const { sessionId } = parsed;
      if (!sessionId) return { statusCode: 400, headers, body: JSON.stringify({ error: "sessionId required" }) };

      const res = await httpsRequest({
        hostname: "api.stripe.com",
        path: "/v1/checkout/sessions/" + sessionId,
        method: "GET",
        headers: {
          "Authorization": "Bearer " + process.env.STRIPE_SECRET_KEY
        }
      });

      const sessionData = JSON.parse(res.body);
      return { statusCode: 200, headers, body: JSON.stringify({ 
        paid: sessionData.payment_status === "paid" || sessionData.status === "complete",
        customerEmail: sessionData.customer_details?.email || sessionData.customer_email
      }) };
    }

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
        model: "claude-haiku-4-5-20251001",
        max_tokens: 3000,
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
