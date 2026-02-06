const express = require('express');
const db = require('../db');
const { verifyAuth } = require('../auth');

const router = express.Router();
router.use(verifyAuth);

// GET /api/taps
router.get('/', async function (req, res) {
    try {
        var result = await db.query('SELECT id, data FROM taps WHERE user_id = $1', [req.user.uid]);
        var taps = {};
        result.rows.forEach(function (row) {
            taps[row.id] = row.data;
        });
        res.json(taps);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load taps' });
    }
});

// GET /api/taps/:id
router.get('/:id', async function (req, res) {
    try {
        var result = await db.query('SELECT data FROM taps WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Tap not found' });
        res.json(result.rows[0].data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load tap' });
    }
});

// PATCH /api/taps/:id
router.patch('/:id', async function (req, res) {
    try {
        var result = await db.query('SELECT data FROM taps WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Tap not found' });
        var data = Object.assign({}, result.rows[0].data, req.body);
        await db.query('UPDATE taps SET data = $1 WHERE user_id = $2 AND id = $3', [JSON.stringify(data), req.user.uid, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update tap' });
    }
});

module.exports = router;
