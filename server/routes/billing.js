const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../db');
const { verifyAuth, requireNotSuspended } = require('../auth');
const { sendSubscriptionConfirmed } = require('../email');
const { sendPush } = require('../push');
const { PLAN_LIMITS } = require('./cards');

const router = express.Router();

var billingLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyGenerator: function (req) { return req.user ? req.user.uid : ipKeyGenerator(req); },
    message: { error: 'Too many billing requests. Please try again later.' }
});

if (!process.env.RAZORPAY_KEY_ID) console.warn('WARNING: RAZORPAY_KEY_ID not set — billing will not work');
if (!process.env.RAZORPAY_KEY_SECRET) console.warn('WARNING: RAZORPAY_KEY_SECRET not set — billing will not work');

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || '',
    key_secret: process.env.RAZORPAY_KEY_SECRET || ''
});

// Pricing in smallest currency unit (paise for INR)
var PLAN_PRICES = {
    pro: 39900,      // ₹399
    business: 99900  // ₹999
};

// Deactivate excess cards when a user's plan downgrades.
// Keeps the most recently updated cards active, deactivates the rest.
// Also reactivates cards when upgrading to a higher-limit plan.
async function enforceCardLimit(userId, newPlan) {
    var maxCards = PLAN_LIMITS[newPlan] || 1;
    if (maxCards === -1) {
        // Unlimited plan — don't auto-reactivate; user controls their own cards
        return;
    }
    var activeResult = await db.query('SELECT COUNT(*) FROM cards WHERE user_id = $1 AND active = true', [userId]);
    var activeCards = parseInt(activeResult.rows[0].count) || 0;
    if (activeCards <= maxCards) {
        // Under limit — no changes needed. Don't auto-reactivate cards the user may have intentionally deactivated.
        return;
    }
    // Deactivate oldest active cards, keeping only the most recently updated within the limit
    await db.query(
        'UPDATE cards SET active = false WHERE user_id = $1 AND active = true AND id NOT IN (SELECT id FROM cards WHERE user_id = $1 AND active = true ORDER BY updated_at DESC LIMIT $2)',
        [userId, maxCards]
    );
    if (process.env.NODE_ENV !== 'production') console.log('Deactivated excess cards for user ' + userId + ': plan=' + newPlan + ', limit=' + maxCards);
}

// POST /api/billing/create-order (JWT required)
router.post('/create-order', verifyAuth, requireNotSuspended, billingLimiter, async function (req, res) {
    try {
        var uid = req.user.uid;
        var plan = req.body.plan;

        if (!['pro', 'business'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });

        // Block suspended users
        var userCheck = await db.query('SELECT suspended_at FROM users WHERE id = $1', [uid]);
        if (userCheck.rows.length > 0 && userCheck.rows[0].suspended_at) {
            return res.status(403).json({ error: 'Account is suspended. Contact support.' });
        }

        var amount = PLAN_PRICES[plan];
        if (!amount) return res.status(400).json({ error: 'Price not configured' });

        var order = await razorpay.orders.create({
            amount: amount,
            currency: 'INR',
            receipt: ('rcpt_' + uid).slice(0, 30) + '_' + Date.now().toString(36),
            notes: {
                userId: uid,
                plan: plan
            }
        });

        // Upsert subscription row with order_id (pre-payment)
        await db.query(
            'INSERT INTO subscriptions (user_id, razorpay_order_id, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (user_id) DO UPDATE SET razorpay_order_id = $2, updated_at = NOW()',
            [uid, order.id]
        );

        res.json({
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            keyId: process.env.RAZORPAY_KEY_ID
        });
    } catch (err) {
        console.error('Create order error:', err);
        res.status(500).json({ error: 'Failed to create order' });
    }
});

// POST /api/billing/verify-payment (JWT required)
router.post('/verify-payment', verifyAuth, requireNotSuspended, billingLimiter, async function (req, res) {
    try {
        var uid = req.user.uid;
        var { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: 'Missing payment verification fields' });
        }

        // Block suspended users
        var userCheck2 = await db.query('SELECT suspended_at FROM users WHERE id = $1', [uid]);
        if (userCheck2.rows.length > 0 && userCheck2.rows[0].suspended_at) {
            return res.status(403).json({ error: 'Account is suspended. Contact support.' });
        }

        // Verify HMAC signature
        var expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + '|' + razorpay_payment_id)
            .digest('hex');

        var sigBuf = Buffer.from(expectedSignature);
        var providedBuf = Buffer.from(razorpay_signature);
        if (sigBuf.length !== providedBuf.length || !crypto.timingSafeEqual(sigBuf, providedBuf)) {
            console.error('Payment signature mismatch for user ' + uid);
            return res.status(400).json({ error: 'Payment verification failed' });
        }

        // Verify order_id matches what we stored
        var subResult = await db.query('SELECT razorpay_order_id FROM subscriptions WHERE user_id = $1', [uid]);
        if (subResult.rows.length === 0 || subResult.rows[0].razorpay_order_id !== razorpay_order_id) {
            return res.status(400).json({ error: 'Order mismatch' });
        }

        // Get the authoritative plan from Razorpay order notes (not from client)
        var rzpOrder = await razorpay.orders.fetch(razorpay_order_id);
        var plan = rzpOrder.notes && rzpOrder.notes.plan;
        if (!['pro', 'business'].includes(plan)) {
            return res.status(400).json({ error: 'Invalid plan in order' });
        }

        // Signature valid — activate the plan atomically
        // Extend from existing period end if still active, otherwise from now
        var existingSub = await db.query('SELECT current_period_end, status FROM subscriptions WHERE user_id = $1', [uid]);
        var baseTime = Date.now();
        if (existingSub.rows.length > 0 && existingSub.rows[0].current_period_end) {
            var existingEnd = existingSub.rows[0].current_period_end * 1000; // convert epoch seconds to ms
            if (existingEnd > baseTime && existingSub.rows[0].status !== 'cancelled') {
                baseTime = existingEnd;
            }
        }
        var periodEnd = Math.floor((baseTime + 30 * 24 * 60 * 60 * 1000) / 1000); // 30 days (epoch seconds)
        var client = await db.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                'UPDATE subscriptions SET plan = $1, status = $2, razorpay_payment_id = $3, razorpay_order_id = $4, current_period_end = $5, updated_at = NOW() WHERE user_id = $6',
                [plan, 'active', razorpay_payment_id, razorpay_order_id, periodEnd, uid]
            );
            await client.query('UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2', [plan, uid]);
            await client.query('COMMIT');
        } catch (txErr) {
            try { await client.query('ROLLBACK'); } catch (e) {}
            throw txErr;
        } finally {
            client.release();
        }

        await enforceCardLimit(uid, plan);

        // Send confirmation email + push (fire-and-forget)
        db.query('SELECT email FROM users WHERE id = $1', [uid]).then(function (r) {
            if (r.rows.length > 0) sendSubscriptionConfirmed(r.rows[0].email, plan).catch(function () {});
        }).catch(function () {});
        sendPush(uid, { title: 'Plan Activated!', body: plan.charAt(0).toUpperCase() + plan.slice(1) + ' plan is now active' });

        res.json({ success: true, plan: plan });
    } catch (err) {
        console.error('Verify payment error:', err);
        res.status(500).json({ error: 'Payment verification failed' });
    }
});

// GET /api/billing/subscription (JWT required)
router.get('/subscription', verifyAuth, requireNotSuspended, async function (req, res) {
    try {
        var result = await db.query('SELECT * FROM subscriptions WHERE user_id = $1', [req.user.uid]);
        if (result.rows.length === 0) return res.json({ plan: 'free', status: 'none' });
        var sub = result.rows[0];
        res.json({
            plan: sub.plan,
            status: sub.status,
            currentPeriodEnd: sub.current_period_end
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load subscription' });
    }
});

// POST /api/billing/cancel (JWT required)
// Marks subscription as cancelled but keeps plan active until current_period_end.
// The hourly cron job handles the actual downgrade when the period expires.
router.post('/cancel', verifyAuth, requireNotSuspended, billingLimiter, async function (req, res) {
    try {
        var uid = req.user.uid;
        // Check if there's an active subscription with remaining time
        var subResult = await db.query(
            "SELECT plan, status, current_period_end FROM subscriptions WHERE user_id = $1",
            [uid]
        );
        if (subResult.rows.length === 0 || subResult.rows[0].status !== 'active') {
            return res.status(400).json({ error: 'No active subscription to cancel' });
        }
        var sub = subResult.rows[0];
        var nowEpoch = Math.floor(Date.now() / 1000);
        // If period has already expired or no period end set, downgrade immediately
        if (!sub.current_period_end || sub.current_period_end <= nowEpoch) {
            var client = await db.connect();
            try {
                await client.query('BEGIN');
                await client.query(
                    "UPDATE subscriptions SET plan = 'free', status = 'cancelled', updated_at = NOW() WHERE user_id = $1",
                    [uid]
                );
                await client.query("UPDATE users SET plan = 'free', updated_at = NOW() WHERE id = $1", [uid]);
                await client.query('COMMIT');
            } catch (txErr) {
                try { await client.query('ROLLBACK'); } catch (e) {}
                throw txErr;
            } finally {
                client.release();
            }
            await enforceCardLimit(uid, 'free');
            res.json({ success: true, plan: 'free', immediate: true });
        } else {
            // Mark as cancelled — plan stays active until period ends
            await db.query(
                "UPDATE subscriptions SET status = 'cancelled', updated_at = NOW() WHERE user_id = $1",
                [uid]
            );
            res.json({ success: true, plan: sub.plan, cancelledAt: nowEpoch, activeUntil: sub.current_period_end });
        }
    } catch (err) {
        console.error('Cancel subscription error:', err);
        res.status(500).json({ error: 'Failed to cancel subscription' });
    }
});

module.exports = router;
module.exports.enforceCardLimit = enforceCardLimit;
