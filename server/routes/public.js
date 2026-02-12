const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { URL } = require('url');
const dns = require('dns');
const db = require('../db');
const sse = require('../sse');
const { sendLeadNotification, sendWaitlistConfirmation, sendEventRegistration } = require('../email');
const { sendPush } = require('../push');

const router = express.Router();

// ── SSRF protection ──
function isPrivateIP(ip) {
    var parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (ip === '0.0.0.0') return true;
    return false;
}

async function validateWebhookUrl(urlStr) {
    try {
        var parsed = new URL(urlStr);
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;
        if (parsed.hostname === 'localhost') return false;
        // DNS resolve to check for private IPs
        var addresses = await new Promise(function(resolve, reject) {
            dns.resolve4(parsed.hostname, function(err, addrs) {
                if (err) reject(err); else resolve(addrs);
            });
        });
        return !addresses.some(isPrivateIP);
    } catch(e) { return false; }
}

// ── Webhook dispatch helper ──
async function dispatchWebhook(userId, leadData) {
    try {
        var result = await db.query('SELECT data FROM user_settings WHERE user_id = $1', [userId]);
        if (result.rows.length === 0) return;
        var settings = result.rows[0].data;
        if (!settings || !settings.webhookUrl) return;

        var payload = {
            event: 'new_lead',
            name: leadData.name || '',
            email: leadData.email || '',
            phone: leadData.phone || '',
            company: leadData.company || '',
            source: leadData.source || 'unknown',
            card: leadData.card || '',
            timestamp: new Date().toISOString()
        };

        // SSRF protection: validate webhook URL before fetching
        var urlSafe = await validateWebhookUrl(settings.webhookUrl);
        if (!urlSafe) {
            console.error('Webhook URL blocked (SSRF protection) for user ' + userId + ':', settings.webhookUrl);
            return;
        }

        var controller = new AbortController();
        var timeout = setTimeout(function () { controller.abort(); }, 10000);

        fetch(settings.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'CardFlow-Webhook/1.0' },
            body: JSON.stringify(payload),
            signal: controller.signal
        }).then(function (res) {
            clearTimeout(timeout);
            // Consume response body to free resources
            return res.text();
        }).then(function () {}).catch(function (err) {
            clearTimeout(timeout);
            console.error('Webhook dispatch failed for user ' + userId + ':', err.message);
        });
    } catch (err) {
        console.error('Webhook lookup failed:', err.message);
    }
}

var visitorLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, try again later' }
});

var publicWriteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: 'Too many requests' },
    standardHeaders: true,
    legacyHeaders: false
});

const RESERVED_USERNAMES = [
    'admin','login','signup','pricing','landing','api','www','app',
    'help','support','billing','settings','dashboard','account',
    'cards','leads','analytics','nfc','qr','public','static','assets',
    'sw','manifest','icons','favicon','robots','sitemap','functions',
    'reset','password','reset-password','terms','privacy','cookies',
    'refund','disclaimer','about','contact','blog','news','status',
    'events','e','booth','booth-setup','badge','exhibitor'
];

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
        var uname = req.params.username.toLowerCase();
        if (RESERVED_USERNAMES.includes(uname)) {
            return res.json({ available: false });
        }
        var result = await db.query('SELECT id FROM users WHERE username = $1', [uname]);
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
router.post('/user/:userId/taps', publicWriteLimiter, async function (req, res) {
    try {
        var tapId = req.body.id || (Date.now().toString(36) + Math.random().toString(36).substr(2, 5));
        var data = req.body.data || req.body;
        // Add server timestamp
        if (data.ts && data.ts['.sv'] === 'timestamp') data.ts = Date.now();

        // Extract visitor_id for column storage
        var visitorId = req.body.visitorId || data.visitorId || null;
        if (visitorId && !UUID_RE.test(visitorId)) visitorId = null;
        delete data.visitorId;

        await db.query(
            'INSERT INTO taps (user_id, id, data, visitor_id) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, id) DO UPDATE SET data = $3, visitor_id = COALESCE($4, taps.visitor_id)',
            [req.params.userId, tapId, JSON.stringify(data), visitorId]
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
router.patch('/user/:userId/taps/:tapId', publicWriteLimiter, async function (req, res) {
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
router.put('/user/:userId/latest', publicWriteLimiter, async function (req, res) {
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
router.post('/user/:userId/leads', publicWriteLimiter, async function (req, res) {
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

        // Extract visitor_id for column storage
        var visitorId = req.body.visitorId || data.visitorId || null;
        if (visitorId && !UUID_RE.test(visitorId)) visitorId = null;
        delete data.visitorId;

        await db.query(
            'INSERT INTO leads (user_id, id, data, visitor_id, updated_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (user_id, id) DO UPDATE SET data = $3, visitor_id = COALESCE($4, leads.visitor_id), updated_at = NOW()',
            [req.params.userId, leadId, JSON.stringify(data), visitorId]
        );

        // Publish SSE event — public channel gets non-sensitive fields only
        var publicLeadData = { name: data.name || '', cardName: data.card || '' };
        sse.publish('lead:' + req.params.userId + ':' + leadId, publicLeadData);
        sse.publish('leads:' + req.params.userId, { id: leadId, data: data });

        res.json({ success: true, id: leadId });

        // Push notification in background
        sendPush(req.params.userId, { title: 'New Lead Captured!', body: (data.name || 'Someone') + ' submitted their contact info' });

        // Webhook dispatch in background
        dispatchWebhook(req.params.userId, data);

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
router.put('/user/:userId/leads/:leadId', publicWriteLimiter, async function (req, res) {
    try {
        // Check lead limit (PUT can create new leads via upsert)
        var allowed = await checkLeadLimit(req.params.userId);
        if (!allowed) {
            return res.status(403).json({ error: 'lead_limit', message: 'Monthly lead limit reached (25/25). Upgrade to capture unlimited leads.' });
        }

        var data = req.body;
        if (data.ts && data.ts['.sv'] === 'timestamp') data.ts = Date.now();

        // Extract visitor_id for column storage
        var visitorId = data.visitorId || null;
        if (visitorId && !UUID_RE.test(visitorId)) visitorId = null;
        delete data.visitorId;

        await db.query(
            'INSERT INTO leads (user_id, id, data, visitor_id, updated_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (user_id, id) DO UPDATE SET data = $3, visitor_id = COALESCE($4, leads.visitor_id), updated_at = NOW()',
            [req.params.userId, req.params.leadId, JSON.stringify(data), visitorId]
        );

        // Public channel gets non-sensitive fields only
        var publicLeadData2 = { name: data.name || '', cardName: data.card || '' };
        sse.publish('lead:' + req.params.userId + ':' + req.params.leadId, publicLeadData2);
        sse.publish('leads:' + req.params.userId, { id: req.params.leadId, data: data });

        res.json({ success: true });

        // Webhook dispatch in background (only if it has name/email/phone — real lead data)
        if (data.name || data.email || data.phone) {
            dispatchWebhook(req.params.userId, data);
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to update lead' });
    }
});

// PATCH /api/public/user/:userId/leads/:leadId — partial update lead
router.patch('/user/:userId/leads/:leadId', publicWriteLimiter, async function (req, res) {
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

        // Public channel gets non-sensitive fields only
        var publicLeadData3 = { name: data.name || '', cardName: data.card || '' };
        sse.publish('lead:' + req.params.userId + ':' + req.params.leadId, publicLeadData3);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update lead' });
    }
});

// POST /api/public/user/:userId/analytics/:cardId/:metric — increment counter
router.post('/user/:userId/analytics/:cardId/:metric', publicWriteLimiter, async function (req, res) {
    try {
        var entry = req.body;
        if (entry.ts && entry.ts['.sv'] === 'timestamp') entry.ts = Date.now();

        // Append event to analytics data array (capped at 1000 entries)
        await db.query(
            `INSERT INTO analytics (user_id, card_id, metric, data)
             VALUES ($1, $2, $3, $4::jsonb)
             ON CONFLICT (user_id, card_id, metric)
             DO UPDATE SET data = (
                 CASE WHEN jsonb_array_length(analytics.data) >= 1000
                 THEN analytics.data #- '{0}' || $4::jsonb
                 ELSE analytics.data || $4::jsonb END
             )`,
            [req.params.userId, req.params.cardId, req.params.metric, JSON.stringify([entry])]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Analytics error:', err);
        res.status(500).json({ error: 'Failed to record analytics' });
    }
});

// GET /api/public/user/:userId/analytics/:cardId/:metric/count — get event count
router.get('/user/:userId/analytics/:cardId/:metric/count', async function (req, res) {
    try {
        var result = await db.query(
            `SELECT jsonb_array_length(data) as count FROM analytics WHERE user_id = $1 AND card_id = $2 AND metric = $3`,
            [req.params.userId, req.params.cardId, req.params.metric]
        );
        var count = (result.rows.length > 0 && result.rows[0].count) ? result.rows[0].count : 0;
        res.json({ count: count });
    } catch (err) {
        res.json({ count: 0 });
    }
});

// POST /api/public/waitlist — add email to waitlist
router.post('/waitlist', async function (req, res) {
    try {
        var waitlistEmail = (req.body.email || '').trim().toLowerCase();
        if (!waitlistEmail) return res.status(400).json({ error: 'Email required' });
        var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(waitlistEmail)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
        await db.query('INSERT INTO waitlist (email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [waitlistEmail]);
        res.json({ success: true });

        // Send waitlist confirmation in background
        sendWaitlistConfirmation(waitlistEmail).catch(function () {});
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

// ── Visitor identity ──

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/public/visitors — register or update visitor
router.post('/visitors', visitorLimiter, async function (req, res) {
    try {
        var visitorId = req.body.visitorId;
        var device = (req.body.device || '').substring(0, 20);
        var browser = (req.body.browser || '').substring(0, 20);

        if (visitorId && UUID_RE.test(visitorId)) {
            // Try to update existing visitor
            var result = await db.query(
                'UPDATE visitors SET last_seen = NOW(), total_visits = total_visits + 1 WHERE id = $1 RETURNING id',
                [visitorId]
            );
            if (result.rows.length > 0) {
                return res.json({ visitorId: result.rows[0].id });
            }
        }

        // Create new visitor
        var ins = await db.query(
            'INSERT INTO visitors (device, browser) VALUES ($1, $2) RETURNING id',
            [device, browser]
        );
        res.json({ visitorId: ins.rows[0].id });
    } catch (err) {
        console.error('Visitor register error:', err);
        res.status(500).json({ error: 'Failed to register visitor' });
    }
});

// PATCH /api/public/visitors/:visitorId/viewed — record card view
router.patch('/visitors/:visitorId/viewed', visitorLimiter, async function (req, res) {
    try {
        var visitorId = req.params.visitorId;
        if (!UUID_RE.test(visitorId)) return res.status(400).json({ error: 'Invalid visitor ID' });

        var ownerId = req.body.ownerId;
        var cardId = req.body.cardId;
        if (!ownerId || !cardId) return res.status(400).json({ error: 'ownerId and cardId required' });

        var entry = JSON.stringify({ ownerId: ownerId, cardId: cardId, ts: Date.now() });
        await db.query(
            "UPDATE visitors SET cards_viewed = cards_viewed || $1::jsonb, last_seen = NOW() WHERE id = $2",
            ['[' + entry + ']', visitorId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Visitor viewed error:', err);
        res.status(500).json({ error: 'Failed to record view' });
    }
});

// POST /api/public/exchange — submit card exchange (authenticated via body token)
router.post('/exchange', visitorLimiter, async function (req, res) {
    try {
        var token = req.body.token;
        if (!token) return res.status(401).json({ error: 'Token required' });

        var decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (e) {
            return res.status(401).json({ error: 'Invalid token' });
        }
        var senderUserId = decoded.uid;
        var senderCardId = req.body.senderCardId;
        var recipientUserId = req.body.recipientUserId;
        var recipientCardId = req.body.recipientCardId || null;
        var exchangeVisitorId = req.body.visitorId || null;

        if (!senderCardId || !recipientUserId) {
            return res.status(400).json({ error: 'senderCardId and recipientUserId required' });
        }
        if (senderUserId === recipientUserId) {
            return res.status(400).json({ error: 'Cannot exchange with yourself' });
        }

        // Verify sender owns the card
        var cardCheck = await db.query('SELECT id FROM cards WHERE user_id = $1 AND id = $2', [senderUserId, senderCardId]);
        if (cardCheck.rows.length === 0) {
            return res.status(400).json({ error: 'Card not found' });
        }

        // Validate visitor ID
        if (exchangeVisitorId && !UUID_RE.test(exchangeVisitorId)) exchangeVisitorId = null;

        // Check for duplicate exchange (same sender → same recipient, last 24h)
        var dupCheck = await db.query(
            "SELECT id FROM card_exchanges WHERE sender_user_id = $1 AND recipient_user_id = $2 AND created_at > NOW() - INTERVAL '24 hours'",
            [senderUserId, recipientUserId]
        );
        if (dupCheck.rows.length > 0) {
            return res.json({ success: true, message: 'Already exchanged' });
        }

        // Insert exchange
        await db.query(
            'INSERT INTO card_exchanges (sender_user_id, sender_card_id, recipient_user_id, recipient_card_id, visitor_id) VALUES ($1, $2, $3, $4, $5)',
            [senderUserId, senderCardId, recipientUserId, recipientCardId, exchangeVisitorId]
        );

        // Get sender info for lead
        var senderInfo = await db.query('SELECT name, username, email FROM users WHERE id = $1', [senderUserId]);
        var sender = senderInfo.rows[0] || {};

        // Get sender card data for lead details
        var senderCardData = await db.query('SELECT data FROM cards WHERE user_id = $1 AND id = $2', [senderUserId, senderCardId]);
        var senderCard = senderCardData.rows.length > 0 ? senderCardData.rows[0].data : {};

        // Create a lead for the recipient with type: card_exchange
        var leadId = 'ex_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        var leadData = {
            type: 'card_exchange',
            name: senderCard.name || sender.name || '',
            email: senderCard.email || sender.email || '',
            phone: senderCard.phone || '',
            company: senderCard.company || '',
            ts: Date.now(),
            source: 'exchange',
            card: recipientCardId || '',
            exchangerUsername: sender.username || '',
            exchangerCardId: senderCardId,
            exchangerUserId: senderUserId,
            visitor: { device: '', browser: '' }
        };

        await db.query(
            'INSERT INTO leads (user_id, id, data, visitor_id, updated_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (user_id, id) DO UPDATE SET data = $3, updated_at = NOW()',
            [recipientUserId, leadId, JSON.stringify(leadData), exchangeVisitorId]
        );

        // SSE + push notification
        sse.publish('leads:' + recipientUserId, { id: leadId, data: leadData });
        sendPush(recipientUserId, {
            title: 'Card Exchange!',
            body: (sender.name || 'Someone') + ' exchanged their card with you'
        });

        res.json({ success: true });
    } catch (err) {
        console.error('Exchange error:', err);
        res.status(500).json({ error: 'Exchange failed' });
    }
});

// GET /api/public/vapid-key — public VAPID key for push subscription
router.get('/vapid-key', function (req, res) {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

// ── Public Event Routes ──

// GET /api/public/event/:slug — public event info
router.get('/event/:slug', async function (req, res) {
    try {
        var result = await db.query(
            `SELECT id, slug, name, description, venue, address, city, start_date, end_date,
                    logo, cover_image, branding, categories, floor_plan_image, settings, status,
                    (SELECT COUNT(*) FROM event_exhibitors WHERE event_id = events.id AND status = 'approved') as exhibitor_count,
                    (SELECT COUNT(*) FROM event_attendees WHERE event_id = events.id) as attendee_count
             FROM events WHERE slug = $1 AND status IN ('published', 'live', 'completed')`,
            [req.params.slug]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Public event error:', err);
        res.status(500).json({ error: 'Failed to load event' });
    }
});

// GET /api/public/event/:slug/exhibitors — public exhibitor list
router.get('/event/:slug/exhibitors', async function (req, res) {
    try {
        var event = await db.query("SELECT id FROM events WHERE slug = $1 AND status IN ('published', 'live', 'completed')", [req.params.slug]);
        if (event.rows.length === 0) return res.status(404).json({ error: 'Event not found' });

        var result = await db.query(
            `SELECT ex.id, ex.booth_number, ex.booth_size, ex.category, ex.company_name,
                    ex.company_description, ex.products, ex.logo, ex.website, ex.brochure_url,
                    u.username, u.photo as user_photo
             FROM event_exhibitors ex
             JOIN users u ON u.id = ex.user_id
             WHERE ex.event_id = $1 AND ex.status = 'approved'
             ORDER BY ex.booth_number, ex.company_name`,
            [event.rows[0].id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Public exhibitors error:', err);
        res.status(500).json({ error: 'Failed to load exhibitors' });
    }
});

// POST /api/public/event/:slug/register — attendee registration
router.post('/event/:slug/register', visitorLimiter, async function (req, res) {
    try {
        var event = await db.query(
            "SELECT id, slug, name, settings FROM events WHERE slug = $1 AND status IN ('published', 'live')",
            [req.params.slug]
        );
        if (event.rows.length === 0) return res.status(404).json({ error: 'Event not found or registration closed' });
        var ev = event.rows[0];

        var b = req.body;
        if (!b.name) return res.status(400).json({ error: 'Name is required' });
        if (!b.email) return res.status(400).json({ error: 'Email is required' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email.trim())) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        // Generate unique badge code with retry on unique constraint violation
        var badgeCode;
        var result;
        var maxBadgeRetries = 10;

        for (var badgeAttempt = 0; badgeAttempt < maxBadgeRetries; badgeAttempt++) {
            badgeCode = '';
            var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 for readability
            for (var i = 0; i < 8; i++) badgeCode += chars.charAt(Math.floor(Math.random() * chars.length));

            try {
                result = await db.query(
                    `INSERT INTO event_attendees (event_id, name, email, phone, company, title, badge_code, data)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     RETURNING *`,
                    [
                        ev.id, b.name, b.email.toLowerCase().trim(), b.phone || null,
                        b.company || null, b.title || null, badgeCode,
                        JSON.stringify(b.data || {})
                    ]
                );
                break; // Insert succeeded
            } catch (insertErr) {
                // 23505 = unique_violation on badge_code — retry with new code
                if (insertErr.code === '23505' && insertErr.constraint && insertErr.constraint.includes('badge_code')) {
                    continue;
                }
                throw insertErr; // Re-throw other errors (e.g., duplicate email)
            }
        }
        if (!result) return res.status(500).json({ error: 'Failed to generate unique badge code' });

        // Send registration confirmation email (background)
        var baseUrl = process.env.BASE_URL || 'https://card.cardflow.cloud';
        var badgeUrl = baseUrl + '/e/' + ev.slug + '/b/' + badgeCode;
        sendEventRegistration(b.email.toLowerCase().trim(), b.name, ev.name, badgeUrl).catch(function(e) {
            console.error('Registration email error:', e.message);
        });

        res.status(201).json({
            attendee: result.rows[0],
            badge_url: '/e/' + ev.slug + '/b/' + badgeCode
        });
    } catch (err) {
        if (err.code === '23505') { // unique constraint violation
            return res.status(409).json({ error: 'Already registered with this email' });
        }
        console.error('Register attendee error:', err);
        res.status(500).json({ error: 'Failed to register' });
    }
});

// BADGE LOOKUP MOVED to /api/exhibitor/badge/:code (exhibitor.js) — requires auth
// Public endpoint only returns name and company (no PII)
router.get('/badge/:code', async function (req, res) {
    try {
        var result = await db.query(
            `SELECT ea.name, ea.company, ea.badge_code, ea.event_id,
                    e.name as event_name, e.slug as event_slug
             FROM event_attendees ea
             JOIN events e ON e.id = ea.event_id
             WHERE ea.badge_code = $1`,
            [req.params.code.toUpperCase()]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Badge not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Badge lookup error:', err);
        res.status(500).json({ error: 'Failed to look up badge' });
    }
});

// CHECK-IN MOVED to /api/events/:id/checkin (events.js) — requires organizer auth

module.exports = router;
