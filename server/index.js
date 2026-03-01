require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const db = require('./db');
const sse = require('./sse');
const { verifyAuth, requireNotSuspended, requireFeatureFlag, issueSSETicket } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (behind Nginx)
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://checkout.razorpay.com", "https://accounts.google.com", "https://apis.google.com", "https://cdn.jsdelivr.net", "https://unpkg.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://accounts.google.com"],
            imgSrc: ["'self'", "data:", "blob:", "https:"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            connectSrc: ["'self'", "https://api.razorpay.com", "https://lumberjack.razorpay.com", "https://accounts.google.com"],
            frameSrc: ["'self'", "https://api.razorpay.com", "https://accounts.google.com"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            scriptSrcAttr: ["'unsafe-inline'"]
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// Response compression (API JSON — Nginx handles static files)
var compression = require('compression');
app.use(compression());

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
app.use(express.json({ limit: '2mb' }));

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

// Global API rate limiter (300 req/min per IP)
var rateLimit = require('express-rate-limit');
var globalApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    message: { error: 'Too many requests' },
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api', globalApiLimiter);

// Impersonation audit logging (tracks admin actions while impersonating users)
app.use('/api', function (req, res, next) {
    var origEnd = res.end;
    res.end = function () {
        if (req.user && req.user.impersonatedBy && ['POST', 'PUT', 'PATCH', 'DELETE'].indexOf(req.method) !== -1) {
            console.log('[IMPERSONATION] Admin ' + req.user.impersonatedBy + ' as ' + req.user.uid + ': ' + req.method + ' ' + req.path + ' \u2192 ' + res.statusCode);
        }
        origEnd.apply(res, arguments);
    };
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
app.use('/api/referrals', verifyAuth, requireNotSuspended, requireFeatureFlag('referrals_enabled'), require('./routes/referrals'));
app.use('/api/exchanges', requireFeatureFlag('card_exchange_enabled'), require('./routes/exchanges'));
app.use('/api/teams', requireFeatureFlag('teams_enabled'), require('./routes/teams'));
app.use('/api/events', requireFeatureFlag('events_enabled'), require('./routes/events'));
app.use('/api/exhibitor', requireFeatureFlag('events_enabled'), require('./routes/exhibitor'));
app.use('/api/public', require('./routes/public'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/ocr', require('./routes/ocr'));
app.use('/api/sequences', require('./routes/sequences'));
app.use('/api/verification', require('./routes/card-verification'));

// -- SSE Ticket endpoint (short-lived single-use tickets for EventSource auth) --
app.get('/api/auth/sse-ticket', verifyAuth, requireNotSuspended, function (req, res) {
    var ticket = issueSSETicket(req.user);
    res.json({ ticket: ticket });
});

// -- SSE Live Reload (unauthenticated, for all pages) --
app.get('/api/sse/reload', function (req, res) {
    sse.setupSSE(res);
    sse.subscribe('reload', res);
});

// -- SSE Routes (authenticated) --
app.get('/api/sse/taps', verifyAuth, requireNotSuspended, function (req, res) {
    var ch = 'latest:' + req.user.uid;
    if (!sse.canSubscribe(ch)) return res.status(429).json({ error: 'Too many SSE connections' });
    sse.setupSSE(res);
    sse.subscribe(ch, res);
    // Send current latest tap on connect so dashboard picks up pending taps
    db.query('SELECT data FROM latest_tap WHERE user_id = $1', [req.user.uid])
        .then(function (result) {
            if (result.rows.length > 0 && result.rows[0].data) {
                try { res.write('data: ' + JSON.stringify(result.rows[0].data) + '\n\n'); } catch (e) {}
            }
        }).catch(function () {});
});

app.get('/api/sse/leads', verifyAuth, requireNotSuspended, function (req, res) {
    var ch = 'leads:' + req.user.uid;
    if (!sse.canSubscribe(ch)) return res.status(429).json({ error: 'Too many SSE connections' });
    sse.setupSSE(res);
    sse.subscribe(ch, res);
});

app.get('/api/sse/team', verifyAuth, requireNotSuspended, async function (req, res) {
    try {
        var membership = await db.query('SELECT team_id FROM team_members WHERE user_id = $1', [req.user.uid]);
        if (membership.rows.length === 0) return res.status(404).json({ error: 'Not in a team' });
        var ch = 'team:' + membership.rows[0].team_id;
        if (!sse.canSubscribe(ch)) return res.status(429).json({ error: 'Too many SSE connections' });
        sse.setupSSE(res);
        sse.subscribe(ch, res);
    } catch (err) {
        res.status(500).json({ error: 'Team SSE error' });
    }
});

app.get('/api/sse/lead/:leadId', verifyAuth, requireNotSuspended, function (req, res) {
    var ch = 'lead:' + req.user.uid + ':' + req.params.leadId;
    if (!sse.canSubscribe(ch)) return res.status(429).json({ error: 'Too many SSE connections' });
    sse.setupSSE(res);
    sse.subscribe(ch, res);
});

// SSE for booth real-time lead feed (verify user is the exhibitor or event organizer)
app.get('/api/sse/booth/:eventId/:exhibitorId', verifyAuth, requireNotSuspended, async function (req, res) {
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

// -- Health check --
app.get('/api/health', async function (req, res) {
    try {
        await db.query('SELECT 1');
        res.json({ ok: true, ts: Date.now() });
    } catch (err) {
        res.status(503).json({ ok: false, error: 'Database unreachable' });
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
function escOg(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;').replace(/`/g,'&#96;'); }
function injectOgTags(cardData, canonicalUrl, userId, cardId, bundle) {
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
    // Inject card photo into og:image if available (only HTTPS URLs, not base64)
    if (cardData.photo && typeof cardData.photo === 'string' && cardData.photo.startsWith('https://')) {
        html = html.replace(/<meta property="og:image" content="[^"]*">/, '<meta property="og:image" content="' + escOg(cardData.photo) + '">');
        html = html.replace(/<meta name="twitter:image" content="[^"]*">/, '<meta name="twitter:image" content="' + escOg(cardData.photo) + '">');
    }
    // Inject resolved userId/cardId so client skips username→userId API call
    var extraHead = '';
    if (userId) {
        extraHead += '<meta name="cf-user-id" content="' + escOg(userId) + '">';
        if (cardId) extraHead += '<meta name="cf-card-id" content="' + escOg(cardId) + '">';
    }
    // Embed full card bundle so client needs ZERO API calls
    if (bundle) {
        extraHead += '<script>window.__CF_BUNDLE=' + JSON.stringify(bundle).replace(/<\//g, '<\\/') + '</script>';
    }
    if (extraHead) {
        html = html.replace('</head>', extraHead + '</head>');
    }
    return html;
}

// Root → landing page, or card if ?c= token present
app.get('/', async function (req, res) {
    var token = req.query.c;
    if (token) {
        try {
            var tokenResult = await db.query("SELECT data, user_id, id as card_id FROM cards WHERE data->>'token' = $1 AND active = true LIMIT 1", [token]);
            if (tokenResult.rows.length > 0) {
                var tUid = tokenResult.rows[0].user_id;
                // Fetch full bundle for token-based card views too
                var tBundleResults = await Promise.all([
                    db.query('SELECT id, data, verified_at FROM cards WHERE user_id = $1 AND active = true', [tUid]),
                    db.query('SELECT default_card FROM user_settings WHERE user_id = $1', [tUid]),
                    db.query('SELECT name, username, plan FROM users WHERE id = $1', [tUid])
                ]);
                var tCards = {};
                tBundleResults[0].rows.forEach(function (row) {
                    var c = row.data;
                    if (row.verified_at) c.verified_at = row.verified_at;
                    tCards[row.id] = c;
                });
                var tDefaultCard = tBundleResults[1].rows.length > 0 ? tBundleResults[1].rows[0].default_card : null;
                var tProfile = tBundleResults[2].rows.length > 0 ? tBundleResults[2].rows[0] : null;
                var tBundle = { cards: tCards, settings: { defaultCard: tDefaultCard }, profile: tProfile };
                var url = 'https://' + (req.hostname || 'cardflow.cloud') + '/?c=' + encodeURIComponent(token);
                return res.send(injectOgTags(tokenResult.rows[0].data, url, tUid, tokenResult.rows[0].card_id, tBundle));
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

        // NFC taps (?nfc=1) always go through the waiting flow so the owner
        // can pick which card to share. The default card is used as a 45-second
        // timeout fallback on the client side.

        if (parts.length >= 1 && parts.length <= 2) {
            var username = parts[0].toLowerCase();
            var cardId = parts[1] || null;

            // Resolve username → userId first
            var userResult = await db.query(
                'SELECT u.id as user_id, u.name, u.username, u.plan FROM users u WHERE u.username = $1',
                [username]
            );
            if (userResult.rows.length > 0) {
                var resolvedUid = userResult.rows[0].user_id;
                // Fetch all cards + settings in parallel for the bundle
                var bundleResults = await Promise.all([
                    db.query('SELECT id, data, verified_at FROM cards WHERE user_id = $1 AND active = true', [resolvedUid]),
                    db.query('SELECT default_card FROM user_settings WHERE user_id = $1', [resolvedUid])
                ]);
                var allCards = {};
                bundleResults[0].rows.forEach(function (row) {
                    var c = row.data;
                    if (row.verified_at) c.verified_at = row.verified_at;
                    allCards[row.id] = c;
                });
                var defaultCard = bundleResults[1].rows.length > 0 ? bundleResults[1].rows[0].default_card : null;
                var profile = { name: userResult.rows[0].name, username: userResult.rows[0].username, plan: userResult.rows[0].plan };

                // Pick OG card (specific slug > default > first)
                var resolvedCid = cardId && allCards[cardId] ? cardId : (defaultCard && allCards[defaultCard] ? defaultCard : Object.keys(allCards)[0]);
                if (resolvedCid && allCards[resolvedCid]) {
                    cardData = allCards[resolvedCid];
                    var bundle = { cards: allCards, settings: { defaultCard: defaultCard }, profile: profile };
                }
            }
        }

        if (cardData) {
            var url = 'https://' + (req.hostname || 'cardflow.cloud') + req.originalUrl;
            return res.send(injectOgTags(cardData, url, resolvedUid, resolvedCid, bundle));
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
            try {
                var uid = result.rows[i].user_id;
                await db.query("UPDATE users SET plan = 'free', updated_at = NOW() WHERE id = $1", [uid]);
                await db.query("UPDATE subscriptions SET plan = 'free', status = 'expired', updated_at = NOW() WHERE user_id = $1 AND status = 'referral'", [uid]);
                // Revoke organizer role on referral expiry
                await db.query("UPDATE users SET role = 'user' WHERE id = $1 AND role = 'organizer'", [uid]);
                await enforceCardLimit(uid, 'free');
            } catch (userErr) {
                console.error('Referral expiry failed for user ' + result.rows[i].user_id + ':', userErr.message);
            }
        }

        // 2. Expire paid subscriptions past their period end (both 'active' and 'cancelled')
        var paidExpired = await db.query(
            "SELECT s.user_id FROM subscriptions s WHERE s.status IN ('active', 'cancelled') AND s.plan != 'free' AND s.current_period_end IS NOT NULL AND s.current_period_end < $1",
            [nowEpoch]
        );
        for (var j = 0; j < paidExpired.rows.length; j++) {
            try {
                var puid = paidExpired.rows[j].user_id;
                await db.query("UPDATE users SET plan = 'free', updated_at = NOW() WHERE id = $1", [puid]);
                await db.query("UPDATE subscriptions SET plan = 'free', status = 'expired', updated_at = NOW() WHERE user_id = $1 AND status IN ('active', 'cancelled')", [puid]);
                // Revoke organizer role on plan downgrade (only if role is 'organizer', not 'superadmin')
                await db.query("UPDATE users SET role = 'user' WHERE id = $1 AND role = 'organizer'", [puid]);
                await enforceCardLimit(puid, 'free');
            } catch (userErr) {
                console.error('Paid sub expiry failed for user ' + paidExpired.rows[j].user_id + ':', userErr.message);
            }
        }
    } catch (err) {
        console.error('Subscription expiration check error:', err.message);
    }
}, 60 * 60 * 1000); // Every hour

// Cleanup expired tokens (runs every 6 hours)
setInterval(async function () {
    try {
        var r1 = await db.query("DELETE FROM email_verification_tokens WHERE expires_at < NOW()");
        var r2 = await db.query("DELETE FROM password_reset_tokens WHERE expires_at < NOW()");
        if (r1.rowCount > 0 || r2.rowCount > 0) {
            console.log('Token cleanup: removed ' + r1.rowCount + ' email tokens, ' + r2.rowCount + ' reset tokens');
        }
    } catch (err) {
        console.error('Token cleanup error:', err.message);
    }
}, 6 * 60 * 60 * 1000); // Every 6 hours

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
        var userIds = users.rows.map(function (u) { return u.id; });

        // Batch queries: analytics, lead counts, and card names for ALL users at once
        var allAnalytics = await db.query(
            'SELECT user_id, card_id, metric, data FROM analytics WHERE user_id = ANY($1)',
            [userIds]
        );
        var allLeadCounts = await db.query(
            'SELECT user_id, COUNT(*) as cnt FROM leads WHERE user_id = ANY($1) AND created_at >= $2 GROUP BY user_id',
            [userIds, weekAgo]
        );
        var allCards = await db.query(
            "SELECT user_id, id, data->>'name' as name FROM cards WHERE user_id = ANY($1)",
            [userIds]
        );

        // Index lead counts and card names by user
        var leadCountMap = {};
        allLeadCounts.rows.forEach(function (r) { leadCountMap[r.user_id] = parseInt(r.cnt) || 0; });
        var cardNameMap = {};
        allCards.rows.forEach(function (r) {
            if (!cardNameMap[r.user_id]) cardNameMap[r.user_id] = {};
            cardNameMap[r.user_id][r.id] = r.name;
        });

        // Group analytics by user
        var analyticsByUser = {};
        allAnalytics.rows.forEach(function (row) {
            if (!analyticsByUser[row.user_id]) analyticsByUser[row.user_id] = [];
            analyticsByUser[row.user_id].push(row);
        });

        for (var i = 0; i < users.rows.length; i++) {
            var user = users.rows[i];
            try {
                var userAnalytics = analyticsByUser[user.id] || [];
                var views = 0, prevViews = 0, saves = 0;
                var cardViews = {};

                userAnalytics.forEach(function (row) {
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

                var leads = leadCountMap[user.id] || 0;

                // Find top card
                var topCard = null, topCardViews = 0;
                Object.keys(cardViews).forEach(function (cid) {
                    if (cardViews[cid] > topCardViews) {
                        topCardViews = cardViews[cid];
                        topCard = cid;
                    }
                });

                var topCardName = topCard;
                if (topCard && cardNameMap[user.id] && cardNameMap[user.id][topCard]) {
                    topCardName = cardNameMap[user.id][topCard];
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

// Daily digest + follow-up reminders — runs every hour, sends at 9am IST (3:30 UTC)
var pushModule = require('./push');
var lastDailyDigestDate = null;

setInterval(async function () {
    try {
        var now = new Date();
        var istDate = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
        var istHour = istDate.getUTCHours();
        var todayStr = now.toISOString().split('T')[0];

        // Send daily at 9-10am IST (not Monday — that's weekly digest)
        if (istHour < 9 || istHour >= 10 || lastDailyDigestDate === todayStr) return;
        lastDailyDigestDate = todayStr;

        if (process.env.NODE_ENV !== 'production') console.log('Running daily digest...');

        // Find opted-in users (all plans)
        var users = await db.query(
            "SELECT u.id, u.email, u.name, u.plan FROM users u " +
            "JOIN user_settings s ON s.user_id = u.id " +
            "WHERE (s.data->>'dailyDigest')::boolean = true"
        );

        if (users.rows.length === 0) return;

        var yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        var twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        for (var i = 0; i < users.rows.length; i++) {
            var user = users.rows[i];
            try {
                // 1. Yesterday's activity stats
                var analyticsRows = await db.query(
                    'SELECT metric, data FROM analytics WHERE user_id = $1',
                    [user.id]
                );
                var views = 0, saves = 0;
                analyticsRows.rows.forEach(function (row) {
                    if (!Array.isArray(row.data)) return;
                    row.data.forEach(function (entry) {
                        var ts = entry.timestamp || entry.ts || '';
                        if (ts >= yesterday) {
                            if (row.metric === 'views') views++;
                            if (row.metric === 'saves') saves++;
                        }
                    });
                });
                var leadCount = await db.query(
                    'SELECT COUNT(*) as cnt FROM leads WHERE user_id = $1 AND created_at >= $2',
                    [user.id, yesterday]
                );
                var newLeads = parseInt(leadCount.rows[0].cnt) || 0;

                // 2. Find stale leads needing follow-up (2+ days old, status still 'new', no reminder set)
                var staleLeads = await db.query(
                    "SELECT id, data FROM leads WHERE user_id = $1 AND created_at <= $2 " +
                    "AND (data->>'status' IS NULL OR data->>'status' = 'new') " +
                    "AND (data->'reminder' IS NULL OR data->'reminder'->>'done' = 'true' OR data->'reminder'->>'date' IS NULL) " +
                    "AND (data->>'lastFollowup' IS NULL) " +
                    "ORDER BY created_at DESC LIMIT 10",
                    [user.id, twoDaysAgo]
                );

                var followups = staleLeads.rows.map(function (row) {
                    var d = row.data || {};
                    var createdTs = d.timestamp || d.ts;
                    var days = createdTs ? Math.floor((Date.now() - new Date(createdTs).getTime()) / (86400000)) : 3;
                    return {
                        name: d.name || 'Unknown',
                        company: d.company || '',
                        status: d.status || 'New',
                        days: days || 2
                    };
                });

                // 2b. Find overdue tasks
                var todayStr = now.toISOString().split('T')[0];
                var taskLeads = await db.query(
                    "SELECT id, data FROM leads WHERE user_id = $1 AND data->'tasks' IS NOT NULL",
                    [user.id]
                );
                var overdueTasks = 0;
                taskLeads.rows.forEach(function (row) {
                    var tasks = (row.data && row.data.tasks) || [];
                    tasks.forEach(function (t) {
                        if (!t.done && t.due && t.due < todayStr) overdueTasks++;
                    });
                });

                // Skip if no activity and no follow-ups and no tasks
                if (views === 0 && newLeads === 0 && saves === 0 && followups.length === 0 && overdueTasks === 0) continue;

                // 3. Send push notification
                var alertItems = followups.length + overdueTasks;
                if (alertItems > 0) {
                    var pushTitle = alertItems + ' item(s) need attention';
                    var pushParts = [];
                    if (followups.length > 0) pushParts.push(followups.length + ' follow-up(s)');
                    if (overdueTasks > 0) pushParts.push(overdueTasks + ' overdue task(s)');
                    pushModule.sendPush(user.id, {
                        title: pushTitle,
                        body: pushParts.join(', '),
                        url: '/dashboard#leads'
                    });
                } else if (views > 0 || newLeads > 0) {
                    pushModule.sendPush(user.id, {
                        title: 'Daily activity update',
                        body: views + ' views, ' + newLeads + ' new leads yesterday',
                        url: '/dashboard#analytics'
                    });
                }

                // 4. Send email digest
                await emailModule.sendDailyDigest(user.email, user.name, {
                    views: views,
                    leads: newLeads,
                    saves: saves,
                    followups: followups
                });

                if (process.env.NODE_ENV !== 'production') console.log('Daily digest sent to:', user.email);
            } catch (userErr) {
                console.error('Daily digest error for user ' + user.id + ':', userErr.message);
            }
        }

        if (process.env.NODE_ENV !== 'production') console.log('Daily digest complete');
    } catch (err) {
        console.error('Daily digest cron error:', err.message);
    }
}, 60 * 60 * 1000); // Check every hour

// Email sequence processor — runs every 5 minutes
var BASE_URL_SEQ = process.env.BASE_URL || 'https://card.cardflow.cloud';
setInterval(async function () {
    try {
        var due = await db.query(
            "SELECT e.id, e.sequence_id, e.user_id, e.lead_id, e.current_step, e.enrolled_at, " +
            "s.steps, s.name as seq_name, " +
            "l.data as lead_data, u.email as owner_email, u.plan " +
            "FROM sequence_enrollments e " +
            "JOIN sequences s ON s.id = e.sequence_id " +
            "JOIN leads l ON l.user_id = e.user_id AND l.id = e.lead_id " +
            "JOIN users u ON u.id = e.user_id " +
            "WHERE e.status = 'active' AND e.next_send_at <= NOW() " +
            "AND s.active = true AND u.plan != 'free' " +
            "ORDER BY e.next_send_at ASC LIMIT 50"
        );
        for (var i = 0; i < due.rows.length; i++) {
            var row = due.rows[i];
            try {
                var steps = row.steps;
                var stepIndex = row.current_step;
                if (!steps || stepIndex >= steps.length) {
                    await db.query("UPDATE sequence_enrollments SET status = 'completed', last_sent_at = NOW() WHERE id = $1", [row.id]);
                    continue;
                }
                var step = steps[stepIndex];
                var leadData = row.lead_data || {};
                var leadEmail = Array.isArray(leadData.email) ? leadData.email[0] : leadData.email;
                if (!leadEmail) {
                    await db.query("UPDATE sequence_enrollments SET status = 'paused' WHERE id = $1", [row.id]);
                    continue;
                }
                var subject = emailModule.interpolateTemplate(step.subject, leadData);
                var bodyText = emailModule.interpolateTemplate(step.body, leadData);
                var bodyHtml = '<p>' + bodyText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g, '<br>') + '</p>';
                var unsubToken = emailModule.generateUnsubscribeToken(row.user_id, row.lead_id, row.id);
                var unsubUrl = BASE_URL_SEQ + '/api/public/unsubscribe/' + unsubToken;
                var sent = await emailModule.sendSequenceEmail(leadEmail, subject, bodyHtml, row.owner_email, unsubUrl);
                if (sent) {
                    var nextStep = stepIndex + 1;
                    if (nextStep >= steps.length) {
                        await db.query("UPDATE sequence_enrollments SET status = 'completed', current_step = $1, last_sent_at = NOW() WHERE id = $2", [nextStep, row.id]);
                    } else {
                        var nextSend = new Date(new Date(row.enrolled_at).getTime() + steps[nextStep].delay_days * 86400000);
                        if (nextSend.getTime() < Date.now()) nextSend = new Date(Date.now() + 60000);
                        await db.query("UPDATE sequence_enrollments SET current_step = $1, last_sent_at = NOW(), next_send_at = $2 WHERE id = $3", [nextStep, nextSend, row.id]);
                    }
                    // Log to lead timeline
                    await db.query(
                        "UPDATE leads SET data = jsonb_set(COALESCE(data, '{}'), '{actions}', " +
                        "COALESCE(data->'actions', '[]'::jsonb) || $1::jsonb), updated_at = NOW() " +
                        "WHERE user_id = $2 AND id = $3",
                        [JSON.stringify([{type:'system', action:'sequence_email', ts:Date.now(), step:stepIndex+1, sequence:row.seq_name, subject:subject}]), row.user_id, row.lead_id]
                    );
                }
                // Small delay between sends
                await new Promise(function(r){ setTimeout(r, 200); });
            } catch (stepErr) {
                console.error('Sequence step error for enrollment ' + row.id + ':', stepErr.message);
            }
        }
    } catch (err) {
        console.error('Sequence cron error:', err.message);
    }
}, 5 * 60 * 1000);

// ── Global error handler (must be after all routes) ──
app.use(function (err, req, res, next) {
    // Body parser JSON syntax errors return 400 (not 500)
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
        return res.status(400).json({ error: 'Invalid JSON body' });
    }
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
