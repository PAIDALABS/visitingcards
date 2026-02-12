const express = require('express');
const { URL } = require('url');
const dns = require('dns');
const db = require('../db');
const { verifyAuth } = require('../auth');

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
        var addresses = await new Promise(function(resolve, reject) {
            dns.resolve4(parsed.hostname, function(err, addrs) {
                if (err) reject(err); else resolve(addrs);
            });
        });
        return !addresses.some(isPrivateIP);
    } catch(e) { return false; }
}

const router = express.Router();
router.use(verifyAuth);

// GET /api/settings
router.get('/', async function (req, res) {
    try {
        var result = await db.query('SELECT * FROM user_settings WHERE user_id = $1', [req.user.uid]);
        if (result.rows.length === 0) {
            // Create default settings
            await db.query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [req.user.uid]);
            return res.json({ defaultCard: null, nfc_token: null, data: {} });
        }
        var row = result.rows[0];
        res.json({
            defaultCard: row.default_card,
            nfc_token: row.nfc_token,
            push_subscription: row.push_subscription,
            data: row.data
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

// PATCH /api/settings
router.patch('/', async function (req, res) {
    try {
        var updates = [];
        var values = [];
        var idx = 1;

        if (req.body.defaultCard !== undefined) {
            updates.push('default_card = $' + idx++);
            values.push(req.body.defaultCard);
        }
        if (req.body.push_subscription !== undefined) {
            updates.push('push_subscription = $' + idx++);
            values.push(JSON.stringify(req.body.push_subscription));
        }
        if (req.body.data !== undefined) {
            updates.push('data = COALESCE(user_settings.data, \'{}\'::jsonb) || $' + idx++);
            values.push(JSON.stringify(req.body.data));
        }

        if (updates.length === 0) return res.json({ success: true });

        values.push(req.user.uid);
        await db.query(
            'INSERT INTO user_settings (user_id) VALUES ($' + idx + ') ON CONFLICT (user_id) DO UPDATE SET ' + updates.join(', '),
            values
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Settings update error:', err);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// GET /api/settings/nfc-token
router.get('/nfc-token', async function (req, res) {
    try {
        var result = await db.query('SELECT nfc_token FROM user_settings WHERE user_id = $1', [req.user.uid]);
        res.json({ token: result.rows.length > 0 ? result.rows[0].nfc_token : null });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get NFC token' });
    }
});

// PUT /api/settings/nfc-token
router.put('/nfc-token', async function (req, res) {
    var client = await db.connect();
    try {
        var token = req.body.token;
        await client.query('BEGIN');

        // Update settings
        await client.query(
            'INSERT INTO user_settings (user_id, nfc_token) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET nfc_token = $2',
            [req.user.uid, token]
        );

        // Update public NFC lookup
        if (token) {
            // Remove any old token for this user
            await client.query('DELETE FROM public_nfc_tokens WHERE user_id = $1', [req.user.uid]);
            // Insert new token — DO NOTHING if another user already owns it
            var insertResult = await client.query(
                'INSERT INTO public_nfc_tokens (token, user_id) VALUES ($1, $2) ON CONFLICT (token) DO NOTHING',
                [token, req.user.uid]
            );
            // If no row was inserted, another user owns this token
            if (insertResult.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'This NFC token is already claimed by another user' });
            }
        } else {
            await client.query('DELETE FROM public_nfc_tokens WHERE user_id = $1', [req.user.uid]);
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Failed to set NFC token' });
    } finally {
        client.release();
    }
});

// POST /api/settings/test-webhook — test a webhook URL with sample data
router.post('/test-webhook', async function (req, res) {
    var url = req.body.url;
    if (!url) return res.status(400).json({ error: 'URL required' });

    // Validate URL format
    try { new URL(url); } catch (e) { return res.status(400).json({ error: 'Invalid URL' }); }

    // SSRF protection: validate webhook URL before fetching
    var urlSafe = await validateWebhookUrl(url);
    if (!urlSafe) {
        return res.status(400).json({ error: 'URL not allowed: private/internal addresses are blocked' });
    }

    var testPayload = {
        event: 'test',
        name: 'Test Lead',
        email: 'test@example.com',
        phone: '+1234567890',
        company: 'Test Company',
        source: 'test',
        card: 'test-card',
        timestamp: new Date().toISOString(),
        message: 'This is a test webhook from CardFlow'
    };

    try {
        var controller = new AbortController();
        var timeout = setTimeout(function () { controller.abort(); }, 10000);

        var response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'CardFlow-Webhook/1.0' },
            body: JSON.stringify(testPayload),
            signal: controller.signal
        });

        clearTimeout(timeout);
        res.json({ success: response.ok, status: response.status });
    } catch (err) {
        res.json({ success: false, error: err.message || 'Connection failed' });
    }
});

module.exports = router;
