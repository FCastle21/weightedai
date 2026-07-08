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
    const { action, prompt, email, profileData, logEntry, historyEntry, accessToken, sender, message, adminEmail, targetEmail, reader } = parsed;
    
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
            subscription_status: "active",
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

      // Stripe deprecated the top-level current_period_end field - it now lives on the
      // subscription item's billing period instead (items.data[0].current_period_end)
      const periodEnd = cancelData.current_period_end || cancelData.items?.data?.[0]?.current_period_end || null;

      // Save cancellation status to profile so the UI can reflect it
      await supabase("POST", "profiles", {
        email,
        subscription_cancel_at_period_end: true,
        subscription_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
        updated_at: new Date().toISOString()
      });

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, periodEnd: periodEnd }) };
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

    if (action === "loadWeightProgress") {
      // Separate from loadHistory (capped at 5, used for AI prompt context) - this pulls a much
      // longer window specifically for the user-facing weight progress chart, since a trend needs
      // more than 5 data points to be meaningful.
      const res = await supabase("GET", `workout_history?email=eq.${encodeURIComponent(email)}&select=date,performance&order=created_at.asc&limit=50`);
      return { statusCode: 200, headers, body: res.body };
    }

    if (action === "saveHistory") {
      const res = await supabase("POST", "workout_history", { ...historyEntry, email });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status: res.status }) };
    }

    // ── COACH CHAT ──────────────────────────────────────────────────────────
    // ADMIN_EMAILS is a comma-separated Netlify env var (e.g. "adam@weightedai.net,partner@weightedai.net").
    // Kept server-side only so the client never learns who the admins are - it just asks
    // checkAdminStatus and gets back a yes/no.
    function isAdminEmail(candidateEmail) {
      const adminList = (process.env.ADMIN_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
      return !!candidateEmail && adminList.includes(candidateEmail.toLowerCase());
    }

    if (action === "checkAdminStatus") {
      return { statusCode: 200, headers, body: JSON.stringify({ isAdmin: isAdminEmail(email) }) };
    }

    if (action === "sendCoachMessage") {
      if (!message) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing message" }) };
      }
      if (sender === "coach") {
        if (!isAdminEmail(adminEmail)) {
          return { statusCode: 403, headers, body: JSON.stringify({ error: "Not authorized" }) };
        }
        if (!targetEmail) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing targetEmail" }) };
        }
        await supabase("POST", "coach_messages", { email: targetEmail, sender: "coach", message });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      } else {
        if (!email) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing email" }) };
        }
        // Coach chat is a paid-tier perk - verify before allowing the message through
        const profileRes = await supabase("GET", `profiles?email=eq.${encodeURIComponent(email)}&select=tier`);
        const profileRows = JSON.parse(profileRes.body);
        const userTier = profileRows?.[0]?.tier;
        if (userTier !== "unlimited" && userTier !== "annual") {
          return { statusCode: 403, headers, body: JSON.stringify({ error: "Coach chat is available on the Unlimited plan only" }) };
        }
        await supabase("POST", "coach_messages", { email, sender: "user", message });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      }
    }

    if (action === "getCoachMessages") {
      const res = await supabase("GET", `coach_messages?email=eq.${encodeURIComponent(email)}&order=created_at.asc`);
      return { statusCode: 200, headers, body: res.body };
    }

    if (action === "getAllCoachThreads") {
      if (!isAdminEmail(adminEmail)) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "Not authorized" }) };
      }
      const res = await supabase("GET", `coach_messages?select=*&order=created_at.desc`);
      const allMessages = JSON.parse(res.body);
      const threadsByEmail = {};
      for (const msg of allMessages) {
        if (!threadsByEmail[msg.email]) {
          threadsByEmail[msg.email] = { email: msg.email, lastMessage: msg.message, lastSender: msg.sender, lastAt: msg.created_at, unreadCount: 0 };
        }
        if (msg.sender === "user" && !msg.read_by_coach) {
          threadsByEmail[msg.email].unreadCount++;
        }
      }
      const threads = Object.values(threadsByEmail).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
      return { statusCode: 200, headers, body: JSON.stringify(threads) };
    }

    if (action === "markMessagesRead") {
      if (reader === "coach") {
        if (!isAdminEmail(adminEmail)) {
          return { statusCode: 403, headers, body: JSON.stringify({ error: "Not authorized" }) };
        }
        await supabase("PATCH", `coach_messages?email=eq.${encodeURIComponent(targetEmail || email)}&sender=eq.user&read_by_coach=eq.false`, { read_by_coach: true });
      } else {
        if (!email) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing email" }) };
        }
        await supabase("PATCH", `coach_messages?email=eq.${encodeURIComponent(email)}&sender=eq.coach&read_by_user=eq.false`, { read_by_user: true });
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    if (action === "generateThirtyDayOverview") {
      const { age, gender, weight, height, thirtyDayGoal, level } = parsed;
      if (!thirtyDayGoal) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "thirtyDayGoal required" }) };
      }

      const overviewPrompt = `You are an elite fitness and nutrition coach. Create a standalone Overview and Nutrition Strategy for a user with these details:

- Age: ${age || "Not specified"}
- Gender: ${gender || "Not specified"}
- Weight: ${weight || "Not specified"}
- Height: ${height || "Not specified"}
- Level: ${level || "Not specified"}
- 30-Day Goal: ${thirtyDayGoal}

NUTRITION GUIDELINES — APPLY BASED ON THE 30-DAY GOAL. Use weight (convert to kg if needed: lbs / 2.2 = kg) to calculate exact numbers, not vague ranges. Show your math briefly (e.g. "180 lb = ~82 kg").

IF GOAL IS MUSCLE BUILDING:
Building muscle increases resting metabolic rate, making it an effective long-term strategy for fat loss as well as strength and aesthetics. Offer two calorie approaches:
- OPTION A (Lean Muscle Gain): small surplus, 5-15% above estimated maintenance.
- OPTION B (Recomp / Fat Loss While Building): small deficit (0-10% below maintenance) or maintenance calories.
- Protein: 0.8 g/lb bodyweight (1.76 g/kg).
- Fat: 20-35% of total calories.
- Carbs: fill remaining calories, typically 3-7 g/kg depending on training volume.

IF GOAL IS BUILD & BURN:
This is a body recomposition goal - building muscle while losing fat simultaneously. This requires
a different approach than pure Fat Loss (an aggressive deficit would work against muscle building)
or pure Muscle Building (a surplus would work against fat loss).
- Calories: at maintenance, or a small deficit (0-15% below estimated maintenance) - never larger,
  since a steeper deficit will cost the muscle-building side of this goal.
- Protein: HIGHER than standard - 1.0-1.2 g/lb bodyweight (2.2-2.6 g/kg), above the usual 0.8 g/lb,
  since preserving and building muscle in a deficit or at maintenance requires more protein than a
  single-focus goal does.
- Fat: 20-30% of calories.
- Carbs: fill remaining calories, with a note to prioritize carbs around training sessions to fuel
  performance and recovery.

IF GOAL IS FAT LOSS:
- Calories: deficit of 10-25% below estimated maintenance. Target fat loss of 0.5-1% of bodyweight per week.
- Protein: 0.8 g/lb bodyweight (1.76 g/kg) to preserve muscle during the deficit.
- Fat: minimum 20% of calories.
- Carbs: fill remaining calories — avoid going too low.

IF GOAL IS STRENGTH GAINING:
- Calories: at or near maintenance.
- Protein: 0.8 g/lb bodyweight (1.76 g/kg).
- Fat: 20-35% of calories.
- Carbs: moderate, 3-5 g/kg.

IF GOAL IS GENERAL FITNESS:
- Calories: at maintenance.
- Protein: 0.8 g/lb bodyweight (1.76 g/kg).
- Fat: 25-35% of calories.
- Carbs: fill remaining calories.

PRIORITY ORDER: 1) Total calories 2) Protein intake 3) Training consistency 4) Sleep and recovery 5) Carbohydrate intake 6) Food timing 7) Supplements.

At the end of the Nutrition Strategy section, add a heading "**Disclaimer**" followed by this exact text verbatim (do not include any other instructional text, just this sentence): "These nutrition recommendations are general guidelines based on widely accepted sports nutrition principles, not personalized medical or dietary prescriptions. Individual needs vary based on health history, medical conditions, and other factors. Please consult a registered dietitian or physician with any specific questions or concerns before making significant changes to your diet."

FORMATTING RULE: Do NOT use markdown tables — no | pipe characters or |---|---| separator rows. Use bullet points or bold labels with colons instead.

Output format:
## Your 30-Day Overview
A short paragraph (3-4 sentences) framing what this 30-day goal means in practice and what to expect.

## Nutrition Strategy
Apply the guidelines above using the user's actual weight and goal. Show calorie target, exact protein/fat/carb grams, meal timing guidance, and food recommendations. Be specific with numbers, not vague ranges.

## Recovery Protocol
2-3 sentences on sleep, rest days, and recovery habits that support this specific goal.`;

      const postData = JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [{ role: "user", content: overviewPrompt }]
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

      const responseData = JSON.parse(res.body);
      const overviewText = responseData.content?.find(b => b.type === "text")?.text || "";

      // Cache this result to the user's profile so we don't regenerate every time
      if (email && overviewText) {
        try {
          await supabase("POST", "profiles", {
            email,
            thirty_day_overview_cache: overviewText,
            updated_at: new Date().toISOString()
          });
        } catch (cacheErr) {
          console.error("Failed to cache overview:", cacheErr);
        }
      }

      return { statusCode: 200, headers, body: JSON.stringify({ overview: overviewText }) };
    }

    if (action === "checkGenerationStatus") {
      const { jobId } = parsed;
      if (!jobId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing jobId" }) };
      }

      // Opportunistic cleanup - fire and forget, don't block the actual status check on this.
      // Keeps generation_jobs from growing unbounded without needing a separate scheduled job.
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      supabase("DELETE", `generation_jobs?created_at=lt.${encodeURIComponent(oneHourAgo)}`).catch(() => {});

      const res = await supabase("GET", `generation_jobs?job_id=eq.${encodeURIComponent(jobId)}&select=status,result,error`);
      const rows = JSON.parse(res.body);
      const job = rows?.[0];

      if (!job) {
        // No row yet (background function may not have started writing its initial "pending"
        // row) - treat this the same as pending rather than an error, and keep polling.
        return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
      }

      return { statusCode: 200, headers, body: JSON.stringify(job) };
    }

    if (action === "generate" || prompt) {
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
