const express = require('express');
const Stripe = require('stripe');
const db = require('../db');
const { verifyAuth } = require('../auth');
const { sendSubscriptionConfirmed, sendPaymentFailed } = require('../email');
const { sendPush } = require('../push');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2023-10-16' });

const ALLOWED_ORIGINS = ['https://card.cardflow.cloud', 'https://cardflow.cloud'];
function sanitizeUrl(url, fallback) {
    if (!url) return fallback;
    try {
        var parsed = new URL(url);
        if (ALLOWED_ORIGINS.some(function (o) { return parsed.origin === o; })) return url;
    } catch (e) {}
    return fallback;
}

function getPriceId(plan, interval) {
    var key = 'STRIPE_PRICE_' + plan.toUpperCase() + '_' + interval.toUpperCase();
    return process.env[key] || null;
}

// POST /api/billing/create-checkout (JWT required)
router.post('/create-checkout', verifyAuth, async function (req, res) {
    try {
        var uid = req.user.uid;
        var { plan, interval } = req.body;

        if (!['pro', 'business'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
        if (!['monthly', 'annual'].includes(interval || 'monthly')) return res.status(400).json({ error: 'Invalid interval' });
        interval = interval || 'monthly';

        var priceId = getPriceId(plan, interval);
        if (!priceId) return res.status(400).json({ error: 'Price not configured' });

        // Get or create Stripe customer
        var subResult = await db.query('SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1', [uid]);
        var customerId = subResult.rows.length > 0 ? subResult.rows[0].stripe_customer_id : null;

        if (!customerId) {
            var userResult = await db.query('SELECT email FROM users WHERE id = $1', [uid]);
            var customer = await stripe.customers.create({
                email: userResult.rows[0].email,
                metadata: { userId: uid }
            });
            customerId = customer.id;
            await db.query(
                'INSERT INTO subscriptions (user_id, stripe_customer_id) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = $2',
                [uid, customerId]
            );
        }

        var session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            mode: 'subscription',
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: sanitizeUrl(req.body.successUrl, 'https://card.cardflow.cloud/admin.html?billing=success'),
            cancel_url: sanitizeUrl(req.body.cancelUrl, 'https://card.cardflow.cloud/admin.html?billing=cancelled'),
            metadata: { userId: uid, plan: plan },
            subscription_data: {
                metadata: { userId: uid, plan: plan },
                trial_period_days: plan === 'pro' ? 14 : undefined
            }
        });

        res.json({ sessionId: session.id, url: session.url });
    } catch (err) {
        console.error('Checkout error:', err);
        res.status(500).json({ error: 'Failed to create checkout' });
    }
});

// POST /api/billing/create-portal (JWT required)
router.post('/create-portal', verifyAuth, async function (req, res) {
    try {
        var subResult = await db.query('SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1', [req.user.uid]);
        if (subResult.rows.length === 0 || !subResult.rows[0].stripe_customer_id) {
            return res.status(404).json({ error: 'No billing account found' });
        }

        var session = await stripe.billingPortal.sessions.create({
            customer: subResult.rows[0].stripe_customer_id,
            return_url: sanitizeUrl(req.body.returnUrl, 'https://card.cardflow.cloud/admin.html')
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error('Portal error:', err);
        res.status(500).json({ error: 'Failed to open billing portal' });
    }
});

// GET /api/billing/subscription (JWT required)
router.get('/subscription', verifyAuth, async function (req, res) {
    try {
        var result = await db.query('SELECT * FROM subscriptions WHERE user_id = $1', [req.user.uid]);
        if (result.rows.length === 0) return res.json({ plan: 'free', status: 'none' });
        var sub = result.rows[0];
        res.json({
            plan: sub.plan,
            status: sub.status,
            currentPeriodEnd: sub.current_period_end,
            stripeCustomerId: sub.stripe_customer_id
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load subscription' });
    }
});

// POST /api/billing/webhook — Stripe webhook (no JWT, uses Stripe signature)
router.post('/webhook', express.raw({ type: 'application/json' }), async function (req, res) {
    var sig = req.headers['stripe-signature'];
    var webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    var event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send('Webhook Error: ' + err.message);
    }

    try {
        switch (event.type) {
            case 'checkout.session.completed': {
                var session = event.data.object;
                var uid = session.metadata.userId;
                var plan = session.metadata.plan;
                if (uid && plan) {
                    await db.query(
                        'INSERT INTO subscriptions (user_id, plan, status, stripe_subscription_id, updated_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (user_id) DO UPDATE SET plan = $2, status = $3, stripe_subscription_id = $4, updated_at = NOW()',
                        [uid, plan, 'active', session.subscription]
                    );
                    await db.query('UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2', [plan, uid]);
                    // Send confirmation email + push
                    db.query('SELECT email FROM users WHERE id = $1', [uid]).then(function (r) {
                        if (r.rows.length > 0) sendSubscriptionConfirmed(r.rows[0].email, plan).catch(function () {});
                    }).catch(function () {});
                    sendPush(uid, { title: 'Subscription Confirmed!', body: plan.charAt(0).toUpperCase() + plan.slice(1) + ' plan is now active' });
                }
                break;
            }
            case 'customer.subscription.updated': {
                var subscription = event.data.object;
                var uid = subscription.metadata.userId;
                if (uid) {
                    var plan = subscription.metadata.plan || 'free';
                    var status = subscription.status;
                    var effectivePlan = status === 'active' ? plan : 'free';
                    await db.query(
                        'UPDATE subscriptions SET plan = $1, status = $2, current_period_end = $3, updated_at = NOW() WHERE user_id = $4',
                        [effectivePlan, status, subscription.current_period_end * 1000, uid]
                    );
                    await db.query('UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2', [effectivePlan, uid]);
                }
                break;
            }
            case 'customer.subscription.deleted': {
                var subscription = event.data.object;
                var uid = subscription.metadata.userId;
                if (uid) {
                    await db.query(
                        'UPDATE subscriptions SET plan = $1, status = $2, updated_at = NOW() WHERE user_id = $3',
                        ['free', 'canceled', uid]
                    );
                    await db.query('UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2', ['free', uid]);
                }
                break;
            }
            case 'invoice.payment_failed': {
                var invoice = event.data.object;
                var subId = invoice.subscription;
                if (subId) {
                    var sub = await stripe.subscriptions.retrieve(subId);
                    var uid = sub.metadata.userId;
                    if (uid) {
                        await db.query('UPDATE subscriptions SET status = $1, updated_at = NOW() WHERE user_id = $2', ['past_due', uid]);
                        // Send payment failed email + push
                        db.query('SELECT email FROM users WHERE id = $1', [uid]).then(function (r) {
                            if (r.rows.length > 0) sendPaymentFailed(r.rows[0].email).catch(function () {});
                        }).catch(function () {});
                        sendPush(uid, { title: 'Payment Failed', body: 'Please update your payment method' });
                    }
                }
                break;
            }
        }
    } catch (err) {
        console.error('Error processing webhook:', err);
        return res.status(500).send('Internal error');
    }

    res.status(200).json({ received: true });
});

module.exports = router;
