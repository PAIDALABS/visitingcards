const express = require('express');
const db = require('../db');
const sse = require('../sse');
const { sendLeadNotification, sendWaitlistConfirmation } = require('../email');
const { sendPush } = require('../push');

const router = express.Router();

// ── Lead limit helper ──
async function checkLeadLimit(userId) {
    var userResult = await db.query('SELECT plan FROM users WHERE id = $1', [userId]);
    var plan = (userResult.rows.length > 0 && userResult.rows[0].plan) || 'free';
    if (plan !== 'free') return true;
    var startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    var countResult = await db.query(
        'SELECT COUNT(*) as cnt FROM leads WHERE user_id = $1 AND updated_at >= $2',
        [userId, startOfMonth]
    );
    return parseInt(countResult.rows[0].cnt, 10) < 25;
}

// GET /api/public/username/:username — resolve username to userId
router.get('/username/:username', async function (req, res) {
    try {
        var result = await db.query('SELECT id FROM users WHERE username = $1', [req.params.username.toLowerCase()]);
        if (result.rows.length === 0) return res.json(null);
        res.json(result.rows[0].id);
    } catch (err) {
        res.status(500).json({ error: 'Lookup failed' });
    }
});

// GET /api/public/check-username/:username — availability check for signup
router.get('/check-username/:username', async function (req, res) {
    try {
        var result = await db.query('SELECT id FROM users WHERE username = $1', [req.params.username.toLowerCase()]);
        res.json({ available: result.rows.length === 0 });
    } catch (err) {
        res.status(500).json({ error: 'Check failed' });
    }
});

// GET /api/public/user/:userId/cards — all cards for a user (public)
router.get('/user/:userId/cards', async function (req, res) {
    try {
        var result = await db.query('SELECT id, data FROM cards WHERE user_id = $1', [req.params.userId]);
        var cards = {};
        result.rows.forEach(function (row) {
            cards[row.id] = row.data;
        });
        res.json(cards);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load cards' });
    }
});

// GET /api/public/user/:userId/cards/:cardId — single card (public)
router.get('/user/:userId/cards/:cardId', async function (req, res) {
    try {
        var result = await db.query('SELECT data FROM cards WHERE user_id = $1 AND id = $2', [req.params.userId, req.params.cardId]);
        if (result.rows.length === 0) return res.json(null);
        res.json(result.rows[0].data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load card' });
    }
});

// GET /api/public/user/:userId/settings — public settings (default card, etc.)
router.get('/user/:userId/settings', async function (req, res) {
    try {
        var result = await db.query('SELECT default_card FROM user_settings WHERE user_id = $1', [req.params.userId]);
        if (result.rows.length === 0) return res.json({ defaultCard: null });
        res.json({ defaultCard: result.rows[0].default_card });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

// GET /api/public/user/:userId/profile — public profile info
router.get('/user/:userId/profile', async function (req, res) {
    try {
        var result = await db.query('SELECT name, username, plan FROM users WHERE id = $1', [req.params.userId]);
        if (result.rows.length === 0) return res.json(null);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load profile' });
    }
});

// GET /api/public/token/:token — resolve card token to userId + cardId
router.get('/token/:token', async function (req, res) {
    try {
        var result = await db.query(
            "SELECT user_id, id FROM cards WHERE data->>'token' = $1 LIMIT 1",
            [req.params.token]
        );
        if (result.rows.length === 0) return res.json(null);
        var row = result.rows[0];
        // Also fetch username for path display
        var userResult = await db.query('SELECT username FROM users WHERE id = $1', [row.user_id]);
        var username = userResult.rows.length > 0 ? userResult.rows[0].username : null;
        res.json({ userId: row.user_id, cardId: row.id, username: username });
    } catch (err) {
        res.status(500).json({ error: 'Lookup failed' });
    }
});

// GET /api/public/nfc/:token — resolve NFC token to userId
router.get('/nfc/:token', async function (req, res) {
    try {
        var result = await db.query('SELECT user_id FROM public_nfc_tokens WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.json(null);
        res.json(result.rows[0].user_id);
    } catch (err) {
        res.status(500).json({ error: 'Lookup failed' });
    }
});

// POST /api/public/user/:userId/taps — create tap session
router.post('/user/:userId/taps', async function (req, res) {
    try {
        var tapId = req.body.id || (Date.now().toString(36) + Math.random().toString(36).substr(2, 5));
        var data = req.body.data || req.body;
        // Add server timestamp
        if (data.ts && data.ts['.sv'] === 'timestamp') data.ts = Date.now();

        await db.query(
            'INSERT INTO taps (user_id, id, data) VALUES ($1, $2, $3) ON CONFLICT (user_id, id) DO UPDATE SET data = $3',
            [req.params.userId, tapId, JSON.stringify(data)]
        );
        res.json({ success: true, id: tapId });

        // Push notification in background
        sendPush(req.params.userId, { title: 'Someone tapped your card!', body: 'Tap to select which card to share' });
    } catch (err) {
        console.error('Create tap error:', err);
        res.status(500).json({ error: 'Failed to create tap' });
    }
});

// PATCH /api/public/user/:userId/taps/:tapId — update tap
router.patch('/user/:userId/taps/:tapId', async function (req, res) {
    try {
        var result = await db.query('SELECT data FROM taps WHERE user_id = $1 AND id = $2', [req.params.userId, req.params.tapId]);
        var existing = result.rows.length > 0 ? result.rows[0].data : {};
        var data = Object.assign({}, existing, req.body);
        await db.query(
            'INSERT INTO taps (user_id, id, data) VALUES ($1, $2, $3) ON CONFLICT (user_id, id) DO UPDATE SET data = $3',
            [req.params.userId, req.params.tapId, JSON.stringify(data)]
        );

        // Publish SSE event for admin listening to this tap
        sse.publish('tap:' + req.params.userId + ':' + req.params.tapId, data);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update tap' });
    }
});

// PUT /api/public/user/:userId/latest — update latest tap info
router.put('/user/:userId/latest', async function (req, res) {
    try {
        var data = req.body;
        if (data.ts && data.ts['.sv'] === 'timestamp') data.ts = Date.now();

        await db.query(
            'INSERT INTO latest_tap (user_id, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = NOW()',
            [req.params.userId, JSON.stringify(data)]
        );

        // Publish SSE event for admin's tap listener
        sse.publish('latest:' + req.params.userId, data);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update latest' });
    }
});

// POST /api/public/user/:userId/leads — submit lead
router.post('/user/:userId/leads', async function (req, res) {
    try {
        // Check lead limit for free users
        var allowed = await checkLeadLimit(req.params.userId);
        if (!allowed) {
            return res.status(403).json({ error: 'lead_limit', message: 'Monthly lead limit reached (25/25). Upgrade to capture unlimited leads.' });
        }

        var leadId = req.body.id || (Date.now().toString(36) + Math.random().toString(36).substr(2, 5));
        var data = req.body.data || req.body;
        if (data.ts && data.ts['.sv'] === 'timestamp') data.ts = Date.now();
        // Remove the 'id' from data if it was used as the lead ID
        delete data.id;

        await db.query(
            'INSERT INTO leads (user_id, id, data, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id, id) DO UPDATE SET data = $3, updated_at = NOW()',
            [req.params.userId, leadId, JSON.stringify(data)]
        );

        // Publish SSE event for admin's lead listener
        sse.publish('lead:' + req.params.userId + ':' + leadId, data);
        sse.publish('leads:' + req.params.userId, { id: leadId, data: data });

        res.json({ success: true, id: leadId });

        // Push notification in background
        sendPush(req.params.userId, { title: 'New Lead Captured!', body: (data.name || 'Someone') + ' submitted their contact info' });

        // Send lead notification email in background
        db.query('SELECT email FROM users WHERE id = $1', [req.params.userId])
            .then(function (userResult) {
                if (userResult.rows.length > 0) {
                    sendLeadNotification(userResult.rows[0].email, data).catch(function () {});
                }
            }).catch(function () {});
    } catch (err) {
        console.error('Submit lead error:', err);
        res.status(500).json({ error: 'Failed to submit lead' });
    }
});

// PUT /api/public/user/:userId/leads/:leadId — update specific lead field
router.put('/user/:userId/leads/:leadId', async function (req, res) {
    try {
        // Check lead limit (PUT can create new leads via upsert)
        var allowed = await checkLeadLimit(req.params.userId);
        if (!allowed) {
            return res.status(403).json({ error: 'lead_limit', message: 'Monthly lead limit reached (25/25). Upgrade to capture unlimited leads.' });
        }

        var data = req.body;
        if (data.ts && data.ts['.sv'] === 'timestamp') data.ts = Date.now();

        await db.query(
            'INSERT INTO leads (user_id, id, data, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id, id) DO UPDATE SET data = $3, updated_at = NOW()',
            [req.params.userId, req.params.leadId, JSON.stringify(data)]
        );

        sse.publish('lead:' + req.params.userId + ':' + req.params.leadId, data);
        sse.publish('leads:' + req.params.userId, { id: req.params.leadId, data: data });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update lead' });
    }
});

// PATCH /api/public/user/:userId/leads/:leadId — partial update lead
router.patch('/user/:userId/leads/:leadId', async function (req, res) {
    try {
        // Check lead limit (PATCH can create new leads via upsert)
        var allowed = await checkLeadLimit(req.params.userId);
        if (!allowed) {
            return res.status(403).json({ error: 'lead_limit', message: 'Monthly lead limit reached (25/25). Upgrade to capture unlimited leads.' });
        }

        var result = await db.query('SELECT data FROM leads WHERE user_id = $1 AND id = $2', [req.params.userId, req.params.leadId]);
        var existing = result.rows.length > 0 ? result.rows[0].data : {};
        var data = Object.assign({}, existing, req.body);

        await db.query(
            'INSERT INTO leads (user_id, id, data, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id, id) DO UPDATE SET data = $3, updated_at = NOW()',
            [req.params.userId, req.params.leadId, JSON.stringify(data)]
        );

        sse.publish('lead:' + req.params.userId + ':' + req.params.leadId, data);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update lead' });
    }
});

// POST /api/public/user/:userId/analytics/:cardId/:metric — increment counter
router.post('/user/:userId/analytics/:cardId/:metric', async function (req, res) {
    try {
        var entry = req.body;
        if (entry.ts && entry.ts['.sv'] === 'timestamp') entry.ts = Date.now();

        // Append event to analytics data array
        await db.query(
            `INSERT INTO analytics (user_id, card_id, metric, data)
             VALUES ($1, $2, $3, $4::jsonb)
             ON CONFLICT (user_id, card_id, metric)
             DO UPDATE SET data = analytics.data || $4::jsonb`,
            [req.params.userId, req.params.cardId, req.params.metric, JSON.stringify([entry])]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Analytics error:', err);
        res.status(500).json({ error: 'Failed to record analytics' });
    }
});

// POST /api/public/waitlist — add email to waitlist
router.post('/waitlist', async function (req, res) {
    try {
        var email = req.body.email;
        if (!email) return res.status(400).json({ error: 'Email required' });
        await db.query('INSERT INTO waitlist (email) VALUES ($1)', [email]);
        res.json({ success: true });

        // Send waitlist confirmation in background
        sendWaitlistConfirmation(email).catch(function () {});
    } catch (err) {
        res.status(500).json({ error: 'Failed to join waitlist' });
    }
});

// SSE: /api/public/sse/latest/:userId — visitor waiting screen
router.get('/sse/latest/:userId', function (req, res) {
    sse.setupSSE(res);
    sse.subscribe('latest:' + req.params.userId, res);
});

// SSE: /api/public/sse/tap/:userId/:tapId — visitor listening for card selection
router.get('/sse/tap/:userId/:tapId', function (req, res) {
    sse.setupSSE(res);
    sse.subscribe('tap:' + req.params.userId + ':' + req.params.tapId, res);
});

// SSE: /api/public/sse/lead/:userId/:leadId — admin listening for lead from visitor
router.get('/sse/lead/:userId/:leadId', function (req, res) {
    sse.setupSSE(res);
    sse.subscribe('lead:' + req.params.userId + ':' + req.params.leadId, res);
});

// GET /api/public/referral/:code — validate referral code
router.get('/referral/:code', async function (req, res) {
    try {
        var result = await db.query('SELECT name FROM users WHERE referral_code = $1', [req.params.code.toUpperCase()]);
        if (result.rows.length === 0) return res.json({ valid: false });
        res.json({ valid: true, referrerName: result.rows[0].name || 'A CardFlow user' });
    } catch (err) {
        res.status(500).json({ error: 'Validation failed' });
    }
});

// GET /api/public/vapid-key — public VAPID key for push subscription
router.get('/vapid-key', function (req, res) {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

module.exports = router;
