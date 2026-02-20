const express = require('express');
const db = require('../db');
const { verifyAuth, requireNotSuspended } = require('../auth');

const router = express.Router();
router.use(verifyAuth);
router.use(requireNotSuspended);

// GET /api/exchanges — all exchanges for logged-in user
router.get('/', async function (req, res) {
    try {
        var uid = req.user.uid;
        // Received exchanges (where current user is recipient) — join sender's card for enrichment
        var received = await db.query(
            `SELECT e.id, e.sender_user_id, e.sender_card_id, e.recipient_card_id, e.status, e.created_at,
                    u.name AS sender_name, u.username AS sender_username,
                    c.data->>'company' AS sender_company, c.data->>'title' AS sender_title,
                    c.data->>'phone' AS sender_phone, c.data->>'email' AS sender_email
             FROM card_exchanges e
             JOIN users u ON u.id = e.sender_user_id
             LEFT JOIN cards c ON c.id = e.sender_card_id
             WHERE e.recipient_user_id = $1
             ORDER BY e.created_at DESC`,
            [uid]
        );
        // Sent exchanges (where current user is sender) — join recipient's card for enrichment
        var sent = await db.query(
            `SELECT e.id, e.recipient_user_id, e.sender_card_id, e.recipient_card_id, e.status, e.created_at,
                    u.name AS recipient_name, u.username AS recipient_username,
                    c.data->>'company' AS recipient_company, c.data->>'title' AS recipient_title,
                    c.data->>'phone' AS recipient_phone, c.data->>'email' AS recipient_email
             FROM card_exchanges e
             JOIN users u ON u.id = e.recipient_user_id
             LEFT JOIN cards c ON c.id = e.recipient_card_id
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
