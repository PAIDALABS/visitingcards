const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { sendReferralInvite, sendReferralReward } = require('../email');

const router = express.Router();

var CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateReferralCode() {
    var bytes = crypto.randomBytes(8);
    var code = '';
    for (var i = 0; i < 8; i++) {
        code += CHARSET[bytes[i] % CHARSET.length];
    }
    return code;
}

// GET /api/referrals/code — get or generate referral code
router.get('/code', async function (req, res) {
    try {
        var uid = req.user.uid;
        var result = await db.query('SELECT referral_code FROM users WHERE id = $1', [uid]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

        var code = result.rows[0].referral_code;
        if (!code) {
            // Generate unique code with retry
            for (var attempt = 0; attempt < 5; attempt++) {
                code = generateReferralCode();
                try {
                    await db.query('UPDATE users SET referral_code = $1 WHERE id = $2', [code, uid]);
                    break;
                } catch (e) {
                    if (e.code === '23505' && attempt < 4) { code = null; continue; }
                    throw e;
                }
            }
            if (!code) return res.status(500).json({ error: 'Failed to generate referral code' });
        }

        var BASE_URL = process.env.BASE_URL || 'https://card.cardflow.cloud';
        res.json({ code: code, link: BASE_URL + '/signup?ref=' + code });
    } catch (err) {
        console.error('Get referral code error:', err);
        res.status(500).json({ error: 'Failed to get referral code' });
    }
});

// GET /api/referrals/stats — invite stats
router.get('/stats', async function (req, res) {
    try {
        var uid = req.user.uid;

        var countResult = await db.query(
            "SELECT COUNT(*) as total, COUNT(CASE WHEN status != 'pending' THEN 1 END) as signups, COUNT(CASE WHEN referrer_rewarded THEN 1 END) as rewarded FROM referrals WHERE referrer_id = $1",
            [uid]
        );
        var counts = countResult.rows[0];

        var recentResult = await db.query(
            'SELECT invitee_email, status, referrer_rewarded, created_at, converted_at FROM referrals WHERE referrer_id = $1 ORDER BY created_at DESC LIMIT 20',
            [uid]
        );

        res.json({
            invitesSent: parseInt(counts.total, 10),
            signups: parseInt(counts.signups, 10),
            monthsEarned: parseInt(counts.rewarded, 10),
            recent: recentResult.rows
        });
    } catch (err) {
        console.error('Referral stats error:', err);
        res.status(500).json({ error: 'Failed to load stats' });
    }
});

// POST /api/referrals/send-invite — send email invite
router.post('/send-invite', async function (req, res) {
    try {
        var uid = req.user.uid;
        var email = (req.body.email || '').trim().toLowerCase();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Valid email is required' });
        }

        // Get user info
        var userResult = await db.query('SELECT email, name, referral_code FROM users WHERE id = $1', [uid]);
        if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        var user = userResult.rows[0];

        // Block self-referral
        if (email === user.email.toLowerCase()) {
            return res.status(400).json({ error: 'You cannot invite yourself' });
        }

        // Block if invitee already has account
        var existingUser = await db.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'This person already has a CardFlow account' });
        }

        // Rate limit: max 10 invites per day
        var todayCount = await db.query(
            "SELECT COUNT(*) as cnt FROM referrals WHERE referrer_id = $1 AND created_at > NOW() - INTERVAL '24 hours'",
            [uid]
        );
        if (parseInt(todayCount.rows[0].cnt, 10) >= 10) {
            return res.status(429).json({ error: 'You can send up to 10 invites per day. Please try again tomorrow.' });
        }

        // Ensure referral code exists
        var code = user.referral_code;
        if (!code) {
            code = generateReferralCode();
            await db.query('UPDATE users SET referral_code = $1 WHERE id = $2', [code, uid]);
        }

        // Insert referral record (UNIQUE constraint handles duplicates)
        try {
            await db.query(
                'INSERT INTO referrals (referrer_id, invitee_email) VALUES ($1, $2)',
                [uid, email]
            );
        } catch (e) {
            if (e.code === '23505') {
                return res.status(400).json({ error: 'You already invited this person' });
            }
            throw e;
        }

        res.json({ success: true });

        // Send email in background
        var BASE_URL = process.env.BASE_URL || 'https://card.cardflow.cloud';
        var referralLink = BASE_URL + '/signup?ref=' + code;
        sendReferralInvite(email, user.name || 'Your friend', referralLink).catch(function () {});
    } catch (err) {
        console.error('Send invite error:', err);
        res.status(500).json({ error: 'Failed to send invite' });
    }
});

// Apply referral reward to both parties
async function applyReferralReward(referralId, referrerId, inviteeId) {
    var client = await db.connect();
    try {
        await client.query('BEGIN');

        // Lock the referral row
        var refResult = await client.query(
            'SELECT id, referrer_rewarded, invitee_rewarded FROM referrals WHERE id = $1 FOR UPDATE',
            [referralId]
        );
        if (refResult.rows.length === 0) { await client.query('ROLLBACK'); return; }
        var ref = refResult.rows[0];
        if (ref.referrer_rewarded && ref.invitee_rewarded) { await client.query('ROLLBACK'); return; }

        // Apply free month to referrer
        if (!ref.referrer_rewarded) {
            await applyFreeMonth(client, referrerId);
        }

        // Apply free month to invitee
        if (!ref.invitee_rewarded) {
            await applyFreeMonth(client, inviteeId);
        }

        // Mark referral as rewarded
        await client.query(
            "UPDATE referrals SET status = 'rewarded', referrer_rewarded = true, invitee_rewarded = true, rewarded_at = NOW() WHERE id = $1",
            [referralId]
        );

        await client.query('COMMIT');

        // Send reward emails in background
        try {
            var referrerResult = await db.query('SELECT email, name FROM users WHERE id = $1', [referrerId]);
            var inviteeResult = await db.query('SELECT email, name FROM users WHERE id = $1', [inviteeId]);
            if (referrerResult.rows.length > 0) {
                var inviteeName = inviteeResult.rows.length > 0 ? inviteeResult.rows[0].name : 'a friend';
                sendReferralReward(referrerResult.rows[0].email, referrerResult.rows[0].name, inviteeName).catch(function () {});
            }
            if (inviteeResult.rows.length > 0) {
                var referrerName = referrerResult.rows.length > 0 ? referrerResult.rows[0].name : 'your referrer';
                sendReferralReward(inviteeResult.rows[0].email, inviteeResult.rows[0].name, referrerName).catch(function () {});
            }
        } catch (emailErr) {
            console.error('Referral reward email error:', emailErr.message);
        }
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('applyReferralReward error:', err);
    } finally {
        client.release();
    }
}

async function applyFreeMonth(client, userId) {
    var userResult = await client.query('SELECT plan FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) return;
    var currentPlan = userResult.rows[0].plan;

    if (currentPlan === 'free') {
        // Upgrade to pro
        await client.query("UPDATE users SET plan = 'pro', updated_at = NOW() WHERE id = $1", [userId]);
        await client.query(
            "INSERT INTO subscriptions (user_id, plan, status, current_period_end, updated_at) VALUES ($1, 'pro', 'referral', $2, NOW()) ON CONFLICT (user_id) DO UPDATE SET plan = 'pro', status = 'referral', current_period_end = $2, updated_at = NOW()",
            [userId, Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)]
        );
    } else {
        // Already pro/business — extend by 30 days
        var subResult = await client.query('SELECT current_period_end FROM subscriptions WHERE user_id = $1', [userId]);
        var currentEnd = subResult.rows.length > 0 ? parseInt(subResult.rows[0].current_period_end, 10) : Math.floor(Date.now() / 1000);
        var base = Math.max(currentEnd, Math.floor(Date.now() / 1000));
        var newEnd = base + (30 * 24 * 60 * 60);
        await client.query(
            'UPDATE subscriptions SET current_period_end = $1, updated_at = NOW() WHERE user_id = $2',
            [newEnd, userId]
        );
    }
}

module.exports = router;
module.exports.applyReferralReward = applyReferralReward;
module.exports.generateReferralCode = generateReferralCode;
