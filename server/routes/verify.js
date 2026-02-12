const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');

var router = express.Router();

var resetPasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});

// GET /api/auth/verify-email?token=...
router.get('/verify-email', async function (req, res) {
    try {
        var token = req.query.token;
        if (!token) return res.status(400).send(resultPage(false, 'Missing verification token.'));

        var result = await db.query(
            'SELECT user_id, expires_at FROM email_verification_tokens WHERE token = $1',
            [token]
        );

        if (result.rows.length === 0) {
            return res.send(resultPage(false, 'Invalid or expired verification link.'));
        }

        var row = result.rows[0];
        if (new Date(row.expires_at) < new Date()) {
            await db.query('DELETE FROM email_verification_tokens WHERE token = $1', [token]);
            return res.send(resultPage(false, 'This verification link has expired. Please request a new one.'));
        }

        await db.query('UPDATE users SET email_verified = true, updated_at = NOW() WHERE id = $1', [row.user_id]);
        await db.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [row.user_id]);

        res.send(resultPage(true, 'Your email has been verified! You can close this page.'));
    } catch (err) {
        console.error('Verify email error:', err);
        res.status(500).send(resultPage(false, 'Something went wrong. Please try again.'));
    }
});

// POST /api/auth/reset-password
router.post('/reset-password', resetPasswordLimiter, async function (req, res) {
    try {
        var { token, password } = req.body;
        if (!token || !password) {
            return res.status(400).json({ error: 'Token and new password are required' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        if (password.length > 128) {
            return res.status(400).json({ error: 'Password must be at most 128 characters' });
        }

        var result = await db.query(
            'SELECT user_id, expires_at FROM password_reset_tokens WHERE token = $1',
            [token]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired reset token' });
        }

        var row = result.rows[0];
        if (new Date(row.expires_at) < new Date()) {
            await db.query('DELETE FROM password_reset_tokens WHERE token = $1', [token]);
            return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
        }

        var hash = await bcrypt.hash(password, 10);
        await db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, row.user_id]);
        await db.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [row.user_id]);

        res.json({ message: 'Password has been reset. You can now log in with your new password.' });
    } catch (err) {
        console.error('Reset password error:', err);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// Simple HTML result page for email verification (GET request opens in browser)
function resultPage(success, message) {
    var color = success ? '#10b981' : '#ef4444';
    var icon = success ? '&#10003;' : '&#10007;';
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>CardFlow — Email Verification</title></head>' +
        '<body style="margin:0;padding:0;background:#111827;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">' +
        '<div style="text-align:center;padding:40px;max-width:400px">' +
        '<div style="width:64px;height:64px;border-radius:50%;background:' + color + ';display:inline-flex;align-items:center;justify-content:center;font-size:32px;color:#fff;margin-bottom:24px">' + icon + '</div>' +
        '<h1 style="color:#fff;font-size:24px;margin:0 0 12px">CardFlow</h1>' +
        '<p style="color:#e5e7eb;font-size:16px;line-height:1.5">' + message + '</p>' +
        '</div></body></html>';
}

module.exports = router;
