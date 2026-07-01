// netlify/functions/stripe-webhook/index.js
//
// Handles Stripe webhook events so subscription status in Supabase stays in sync with what
// Stripe actually thinks is true — independent of whether the user's browser is open, the
// post-checkout redirect completes, or a card fails on renewal weeks later.
//
// SETUP REQUIRED (do this before going live):
// 1. Deploy this file to netlify/functions/stripe-webhook/index.js (same folder pattern as
//    netlify/functions/generate/index.js).
// 2. In the Stripe Dashboard: Developers -> Webhooks -> Add endpoint.
//    Endpoint URL: https://weightedai.net/.netlify/functions/stripe-webhook
//    Events to send: checkout.session.completed, customer.subscription.updated,
//                     customer.subscription.deleted, invoice.payment_failed
// 3. Stripe will show you a signing secret (starts with whsec_) after creating the endpoint.
//    Add it to Netlify's environment variables as STRIPE_WEBHOOK_SECRET.
// 4. Run add-subscription-status-column.sql against Supabase before deploying this, since this
//    handler writes to that column.
// 5. Do this for BOTH Stripe test mode and live mode separately — they have different signing
//    secrets and the endpoint has to be registered in each mode's dashboard independently.

const https = require("https");
const crypto = require("crypto");

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
  console.log(`Supabase ${method} ${path} -> ${res.status}: ${res.body.slice(0, 200)}`);
  return res;
}

// Verifies the Stripe-Signature header against the raw request body using the webhook
// signing secret. Implemented by hand (no stripe npm package) to match this project's existing
// pattern of calling the Stripe REST API directly over https rather than pulling in the SDK.
function verifyStripeSignature(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  if (!signatureHeader || !secret) return false;

  const parts = signatureHeader.split(",").reduce((acc, part) => {
    const [k, v] = part.split("=");
    if (k === "t") acc.t = v;
    if (k === "v1") acc.v1.push(v);
    return acc;
  }, { t: null, v1: [] });

  if (!parts.t || parts.v1.length === 0) return false;

  const signedPayload = `${parts.t}.${rawBody}`;
  const expectedSig = crypto.createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");

  const isValid = parts.v1.some(sig => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expectedSig, "hex"));
    } catch (e) {
      return false; // signature length mismatch, malformed hex, etc.
    }
  });
  if (!isValid) return false;

  // Reject stale timestamps to guard against replay attacks
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (ageSeconds > toleranceSeconds) return false;

  return true;
}

// Looks up the profile row owning a given Stripe subscription ID, then writes the latest
// status/period-end/cancel-flag onto it. Used by both the "updated" and "deleted" handlers.
async function syncSubscriptionToProfile(subscription, statusOverride) {
  const subscriptionId = subscription.id;

  const res = await supabase("GET", `profiles?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=email`);
  const rows = JSON.parse(res.body);
  const email = rows?.[0]?.email;

  if (!email) {
    console.warn("No profile found for subscription:", subscriptionId);
    return;
  }

  // Stripe deprecated the top-level current_period_end field in newer API versions - it now
  // lives on the subscription item's billing period instead (matches cancelSubscription's
  // handling of the same field in generate-function.js).
  const periodEndSeconds = subscription.current_period_end || subscription.items?.data?.[0]?.current_period_end || null;

  await supabase("POST", "profiles", {
    email,
    subscription_status: statusOverride || subscription.status,
    subscription_cancel_at_period_end: !!subscription.cancel_at_period_end,
    subscription_period_end: periodEndSeconds ? new Date(periodEndSeconds * 1000).toISOString() : null,
    updated_at: new Date().toISOString()
  });

  console.log(`Synced subscription ${subscriptionId} for ${email}: status=${statusOverride || subscription.status}`);
}

exports.handler = async function(event, context) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Signature verification needs the exact raw bytes Stripe signed - must not JSON.parse first.
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  const signature = event.headers["stripe-signature"] || event.headers["Stripe-Signature"];

  if (!verifyStripeSignature(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET)) {
    console.error("Stripe webhook signature verification failed");
    return { statusCode: 400, body: "Invalid signature" };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  console.log("Stripe webhook received:", stripeEvent.type);

  try {
    switch (stripeEvent.type) {
      case "checkout.session.completed": {
        const session = stripeEvent.data.object;
        const customerEmail = session.customer_details?.email || session.customer_email;
        if (session.mode === "subscription" && session.subscription && customerEmail) {
          await supabase("POST", "profiles", {
            email: customerEmail,
            stripe_subscription_id: session.subscription,
            stripe_customer_id: session.customer,
            subscription_status: "active",
            subscription_cancel_at_period_end: false,
            updated_at: new Date().toISOString()
          });
          console.log("Checkout completed for:", customerEmail);
        }
        break;
      }

      case "customer.subscription.updated": {
        // Covers plan changes, cancel_at_period_end toggling, and status transitions like
        // active -> past_due when a renewal payment fails.
        await syncSubscriptionToProfile(stripeEvent.data.object);
        break;
      }

      case "customer.subscription.deleted": {
        // Fires when a subscription actually ends - either the cancel-at-period-end date
        // arrived, or Stripe gave up retrying a failed payment. This is what should actually
        // cut off access, not the user clicking "Cancel" earlier.
        await syncSubscriptionToProfile(stripeEvent.data.object, "canceled");
        break;
      }

      case "invoice.payment_failed": {
        // Informational only - the subscription.updated event that follows (status -> past_due,
        // and eventually subscription.deleted once retries are exhausted) is what actually
        // gates access. Logged here so failed payments are visible in Netlify function logs.
        console.warn("Invoice payment failed:", stripeEvent.data.object.id, stripeEvent.data.object.customer_email);
        break;
      }

      default:
        // Unhandled event type - acknowledge receipt so Stripe doesn't retry it.
        break;
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error("Webhook processing error:", err.message, err.stack);
    // Non-2xx tells Stripe to retry with backoff - appropriate here since these are transient
    // failures (e.g. Supabase briefly unavailable), not permanent rejections.
    return { statusCode: 500, body: JSON.stringify({ error: "Processing failed, Stripe should retry" }) };
  }
};
