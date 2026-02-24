const express = require('express');
const db = require('../db');
const { signToken, verifyAuth, requireSuperAdmin } = require('../auth');
const { enforceCardLimit } = require('./billing');
const { PLAN_LIMITS } = require('./cards');
const { sendAdminEmail } = require('../email');

const router = express.Router();

// All admin routes require auth + superadmin role
router.use(verifyAuth);
router.use(requireSuperAdmin);

// Plan prices in paise (INR)
var PLAN_PRICES = { pro: 39900, business: 99900 };

// Helper: write audit log
async function audit(adminId, action, targetUserId, details) {
    await db.query(
        'INSERT INTO admin_audit_log (admin_id, action, target_user_id, details) VALUES ($1, $2, $3, $4)',
        [adminId, action, targetUserId || null, details || {}]
    );
}

// ═══════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/dashboard — KPIs
router.get('/dashboard', async function (req, res) {
    try {
        var results = await Promise.all([
            db.query('SELECT COUNT(*) FROM users'),
            db.query('SELECT COUNT(*) FROM cards'),
            db.query('SELECT COUNT(*) FROM leads'),
            db.query("SELECT plan, COUNT(*) as count FROM users GROUP BY plan"),
            db.query("SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '7 days'"),
            db.query("SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '30 days'"),
            db.query("SELECT COUNT(*) as total_payments, COALESCE(SUM(CASE WHEN plan='pro' THEN 39900 WHEN plan='business' THEN 99900 ELSE 0 END), 0) as total_paise FROM subscriptions WHERE razorpay_payment_id IS NOT NULL"),
            db.query("SELECT s.*, u.email, u.name, u.username FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.razorpay_payment_id IS NOT NULL ORDER BY s.updated_at DESC LIMIT 10"),
            db.query("SELECT COUNT(*) FROM cards WHERE created_at >= NOW() - INTERVAL '7 days'"),
            db.query("SELECT COUNT(*) FROM leads WHERE created_at >= NOW() - INTERVAL '7 days'"),
            // Active users (24h) — based on lead/card activity since analytics table lacks updated_at
            db.query("SELECT COUNT(DISTINCT user_id) FROM (SELECT user_id FROM leads WHERE updated_at >= NOW() - INTERVAL '24 hours' UNION SELECT user_id FROM cards WHERE updated_at >= NOW() - INTERVAL '24 hours') t").catch(function () { return { rows: [{ count: 0 }] }; }),
            // Events stats
            db.query("SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'live') as live FROM events").catch(function () { return { rows: [{ total: 0, live: 0 }] }; }),
            // Total attendees
            db.query("SELECT COUNT(*) FROM event_attendees").catch(function () { return { rows: [{ count: 0 }] }; }),
            // Total booth visits
            db.query("SELECT COUNT(*) FROM booth_visits").catch(function () { return { rows: [{ count: 0 }] }; })
        ]);

        var planDist = {};
        results[3].rows.forEach(function (r) { planDist[r.plan] = parseInt(r.count); });

        res.json({
            totalUsers: parseInt(results[0].rows[0].count),
            totalCards: parseInt(results[1].rows[0].count),
            totalLeads: parseInt(results[2].rows[0].count),
            planDistribution: planDist,
            newUsers7d: parseInt(results[4].rows[0].count),
            newUsers30d: parseInt(results[5].rows[0].count),
            totalPayments: parseInt(results[6].rows[0].total_payments),
            totalRevenuePaise: parseInt(results[6].rows[0].total_paise),
            recentPayments: results[7].rows.map(function (r) {
                return {
                    userId: r.user_id, email: r.email, name: r.name, username: r.username,
                    plan: r.plan, status: r.status, paymentId: r.razorpay_payment_id, updatedAt: r.updated_at
                };
            }),
            newCards7d: parseInt(results[8].rows[0].count),
            newLeads7d: parseInt(results[9].rows[0].count),
            activeUsers24h: parseInt(results[10].rows[0].count) || 0,
            totalEvents: parseInt(results[11].rows[0].total) || 0,
            liveEvents: parseInt(results[11].rows[0].live) || 0,
            totalAttendees: parseInt(results[12].rows[0].count) || 0,
            totalBoothVisits: parseInt(results[13].rows[0].count) || 0
        });
    } catch (err) {
        console.error('Admin dashboard error:', err);
        res.status(500).json({ error: 'Failed to load dashboard' });
    }
});

// GET /api/admin/dashboard/revenue — MRR & revenue analytics
router.get('/dashboard/revenue', async function (req, res) {
    try {
        var results = await Promise.all([
            // Active paid subscriptions by plan
            db.query("SELECT plan, COUNT(*) as count FROM subscriptions WHERE razorpay_payment_id IS NOT NULL AND status = 'active' GROUP BY plan"),
            // Total revenue
            db.query("SELECT COALESCE(SUM(CASE WHEN plan='pro' THEN 39900 WHEN plan='business' THEN 99900 ELSE 0 END), 0) as total FROM subscriptions WHERE razorpay_payment_id IS NOT NULL"),
            // 6-month trend (monthly revenue)
            db.query(
                "SELECT to_char(date_trunc('month', updated_at), 'YYYY-MM') as month, " +
                "COALESCE(SUM(CASE WHEN plan='pro' THEN 39900 WHEN plan='business' THEN 99900 ELSE 0 END), 0) as revenue, " +
                "COUNT(*) as payments " +
                "FROM subscriptions WHERE razorpay_payment_id IS NOT NULL AND updated_at >= NOW() - INTERVAL '6 months' " +
                "GROUP BY date_trunc('month', updated_at) ORDER BY month"
            ),
            // Failed payments (orders created but never verified)
            db.query("SELECT COUNT(*) FROM subscriptions WHERE razorpay_order_id IS NOT NULL AND razorpay_payment_id IS NULL"),
            // Admin-granted subscriptions
            db.query("SELECT COUNT(*) FROM subscriptions WHERE status = 'admin_granted'")
        ]);

        var planBreakdown = {};
        var mrr = 0;
        results[0].rows.forEach(function (r) {
            var count = parseInt(r.count);
            planBreakdown[r.plan] = count;
            mrr += count * (PLAN_PRICES[r.plan] || 0);
        });

        res.json({
            mrr: mrr,
            totalRevenue: parseInt(results[1].rows[0].total),
            planBreakdown: planBreakdown,
            monthlyTrend: results[2].rows.map(function (r) {
                return { month: r.month, revenue: parseInt(r.revenue), payments: parseInt(r.payments) };
            }),
            failedPayments: parseInt(results[3].rows[0].count),
            adminGranted: parseInt(results[4].rows[0].count)
        });
    } catch (err) {
        console.error('Revenue analytics error:', err);
        res.status(500).json({ error: 'Failed to load revenue data' });
    }
});

// GET /api/admin/dashboard/growth — daily signups last 30 days
router.get('/dashboard/growth', async function (req, res) {
    try {
        var result = await db.query(
            "SELECT date_trunc('day', created_at)::date as day, COUNT(*) as count " +
            "FROM users WHERE created_at >= NOW() - INTERVAL '30 days' " +
            "GROUP BY day ORDER BY day"
        );
        // Fill gaps
        var data = [];
        var map = {};
        result.rows.forEach(function (r) { map[r.day.toISOString().split('T')[0]] = parseInt(r.count); });
        for (var i = 29; i >= 0; i--) {
            var d = new Date(); d.setDate(d.getDate() - i);
            var key = d.toISOString().split('T')[0];
            data.push({ date: key, signups: map[key] || 0 });
        }
        res.json({ growth: data });
    } catch (err) {
        console.error('Growth data error:', err);
        res.status(500).json({ error: 'Failed to load growth data' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/users — paginated user list
router.get('/users', async function (req, res) {
    try {
        var search = (req.query.search || '').trim().toLowerCase();
        var plan = req.query.plan || '';
        var page = Math.max(1, parseInt(req.query.page) || 1);
        var limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
        var offset = (page - 1) * limit;

        var where = [];
        var params = [];
        var idx = 1;

        if (search) {
            var escapedSearch = search.replace(/%/g, '\\%').replace(/_/g, '\\_');
            where.push("(LOWER(u.email) LIKE $" + idx + " OR LOWER(u.name) LIKE $" + idx + " OR LOWER(u.username) LIKE $" + idx + ")");
            params.push('%' + escapedSearch + '%');
            idx++;
        }
        if (plan && ['free', 'pro', 'business'].includes(plan)) {
            where.push("u.plan = $" + idx);
            params.push(plan);
            idx++;
        }

        var whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

        var countResult = await db.query('SELECT COUNT(*) FROM users u ' + whereClause, params);
        var total = parseInt(countResult.rows[0].count);

        var usersResult = await db.query(
            'SELECT u.id, u.email, u.name, u.username, u.plan, u.role, u.created_at, u.suspended_at, u.email_verified, ' +
            '(SELECT COUNT(*) FROM cards WHERE user_id = u.id) as card_count, ' +
            '(SELECT COUNT(*) FROM leads WHERE user_id = u.id) as lead_count ' +
            'FROM users u ' + whereClause +
            ' ORDER BY u.created_at DESC LIMIT $' + idx + ' OFFSET $' + (idx + 1),
            params.concat([limit, offset])
        );

        res.json({
            users: usersResult.rows.map(function (u) {
                return {
                    id: u.id, email: u.email, name: u.name, username: u.username,
                    plan: u.plan, role: u.role, createdAt: u.created_at,
                    suspendedAt: u.suspended_at, emailVerified: u.email_verified,
                    cardCount: parseInt(u.card_count), leadCount: parseInt(u.lead_count)
                };
            }),
            total: total, page: page, limit: limit, totalPages: Math.ceil(total / limit)
        });
    } catch (err) {
        console.error('Admin users list error:', err);
        res.status(500).json({ error: 'Failed to load users' });
    }
});

// GET /api/admin/users/export — CSV download
router.get('/users/export', async function (req, res) {
    try {
        var result = await db.query(
            'SELECT u.id, u.email, u.name, u.username, u.plan, u.role, u.created_at, u.suspended_at, u.email_verified, ' +
            '(SELECT COUNT(*) FROM cards WHERE user_id = u.id) as card_count, ' +
            '(SELECT COUNT(*) FROM leads WHERE user_id = u.id) as lead_count ' +
            'FROM users u ORDER BY u.created_at DESC'
        );
        await audit(req.user.uid, 'export_data', null, { type: 'users', count: result.rows.length });
        var csv = 'ID,Email,Name,Username,Plan,Role,Email Verified,Cards,Leads,Created,Suspended\n';
        result.rows.forEach(function (u) {
            csv += csvVal(u.id) + ',' + csvVal(u.email) + ',' + csvVal(u.name) + ',' + csvVal(u.username) + ',' +
                csvVal(u.plan) + ',' + csvVal(u.role || 'user') + ',' + (u.email_verified ? 'Yes' : 'No') + ',' +
                u.card_count + ',' + u.lead_count + ',' + csvVal(fmtIso(u.created_at)) + ',' + csvVal(fmtIso(u.suspended_at)) + '\n';
        });
        res.set('Content-Type', 'text/csv');
        res.set('Content-Disposition', 'attachment; filename="cardflow-users-' + new Date().toISOString().split('T')[0] + '.csv"');
        res.send(csv);
    } catch (err) {
        console.error('Export users error:', err);
        res.status(500).json({ error: 'Failed to export users' });
    }
});

// GET /api/admin/users/:id — user detail
router.get('/users/:id', async function (req, res) {
    try {
        var userId = req.params.id;
        var userResult = await db.query(
            'SELECT id, email, name, username, phone, plan, role, created_at, suspended_at, referred_by, referral_code, email_verified FROM users WHERE id = $1',
            [userId]
        );
        if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        var user = userResult.rows[0];

        var results = await Promise.all([
            db.query("SELECT id, data->>'name' as name, active, created_at, updated_at FROM cards WHERE user_id = $1 ORDER BY updated_at DESC", [userId]),
            db.query('SELECT COUNT(*) FROM leads WHERE user_id = $1', [userId]),
            db.query('SELECT plan, status, razorpay_payment_id, updated_at FROM subscriptions WHERE user_id = $1', [userId]),
            db.query('SELECT COUNT(*) FROM referrals WHERE referrer_id = $1', [userId])
        ]);

        res.json({
            id: user.id, email: user.email, name: user.name, username: user.username,
            phone: user.phone, plan: user.plan, role: user.role, createdAt: user.created_at,
            suspendedAt: user.suspended_at, referredBy: user.referred_by,
            referralCode: user.referral_code, emailVerified: user.email_verified,
            cards: results[0].rows.map(function (c) {
                return { id: c.id, name: c.name, active: c.active, createdAt: c.created_at, updatedAt: c.updated_at };
            }),
            leadCount: parseInt(results[1].rows[0].count),
            subscription: results[2].rows.length > 0 ? {
                plan: results[2].rows[0].plan, status: results[2].rows[0].status,
                paymentId: results[2].rows[0].razorpay_payment_id, updatedAt: results[2].rows[0].updated_at
            } : null,
            referralCount: parseInt(results[3].rows[0].count)
        });
    } catch (err) {
        console.error('Admin user detail error:', err);
        res.status(500).json({ error: 'Failed to load user' });
    }
});

// GET /api/admin/users/:id/timeline — activity timeline
router.get('/users/:id/timeline', async function (req, res) {
    try {
        var userId = req.params.id;
        var page = Math.max(1, parseInt(req.query.page) || 1);
        var limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        var offset = (page - 1) * limit;

        // UNION query across multiple tables
        var result = await db.query(
            "(SELECT 'signup' as type, created_at as ts, '{}'::jsonb as meta FROM users WHERE id = $1) " +
            "UNION ALL " +
            "(SELECT 'card_created' as type, created_at as ts, jsonb_build_object('cardId', id, 'name', data->>'name') as meta FROM cards WHERE user_id = $1) " +
            "UNION ALL " +
            "(SELECT 'lead_captured' as type, created_at as ts, jsonb_build_object('source', data->>'source') as meta FROM leads WHERE user_id = $1) " +
            "UNION ALL " +
            "(SELECT 'subscription' as type, updated_at as ts, jsonb_build_object('plan', plan, 'status', status) as meta FROM subscriptions WHERE user_id = $1) " +
            "ORDER BY ts DESC LIMIT $2 OFFSET $3",
            [userId, limit, offset]
        );

        res.json({
            events: result.rows.map(function (r) {
                return { type: r.type, timestamp: r.ts, meta: r.meta };
            })
        });
    } catch (err) {
        console.error('User timeline error:', err);
        res.status(500).json({ error: 'Failed to load timeline' });
    }
});

// POST /api/admin/users/:id/impersonate — login as user
router.post('/users/:id/impersonate', async function (req, res) {
    try {
        var userId = req.params.id;
        var target = await db.query('SELECT id, email, username, role FROM users WHERE id = $1', [userId]);
        if (target.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        if (target.rows[0].role === 'superadmin') return res.status(400).json({ error: 'Cannot impersonate another superadmin' });

        var user = target.rows[0];
        var token = signToken({ id: user.id, email: user.email, username: user.username }, { impersonatedBy: req.user.uid });
        await audit(req.user.uid, 'impersonate_user', userId, { email: user.email });

        res.json({ token: token, user: { id: user.id, email: user.email, username: user.username } });
    } catch (err) {
        console.error('Impersonate error:', err);
        res.status(500).json({ error: 'Failed to impersonate user' });
    }
});

// PATCH /api/admin/users/:id/verify-email — manual email verification
router.patch('/users/:id/verify-email', async function (req, res) {
    try {
        var userId = req.params.id;
        await db.query('UPDATE users SET email_verified = true, updated_at = NOW() WHERE id = $1', [userId]);
        await audit(req.user.uid, 'verify_email', userId, {});
        res.json({ success: true });
    } catch (err) {
        console.error('Verify email error:', err);
        res.status(500).json({ error: 'Failed to verify email' });
    }
});

// PATCH /api/admin/users/:id/plan — change user plan
router.patch('/users/:id/plan', async function (req, res) {
    try {
        var userId = req.params.id;
        var newPlan = req.body.plan;
        if (!['free', 'pro', 'business'].includes(newPlan)) return res.status(400).json({ error: 'Invalid plan' });

        var userResult = await db.query('SELECT plan FROM users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        var oldPlan = userResult.rows[0].plan;

        await db.query('UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2', [newPlan, userId]);
        // Upsert subscription record so billing portal + cron reflect the change
        if (newPlan === 'free') {
            await db.query("UPDATE subscriptions SET plan = 'free', status = 'admin_downgrade', updated_at = NOW() WHERE user_id = $1", [userId]);
        } else {
            var adminPeriodEnd = Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000);
            await db.query(
                "INSERT INTO subscriptions (user_id, plan, status, current_period_end, updated_at) VALUES ($1, $2, 'active', $3, NOW()) ON CONFLICT (user_id) DO UPDATE SET plan = $2, status = 'active', current_period_end = $3, updated_at = NOW()",
                [userId, newPlan, adminPeriodEnd]
            );
        }
        await enforceCardLimit(userId, newPlan);
        await audit(req.user.uid, 'change_plan', userId, { from: oldPlan, to: newPlan });

        res.json({ success: true, plan: newPlan });
    } catch (err) {
        console.error('Admin change plan error:', err);
        res.status(500).json({ error: 'Failed to change plan' });
    }
});

// PATCH /api/admin/users/:id/suspend — suspend or unsuspend
router.patch('/users/:id/suspend', async function (req, res) {
    try {
        var userId = req.params.id;
        var suspend = req.body.suspend;
        if (userId === req.user.uid) return res.status(400).json({ error: 'Cannot suspend yourself' });

        var targetResult = await db.query('SELECT role FROM users WHERE id = $1', [userId]);
        if (targetResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        if (targetResult.rows[0].role === 'superadmin') return res.status(400).json({ error: 'Cannot suspend a superadmin' });

        if (suspend) {
            await db.query('UPDATE users SET suspended_at = NOW(), updated_at = NOW() WHERE id = $1', [userId]);
        } else {
            await db.query('UPDATE users SET suspended_at = NULL, updated_at = NOW() WHERE id = $1', [userId]);
        }
        await audit(req.user.uid, suspend ? 'suspend_user' : 'unsuspend_user', userId, {});
        res.json({ success: true, suspended: !!suspend });
    } catch (err) {
        console.error('Admin suspend error:', err);
        res.status(500).json({ error: 'Failed to update suspension status' });
    }
});

// DELETE /api/admin/users/:id — delete user
router.delete('/users/:id', async function (req, res) {
    try {
        var userId = req.params.id;
        if (userId === req.user.uid) return res.status(400).json({ error: 'Cannot delete yourself' });

        var targetResult = await db.query('SELECT role, email FROM users WHERE id = $1', [userId]);
        if (targetResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        if (targetResult.rows[0].role === 'superadmin') return res.status(400).json({ error: 'Cannot delete a superadmin' });

        await audit(req.user.uid, 'delete_user', null, { deletedUserId: userId, deletedEmail: targetResult.rows[0].email });
        await db.query('DELETE FROM users WHERE id = $1', [userId]);
        res.json({ success: true });
    } catch (err) {
        console.error('Admin delete user error:', err);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// POST /api/admin/users/:id/contact — send email to user
router.post('/users/:id/contact', async function (req, res) {
    try {
        var userId = req.params.id;
        var subject = (req.body.subject || '').trim();
        var message = (req.body.message || '').trim();
        if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required' });
        if (subject.length > 200) return res.status(400).json({ error: 'Subject too long (max 200 chars)' });
        if (message.length > 10000) return res.status(400).json({ error: 'Message too long (max 10000 chars)' });

        var userResult = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });

        var adminResult = await db.query('SELECT name FROM users WHERE id = $1', [req.user.uid]);
        var adminName = adminResult.rows.length > 0 ? adminResult.rows[0].name : 'Admin';

        await sendAdminEmail(userResult.rows[0].email, subject, message, adminName);
        await audit(req.user.uid, 'contact_user', userId, { subject: subject });
        res.json({ success: true });
    } catch (err) {
        console.error('Contact user error:', err);
        res.status(500).json({ error: 'Failed to send email' });
    }
});

// POST /api/admin/users/:id/subscription — manual subscription grant
router.post('/users/:id/subscription', async function (req, res) {
    try {
        var userId = req.params.id;
        var plan = req.body.plan;
        var durationDays = parseInt(req.body.durationDays) || 30;
        var reason = (req.body.reason || '').trim();
        if (!['pro', 'business'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
        if (durationDays < 1 || durationDays > 365) return res.status(400).json({ error: 'Duration must be 1-365 days' });

        var userResult = await db.query('SELECT id FROM users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });

        var periodEnd = Math.floor(Date.now() / 1000) + (durationDays * 86400);
        await db.query(
            "INSERT INTO subscriptions (user_id, plan, status, current_period_end, updated_at) VALUES ($1, $2, 'admin_granted', $3, NOW()) " +
            "ON CONFLICT (user_id) DO UPDATE SET plan = $2, status = 'admin_granted', current_period_end = $3, updated_at = NOW()",
            [userId, plan, periodEnd]
        );
        await db.query('UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2', [plan, userId]);
        await enforceCardLimit(userId, plan);
        await audit(req.user.uid, 'grant_subscription', userId, { plan: plan, durationDays: durationDays, reason: reason });

        res.json({ success: true, plan: plan, durationDays: durationDays });
    } catch (err) {
        console.error('Grant subscription error:', err);
        res.status(500).json({ error: 'Failed to grant subscription' });
    }
});

// POST /api/admin/users/bulk-plan — bulk plan change
router.post('/users/bulk-plan', async function (req, res) {
    try {
        var userIds = req.body.userIds;
        var plan = req.body.plan;
        if (!Array.isArray(userIds) || userIds.length === 0) return res.status(400).json({ error: 'No users selected' });
        if (!['free', 'pro', 'business'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
        if (userIds.length > 100) return res.status(400).json({ error: 'Max 100 users at a time' });

        var updated = 0;
        for (var i = 0; i < userIds.length; i++) {
            // Skip superadmins to prevent accidental downgrade
            var roleCheck = await db.query('SELECT role FROM users WHERE id = $1', [userIds[i]]);
            if (roleCheck.rows.length === 0) continue; // user doesn't exist
            if (roleCheck.rows[0].role === 'superadmin') continue;
            await db.query('UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2', [plan, userIds[i]]);
            // Upsert subscription record to stay in sync
            if (plan === 'free') {
                await db.query("UPDATE subscriptions SET plan = 'free', status = 'admin_downgrade', updated_at = NOW() WHERE user_id = $1", [userIds[i]]);
            } else {
                var bulkPeriodEnd = Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000);
                await db.query(
                    "INSERT INTO subscriptions (user_id, plan, status, current_period_end, updated_at) VALUES ($1, $2, 'active', $3, NOW()) ON CONFLICT (user_id) DO UPDATE SET plan = $2, status = 'active', current_period_end = $3, updated_at = NOW()",
                    [userIds[i], plan, bulkPeriodEnd]
                );
            }
            await enforceCardLimit(userIds[i], plan);
            updated++;
        }
        await audit(req.user.uid, 'bulk_plan_change', null, { plan: plan, count: updated, userIds: userIds });
        res.json({ success: true, updated: updated });
    } catch (err) {
        console.error('Bulk plan change error:', err);
        res.status(500).json({ error: 'Failed to change plans' });
    }
});

// POST /api/admin/users/bulk-suspend — bulk suspend
router.post('/users/bulk-suspend', async function (req, res) {
    try {
        var userIds = req.body.userIds;
        var suspend = req.body.suspend;
        if (!Array.isArray(userIds) || userIds.length === 0) return res.status(400).json({ error: 'No users selected' });
        if (userIds.length > 100) return res.status(400).json({ error: 'Max 100 users at a time' });

        // Filter out superadmins and self
        var safe = await db.query("SELECT id FROM users WHERE id = ANY($1) AND role != 'superadmin' AND id != $2", [userIds, req.user.uid]);
        var safeIds = safe.rows.map(function (r) { return r.id; });

        if (suspend) {
            await db.query("UPDATE users SET suspended_at = NOW(), updated_at = NOW() WHERE id = ANY($1)", [safeIds]);
        } else {
            await db.query("UPDATE users SET suspended_at = NULL, updated_at = NOW() WHERE id = ANY($1)", [safeIds]);
        }
        await audit(req.user.uid, 'bulk_suspend', null, { suspend: suspend, count: safeIds.length, userIds: safeIds });
        res.json({ success: true, updated: safeIds.length });
    } catch (err) {
        console.error('Bulk suspend error:', err);
        res.status(500).json({ error: 'Failed to update suspensions' });
    }
});

// GET /api/admin/users/:id/leads — paginated leads for a user
router.get('/users/:id/leads', async function (req, res) {
    try {
        var userId = req.params.id;
        var page = Math.max(1, parseInt(req.query.page) || 1);
        var limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
        var offset = (page - 1) * limit;

        var countResult = await db.query('SELECT COUNT(*) FROM leads WHERE user_id = $1', [userId]);
        var total = parseInt(countResult.rows[0].count);

        var leadsResult = await db.query(
            'SELECT id, data, created_at FROM leads WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
            [userId, limit, offset]
        );

        res.json({ leads: leadsResult.rows, total: total, page: page, limit: limit, totalPages: Math.ceil(total / limit) });
    } catch (err) {
        console.error('Admin user leads error:', err);
        res.status(500).json({ error: 'Failed to load leads' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/payments — paginated payments list
router.get('/payments', async function (req, res) {
    try {
        var page = Math.max(1, parseInt(req.query.page) || 1);
        var limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
        var offset = (page - 1) * limit;
        var planFilter = req.query.plan || '';
        var statusFilter = req.query.status || '';
        var from = req.query.from || '';
        var to = req.query.to || '';

        var where = ["s.razorpay_payment_id IS NOT NULL"];
        var params = [];
        var idx = 1;

        if (planFilter && ['pro', 'business'].includes(planFilter)) {
            where.push("s.plan = $" + idx); params.push(planFilter); idx++;
        }
        if (statusFilter) {
            where.push("s.status = $" + idx); params.push(statusFilter); idx++;
        }
        if (from) {
            where.push("s.updated_at >= $" + idx); params.push(from); idx++;
        }
        if (to) {
            where.push("s.updated_at <= $" + idx + "::date + INTERVAL '1 day'"); params.push(to); idx++;
        }

        var whereClause = 'WHERE ' + where.join(' AND ');

        var countResult = await db.query('SELECT COUNT(*) FROM subscriptions s ' + whereClause, params);
        var total = parseInt(countResult.rows[0].count);

        var result = await db.query(
            'SELECT s.user_id, s.plan, s.status, s.razorpay_payment_id, s.razorpay_order_id, s.updated_at, ' +
            'u.email, u.name, u.username ' +
            'FROM subscriptions s JOIN users u ON u.id = s.user_id ' + whereClause +
            ' ORDER BY s.updated_at DESC LIMIT $' + idx + ' OFFSET $' + (idx + 1),
            params.concat([limit, offset])
        );

        res.json({
            payments: result.rows.map(function (r) {
                return {
                    userId: r.user_id, email: r.email, name: r.name, username: r.username,
                    plan: r.plan, status: r.status, paymentId: r.razorpay_payment_id,
                    orderId: r.razorpay_order_id, updatedAt: r.updated_at,
                    amount: PLAN_PRICES[r.plan] || 0
                };
            }),
            total: total, page: page, limit: limit, totalPages: Math.ceil(total / limit)
        });
    } catch (err) {
        console.error('Payments list error:', err);
        res.status(500).json({ error: 'Failed to load payments' });
    }
});

// GET /api/admin/payments/failed — failed/abandoned payments
router.get('/payments/failed', async function (req, res) {
    try {
        var page = Math.max(1, parseInt(req.query.page) || 1);
        var limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
        var offset = (page - 1) * limit;

        var countResult = await db.query("SELECT COUNT(*) FROM subscriptions WHERE razorpay_order_id IS NOT NULL AND razorpay_payment_id IS NULL");
        var total = parseInt(countResult.rows[0].count);

        var result = await db.query(
            "SELECT s.user_id, s.plan, s.razorpay_order_id, s.updated_at, u.email, u.name, u.username " +
            "FROM subscriptions s JOIN users u ON u.id = s.user_id " +
            "WHERE s.razorpay_order_id IS NOT NULL AND s.razorpay_payment_id IS NULL " +
            "ORDER BY s.updated_at DESC LIMIT $1 OFFSET $2",
            [limit, offset]
        );

        res.json({
            payments: result.rows.map(function (r) {
                return {
                    userId: r.user_id, email: r.email, name: r.name, username: r.username,
                    plan: r.plan, orderId: r.razorpay_order_id, updatedAt: r.updated_at
                };
            }),
            total: total, page: page, limit: limit, totalPages: Math.ceil(total / limit)
        });
    } catch (err) {
        console.error('Failed payments error:', err);
        res.status(500).json({ error: 'Failed to load failed payments' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/events — all events with counts
router.get('/events', async function (req, res) {
    try {
        var page = Math.max(1, parseInt(req.query.page) || 1);
        var limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
        var offset = (page - 1) * limit;
        var status = req.query.status || '';
        var search = (req.query.search || '').trim().toLowerCase();

        var where = [];
        var params = [];
        var idx = 1;

        if (status) {
            where.push("e.status = $" + idx); params.push(status); idx++;
        }
        if (search) {
            var escapedEventSearch = search.replace(/%/g, '\\%').replace(/_/g, '\\_');
            where.push("(LOWER(e.name) LIKE $" + idx + " OR LOWER(e.slug) LIKE $" + idx + ")");
            params.push('%' + escapedEventSearch + '%'); idx++;
        }
        var whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

        var countResult = await db.query('SELECT COUNT(*) FROM events e ' + whereClause, params);
        var total = parseInt(countResult.rows[0].count);

        var result = await db.query(
            'SELECT e.id, e.name, e.slug, e.status, e.start_date, e.end_date, e.created_at, ' +
            'u.name as organizer_name, u.email as organizer_email, u.username as organizer_username, ' +
            '(SELECT COUNT(*) FROM event_exhibitors WHERE event_id = e.id) as exhibitor_count, ' +
            '(SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id) as attendee_count, ' +
            '(SELECT COUNT(*) FROM booth_visits WHERE event_id = e.id) as visit_count ' +
            'FROM events e LEFT JOIN users u ON u.id = e.organizer_id ' + whereClause +
            ' ORDER BY e.created_at DESC LIMIT $' + idx + ' OFFSET $' + (idx + 1),
            params.concat([limit, offset])
        );

        res.json({
            events: result.rows.map(function (r) {
                return {
                    id: r.id, name: r.name, slug: r.slug, status: r.status,
                    startDate: r.start_date, endDate: r.end_date, createdAt: r.created_at,
                    organizer: { name: r.organizer_name, email: r.organizer_email, username: r.organizer_username },
                    exhibitorCount: parseInt(r.exhibitor_count), attendeeCount: parseInt(r.attendee_count),
                    visitCount: parseInt(r.visit_count)
                };
            }),
            total: total, page: page, limit: limit, totalPages: Math.ceil(total / limit)
        });
    } catch (err) {
        console.error('Admin events error:', err);
        res.status(500).json({ error: 'Failed to load events' });
    }
});

// GET /api/admin/events/:id — event detail
router.get('/events/:id', async function (req, res) {
    try {
        var eventId = req.params.id;
        var result = await db.query(
            'SELECT e.*, u.name as organizer_name, u.email as organizer_email, u.username as organizer_username FROM events e LEFT JOIN users u ON u.id = e.organizer_id WHERE e.id = $1',
            [eventId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });

        var ev = result.rows[0];
        var counts = await Promise.all([
            db.query('SELECT COUNT(*) FROM event_exhibitors WHERE event_id = $1', [eventId]),
            db.query('SELECT COUNT(*) FROM event_attendees WHERE event_id = $1', [eventId]),
            db.query('SELECT COUNT(*) FROM booth_visits WHERE event_id = $1', [eventId])
        ]);

        res.json({
            id: ev.id, name: ev.name, slug: ev.slug, description: ev.description,
            status: ev.status, startDate: ev.start_date, endDate: ev.end_date,
            venue: ev.venue, createdAt: ev.created_at,
            organizer: { name: ev.organizer_name, email: ev.organizer_email, username: ev.organizer_username },
            exhibitorCount: parseInt(counts[0].rows[0].count),
            attendeeCount: parseInt(counts[1].rows[0].count),
            visitCount: parseInt(counts[2].rows[0].count)
        });
    } catch (err) {
        console.error('Event detail error:', err);
        res.status(500).json({ error: 'Failed to load event' });
    }
});

// PATCH /api/admin/events/:id/status — change event status
router.patch('/events/:id/status', async function (req, res) {
    try {
        var eventId = req.params.id;
        var status = req.body.status;
        if (!['draft', 'published', 'live', 'completed', 'archived'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        await db.query('UPDATE events SET status = $1, updated_at = NOW() WHERE id = $2', [status, eventId]);
        await audit(req.user.uid, 'change_event_status', null, { eventId: eventId, status: status });
        res.json({ success: true, status: status });
    } catch (err) {
        console.error('Change event status error:', err);
        res.status(500).json({ error: 'Failed to change event status' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/search — global search
router.get('/search', async function (req, res) {
    try {
        var q = (req.query.q || '').trim().toLowerCase();
        if (!q || q.length < 2) return res.json({ users: [], cards: [], events: [] });

        var pattern = '%' + q.replace(/%/g, '\\%').replace(/_/g, '\\_') + '%';
        var results = await Promise.all([
            db.query(
                "SELECT id, email, name, username, plan FROM users WHERE LOWER(email) LIKE $1 OR LOWER(name) LIKE $1 OR LOWER(username) LIKE $1 LIMIT 5",
                [pattern]
            ),
            db.query(
                "SELECT c.id, c.user_id, c.data->>'name' as name, u.username FROM cards c JOIN users u ON u.id = c.user_id WHERE LOWER(c.data->>'name') LIKE $1 LIMIT 5",
                [pattern]
            ),
            db.query(
                "SELECT id, name, slug, status FROM events WHERE LOWER(name) LIKE $1 OR LOWER(slug) LIKE $1 LIMIT 5",
                [pattern]
            ).catch(function () { return { rows: [] }; })
        ]);

        res.json({
            users: results[0].rows,
            cards: results[1].rows.map(function (c) {
                return { id: c.id, userId: c.user_id, name: c.name, username: c.username };
            }),
            events: results[2].rows
        });
    } catch (err) {
        console.error('Search error:', err);
        res.status(500).json({ error: 'Search failed' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// ANNOUNCEMENTS
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/announcements
router.get('/announcements', async function (req, res) {
    try {
        var result = await db.query(
            'SELECT a.*, u.name as creator_name FROM announcements a LEFT JOIN users u ON u.id = a.created_by ORDER BY a.created_at DESC'
        );
        res.json({ announcements: result.rows });
    } catch (err) {
        console.error('Announcements list error:', err);
        res.status(500).json({ error: 'Failed to load announcements' });
    }
});

// POST /api/admin/announcements
router.post('/announcements', async function (req, res) {
    try {
        var title = (req.body.title || '').trim();
        var body = (req.body.body || '').trim();
        var type = req.body.type || 'info';
        var expiresAt = req.body.expiresAt || null;
        if (!title || !body) return res.status(400).json({ error: 'Title and body are required' });
        if (title.length > 200) return res.status(400).json({ error: 'Title too long (max 200 chars)' });
        if (body.length > 5000) return res.status(400).json({ error: 'Body too long (max 5000 chars)' });
        if (!['info', 'warning', 'success', 'error'].includes(type)) return res.status(400).json({ error: 'Invalid type' });

        var result = await db.query(
            'INSERT INTO announcements (title, body, type, created_by, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [title, body, type, req.user.uid, expiresAt]
        );
        await audit(req.user.uid, 'create_announcement', null, { title: title });
        res.json({ announcement: result.rows[0] });
    } catch (err) {
        console.error('Create announcement error:', err);
        res.status(500).json({ error: 'Failed to create announcement' });
    }
});

// PATCH /api/admin/announcements/:id
router.patch('/announcements/:id', async function (req, res) {
    try {
        var id = parseInt(req.params.id);
        var updates = [];
        var params = [];
        var idx = 1;

        if (req.body.title !== undefined) {
            if (typeof req.body.title !== 'string' || req.body.title.length > 200) return res.status(400).json({ error: 'Title too long (max 200 chars)' });
            updates.push("title = $" + idx); params.push(req.body.title); idx++;
        }
        if (req.body.body !== undefined) {
            if (typeof req.body.body !== 'string' || req.body.body.length > 5000) return res.status(400).json({ error: 'Body too long (max 5000 chars)' });
            updates.push("body = $" + idx); params.push(req.body.body); idx++;
        }
        if (req.body.type !== undefined) {
            if (!['info', 'warning', 'success', 'error'].includes(req.body.type)) return res.status(400).json({ error: 'Invalid type' });
            updates.push("type = $" + idx); params.push(req.body.type); idx++;
        }
        if (req.body.active !== undefined) {
            if (typeof req.body.active !== 'boolean') return res.status(400).json({ error: 'active must be a boolean' });
            updates.push("active = $" + idx); params.push(req.body.active); idx++;
        }
        if (req.body.expiresAt !== undefined) { updates.push("expires_at = $" + idx); params.push(req.body.expiresAt || null); idx++; }

        if (updates.length === 0) return res.status(400).json({ error: 'No updates provided' });

        params.push(id);
        await db.query('UPDATE announcements SET ' + updates.join(', ') + ' WHERE id = $' + idx, params);
        await audit(req.user.uid, 'update_announcement', null, { announcementId: id });
        res.json({ success: true });
    } catch (err) {
        console.error('Update announcement error:', err);
        res.status(500).json({ error: 'Failed to update announcement' });
    }
});

// DELETE /api/admin/announcements/:id
router.delete('/announcements/:id', async function (req, res) {
    try {
        await db.query('DELETE FROM announcements WHERE id = $1', [parseInt(req.params.id)]);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete announcement error:', err);
        res.status(500).json({ error: 'Failed to delete announcement' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// FEATURE FLAGS
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/feature-flags
router.get('/feature-flags', async function (req, res) {
    try {
        var result = await db.query('SELECT * FROM feature_flags ORDER BY key');
        res.json({ flags: result.rows });
    } catch (err) {
        console.error('Feature flags error:', err);
        res.status(500).json({ error: 'Failed to load feature flags' });
    }
});

// PATCH /api/admin/feature-flags/:key
router.patch('/feature-flags/:key', async function (req, res) {
    try {
        var key = req.params.key;
        var enabled = req.body.enabled;
        if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });

        await db.query(
            'UPDATE feature_flags SET enabled = $1, updated_at = NOW(), updated_by = $2 WHERE key = $3',
            [enabled, req.user.uid, key]
        );
        await audit(req.user.uid, 'toggle_feature_flag', null, { key: key, enabled: enabled });
        res.json({ success: true, key: key, enabled: enabled });
    } catch (err) {
        console.error('Toggle feature flag error:', err);
        res.status(500).json({ error: 'Failed to toggle feature flag' });
    }
});

// GET /api/admin/config/plans — plan configuration (read-only)
router.get('/config/plans', async function (req, res) {
    res.json({ limits: PLAN_LIMITS, prices: PLAN_PRICES });
});

// ═══════════════════════════════════════════════════════════════════
// REFERRALS
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/referrals — referral analytics
router.get('/referrals', async function (req, res) {
    try {
        var results = await Promise.all([
            db.query('SELECT COUNT(*) FROM referrals'),
            db.query("SELECT COUNT(*) FROM referrals WHERE status = 'signed_up'"),
            db.query(
                'SELECT u.id, u.name, u.email, u.username, COUNT(*) as count FROM referrals r ' +
                'JOIN users u ON u.id = r.referrer_id GROUP BY u.id, u.name, u.email, u.username ORDER BY count DESC LIMIT 10'
            )
        ]);

        res.json({
            totalReferrals: parseInt(results[0].rows[0].count),
            converted: parseInt(results[1].rows[0].count),
            topReferrers: results[2].rows.map(function (r) {
                return { id: r.id, name: r.name, email: r.email, username: r.username, count: parseInt(r.count) };
            })
        });
    } catch (err) {
        console.error('Referral analytics error:', err);
        res.status(500).json({ error: 'Failed to load referral data' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// TEAMS
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/teams — all teams overview
router.get('/teams', async function (req, res) {
    try {
        var result = await db.query(
            'SELECT t.id, t.name, t.created_at, u.name as owner_name, u.email as owner_email, u.username as owner_username, ' +
            '(SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count ' +
            'FROM teams t LEFT JOIN users u ON u.id = t.owner_id ORDER BY t.created_at DESC'
        );
        res.json({
            teams: result.rows.map(function (t) {
                return {
                    id: t.id, name: t.name, createdAt: t.created_at,
                    owner: { name: t.owner_name, email: t.owner_email, username: t.owner_username },
                    memberCount: parseInt(t.member_count)
                };
            })
        });
    } catch (err) {
        console.error('Teams overview error:', err);
        res.status(500).json({ error: 'Failed to load teams' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/export/payments — CSV
router.get('/export/payments', async function (req, res) {
    try {
        var result = await db.query(
            'SELECT s.user_id, s.plan, s.status, s.razorpay_payment_id, s.razorpay_order_id, s.updated_at, u.email, u.name, u.username ' +
            'FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.razorpay_payment_id IS NOT NULL ORDER BY s.updated_at DESC'
        );
        await audit(req.user.uid, 'export_data', null, { type: 'payments', count: result.rows.length });
        var csv = 'User ID,Email,Name,Username,Plan,Status,Payment ID,Order ID,Date\n';
        result.rows.forEach(function (r) {
            csv += csvVal(r.user_id) + ',' + csvVal(r.email) + ',' + csvVal(r.name) + ',' + csvVal(r.username) + ',' +
                csvVal(r.plan) + ',' + csvVal(r.status) + ',' + csvVal(r.razorpay_payment_id) + ',' +
                csvVal(r.razorpay_order_id) + ',' + csvVal(fmtIso(r.updated_at)) + '\n';
        });
        res.set('Content-Type', 'text/csv');
        res.set('Content-Disposition', 'attachment; filename="cardflow-payments-' + new Date().toISOString().split('T')[0] + '.csv"');
        res.send(csv);
    } catch (err) {
        console.error('Export payments error:', err);
        res.status(500).json({ error: 'Failed to export payments' });
    }
});

// GET /api/admin/export/events — CSV
router.get('/export/events', async function (req, res) {
    try {
        var result = await db.query(
            'SELECT e.id, e.name, e.slug, e.status, e.start_date, e.end_date, e.created_at, u.email as organizer_email, ' +
            '(SELECT COUNT(*) FROM event_exhibitors WHERE event_id = e.id) as exhibitor_count, ' +
            '(SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id) as attendee_count, ' +
            '(SELECT COUNT(*) FROM booth_visits WHERE event_id = e.id) as visit_count ' +
            'FROM events e LEFT JOIN users u ON u.id = e.organizer_id ORDER BY e.created_at DESC'
        );
        await audit(req.user.uid, 'export_data', null, { type: 'events', count: result.rows.length });
        var csv = 'ID,Name,Slug,Status,Start Date,End Date,Organizer,Exhibitors,Attendees,Visits,Created\n';
        result.rows.forEach(function (r) {
            csv += r.id + ',' + csvVal(r.name) + ',' + csvVal(r.slug) + ',' + csvVal(r.status) + ',' +
                csvVal(fmtIso(r.start_date)) + ',' + csvVal(fmtIso(r.end_date)) + ',' + csvVal(r.organizer_email) + ',' +
                r.exhibitor_count + ',' + r.attendee_count + ',' + r.visit_count + ',' + csvVal(fmtIso(r.created_at)) + '\n';
        });
        res.set('Content-Type', 'text/csv');
        res.set('Content-Disposition', 'attachment; filename="cardflow-events-' + new Date().toISOString().split('T')[0] + '.csv"');
        res.send(csv);
    } catch (err) {
        console.error('Export events error:', err);
        res.status(500).json({ error: 'Failed to export events' });
    }
});

// GET /api/admin/export/leads — CSV
router.get('/export/leads', async function (req, res) {
    try {
        var result = await db.query(
            "SELECT l.id, l.data->>'name' as name, l.data->>'email' as email, l.data->>'phone' as phone, " +
            "l.data->>'source' as source, l.created_at, u.email as owner_email, u.username as owner_username " +
            "FROM leads l JOIN users u ON u.id = l.user_id ORDER BY l.created_at DESC LIMIT 10000"
        );
        await audit(req.user.uid, 'export_data', null, { type: 'leads', count: result.rows.length });
        var csv = 'ID,Name,Email,Phone,Source,Owner Email,Owner Username,Created\n';
        result.rows.forEach(function (r) {
            csv += r.id + ',' + csvVal(r.name) + ',' + csvVal(r.email) + ',' + csvVal(r.phone) + ',' +
                csvVal(r.source) + ',' + csvVal(r.owner_email) + ',' + csvVal(r.owner_username) + ',' +
                csvVal(fmtIso(r.created_at)) + '\n';
        });
        res.set('Content-Type', 'text/csv');
        res.set('Content-Disposition', 'attachment; filename="cardflow-leads-' + new Date().toISOString().split('T')[0] + '.csv"');
        res.send(csv);
    } catch (err) {
        console.error('Export leads error:', err);
        res.status(500).json({ error: 'Failed to export leads' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/audit-log — paginated audit log
router.get('/audit-log', async function (req, res) {
    try {
        var page = Math.max(1, parseInt(req.query.page) || 1);
        var limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
        var offset = (page - 1) * limit;

        var countResult = await db.query('SELECT COUNT(*) FROM admin_audit_log');
        var total = parseInt(countResult.rows[0].count);

        var logsResult = await db.query(
            'SELECT a.id, a.action, a.details, a.created_at, ' +
            'admin_u.email as admin_email, admin_u.name as admin_name, ' +
            'target_u.email as target_email, target_u.name as target_name ' +
            'FROM admin_audit_log a ' +
            'LEFT JOIN users admin_u ON admin_u.id = a.admin_id ' +
            'LEFT JOIN users target_u ON target_u.id = a.target_user_id ' +
            'ORDER BY a.created_at DESC LIMIT $1 OFFSET $2',
            [limit, offset]
        );

        res.json({
            logs: logsResult.rows.map(function (l) {
                return {
                    id: l.id, action: l.action, details: l.details, createdAt: l.created_at,
                    admin: { email: l.admin_email, name: l.admin_name },
                    target: l.target_email ? { email: l.target_email, name: l.target_name } : null
                };
            }),
            total: total, page: page, limit: limit, totalPages: Math.ceil(total / limit)
        });
    } catch (err) {
        console.error('Admin audit log error:', err);
        res.status(500).json({ error: 'Failed to load audit log' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// CSV HELPERS
// ═══════════════════════════════════════════════════════════════════

function csvVal(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    // Strip embedded newlines to prevent CSV row injection
    s = s.replace(/[\r\n]/g, ' ');
    // Prevent Excel formula injection — prefix dangerous chars
    if (s.length > 0 && '=+-@\t'.indexOf(s[0]) !== -1) {
        s = "'" + s;
    }
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

function fmtIso(d) {
    if (!d) return '';
    return new Date(d).toISOString();
}

// ── Card Verifications ──

// GET /api/admin/verifications — list verifications
router.get('/verifications', async function (req, res) {
    try {
        var page = Math.max(1, parseInt(req.query.page) || 1);
        var limit = 20;
        var offset = (page - 1) * limit;
        var status = req.query.status || 'escalated';

        var where = '';
        var params = [];
        if (status === 'escalated') {
            where = "WHERE cv.status IN ('escalated', 'ai_reviewing')";
        } else if (status !== 'all') {
            where = 'WHERE cv.status = $1';
            params.push(status);
        }

        var countQ = 'SELECT COUNT(*) FROM card_verifications cv ' + where;
        var countResult = await db.query(countQ, params);
        var total = parseInt(countResult.rows[0].count);

        var q = 'SELECT cv.id, cv.user_id, cv.card_id, cv.status, cv.card_email, cv.email_verified, cv.ai_result, cv.rejection_reason, cv.created_at, cv.reviewed_at, ' +
            'u.name as user_name, u.email as user_email, u.username, c.data as card_data ' +
            'FROM card_verifications cv ' +
            'LEFT JOIN users u ON u.id = cv.user_id ' +
            'LEFT JOIN cards c ON c.user_id = cv.user_id AND c.id = cv.card_id ' +
            where + ' ORDER BY cv.created_at DESC LIMIT ' + limit + ' OFFSET ' + offset;
        var result = await db.query(q, params);

        res.json({
            verifications: result.rows.map(function (r) {
                return {
                    id: r.id, userId: r.user_id, cardId: r.card_id, status: r.status,
                    cardEmail: r.card_email, emailVerified: r.email_verified,
                    aiResult: r.ai_result, rejectionReason: r.rejection_reason,
                    createdAt: r.created_at, reviewedAt: r.reviewed_at,
                    userName: r.user_name, userEmail: r.user_email, username: r.username,
                    cardName: r.card_data && r.card_data.name, cardCompany: r.card_data && r.card_data.company
                };
            }),
            total: total,
            page: page,
            pages: Math.ceil(total / limit)
        });
    } catch (err) {
        console.error('Admin list verifications error:', err);
        res.status(500).json({ error: 'Failed to load verifications' });
    }
});

// GET /api/admin/verifications/:id — full details
router.get('/verifications/:id', async function (req, res) {
    try {
        var result = await db.query(
            'SELECT cv.*, u.name as user_name, u.email as user_email, u.username, c.data as card_data ' +
            'FROM card_verifications cv ' +
            'LEFT JOIN users u ON u.id = cv.user_id ' +
            'LEFT JOIN cards c ON c.user_id = cv.user_id AND c.id = cv.card_id ' +
            'WHERE cv.id = $1', [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        var r = result.rows[0];
        res.json({
            id: r.id, userId: r.user_id, cardId: r.card_id, status: r.status,
            cardEmail: r.card_email, emailVerified: r.email_verified,
            documents: r.documents, aiResult: r.ai_result,
            adminNote: r.admin_note, rejectionReason: r.rejection_reason,
            createdAt: r.created_at, reviewedAt: r.reviewed_at,
            userName: r.user_name, userEmail: r.user_email, username: r.username,
            cardData: r.card_data
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load verification' });
    }
});

// POST /api/admin/verifications/:id/approve
router.post('/verifications/:id/approve', async function (req, res) {
    try {
        var note = (req.body.note || '').trim().substring(0, 500);
        var vResult = await db.query('SELECT user_id, card_id, card_email, status FROM card_verifications WHERE id = $1', [req.params.id]);
        if (vResult.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        var v = vResult.rows[0];

        await db.query(
            "UPDATE card_verifications SET status = 'approved', admin_id = $1, admin_note = $2, reviewed_at = NOW() WHERE id = $3",
            [req.user.uid, note, req.params.id]
        );
        await db.query('UPDATE cards SET verified_at = NOW() WHERE user_id = $1 AND id = $2', [v.user_id, v.card_id]);

        // Audit log
        await db.query(
            'INSERT INTO admin_audit_log (admin_id, action, target_user_id, details) VALUES ($1, $2, $3, $4)',
            [req.user.uid, 'approve_verification', v.user_id, JSON.stringify({ verification_id: parseInt(req.params.id), card_id: v.card_id })]
        );

        // Send email
        var { sendVerificationApproved } = require('../email');
        var cardResult = await db.query('SELECT data FROM cards WHERE user_id = $1 AND id = $2', [v.user_id, v.card_id]);
        var cardName = (cardResult.rows[0] && cardResult.rows[0].data && cardResult.rows[0].data.name) || 'Your card';
        sendVerificationApproved(v.card_email, cardName).catch(function () {});

        res.json({ success: true });
    } catch (err) {
        console.error('Admin approve verification error:', err);
        res.status(500).json({ error: 'Failed to approve' });
    }
});

// POST /api/admin/verifications/:id/reject
router.post('/verifications/:id/reject', async function (req, res) {
    try {
        var reason = (req.body.reason || '').trim().substring(0, 500);
        if (!reason) return res.status(400).json({ error: 'Rejection reason is required' });

        var vResult = await db.query('SELECT user_id, card_id, card_email FROM card_verifications WHERE id = $1', [req.params.id]);
        if (vResult.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        var v = vResult.rows[0];

        await db.query(
            "UPDATE card_verifications SET status = 'rejected', admin_id = $1, rejection_reason = $2, reviewed_at = NOW() WHERE id = $3",
            [req.user.uid, reason, req.params.id]
        );

        await db.query(
            'INSERT INTO admin_audit_log (admin_id, action, target_user_id, details) VALUES ($1, $2, $3, $4)',
            [req.user.uid, 'reject_verification', v.user_id, JSON.stringify({ verification_id: parseInt(req.params.id), card_id: v.card_id, reason: reason })]
        );

        var { sendVerificationRejected } = require('../email');
        var cardResult = await db.query('SELECT data FROM cards WHERE user_id = $1 AND id = $2', [v.user_id, v.card_id]);
        var cardName = (cardResult.rows[0] && cardResult.rows[0].data && cardResult.rows[0].data.name) || 'Your card';
        sendVerificationRejected(v.card_email, cardName, reason).catch(function () {});

        res.json({ success: true });
    } catch (err) {
        console.error('Admin reject verification error:', err);
        res.status(500).json({ error: 'Failed to reject' });
    }
});

module.exports = router;
