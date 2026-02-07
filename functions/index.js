const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();

// Stripe secret key from Firebase config
// Set via: firebase functions:config:set stripe.secret="sk_..." stripe.webhook_secret="whsec_..."
const stripe = new Stripe(functions.config().stripe.secret, {
  apiVersion: "2023-10-16",
});

const db = admin.database();

const ALLOWED_ORIGINS = ["https://card.cardflow.cloud", "https://cardflow.cloud"];
function sanitizeUrl(url, fallback) {
  if (!url) return fallback;
  try {
    var parsed = new URL(url);
    if (ALLOWED_ORIGINS.some(function(o) { return parsed.origin === o; })) return url;
  } catch (e) {}
  return fallback;
}

// ── Price IDs (set these after creating products in Stripe dashboard) ──
// Set via: firebase functions:config:set stripe.price_pro_monthly="price_..." stripe.price_pro_annual="price_..." stripe.price_business_monthly="price_..." stripe.price_business_annual="price_..."
function getPriceId(plan, interval) {
  const config = functions.config().stripe;
  const key = "price_" + plan + "_" + interval;
  return config[key] || null;
}

// ── Create Stripe Checkout Session ──
// Called from the client to start a checkout flow
exports.createCheckoutSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Must be logged in"
    );
  }

  const uid = context.auth.uid;
  const plan = data.plan; // 'pro' or 'business'
  const interval = data.interval || "monthly"; // 'monthly' or 'annual'

  if (!["pro", "business"].includes(plan)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Invalid plan"
    );
  }

  if (!["monthly", "annual"].includes(interval)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Invalid interval"
    );
  }

  const priceId = getPriceId(plan, interval);
  if (!priceId) {
    throw new functions.https.HttpsError(
      "not-found",
      "Price not configured for " + plan + " " + interval
    );
  }

  // Get or create Stripe customer
  const subSnap = await db.ref("/users/" + uid + "/subscription").once("value");
  const subData = subSnap.val() || {};
  let customerId = subData.stripeCustomerId;

  if (!customerId) {
    // Get user email from profile
    const profileSnap = await db.ref("/users/" + uid + "/profile").once("value");
    const profile = profileSnap.val() || {};

    const customer = await stripe.customers.create({
      email: profile.email || context.auth.token.email,
      metadata: { firebaseUID: uid },
    });
    customerId = customer.id;

    // Save customer ID
    await db.ref("/users/" + uid + "/subscription/stripeCustomerId").set(customerId);
  }

  // Create checkout session
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ["card"],
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: sanitizeUrl(data.successUrl, "https://card.cardflow.cloud/dashboard?billing=success"),
    cancel_url: sanitizeUrl(data.cancelUrl, "https://card.cardflow.cloud/dashboard?billing=cancelled"),
    metadata: { firebaseUID: uid, plan: plan },
    subscription_data: {
      metadata: { firebaseUID: uid, plan: plan },
      trial_period_days: plan === "pro" ? 14 : undefined,
    },
  });

  return { sessionId: session.id, url: session.url };
});

// ── Create Stripe Billing Portal Session ──
// Allows users to manage their subscription
exports.createPortalSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Must be logged in"
    );
  }

  const uid = context.auth.uid;
  const subSnap = await db.ref("/users/" + uid + "/subscription").once("value");
  const subData = subSnap.val() || {};

  if (!subData.stripeCustomerId) {
    throw new functions.https.HttpsError(
      "not-found",
      "No billing account found"
    );
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: subData.stripeCustomerId,
    return_url: sanitizeUrl(data.returnUrl, "https://card.cardflow.cloud/dashboard"),
  });

  return { url: session.url };
});

// ── Stripe Webhook Handler ──
// Handles subscription lifecycle events from Stripe
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const sig = req.headers["stripe-signature"];
  const webhookSecret = functions.config().stripe.webhook_secret;
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    res.status(400).send("Webhook Error: " + err.message);
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const uid = session.metadata.firebaseUID;
        const plan = session.metadata.plan;
        if (uid && plan) {
          const updates = {};
          updates["/users/" + uid + "/subscription/plan"] = plan;
          updates["/users/" + uid + "/subscription/status"] = "active";
          updates["/users/" + uid + "/subscription/stripeSubscriptionId"] = session.subscription;
          updates["/users/" + uid + "/subscription/updatedAt"] = admin.database.ServerValue.TIMESTAMP;
          updates["/users/" + uid + "/profile/plan"] = plan;
          await db.ref().update(updates);
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object;
        const uid = subscription.metadata.firebaseUID;
        if (uid) {
          const plan = subscription.metadata.plan || "free";
          const status = subscription.status;
          const effectivePlan = status === "active" ? plan : "free";
          const updates = {};
          updates["/users/" + uid + "/subscription/plan"] = effectivePlan;
          updates["/users/" + uid + "/subscription/status"] = status;
          updates["/users/" + uid + "/subscription/currentPeriodEnd"] = subscription.current_period_end * 1000;
          updates["/users/" + uid + "/subscription/updatedAt"] = admin.database.ServerValue.TIMESTAMP;
          updates["/users/" + uid + "/profile/plan"] = effectivePlan;
          await db.ref().update(updates);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const uid = subscription.metadata.firebaseUID;
        if (uid) {
          const updates = {};
          updates["/users/" + uid + "/subscription/plan"] = "free";
          updates["/users/" + uid + "/subscription/status"] = "canceled";
          updates["/users/" + uid + "/subscription/updatedAt"] = admin.database.ServerValue.TIMESTAMP;
          updates["/users/" + uid + "/profile/plan"] = "free";
          await db.ref().update(updates);
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (subId) {
          const subscription = await stripe.subscriptions.retrieve(subId);
          const uid = subscription.metadata.firebaseUID;
          if (uid) {
            await db.ref("/users/" + uid + "/subscription").update({
              status: "past_due",
              updatedAt: admin.database.ServerValue.TIMESTAMP,
            });
          }
        }
        break;
      }

      default:
        console.log("Unhandled event type:", event.type);
    }
  } catch (err) {
    console.error("Error processing webhook:", err);
    res.status(500).send("Internal error");
    return;
  }

  res.status(200).json({ received: true });
});
