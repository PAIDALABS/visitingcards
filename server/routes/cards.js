const express = require('express');
const db = require('../db');
const { verifyAuth, requireNotSuspended } = require('../auth');

const router = express.Router();
router.use(verifyAuth);
router.use(requireNotSuspended);

// Plan card limits (shared with billing webhook)
var PLAN_LIMITS = { free: 1, pro: 5, business: -1 };

// Max card data payload size (500KB stringified)
var MAX_CARD_DATA_SIZE = 500 * 1024;

// Strip internal/dangerous fields from card data
function sanitizeCardData(data) {
    if (typeof data !== 'object' || data === null) return {};
    delete data._inactive;
    delete data.__proto__;
    delete data.constructor;
    delete data.prototype;
    return data;
}

function validateCardKeys(data) {
    return typeof data === 'object' && data !== null && Object.keys(data).length <= 100;
}

// GET /api/cards — all cards (includes active flag)
router.get('/', async function (req, res) {
    try {
        var result = await db.query('SELECT id, data, active FROM cards WHERE user_id = $1', [req.user.uid]);
        var cards = {};
        result.rows.forEach(function (row) {
            var card = row.data;
            if (!row.active) card._inactive = true;
            cards[row.id] = card;
        });
        res.json(cards);
    } catch (err) {
        console.error('Get cards error:', err);
        res.status(500).json({ error: 'Failed to load cards' });
    }
});

// Validate resource ID length (shared for cards)
function validateId(req, res) {
    if (req.params.id && req.params.id.length > 128) {
        res.status(400).json({ error: 'ID too long (max 128 chars)' });
        return false;
    }
    return true;
}

// GET /api/cards/:id
router.get('/:id', async function (req, res) {
    if (!validateId(req, res)) return;
    try {
        var result = await db.query('SELECT data, active FROM cards WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Card not found' });
        var card = result.rows[0].data;
        if (!result.rows[0].active) card._inactive = true;
        res.json(card);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load card' });
    }
});

// PUT /api/cards/:id — create or replace card
router.put('/:id', async function (req, res) {
    if (!validateId(req, res)) return;
    try {
        var data = sanitizeCardData(req.body);
        if (!validateCardKeys(data)) {
            return res.status(400).json({ error: 'Too many fields in card data (max 100)' });
        }
        var dataStr = JSON.stringify(data);
        if (dataStr.length > MAX_CARD_DATA_SIZE) {
            return res.status(400).json({ error: 'Card data too large (max 500KB)' });
        }

        // Check if this is a new card (not an update to existing)
        var existingCard = await db.query('SELECT id, active FROM cards WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);

        if (existingCard.rows.length === 0) {
            // New card — enforce plan limits with advisory lock to prevent race condition
            var client = await db.connect();
            try {
                await client.query('BEGIN');
                // Advisory lock keyed on user ID hash to serialize card creation per user
                await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [req.user.uid]);

                var countResult = await client.query('SELECT COUNT(*) FROM cards WHERE user_id = $1 AND active = true', [req.user.uid]);
                var cardCount = parseInt(countResult.rows[0].count) || 0;

                var userResult = await client.query('SELECT plan FROM users WHERE id = $1', [req.user.uid]);
                var plan = userResult.rows.length > 0 ? userResult.rows[0].plan : 'free';
                var maxCards = PLAN_LIMITS[plan] || 1;

                if (maxCards !== -1 && cardCount >= maxCards) {
                    await client.query('ROLLBACK');
                    return res.status(403).json({ error: 'Card limit reached for your plan' });
                }

                await client.query(
                    'INSERT INTO cards (user_id, id, data, updated_at) VALUES ($1, $2, $3, NOW())',
                    [req.user.uid, req.params.id, JSON.stringify(data)]
                );
                await client.query('COMMIT');
            } catch (txErr) {
                try { await client.query('ROLLBACK'); } catch (e) {}
                throw txErr;
            } finally {
                client.release();
            }
        } else {
            // Existing card — block edits to inactive cards
            if (!existingCard.rows[0].active) {
                return res.status(403).json({ error: 'This card is deactivated. Upgrade your plan to reactivate it.' });
            }
            await db.query(
                'UPDATE cards SET data = $1, updated_at = NOW() WHERE user_id = $2 AND id = $3',
                [JSON.stringify(data), req.user.uid, req.params.id]
            );
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Put card error:', err);
        res.status(500).json({ error: 'Failed to save card' });
    }
});

// PATCH /api/cards/:id — partial update
router.patch('/:id', async function (req, res) {
    if (!validateId(req, res)) return;
    try {
        var result = await db.query('SELECT data, active FROM cards WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Card not found' });
        if (!result.rows[0].active) return res.status(403).json({ error: 'This card is deactivated. Upgrade your plan to reactivate it.' });
        var data = Object.assign({}, result.rows[0].data, sanitizeCardData(req.body));
        if (!validateCardKeys(data)) {
            return res.status(400).json({ error: 'Too many fields in card data (max 100)' });
        }
        var dataStr = JSON.stringify(data);
        if (dataStr.length > MAX_CARD_DATA_SIZE) {
            return res.status(400).json({ error: 'Card data too large (max 500KB)' });
        }
        await db.query('UPDATE cards SET data = $1, updated_at = NOW() WHERE user_id = $2 AND id = $3', [JSON.stringify(data), req.user.uid, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update card' });
    }
});

// DELETE /api/cards/:id
router.delete('/:id', async function (req, res) {
    if (!validateId(req, res)) return;
    try {
        await db.query('DELETE FROM cards WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete card' });
    }
});

module.exports = router;
module.exports.PLAN_LIMITS = PLAN_LIMITS;
