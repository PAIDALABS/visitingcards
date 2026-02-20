const express = require('express');
const db = require('../db');
const { verifyAuth, requireNotSuspended } = require('../auth');

const router = express.Router();
router.use(verifyAuth);
router.use(requireNotSuspended);

var MAX_LEAD_DATA_SIZE = 50 * 1024;

// Check lead limit for free users (25/month)
async function checkLeadLimit(userId) {
    var userResult = await db.query('SELECT plan FROM users WHERE id = $1', [userId]);
    var plan = (userResult.rows.length > 0 && userResult.rows[0].plan) || 'free';
    if (plan !== 'free') return true;
    var startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    var countResult = await db.query(
        'SELECT COUNT(*) as cnt FROM leads WHERE user_id = $1 AND created_at >= $2',
        [userId, startOfMonth]
    );
    return parseInt(countResult.rows[0].cnt, 10) < 25;
}

// GET /api/leads/month-count — count leads this month (for limit display)
router.get('/month-count', async function (req, res) {
    try {
        var startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);
        var result = await db.query(
            'SELECT COUNT(*) as cnt FROM leads WHERE user_id = $1 AND created_at >= $2',
            [req.user.uid, startOfMonth]
        );
        res.json({ count: parseInt(result.rows[0].cnt, 10) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to count leads' });
    }
});

// GET /api/leads
router.get('/', async function (req, res) {
    try {
        var result = await db.query('SELECT id, data, visitor_id FROM leads WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5000', [req.user.uid]);
        var leads = {};
        result.rows.forEach(function (row) {
            var d = row.data;
            if (row.visitor_id) d._visitorId = row.visitor_id;
            leads[row.id] = d;
        });
        res.json(leads);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load leads' });
    }
});

// GET /api/leads/:id
router.get('/:id', async function (req, res) {
    try {
        var result = await db.query('SELECT data FROM leads WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Lead not found' });
        res.json(result.rows[0].data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load lead' });
    }
});

// PUT /api/leads/:id
router.put('/:id', async function (req, res) {
    try {
        if (req.params.id.length > 128) return res.status(400).json({ error: 'Lead ID too long' });
        if (JSON.stringify(req.body).length > MAX_LEAD_DATA_SIZE) {
            return res.status(400).json({ error: 'Lead data too large (max 50KB)' });
        }
        // Check if this is a new lead (INSERT) — enforce limit for free users
        var existing = await db.query('SELECT id FROM leads WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
        if (existing.rows.length === 0) {
            var allowed = await checkLeadLimit(req.user.uid);
            if (!allowed) {
                return res.status(403).json({ error: 'lead_limit', message: 'Monthly lead limit reached (25/25). Upgrade to capture unlimited leads.' });
            }
        }
        await db.query(
            'INSERT INTO leads (user_id, id, data, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id, id) DO UPDATE SET data = $3, updated_at = NOW()',
            [req.user.uid, req.params.id, JSON.stringify(req.body)]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save lead' });
    }
});

// PATCH /api/leads/:id
router.patch('/:id', async function (req, res) {
    try {
        if (req.params.id.length > 128) return res.status(400).json({ error: 'Lead ID too long' });
        if (JSON.stringify(req.body).length > MAX_LEAD_DATA_SIZE) {
            return res.status(400).json({ error: 'Lead data too large (max 50KB)' });
        }
        var result = await db.query('SELECT data FROM leads WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Lead not found' });
        var body = req.body; delete body.__proto__; delete body.constructor; delete body.prototype;
        var data = Object.assign({}, result.rows[0].data, body);
        if (JSON.stringify(data).length > MAX_LEAD_DATA_SIZE) {
            return res.status(400).json({ error: 'Lead data too large (max 50KB)' });
        }
        await db.query('UPDATE leads SET data = $1, updated_at = NOW() WHERE user_id = $2 AND id = $3', [JSON.stringify(data), req.user.uid, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update lead' });
    }
});

// DELETE /api/leads/:id
router.delete('/:id', async function (req, res) {
    try {
        await db.query('DELETE FROM leads WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete lead' });
    }
});

module.exports = router;
