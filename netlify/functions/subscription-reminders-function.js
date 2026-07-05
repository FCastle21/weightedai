// netlify/functions/subscription-reminders/index.js
//
// Scheduled function (runs daily) that sends the reminder emails required by California's amended
// Automatic Renewal Law (AB 2863, effective July 2025):
//   1. At least one reminder per year for EVERY auto-renewing subscription (Unlimited monthly AND
//      Annual), disclosing the plan, charge amount/frequency, and how to cancel.
//   2. For subscriptions with a term of one year or longer (Annual), an additional notice sent
//      15-45 days before each renewal, with the same information.
//
// SETUP REQUIRED:
// 1. Deploy this file to netlify/functions/subscription-reminders/index.js.
// 2. Run add-arl-reminder-columns.sql against Supabase before deploying, since this function reads
//    and writes those two new columns.
// 3. Scheduled Functions are enabled by default on Netlify - no extra dashboard toggle needed. After
//    deploy, confirm it shows up on the Functions page with a "Scheduled" badge and a next-run time.
// 4. You can trigger it manually anytime from the Functions page ("Run now") to test without waiting
//    for the schedule, or to verify it against a test profile you've backdated in Supabase.
//
// This does NOT replace the in-app "Cancel Subscription" flow (which already satisfies the ARL's
// "click to cancel" requirement) - it only adds the reminder-email side of the law.

const https = require("https");

exports.config = {
  schedule: "0 14 * * *" // once daily, 14:00 UTC
};

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

async function sendEmail(to, subject, html) {
  const postData = JSON.stringify({
    from: "WeightedAI <hello@weightedai.net>",
    to: [to],
    subject,
    html
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
    return res.status >= 200 && res.status < 300;
  } catch (e) {
    console.error("Reminder email send failed:", e);
    return false;
  }
}

function planLabel(tier) {
  if (tier === "annual") return "Unlimited Annual ($149.99/year)";
  if (tier === "unlimited") return "Unlimited ($14.99/month)";
  return tier;
}

function emailShell(bodyHtml) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0a0a0a; color: #f5f3ef;">
      <div style="font-size: 20px; margin-bottom: 24px;">
        Weighted<span style="color: #5d8a7a;">[AI]</span>
      </div>
      ${bodyHtml}
      <div style="margin-top: 32px; padding-top: 20px; border-top: 1px solid #222; font-size: 12px; color: #666;">
        WeightedAI &middot; weightedai.net &middot; You're receiving this because you have an active subscription.
      </div>
    </div>
  `;
}

exports.handler = async function(event, context) {
  const summary = { checked: 0, annualNoticesSent: 0, generalRemindersSent: 0, errors: 0 };

  try {
    const res = await supabase(
      "GET",
      "profiles?tier=in.(unlimited,annual)&subscription_status=in.(active,trialing)&select=email,name,tier,subscription_period_end,last_annual_reminder_sent_at,annual_notice_sent_for_period_end"
    );
    const profiles = JSON.parse(res.body);
    if (!Array.isArray(profiles)) {
      console.error("Unexpected profiles response:", res.body);
      return { statusCode: 500, body: JSON.stringify({ error: "Could not load profiles" }) };
    }

    const now = Date.now();

    for (const profile of profiles) {
      summary.checked++;
      try {
        const name = profile.name || "there";
        let sentSomething = false;

        // Check 1: Annual pre-renewal notice, 15-45 days before renewal, once per renewal period
        if (profile.tier === "annual" && profile.subscription_period_end) {
          const periodEnd = new Date(profile.subscription_period_end);
          const daysUntilRenewal = (periodEnd.getTime() - now) / (1000 * 60 * 60 * 24);
          const alreadySentForThisPeriod = profile.annual_notice_sent_for_period_end &&
            new Date(profile.annual_notice_sent_for_period_end).getTime() === periodEnd.getTime();

          if (daysUntilRenewal >= 15 && daysUntilRenewal <= 45 && !alreadySentForThisPeriod) {
            const html = emailShell(`
              <h1 style="font-size: 22px; color: #f5f3ef; margin-bottom: 16px;">Your Annual Plan renews soon</h1>
              <p style="font-size: 15px; line-height: 1.6; color: #ccc;">Hi ${name},</p>
              <p style="font-size: 15px; line-height: 1.6; color: #ccc;">
                This is a reminder that your <strong>${planLabel(profile.tier)}</strong> subscription will automatically
                renew on <strong>${periodEnd.toLocaleDateString()}</strong> unless you cancel before then.
              </p>
              <p style="font-size: 15px; line-height: 1.6; color: #ccc;">
                You can cancel anytime, instantly, from your account settings in the app - no phone call needed.
                If you cancel before your renewal date, you won't be charged again and you'll keep access
                through the end of your current term.
              </p>
            `);
            const sent = await sendEmail(profile.email, "Your WeightedAI Annual Plan renews soon", html);
            if (sent) {
              await supabase("POST", "profiles", {
                email: profile.email,
                annual_notice_sent_for_period_end: profile.subscription_period_end,
                last_annual_reminder_sent_at: new Date().toISOString()
              });
              summary.annualNoticesSent++;
              sentSomething = true;
            } else {
              summary.errors++;
            }
          }
        }

        // Check 2: general "at least once a year" reminder for ANY auto-renewing tier, skipped if
        // the annual pre-renewal notice above already covered this cycle
        if (!sentSomething) {
          const daysSinceLastReminder = profile.last_annual_reminder_sent_at
            ? (now - new Date(profile.last_annual_reminder_sent_at).getTime()) / (1000 * 60 * 60 * 24)
            : Infinity;

          if (daysSinceLastReminder >= 365) {
            const html = emailShell(`
              <h1 style="font-size: 22px; color: #f5f3ef; margin-bottom: 16px;">Your WeightedAI subscription</h1>
              <p style="font-size: 15px; line-height: 1.6; color: #ccc;">Hi ${name},</p>
              <p style="font-size: 15px; line-height: 1.6; color: #ccc;">
                As a reminder, you're subscribed to <strong>${planLabel(profile.tier)}</strong>, which renews
                automatically until you cancel.
              </p>
              <p style="font-size: 15px; line-height: 1.6; color: #ccc;">
                You can cancel anytime, instantly, from your account settings in the app - no phone call needed.
              </p>
            `);
            const sent = await sendEmail(profile.email, "Your WeightedAI subscription", html);
            if (sent) {
              await supabase("POST", "profiles", {
                email: profile.email,
                last_annual_reminder_sent_at: new Date().toISOString()
              });
              summary.generalRemindersSent++;
            } else {
              summary.errors++;
            }
          }
        }
      } catch (perProfileErr) {
        console.error("Error processing reminder for", profile.email, perProfileErr);
        summary.errors++;
      }
    }

    console.log("Subscription reminder run complete:", summary);
    return { statusCode: 200, body: JSON.stringify(summary) };
  } catch (err) {
    console.error("Subscription reminder run failed:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
