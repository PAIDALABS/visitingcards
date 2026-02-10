const express = require('express');
const db = require('../db');
const { verifyAuth } = require('../auth');

const router = express.Router();
router.use(verifyAuth);

// GET /api/exchanges — all exchanges for logged-in user
router.get('/', async function (req, res) {
    try {
        var uid = req.user.uid;
        // Received exchanges (where current user is recipient)
        var received = await db.query(
            `SELECT e.id, e.sender_user_id, e.sender_card_id, e.recipient_card_id, e.status, e.created_at,
                    u.name AS sender_name, u.username AS sender_username
             FROM card_exchanges e
             JOIN users u ON u.id = e.sender_user_id
             WHERE e.recipient_user_id = $1
             ORDER BY e.created_at DESC`,
            [uid]
        );
        // Sent exchanges (where current user is sender)
        var sent = await db.query(
            `SELECT e.id, e.recipient_user_id, e.sender_card_id, e.recipient_card_id, e.status, e.created_at,
                    u.name AS recipient_name, u.username AS recipient_username
             FROM card_exchanges e
             JOIN users u ON u.id = e.recipient_user_id
             WHERE e.sender_user_id = $1
             ORDER BY e.created_at DESC`,
            [uid]
        );
        res.json({ received: received.rows, sent: sent.rows });
    } catch (err) {
        console.error('Exchanges list error:', err);
        res.status(500).json({ error: 'Failed to load exchanges' });
    }
});

module.exports = router;
