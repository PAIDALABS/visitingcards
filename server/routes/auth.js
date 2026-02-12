const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { signToken, verifyAuth } = require('../auth');
const { sendWelcome, sendEmailVerification, sendPasswordReset, sendOTP } = require('../email');
const { applyReferralReward, generateReferralCode } = require('./referrals');

const router = express.Router();

var authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});

var signupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'Too many signups, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});

var otpLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    message: { error: 'Too many OTP attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const RESERVED_USERNAMES = [
    'admin','login','signup','pricing','landing','api','www','app',
    'help','support','billing','settings','dashboard','account',
    'cards','leads','analytics','nfc','qr','public','static','assets',
    'sw','manifest','icons','favicon','robots','sitemap','functions',
    'reset','password','reset-password','terms','privacy','cookies',
    'refund','disclaimer','about','contact','blog','news','status',
    'events','e','booth','booth-setup','badge','exhibitor'
];

// POST /api/auth/signup
router.post('/signup', signupLimiter, async function (req, res) {
    try {
        var { email, password, name, username } = req.body;
        if (!email || !password || !username) {
            return res.status(400).json({ error: 'Email, password, and username are required' });
        }
        email = email.trim().toLowerCase();
        var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
        username = username.trim().toLowerCase();
        if (username.length < 3 || username.length > 30) {
            return res.status(400).json({ error: 'Username must be 3-30 characters' });
        }
        if (!/^[a-z0-9._\-]{3,30}$/.test(username)) {
            return res.status(400).json({ error: 'Username may only contain lowercase letters, numbers, dots, hyphens, and underscores' });
        }
        if (RESERVED_USERNAMES.includes(username)) {
            return res.status(400).json({ error: 'This username is reserved' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        if (password.length > 128) {
            return res.status(400).json({ error: 'Password must be at most 128 characters' });
        }

        // Check username availability
        var existing = await db.query('SELECT id FROM users WHERE username = $1', [username]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Username is taken' });
        }

        // Check email
        var existingEmail = await db.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existingEmail.rows.length > 0) {
            return res.status(409).json({ error: 'An account with this email already exists' });
        }

        var id = uuidv4();
        var hash = await bcrypt.hash(password, 10);
        var referralCode = generateReferralCode();

        await db.query(
            'INSERT INTO users (id, email, password_hash, name, username, plan, referral_code) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [id, email, hash, name || '', username, 'free', referralCode]
        );

        // Create default settings
        await db.query(
            'INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
            [id]
        );

        // Handle referral code if provided
        var userPlan = 'free';
        var referralHandled = false;
        if (req.body.referralCode) {
            try {
                var referrerResult = await db.query('SELECT id FROM users WHERE referral_code = $1', [req.body.referralCode.toUpperCase()]);
                if (referrerResult.rows.length > 0) {
                    var referrerId = referrerResult.rows[0].id;
                    await db.query('UPDATE users SET referred_by = $1 WHERE id = $2', [referrerId, id]);
                    // Upsert referral row (may already exist from email invite)
                    var refUpsert = await db.query(
                        "INSERT INTO referrals (referrer_id, invitee_email, invitee_id, status, converted_at) VALUES ($1, $2, $3, 'signed_up', NOW()) ON CONFLICT (referrer_id, invitee_email) DO UPDATE SET invitee_id = $3, status = 'signed_up', converted_at = NOW() RETURNING id",
                        [referrerId, email, id]
                    );
                    if (refUpsert.rows.length > 0) {
                        await applyReferralReward(refUpsert.rows[0].id, referrerId, id);
                        // Re-check plan after reward
                        var planCheck = await db.query('SELECT plan FROM users WHERE id = $1', [id]);
                        if (planCheck.rows.length > 0) userPlan = planCheck.rows[0].plan;
                    }
                    referralHandled = true;
                }
            } catch (refErr) {
                console.error('Referral processing error:', refErr.message);
            }
        }

        // Smart referral: if no referral code used, check visitor history
        var visitorId = req.body.visitorId;
        if (visitorId) {
            try {
                var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                if (UUID_RE.test(visitorId)) {
                    // Link visitor to new user
                    await db.query('UPDATE visitors SET user_id = $1 WHERE id = $2', [id, visitorId]);

                    if (!referralHandled) {
                        // Find most recent card owner from visitor's viewed history
                        var vResult = await db.query('SELECT cards_viewed FROM visitors WHERE id = $1', [visitorId]);
                        if (vResult.rows.length > 0 && vResult.rows[0].cards_viewed && vResult.rows[0].cards_viewed.length > 0) {
                            var viewed = vResult.rows[0].cards_viewed;
                            var lastOwner = viewed[viewed.length - 1].ownerId;
                            // Ensure the owner exists and is not the new user
                            if (lastOwner && lastOwner !== id) {
                                var ownerCheck = await db.query('SELECT id FROM users WHERE id = $1', [lastOwner]);
                                if (ownerCheck.rows.length > 0) {
                                    await db.query('UPDATE users SET referred_by = $1 WHERE id = $2', [lastOwner, id]);
                                    var autoRef = await db.query(
                                        "INSERT INTO referrals (referrer_id, invitee_email, invitee_id, status, converted_at) VALUES ($1, $2, $3, 'signed_up', NOW()) ON CONFLICT (referrer_id, invitee_email) DO UPDATE SET invitee_id = $3, status = 'signed_up', converted_at = NOW() RETURNING id",
                                        [lastOwner, email, id]
                                    );
                                    if (autoRef.rows.length > 0) {
                                        await applyReferralReward(autoRef.rows[0].id, lastOwner, id);
                                        var planCheck2 = await db.query('SELECT plan FROM users WHERE id = $1', [id]);
                                        if (planCheck2.rows.length > 0) userPlan = planCheck2.rows[0].plan;
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (visErr) {
                console.error('Visitor linking error:', visErr.message);
            }
        }

        var token = signToken({ id: id, email: email, username: username });
        res.json({ token: token, user: { id: id, email: email, name: name || '', username: username, plan: userPlan } });

        // Send emails in background (don't block response)
        var BASE_URL = process.env.BASE_URL || 'https://card.cardflow.cloud';
        sendWelcome(email, name || '').catch(function () {});
        var verifyToken = crypto.randomBytes(32).toString('hex');
        db.query(
            'INSERT INTO email_verification_tokens (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'24 hours\')',
            [verifyToken, id]
        ).then(function () {
            sendEmailVerification(email, BASE_URL + '/api/auth/verify-email?token=' + verifyToken).catch(function () {});
        }).catch(function (e) { console.error('Verify token insert error:', e.message); });
    } catch (err) {
        if (err.code === '23505' && err.constraint && err.constraint.includes('username')) {
            return res.status(409).json({ error: 'Username is already taken' });
        }
        console.error('Signup error:', err);
        res.status(500).json({ error: 'Signup failed' });
    }
});

// POST /api/auth/login
router.post('/login', authLimiter, async function (req, res) {
    try {
        var { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }
        email = email.trim().toLowerCase();

        var result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        var user = result.rows[0];
        if (!user.password_hash) {
            return res.status(401).json({ error: 'Please use Google sign-in or reset your password' });
        }

        var valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Link visitor to user on login
        if (req.body.visitorId) {
            var loginUUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (loginUUID_RE.test(req.body.visitorId)) {
                db.query('UPDATE visitors SET user_id = $1 WHERE id = $2 AND user_id IS NULL', [user.id, req.body.visitorId]).catch(function(){});
            }
        }

        var token = signToken(user);
        res.json({ token: token, user: { id: user.id, email: user.email, name: user.name, username: user.username, plan: user.plan } });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

// POST /api/auth/google
router.post('/google', authLimiter, async function (req, res) {
    try {
        var { idToken, username } = req.body;
        if (!idToken) {
            return res.status(400).json({ error: 'ID token required' });
        }

        var ticket = await googleClient.verifyIdToken({
            idToken: idToken,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        var payload = ticket.getPayload();
        var googleId = payload.sub;
        var email = payload.email;
        var name = payload.name || '';

        // Check if user exists by google_id or email
        var result = await db.query('SELECT * FROM users WHERE google_id = $1 OR email = $2', [googleId, email]);

        if (result.rows.length > 0) {
            // Existing user - update google_id if needed
            var user = result.rows[0];
            if (!user.google_id) {
                await db.query('UPDATE users SET google_id = $1, updated_at = NOW() WHERE id = $2', [googleId, user.id]);
            }
            // Link visitor to user on login
            if (req.body.visitorId) {
                var glUUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                if (glUUID_RE.test(req.body.visitorId)) {
                    db.query('UPDATE visitors SET user_id = $1 WHERE id = $2 AND user_id IS NULL', [user.id, req.body.visitorId]).catch(function(){});
                }
            }
            var token = signToken(user);
            return res.json({ token: token, user: { id: user.id, email: user.email, name: user.name, username: user.username, plan: user.plan }, isNew: false });
        }

        // New user - require username
        if (!username) {
            return res.json({ needsUsername: true });
        }

        username = username.trim().toLowerCase();
        if (username.length < 3 || username.length > 30) {
            return res.status(400).json({ error: 'Username must be 3-30 characters' });
        }
        if (RESERVED_USERNAMES.includes(username)) {
            return res.status(400).json({ error: 'This username is reserved' });
        }

        var existing = await db.query('SELECT id FROM users WHERE username = $1', [username]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Username is taken' });
        }

        var id = uuidv4();
        var gReferralCode = generateReferralCode();
        await db.query(
            'INSERT INTO users (id, email, name, username, google_id, plan, referral_code) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [id, email, name, username, googleId, 'free', gReferralCode]
        );

        await db.query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);

        // Google-verified emails are already verified
        await db.query('UPDATE users SET email_verified = true WHERE id = $1', [id]);

        // Handle referral code if provided
        var gUserPlan = 'free';
        var gReferralHandled = false;
        if (req.body.referralCode) {
            try {
                var gReferrerResult = await db.query('SELECT id FROM users WHERE referral_code = $1', [req.body.referralCode.toUpperCase()]);
                if (gReferrerResult.rows.length > 0) {
                    var gReferrerId = gReferrerResult.rows[0].id;
                    await db.query('UPDATE users SET referred_by = $1 WHERE id = $2', [gReferrerId, id]);
                    var gRefUpsert = await db.query(
                        "INSERT INTO referrals (referrer_id, invitee_email, invitee_id, status, converted_at) VALUES ($1, $2, $3, 'signed_up', NOW()) ON CONFLICT (referrer_id, invitee_email) DO UPDATE SET invitee_id = $3, status = 'signed_up', converted_at = NOW() RETURNING id",
                        [gReferrerId, email, id]
                    );
                    if (gRefUpsert.rows.length > 0) {
                        await applyReferralReward(gRefUpsert.rows[0].id, gReferrerId, id);
                        var gPlanCheck = await db.query('SELECT plan FROM users WHERE id = $1', [id]);
                        if (gPlanCheck.rows.length > 0) gUserPlan = gPlanCheck.rows[0].plan;
                    }
                    gReferralHandled = true;
                }
            } catch (gRefErr) {
                console.error('Google referral processing error:', gRefErr.message);
            }
        }

        // Smart referral: if no referral code used, check visitor history
        var gVisitorId = req.body.visitorId;
        if (gVisitorId) {
            try {
                var gUUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                if (gUUID_RE.test(gVisitorId)) {
                    await db.query('UPDATE visitors SET user_id = $1 WHERE id = $2', [id, gVisitorId]);

                    if (!gReferralHandled) {
                        var gvResult = await db.query('SELECT cards_viewed FROM visitors WHERE id = $1', [gVisitorId]);
                        if (gvResult.rows.length > 0 && gvResult.rows[0].cards_viewed && gvResult.rows[0].cards_viewed.length > 0) {
                            var gViewed = gvResult.rows[0].cards_viewed;
                            var gLastOwner = gViewed[gViewed.length - 1].ownerId;
                            if (gLastOwner && gLastOwner !== id) {
                                var gOwnerCheck = await db.query('SELECT id FROM users WHERE id = $1', [gLastOwner]);
                                if (gOwnerCheck.rows.length > 0) {
                                    await db.query('UPDATE users SET referred_by = $1 WHERE id = $2', [gLastOwner, id]);
                                    var gAutoRef = await db.query(
                                        "INSERT INTO referrals (referrer_id, invitee_email, invitee_id, status, converted_at) VALUES ($1, $2, $3, 'signed_up', NOW()) ON CONFLICT (referrer_id, invitee_email) DO UPDATE SET invitee_id = $3, status = 'signed_up', converted_at = NOW() RETURNING id",
                                        [gLastOwner, email, id]
                                    );
                                    if (gAutoRef.rows.length > 0) {
                                        await applyReferralReward(gAutoRef.rows[0].id, gLastOwner, id);
                                        var gPlanCheck2 = await db.query('SELECT plan FROM users WHERE id = $1', [id]);
                                        if (gPlanCheck2.rows.length > 0) gUserPlan = gPlanCheck2.rows[0].plan;
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (gVisErr) {
                console.error('Google visitor linking error:', gVisErr.message);
            }
        }

        var token = signToken({ id: id, email: email, username: username });
        res.json({ token: token, user: { id: id, email: email, name: name, username: username, plan: gUserPlan }, isNew: true });

        // Send welcome email in background
        sendWelcome(email, name).catch(function () {});
    } catch (err) {
        if (err.code === '23505' && err.constraint && err.constraint.includes('username')) {
            return res.status(409).json({ error: 'Username is already taken' });
        }
        console.error('Google auth error:', err);
        res.status(500).json({ error: 'Google authentication failed' });
    }
});

// POST /api/auth/send-otp
router.post('/send-otp', authLimiter, async function (req, res) {
    try {
        var email = (req.body.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'Email is required' });

        // Rate limit: max 3 OTPs per email in 15 minutes
        var countResult = await db.query(
            "SELECT COUNT(*) FROM otp_codes WHERE email = $1 AND created_at > NOW() - INTERVAL '15 minutes'",
            [email]
        );
        if (parseInt(countResult.rows[0].count) >= 3) {
            return res.status(429).json({ error: 'Too many OTP requests. Please wait before trying again.' });
        }

        var code = Math.floor(100000 + Math.random() * 900000).toString();

        // Insert new OTP (or update existing), then clean up expired OTPs
        await db.query(
            "INSERT INTO otp_codes (email, code, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes') ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = NOW() + INTERVAL '10 minutes', created_at = NOW()",
            [email, code]
        );
        // Clean up only expired OTPs (older than 15 minutes) — preserves rate limit counter
        await db.query(
            "DELETE FROM otp_codes WHERE email = $1 AND created_at < NOW() - INTERVAL '15 minutes'",
            [email]
        );

        res.json({ message: 'OTP sent' });

        // Send email in background
        sendOTP(email, code).catch(function () {});
    } catch (err) {
        console.error('Send OTP error:', err);
        res.status(500).json({ error: 'Failed to send OTP' });
    }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', otpLimiter, async function (req, res) {
    try {
        var email = (req.body.email || '').trim().toLowerCase();
        var code = (req.body.code || '').trim();
        if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });

        var result = await db.query(
            'SELECT id, expires_at FROM otp_codes WHERE email = $1 AND code = $2',
            [email, code]
        );

        if (result.rows.length === 0) {
            // Failed attempt — delete the OTP to prevent brute-force guessing
            await db.query('DELETE FROM otp_codes WHERE email = $1', [email]);
            return res.status(401).json({ error: 'Invalid OTP code' });
        }

        var row = result.rows[0];
        if (new Date(row.expires_at) < new Date()) {
            await db.query('DELETE FROM otp_codes WHERE id = $1', [row.id]);
            return res.status(401).json({ error: 'OTP has expired' });
        }

        // Valid OTP — delete all OTPs for this email
        await db.query('DELETE FROM otp_codes WHERE email = $1', [email]);

        // Look up user
        var userResult = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.json({ needsSignup: true, email: email });
        }

        var user = userResult.rows[0];
        // OTP login verifies email
        if (!user.email_verified) {
            await db.query('UPDATE users SET email_verified = true, updated_at = NOW() WHERE id = $1', [user.id]);
        }

        var token = signToken(user);
        res.json({ token: token, user: { id: user.id, email: user.email, name: user.name, username: user.username, plan: user.plan } });
    } catch (err) {
        console.error('Verify OTP error:', err);
        res.status(500).json({ error: 'Failed to verify OTP' });
    }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', authLimiter, async function (req, res) {
    var { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    email = email.trim().toLowerCase();

    // Always return success to prevent email enumeration
    res.json({ message: 'If an account exists with that email, a reset link has been sent.' });

    // Look up user and send reset email in background
    try {
        var result = await db.query('SELECT id FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return;

        var userId = result.rows[0].id;
        // Delete any existing tokens for this user
        await db.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);

        var resetToken = crypto.randomBytes(32).toString('hex');
        await db.query(
            'INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'1 hour\')',
            [resetToken, userId]
        );

        var BASE_URL = process.env.BASE_URL || 'https://card.cardflow.cloud';
        sendPasswordReset(email, BASE_URL + '/reset-password?token=' + resetToken).catch(function () {});
    } catch (err) {
        console.error('Forgot password background error:', err.message);
    }
});

// GET /api/auth/me (JWT required)
router.get('/me', verifyAuth, async function (req, res) {
    try {
        var result = await db.query('SELECT id, email, name, username, phone, photo, plan, created_at, password_hash, google_id FROM users WHERE id = $1', [req.user.uid]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        var user = result.rows[0];
        var response = {
            id: user.id,
            email: user.email,
            name: user.name,
            username: user.username,
            phone: user.phone,
            photo: user.photo,
            plan: user.plan,
            created_at: user.created_at,
            has_password: !!user.password_hash,
            has_google: !!user.google_id
        };
        res.json(response);
    } catch (err) {
        console.error('Me error:', err);
        res.status(500).json({ error: 'Failed to get profile' });
    }
});

// POST /api/auth/change-password (JWT required)
router.post('/change-password', verifyAuth, async function (req, res) {
    try {
        var { currentPassword, newPassword } = req.body;
        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters' });
        }
        if (newPassword.length > 128) {
            return res.status(400).json({ error: 'New password must be at most 128 characters' });
        }

        var result = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.uid]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        var user = result.rows[0];

        // If user has a password, require current password
        if (user.password_hash) {
            if (!currentPassword) {
                return res.status(400).json({ error: 'Current password is required' });
            }
            var valid = await bcrypt.compare(currentPassword, user.password_hash);
            if (!valid) {
                return res.status(401).json({ error: 'Current password is incorrect' });
            }
        }

        var hash = await bcrypt.hash(newPassword, 10);
        await db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.user.uid]);

        res.json({ message: user.password_hash ? 'Password changed successfully' : 'Password set successfully' });
    } catch (err) {
        console.error('Change password error:', err);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// DELETE /api/auth/account (JWT required)
router.delete('/account', verifyAuth, async function (req, res) {
    try {
        var uid = req.user.uid;
        // Try to cancel Stripe subscription before deleting account
        try {
            var subResult = await db.query('SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1', [uid]);
            if (subResult.rows.length > 0 && subResult.rows[0].stripe_subscription_id) {
                var stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
                await stripe.subscriptions.cancel(subResult.rows[0].stripe_subscription_id);
            }
        } catch (stripeErr) {
            console.error('Failed to cancel Stripe subscription during account deletion:', stripeErr.message);
        }
        // CASCADE handles cards, leads, taps, analytics, settings, subscriptions, nfc tokens
        await db.query('DELETE FROM users WHERE id = $1', [uid]);
        res.json({ message: 'Account deleted' });
    } catch (err) {
        console.error('Delete account error:', err);
        res.status(500).json({ error: 'Failed to delete account' });
    }
});

module.exports = router;
