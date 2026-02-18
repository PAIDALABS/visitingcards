require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const db = require('./db');
const sse = require('./sse');
const { verifyAuth, issueSSETicket } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (behind Nginx)
app.set('trust proxy', 1);

// Security headers (CSP disabled — heavy use of inline scripts/styles in HTML files)
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// CORS (env-configurable, defaults to production origins only)
var corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(function(s) { return s.trim(); })
    : ['https://card.cardflow.cloud', 'https://cardflow.cloud'];
if (process.env.NODE_ENV !== 'production') corsOrigins.push('http://localhost:3000');
app.use(cors({
    origin: corsOrigins,
    credentials: true
}));

// JSON parsing
app.use(express.json({ limit: '10mb' }));

// Request logger with response time (dev only — no auth details)
if (process.env.NODE_ENV !== 'production') {
    app.use(function (req, res, next) {
        if (req.path.startsWith('/api/')) {
            var start = Date.now();
            var origEnd = res.end;
            res.end = function () {
                var ms = Date.now() - start;
                console.log(req.method + ' ' + req.path + ' → ' + res.statusCode + ' (' + ms + 'ms)');
                origEnd.apply(res, arguments);
            };
        }
        next();
    });
}

// Prevent caching on API responses
app.use('/api', function (req, res, next) {
    res.set('Cache-Control', 'no-store');
    next();
});

// -- API Routes --
app.use('/api/auth', require('./routes/auth'));
app.use('/api/auth', require('./routes/verify'));
app.use('/api/cards', require('./routes/cards'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/taps', require('./routes/taps'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/account', require('./routes/account'));
app.use('/api/referrals', verifyAuth, require('./routes/referrals'));
app.use('/api/exchanges', require('./routes/exchanges'));
app.use('/api/teams', require('./routes/teams'));
app.use('/api/events', require('./routes/events'));
app.use('/api/exhibitor', require('./routes/exhibitor'));
app.use('/api/public', require('./routes/public'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/ocr', require('./routes/ocr'));

// -- SSE Ticket endpoint (short-lived single-use tickets for EventSource auth) --
app.get('/api/auth/sse-ticket', verifyAuth, function (req, res) {
    var ticket = issueSSETicket(req.user);
    res.json({ ticket: ticket });
});

// -- SSE Live Reload (unauthenticated, for all pages) --
app.get('/api/sse/reload', function (req, res) {
    sse.setupSSE(res);
    sse.subscribe('reload', res);
});

// -- SSE Routes (authenticated) --
app.get('/api/sse/taps', verifyAuth, function (req, res) {
    sse.setupSSE(res);
    sse.subscribe('latest:' + req.user.uid, res);
    // Send current latest tap on connect so dashboard picks up pending taps
    db.query('SELECT data FROM latest_tap WHERE user_id = $1', [req.user.uid])
        .then(function (result) {
            if (result.rows.length > 0 && result.rows[0].data) {
                try { res.write('data: ' + JSON.stringify(result.rows[0].data) + '\n\n'); } catch (e) {}
            }
        }).catch(function () {});
});

app.get('/api/sse/leads', verifyAuth, function (req, res) {
    sse.setupSSE(res);
    sse.subscribe('leads:' + req.user.uid, res);
});

app.get('/api/sse/lead/:leadId', verifyAuth, function (req, res) {
    sse.setupSSE(res);
    sse.subscribe('lead:' + req.user.uid + ':' + req.params.leadId, res);
});

// SSE for booth real-time lead feed (verify user is the exhibitor or event organizer)
app.get('/api/sse/booth/:eventId/:exhibitorId', verifyAuth, async function (req, res) {
    try {
        // Check if user is the exhibitor for this booth
        var exCheck = await db.query(
            'SELECT id FROM event_exhibitors WHERE id = $1 AND event_id = $2 AND user_id = $3',
            [parseInt(req.params.exhibitorId), req.params.eventId, req.user.uid]
        );
        if (exCheck.rows.length === 0) {
            // Also allow the event organizer
            var orgCheck = await db.query(
                'SELECT id FROM events WHERE id = $1 AND organizer_id = $2',
                [req.params.eventId, req.user.uid]
            );
            if (orgCheck.rows.length === 0) {
                return res.status(403).json({ error: 'Not authorized for this booth' });
            }
        }
        sse.setupSSE(res);
        sse.subscribe('booth:' + req.params.eventId + ':' + req.params.exhibitorId, res);
    } catch (err) {
        console.error('Booth SSE auth error:', err);
        res.status(500).json({ error: 'Failed to authorize booth SSE' });
    }
});

// -- Client config (Google Client ID etc.) --
app.get('/api/client-config', function (req, res) {
    res.type('application/javascript');
    var gcid = process.env.GOOGLE_CLIENT_ID || '';
    res.send('window.GOOGLE_CLIENT_ID=' + JSON.stringify(gcid) + ';');
});

// -- Static files --
app.use(express.static(path.join(__dirname, '..', 'public'), {
    extensions: ['html'],
    index: false
}));

// OG tag injection helper
var fs = require('fs');
var INDEX_PATH = path.join(__dirname, '..', 'public', 'index.html');
var indexHtmlCache = null;
function escOg(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;'); }
function injectOgTags(cardData, canonicalUrl) {
    var name = cardData.name || 'Digital Business Card';
    var title = cardData.title || '';
    var company = cardData.company || '';
    var subtitle = [title, company].filter(Boolean).join(' at ');
    var ogTitle = subtitle ? name + ' — ' + subtitle : name;
    var ogDesc = cardData.bio || ('Connect with ' + name + '. Tap to view their digital business card.');
    if (!indexHtmlCache) indexHtmlCache = fs.readFileSync(INDEX_PATH, 'utf8');
    var html = indexHtmlCache;
    html = html.replace('<title>Digital Business Card — CardFlow</title>', '<title>' + escOg(ogTitle) + ' — CardFlow</title>');
    html = html.replace('<meta property="og:title" content="Digital Business Card">', '<meta property="og:title" content="' + escOg(ogTitle) + '">');
    html = html.replace('<meta property="og:description" content="Tap to connect. Share your digital business card instantly.">', '<meta property="og:description" content="' + escOg(ogDesc.substring(0, 200)) + '">');
    if (canonicalUrl) {
        html = html.replace('<meta property="og:url" content="https://cardflow.cloud">', '<meta property="og:url" content="' + escOg(canonicalUrl) + '">');
    }
    return html;
}

// Root → landing page, or card if ?c= token present
app.get('/', async function (req, res) {
    var token = req.query.c;
    if (token) {
        try {
            var tokenResult = await db.query("SELECT data FROM cards WHERE data->>'token' = $1 AND active = true LIMIT 1", [token]);
            if (tokenResult.rows.length > 0) {
                var url = 'https://' + (req.hostname || 'cardflow.cloud') + '/?c=' + encodeURIComponent(token);
                return res.send(injectOgTags(tokenResult.rows[0].data, url));
            }
        } catch (err) {
            console.error('Token OG error:', err.message);
        }
        return res.sendFile(INDEX_PATH);
    }
    res.sendFile(path.join(__dirname, '..', 'public', 'landing.html'));
});

// -- Event page routes --
var PUBLIC_DIR = path.join(__dirname, '..', 'public');

// /events → organizer dashboard (auth checked client-side)
app.get('/events', function (req, res) {
    res.sendFile(path.join(PUBLIC_DIR, 'event-dashboard.html'));
});

// /e/:slug → public event page
app.get('/e/:slug', function (req, res) {
    res.sendFile(path.join(PUBLIC_DIR, 'event.html'));
});

// /e/:slug/b/:code → attendee badge page
app.get('/e/:slug/b/:code', function (req, res) {
    res.sendFile(path.join(PUBLIC_DIR, 'badge.html'));
});

// /booth/:eventId → exhibitor live booth dashboard
app.get('/booth/:eventId', function (req, res) {
    res.sendFile(path.join(PUBLIC_DIR, 'booth-dashboard.html'));
});

// /booth-setup/:eventId → exhibitor booth profile setup
app.get('/booth-setup/:eventId', function (req, res) {
    res.sendFile(path.join(PUBLIC_DIR, 'booth-setup.html'));
});

// /super-admin → super admin panel (auth checked client-side)
app.get('/super-admin', function (req, res) {
    res.sendFile(path.join(PUBLIC_DIR, 'super-admin.html'));
});
app.get('/admin', function (req, res) {
    res.redirect('/super-admin');
});

// SPA fallback for /username/cardname routes — with dynamic OG tags
app.get('*', async function (req, res) {
    if (req.path.startsWith('/api/') || req.path.includes('.')) {
        return res.status(404).json({ error: 'Not found' });
    }

    try {
        var cardData = null;
        var parts = req.path.split('/').filter(Boolean);

        // NFC instant redirect: if user has a default card, skip the waiting flow
        if (req.query.nfc === '1' && parts.length === 1) {
            var nfcUsername = parts[0].toLowerCase();
            var nfcUser = await db.query('SELECT id FROM users WHERE username = $1', [nfcUsername]);
            if (nfcUser.rows.length > 0) {
                var nfcUserId = nfcUser.rows[0].id;
                var nfcSettings = await db.query('SELECT default_card FROM user_settings WHERE user_id = $1', [nfcUserId]);
                var defCard = nfcSettings.rows.length > 0 ? nfcSettings.rows[0].default_card : null;
                if (defCard) {
                    var cardCheck = await db.query('SELECT 1 FROM cards WHERE user_id = $1 AND id = $2 AND active = true', [nfcUserId, defCard]);
                    if (cardCheck.rows.length > 0) {
                        return res.redirect('/' + encodeURIComponent(nfcUsername) + '/' + encodeURIComponent(defCard) + '?nfc=1');
                    }
                }
            }
            // No default card → fall through to serve index.html (NFC waiting flow)
        }

        if (parts.length >= 1 && parts.length <= 2) {
            var username = parts[0].toLowerCase();
            var userResult = await db.query('SELECT id FROM users WHERE username = $1', [username]);
            if (userResult.rows.length > 0) {
                var userId = userResult.rows[0].id;
                var cardId = parts[1] || null;
                if (cardId) {
                    var cardResult = await db.query('SELECT data FROM cards WHERE user_id = $1 AND id = $2 AND active = true', [userId, cardId]);
                    if (cardResult.rows.length > 0) cardData = cardResult.rows[0].data;
                }
                if (!cardData) {
                    var allCards = await db.query('SELECT data FROM cards WHERE user_id = $1 AND active = true LIMIT 1', [userId]);
                    if (allCards.rows.length > 0) cardData = allCards.rows[0].data;
                }
            }
        }

        if (cardData) {
            var url = 'https://' + (req.hostname || 'cardflow.cloud') + req.originalUrl;
            return res.send(injectOgTags(cardData, url));
        }
    } catch (err) {
        console.error('OG tag injection error:', err.message);
    }

    res.sendFile(INDEX_PATH);
});

// -- File watcher for live reload (dev only) --
if (process.env.NODE_ENV !== 'production') {
    var publicDir = path.join(__dirname, '..', 'public');
    var reloadTimeout = null;

    fs.watch(publicDir, { recursive: true }, function (eventType, filename) {
        if (!filename || filename.startsWith('.')) return;
        // Invalidate index.html cache when it changes
        if (filename === 'index.html') indexHtmlCache = null;
        clearTimeout(reloadTimeout);
        reloadTimeout = setTimeout(function () {
            console.log('File changed:', filename, '- sending reload');
            sse.publish('reload', { file: filename, ts: Date.now() });
        }, 300);
    });
}

// Hourly check: expire referral-based and paid subscriptions
setInterval(async function () {
    try {
        var nowEpoch = Math.floor(Date.now() / 1000);
        var { PLAN_LIMITS } = require('./routes/cards');
        var { enforceCardLimit } = require('./routes/billing');

        // 1. Expire referral-based pro subscriptions
        var result = await db.query(
            "SELECT s.user_id FROM subscriptions s WHERE s.status = 'referral' AND s.current_period_end < $1",
            [nowEpoch]
        );
        for (var i = 0; i < result.rows.length; i++) {
            var uid = result.rows[i].user_id;
            var paidSub = await db.query(
                "SELECT razorpay_payment_id FROM subscriptions WHERE user_id = $1 AND razorpay_payment_id IS NOT NULL AND status = 'active'",
                [uid]
            );
            if (paidSub.rows.length === 0 || !paidSub.rows[0].razorpay_payment_id) {
                await db.query("UPDATE users SET plan = 'free', updated_at = NOW() WHERE id = $1", [uid]);
                await db.query("UPDATE subscriptions SET plan = 'free', status = 'expired', updated_at = NOW() WHERE user_id = $1 AND status = 'referral'", [uid]);
                await enforceCardLimit(uid, 'free');
            }
        }

        // 2. Expire paid subscriptions past their period end
        var paidExpired = await db.query(
            "SELECT s.user_id FROM subscriptions s WHERE s.status = 'active' AND s.current_period_end IS NOT NULL AND s.current_period_end < $1",
            [nowEpoch]
        );
        for (var j = 0; j < paidExpired.rows.length; j++) {
            var puid = paidExpired.rows[j].user_id;
            await db.query("UPDATE users SET plan = 'free', updated_at = NOW() WHERE id = $1", [puid]);
            await db.query("UPDATE subscriptions SET plan = 'free', status = 'expired', updated_at = NOW() WHERE user_id = $1 AND status = 'active'", [puid]);
            await enforceCardLimit(puid, 'free');
        }
    } catch (err) {
        console.error('Subscription expiration check error:', err.message);
    }
}, 60 * 60 * 1000); // Every hour

// Weekly digest — runs every hour, sends on Monday 9am IST (3:30 UTC)
var emailModule = require('./email');
var lastDigestDate = null;

setInterval(async function () {
    try {
        var now = new Date();
        // IST = UTC + 5:30 — compute via epoch offset for correct hour and day
        var istDate = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
        var istHour = istDate.getUTCHours();
        var istDay = istDate.getUTCDay();

        // Only send on Monday between 9-10am IST
        var todayStr = now.toISOString().split('T')[0];
        if (istDay !== 1 || istHour < 9 || istHour >= 10 || lastDigestDate === todayStr) return;
        lastDigestDate = todayStr;

        if (process.env.NODE_ENV !== 'production') console.log('Running weekly digest...');

        // Find opted-in Pro/Business users
        var users = await db.query(
            "SELECT u.id, u.email, u.name, u.plan FROM users u " +
            "JOIN user_settings s ON s.user_id = u.id " +
            "WHERE u.plan IN ('pro', 'business') AND (s.data->>'weeklyDigest')::boolean = true"
        );

        if (users.rows.length === 0) return;

        var weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        var twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

        for (var i = 0; i < users.rows.length; i++) {
            var user = users.rows[i];
            try {
                // Get all analytics for this user
                var analyticsResult = await db.query(
                    'SELECT card_id, metric, data FROM analytics WHERE user_id = $1',
                    [user.id]
                );

                var views = 0, prevViews = 0, saves = 0, leads = 0;
                var cardViews = {};

                analyticsResult.rows.forEach(function (row) {
                    if (!Array.isArray(row.data)) return;
                    row.data.forEach(function (entry) {
                        var ts = entry.timestamp || entry.ts || '';
                        if (ts >= weekAgo) {
                            if (row.metric === 'views') {
                                views++;
                                cardViews[row.card_id] = (cardViews[row.card_id] || 0) + 1;
                            }
                            if (row.metric === 'saves') saves++;
                        }
                        if (ts >= twoWeeksAgo && ts < weekAgo) {
                            if (row.metric === 'views') prevViews++;
                        }
                    });
                });

                // Count leads from last week
                var leadsResult = await db.query(
                    'SELECT count(*) FROM leads WHERE user_id = $1 AND created_at >= $2',
                    [user.id, weekAgo]
                );
                leads = parseInt(leadsResult.rows[0].count) || 0;

                // Find top card
                var topCard = null, topCardViews = 0;
                Object.keys(cardViews).forEach(function (cid) {
                    if (cardViews[cid] > topCardViews) {
                        topCardViews = cardViews[cid];
                        topCard = cid;
                    }
                });

                // Get card name if we have a top card
                var topCardName = topCard;
                if (topCard) {
                    var cardResult = await db.query(
                        "SELECT data->>'name' as name FROM cards WHERE user_id = $1 AND id = $2",
                        [user.id, topCard]
                    );
                    if (cardResult.rows.length > 0 && cardResult.rows[0].name) {
                        topCardName = cardResult.rows[0].name;
                    }
                }

                // Skip if zero activity
                if (views === 0 && leads === 0 && saves === 0) continue;

                await emailModule.sendWeeklyDigest(user.email, user.name, {
                    views: views,
                    leads: leads,
                    saves: saves,
                    topCard: topCardName,
                    topCardViews: topCardViews,
                    prevViews: prevViews
                });

                if (process.env.NODE_ENV !== 'production') console.log('Digest sent to:', user.email);
            } catch (userErr) {
                console.error('Digest error for user ' + user.id + ':', userErr.message);
            }
        }

        if (process.env.NODE_ENV !== 'production') console.log('Weekly digest complete');
    } catch (err) {
        console.error('Weekly digest cron error:', err.message);
    }
}, 60 * 60 * 1000); // Check every hour

// ── Global error handler (must be after all routes) ──
app.use(function (err, req, res, next) {
    console.error('Unhandled error on ' + req.method + ' ' + req.path + ':', err.message);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Catch unhandled promise rejections
process.on('unhandledRejection', function (reason) {
    console.error('Unhandled rejection:', reason);
});

// Start
var server = app.listen(PORT, function () {
    console.log('CardFlow server running on port ' + PORT);
});

// ── Graceful shutdown ──
function shutdown(signal) {
    console.log(signal + ' received — shutting down gracefully');
    server.close(function () {
        console.log('HTTP server closed');
        db.end().then(function () {
            console.log('DB pool drained');
            process.exit(0);
        }).catch(function () {
            process.exit(0);
        });
    });
    // Force exit after 10s if graceful shutdown stalls
    setTimeout(function () { console.error('Forced exit after timeout'); process.exit(1); }, 10000);
}
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('SIGINT', function () { shutdown('SIGINT'); });
