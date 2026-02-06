const express = require('express');
const db = require('../db');
const { verifyAuth } = require('../auth');

const router = express.Router();
router.use(verifyAuth);

// GET /api/analytics — all analytics for user
router.get('/', async function (req, res) {
    try {
        var result = await db.query('SELECT card_id, metric, data FROM analytics WHERE user_id = $1', [req.user.uid]);
        var analytics = {};
        result.rows.forEach(function (row) {
            if (!analytics[row.card_id]) analytics[row.card_id] = {};
            analytics[row.card_id][row.metric] = row.data;
        });
        res.json(analytics);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load analytics' });
    }
});

module.exports = router;
