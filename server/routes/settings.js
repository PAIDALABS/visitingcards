const express = require('express');
const db = require('../db');
const { verifyAuth } = require('../auth');

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
            updates.push('data = $' + idx++);
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
    try {
        var token = req.body.token;
        // Prevent NFC token hijacking
        if (token) {
            var existing = await db.query('SELECT user_id FROM nfc_tokens WHERE token = $1', [token]);
            if (existing.rows.length > 0 && existing.rows[0].user_id !== req.user.uid) {
                return res.status(409).json({ error: 'This NFC token is already claimed by another user' });
            }
        }
        // Update settings
        await db.query(
            'INSERT INTO user_settings (user_id, nfc_token) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET nfc_token = $2',
            [req.user.uid, token]
        );
        // Update public NFC lookup
        if (token) {
            // Remove any old token for this user
            await db.query('DELETE FROM public_nfc_tokens WHERE user_id = $1', [req.user.uid]);
            await db.query(
                'INSERT INTO public_nfc_tokens (token, user_id) VALUES ($1, $2) ON CONFLICT (token) DO UPDATE SET user_id = $2',
                [token, req.user.uid]
            );
        } else {
            await db.query('DELETE FROM public_nfc_tokens WHERE user_id = $1', [req.user.uid]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to set NFC token' });
    }
});

module.exports = router;
