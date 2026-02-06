const express = require('express');
const db = require('../db');
const { verifyAuth } = require('../auth');

const router = express.Router();
router.use(verifyAuth);

// GET /api/leads/month-count — count leads this month (for limit display)
router.get('/month-count', async function (req, res) {
    try {
        var startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);
        var result = await db.query(
            'SELECT COUNT(*) as cnt FROM leads WHERE user_id = $1 AND updated_at >= $2',
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
        var result = await db.query('SELECT id, data FROM leads WHERE user_id = $1', [req.user.uid]);
        var leads = {};
        result.rows.forEach(function (row) {
            leads[row.id] = row.data;
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
        var result = await db.query('SELECT data FROM leads WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Lead not found' });
        var data = Object.assign({}, result.rows[0].data, req.body);
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
