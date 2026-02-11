const express = require('express');
const db = require('../db');
const { verifyAuth } = require('../auth');

const router = express.Router();
router.use(verifyAuth);

// GET /api/cards — all cards
router.get('/', async function (req, res) {
    try {
        var result = await db.query('SELECT id, data FROM cards WHERE user_id = $1', [req.user.uid]);
        var cards = {};
        result.rows.forEach(function (row) {
            cards[row.id] = row.data;
        });
        res.json(cards);
    } catch (err) {
        console.error('Get cards error:', err);
        res.status(500).json({ error: 'Failed to load cards' });
    }
});

// GET /api/cards/:id
router.get('/:id', async function (req, res) {
    try {
        var result = await db.query('SELECT data FROM cards WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Card not found' });
        res.json(result.rows[0].data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load card' });
    }
});

// PUT /api/cards/:id — create or replace card
router.put('/:id', async function (req, res) {
    try {
        var data = req.body;

        // Check if this is a new card (not an update to existing)
        var existingCard = await db.query('SELECT id FROM cards WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
        if (existingCard.rows.length === 0) {
            // New card — enforce plan limits
            var countResult = await db.query('SELECT COUNT(*) FROM cards WHERE user_id = $1', [req.user.uid]);
            var cardCount = parseInt(countResult.rows[0].count) || 0;

            var userResult = await db.query('SELECT plan FROM users WHERE id = $1', [req.user.uid]);
            var plan = userResult.rows.length > 0 ? userResult.rows[0].plan : 'free';
            var PLAN_LIMITS = { free: 1, pro: 5, business: 20 };
            var maxCards = PLAN_LIMITS[plan] || 1;

            if (cardCount >= maxCards) {
                return res.status(403).json({ error: 'Card limit reached for your plan' });
            }
        }

        await db.query(
            'INSERT INTO cards (user_id, id, data, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id, id) DO UPDATE SET data = $3, updated_at = NOW()',
            [req.user.uid, req.params.id, JSON.stringify(data)]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Put card error:', err);
        res.status(500).json({ error: 'Failed to save card' });
    }
});

// PATCH /api/cards/:id — partial update
router.patch('/:id', async function (req, res) {
    try {
        var result = await db.query('SELECT data FROM cards WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Card not found' });
        var data = Object.assign({}, result.rows[0].data, req.body);
        await db.query('UPDATE cards SET data = $1, updated_at = NOW() WHERE user_id = $2 AND id = $3', [JSON.stringify(data), req.user.uid, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update card' });
    }
});

// DELETE /api/cards/:id
router.delete('/:id', async function (req, res) {
    try {
        await db.query('DELETE FROM cards WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete card' });
    }
});

module.exports = router;
