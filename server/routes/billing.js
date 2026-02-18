const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const db = require('../db');
const { verifyAuth } = require('../auth');
const { sendSubscriptionConfirmed, sendPaymentFailed } = require('../email');
const { sendPush } = require('../push');
const { PLAN_LIMITS } = require('./cards');

const router = express.Router();

if (!process.env.RAZORPAY_KEY_ID) console.warn('WARNING: RAZORPAY_KEY_ID not set — billing will not work');
if (!process.env.RAZORPAY_KEY_SECRET) console.warn('WARNING: RAZORPAY_KEY_SECRET not set — billing will not work');

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || '',
    key_secret: process.env.RAZORPAY_KEY_SECRET || ''
});

// Pricing in smallest currency unit (cents for USD)
var PLAN_PRICES = {
    pro: 1000,       // $10.00
    business: 2500   // $25.00
};

// Deactivate excess cards when a user's plan downgrades.
// Keeps the most recently updated cards active, deactivates the rest.
// Also reactivates cards when upgrading to a higher-limit plan.
async function enforceCardLimit(userId, newPlan) {
    var maxCards = PLAN_LIMITS[newPlan] || 1;
    if (maxCards === -1) {
        await db.query('UPDATE cards SET active = true WHERE user_id = $1 AND active = false', [userId]);
        return;
    }
    var countResult = await db.query('SELECT COUNT(*) FROM cards WHERE user_id = $1', [userId]);
    var totalCards = parseInt(countResult.rows[0].count) || 0;
    if (totalCards <= maxCards) {
        await db.query('UPDATE cards SET active = true WHERE user_id = $1 AND active = false', [userId]);
        return;
    }
    await db.query(
        'UPDATE cards SET active = (id IN (SELECT id FROM cards WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2)) WHERE user_id = $1',
        [userId, maxCards]
    );
    console.log('Deactivated excess cards for user ' + userId + ': plan=' + newPlan + ', total=' + totalCards + ', limit=' + maxCards);
}

// POST /api/billing/create-order (JWT required)
router.post('/create-order', verifyAuth, async function (req, res) {
    try {
        var uid = req.user.uid;
        var plan = req.body.plan;

        if (!['pro', 'business'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });

        var amount = PLAN_PRICES[plan];
        if (!amount) return res.status(400).json({ error: 'Price not configured' });

        var order = await razorpay.orders.create({
            amount: amount,
            currency: 'USD',
            receipt: 'order_' + uid + '_' + Date.now(),
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
router.post('/verify-payment', verifyAuth, async function (req, res) {
    try {
        var uid = req.user.uid;
        var { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: 'Missing payment verification fields' });
        }
        if (!['pro', 'business'].includes(plan)) {
            return res.status(400).json({ error: 'Invalid plan' });
        }

        // Verify HMAC signature
        var expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + '|' + razorpay_payment_id)
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            console.error('Payment signature mismatch for user ' + uid);
            return res.status(400).json({ error: 'Payment verification failed' });
        }

        // Verify order_id matches what we stored
        var subResult = await db.query('SELECT razorpay_order_id FROM subscriptions WHERE user_id = $1', [uid]);
        if (subResult.rows.length === 0 || subResult.rows[0].razorpay_order_id !== razorpay_order_id) {
            return res.status(400).json({ error: 'Order mismatch' });
        }

        // Signature valid — activate the plan
        await db.query(
            'UPDATE subscriptions SET plan = $1, status = $2, razorpay_payment_id = $3, razorpay_order_id = $4, updated_at = NOW() WHERE user_id = $5',
            [plan, 'active', razorpay_payment_id, razorpay_order_id, uid]
        );
        await db.query('UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2', [plan, uid]);

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
router.get('/subscription', verifyAuth, async function (req, res) {
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

module.exports = router;
