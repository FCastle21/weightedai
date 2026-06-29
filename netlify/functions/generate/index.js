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
      const isPaid = sessionData.payment_status === "paid" || sessionData.status === "complete";
      const customerEmail = sessionData.customer_details?.email || sessionData.customer_email;

      // If this was a subscription purchase, save the Stripe subscription/customer IDs to the user's profile
      // so we can later allow them to self-cancel.
      if (isPaid && sessionData.mode === "subscription" && sessionData.subscription && customerEmail) {
        try {
          await supabase("POST", "profiles", {
            email: customerEmail,
            stripe_subscription_id: sessionData.subscription,
            stripe_customer_id: sessionData.customer,
            updated_at: new Date().toISOString()
          });
        } catch (saveErr) {
          console.error("Failed to save subscription ID:", saveErr);
        }
      }

      return { statusCode: 200, headers, body: JSON.stringify({ 
        paid: isPaid,
        customerEmail: customerEmail
      }) };
    }

    if (action === "cancelSubscription") {
      if (!email) return { statusCode: 400, headers, body: JSON.stringify({ error: "email required" }) };

      const profileRes = await supabase("GET", `profiles?email=eq.${encodeURIComponent(email)}&select=stripe_subscription_id`);
      const profileData = JSON.parse(profileRes.body);
      const subscriptionId = profileData?.[0]?.stripe_subscription_id;

      if (!subscriptionId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "No active subscription found for this account." }) };
      }

      // Cancel at period end (not immediately) so the user keeps access through what they already paid for
      const params = new URLSearchParams();
      params.append("cancel_at_period_end", "true");
      const postData = params.toString();

      const cancelRes = await httpsRequest({
        hostname: "api.stripe.com",
        path: "/v1/subscriptions/" + subscriptionId,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": "Bearer " + process.env.STRIPE_SECRET_KEY,
          "Content-Length": Buffer.byteLength(postData)
        }
      }, postData);

      const cancelData = JSON.parse(cancelRes.body);
      if (cancelData.error) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: cancelData.error.message }) };
      }

      // Save cancellation status to profile so the UI can reflect it
      await supabase("POST", "profiles", {
        email,
        subscription_cancel_at_period_end: true,
        subscription_period_end: cancelData.current_period_end ? new Date(cancelData.current_period_end * 1000).toISOString() : null,
        updated_at: new Date().toISOString()
      });

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, periodEnd: cancelData.current_period_end }) };
    }

    if (action === "sendWelcomeEmail") {
      if (!email) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "No email provided" }) };
      }
      const name = parsed.name || "there";

      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0a0a0a; color: #f2f0eb;">
          <div style="font-size: 22px; font-weight: bold; margin-bottom: 24px;">
            WEIGHT<span style="color: #5d8a7a;">ED[AI]</span>
          </div>
          <h1 style="font-size: 24px; color: #f2f0eb; margin-bottom: 16px;">Welcome, ${name}!</h1>
          <p style="font-size: 15px; line-height: 1.6; color: #ccc;">
            Thanks for joining WeightedAI. Your account is ready — head back to the app to generate your first workout, built from real coaching logic, not generic AI guesswork.
          </p>
          <p style="font-size: 15px; line-height: 1.6; color: #ccc; margin-top: 20px;">
            If you have any questions, just reply to this email.
          </p>
          <div style="margin-top: 32px; padding-top: 20px; border-top: 1px solid #222; font-size: 12px; color: #666;">
            WeightedAI &middot; weightedai.net
          </div>
        </div>
      `;

      const postData = JSON.stringify({
        from: "WeightedAI <hello@weightedai.net>",
        to: [email],
        subject: "Welcome to WeightedAI",
        html: emailHtml
      });

      try {
        const res = await httpsRequest({
          hostname: "api.resend.com",
          path: "/emails",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Length": Buffer.byteLength(postData)
          }
        }, postData);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, resendStatus: res.status }) };
      } catch (emailErr) {
        console.error("Welcome email failed:", emailErr);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: "Email send failed but not blocking signup" }) };
      }
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
        max_tokens: 4096,
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
