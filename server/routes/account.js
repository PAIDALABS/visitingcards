const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { verifyAuth, signToken } = require('../auth');

const router = express.Router();
router.use(verifyAuth);

// PATCH /api/account/profile
router.patch('/profile', async function (req, res) {
    try {
        var updates = [];
        var values = [];
        var idx = 1;

        if (req.body.name !== undefined) {
            updates.push('name = $' + idx++);
            values.push(req.body.name);
        }
        if (req.body.phone !== undefined) {
            updates.push('phone = $' + idx++);
            values.push(req.body.phone);
        }
        if (req.body.photo !== undefined) {
            updates.push('photo = $' + idx++);
            values.push(req.body.photo);
        }

        if (updates.length === 0) return res.json({ success: true });

        updates.push('updated_at = NOW()');
        values.push(req.user.uid);
        await db.query('UPDATE users SET ' + updates.join(', ') + ' WHERE id = $' + idx, values);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

// POST /api/account/change-password
router.post('/change-password', async function (req, res) {
    try {
        var { currentPassword, newPassword } = req.body;
        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters' });
        }

        var result = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.uid]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

        var user = result.rows[0];
        if (user.password_hash) {
            if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
            var valid = await bcrypt.compare(currentPassword, user.password_hash);
            if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
        }

        var hash = await bcrypt.hash(newPassword, 10);
        await db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.user.uid]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to change password' });
    }
});

module.exports = router;
