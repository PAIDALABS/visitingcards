require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const db = require('./db');
const sse = require('./sse');
const { verifyAuth } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (behind Nginx)
app.set('trust proxy', 1);

// Security headers (relaxed for inline scripts/styles in HTML files)
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

// CORS
app.use(cors({
    origin: ['https://card.cardflow.cloud', 'https://cardflow.cloud', 'http://localhost:3000'],
    credentials: true
}));

// JSON parsing for all routes except Stripe webhook
app.use(function (req, res, next) {
    if (req.path === '/api/billing/webhook') {
        next();
    } else {
        express.json({ limit: '10mb' })(req, res, next);
    }
});

// Request logger
app.use(function (req, res, next) {
    if (req.path.startsWith('/api/')) {
        var auth = req.headers.authorization ? 'Bearer...' + req.headers.authorization.slice(-8) : (req.query.token ? 'query-token' : 'NO-AUTH');
        var origEnd = res.end;
        res.end = function () {
            console.log(req.method + ' ' + req.path + ' [' + auth + '] → ' + res.statusCode);
            origEnd.apply(res, arguments);
        };
    }
    next();
});

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
app.use('/api/public', require('./routes/public'));

// -- SSE Live Reload (unauthenticated, for all pages) --
app.get('/api/sse/reload', function (req, res) {
    sse.setupSSE(res);
    sse.subscribe('reload', res);
});

// -- SSE Routes (authenticated) --
app.get('/api/sse/taps', verifyAuth, function (req, res) {
    sse.setupSSE(res);
    sse.subscribe('latest:' + req.user.uid, res);
});

app.get('/api/sse/leads', verifyAuth, function (req, res) {
    sse.setupSSE(res);
    sse.subscribe('leads:' + req.user.uid, res);
});

app.get('/api/sse/lead/:leadId', verifyAuth, function (req, res) {
    sse.setupSSE(res);
    sse.subscribe('lead:' + req.user.uid + ':' + req.params.leadId, res);
});

// -- Static files --
app.use(express.static(path.join(__dirname, '..', 'public'), {
    extensions: ['html'],
    index: false
}));

// Root → landing page, or card if ?c= token present
app.get('/', async function (req, res) {
    var token = req.query.c;
    if (token) {
        // Token-based card URL — serve index.html with dynamic OG tags
        try {
            var tokenResult = await db.query("SELECT data FROM cards WHERE data->>'token' = $1 LIMIT 1", [token]);
            if (tokenResult.rows.length > 0) {
                var cardData = tokenResult.rows[0].data;
                var name = cardData.name || 'Digital Business Card';
                var title = cardData.title || '';
                var company = cardData.company || '';
                var subtitle = [title, company].filter(Boolean).join(' at ');
                var ogTitle = subtitle ? name + ' — ' + subtitle : name;
                var ogDesc = cardData.bio || ('Connect with ' + name + '. Tap to view their digital business card.');
                function escOg(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
                var fs = require('fs');
                var indexPath = path.join(__dirname, '..', 'public', 'index.html');
                var html = fs.readFileSync(indexPath, 'utf8');
                html = html.replace('<meta property="og:title" content="Digital Business Card">', '<meta property="og:title" content="' + escOg(ogTitle) + '">');
                html = html.replace('<meta property="og:description" content="Tap to connect. Share your digital business card instantly.">', '<meta property="og:description" content="' + escOg(ogDesc.substring(0, 200)) + '">');
                html = html.replace('<title>Digital Business Card — CardFlow</title>', '<title>' + escOg(ogTitle) + ' — CardFlow</title>');
                return res.send(html);
            }
        } catch (err) {
            console.error('Token OG error:', err.message);
        }
        // Token not found — still serve index.html (JS will show error)
        return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    }
    res.sendFile(path.join(__dirname, '..', 'public', 'landing.html'));
});

// SPA fallback for /username/cardname routes — with dynamic OG tags
app.get('*', async function (req, res) {
    // Don't serve index.html for API or file requests
    if (req.path.startsWith('/api/') || req.path.includes('.')) {
        return res.status(404).json({ error: 'Not found' });
    }

    var indexPath = path.join(__dirname, '..', 'public', 'index.html');

    // Try to inject dynamic OG tags
    try {
        var cardData = null;
        var token = req.query.c;
        var parts = req.path.split('/').filter(Boolean);

        if (token) {
            // Token-based URL: /?c=token
            var tokenResult = await db.query("SELECT data FROM cards WHERE data->>'token' = $1 LIMIT 1", [token]);
            if (tokenResult.rows.length > 0) cardData = tokenResult.rows[0].data;
        } else if (parts.length >= 1 && parts.length <= 2) {
            // Path-based URL: /username or /username/cardId
            var username = parts[0].toLowerCase();
            var userResult = await db.query('SELECT id FROM users WHERE username = $1', [username]);
            if (userResult.rows.length > 0) {
                var userId = userResult.rows[0].id;
                var cardId = parts[1] || null;
                if (cardId) {
                    var cardResult = await db.query('SELECT data FROM cards WHERE user_id = $1 AND id = $2', [userId, cardId]);
                    if (cardResult.rows.length > 0) cardData = cardResult.rows[0].data;
                }
                if (!cardData) {
                    var allCards = await db.query('SELECT data FROM cards WHERE user_id = $1 LIMIT 1', [userId]);
                    if (allCards.rows.length > 0) cardData = allCards.rows[0].data;
                }
            }
        }

        if (cardData) {
            var name = cardData.name || 'Digital Business Card';
            var title = cardData.title || '';
            var company = cardData.company || '';
            var subtitle = [title, company].filter(Boolean).join(' at ');
            var ogTitle = subtitle ? name + ' — ' + subtitle : name;
            var ogDesc = cardData.bio || ('Connect with ' + name + '. Tap to view their digital business card.');

            function escOg(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

            var fs = require('fs');
            var html = fs.readFileSync(indexPath, 'utf8');
            html = html.replace(
                '<meta property="og:title" content="Digital Business Card">',
                '<meta property="og:title" content="' + escOg(ogTitle) + '">'
            );
            html = html.replace(
                '<meta property="og:description" content="Tap to connect. Share your digital business card instantly.">',
                '<meta property="og:description" content="' + escOg(ogDesc.substring(0, 200)) + '">'
            );
            html = html.replace(
                '<title>Digital Business Card — CardFlow</title>',
                '<title>' + escOg(ogTitle) + ' — CardFlow</title>'
            );
            return res.send(html);
        }
    } catch (err) {
        console.error('OG tag injection error:', err.message);
    }

    // Fallback: serve static index.html
    res.sendFile(indexPath);
});

// -- File watcher for live reload --
var fs = require('fs');
var publicDir = path.join(__dirname, '..', 'public');
var reloadTimeout = null;

fs.watch(publicDir, { recursive: true }, function (eventType, filename) {
    if (!filename || filename.startsWith('.')) return;
    // Debounce: wait 300ms so batch saves don't fire multiple reloads
    clearTimeout(reloadTimeout);
    reloadTimeout = setTimeout(function () {
        console.log('File changed:', filename, '- sending reload');
        sse.publish('reload', { file: filename, ts: Date.now() });
    }, 300);
});

// Start
app.listen(PORT, function () {
    console.log('CardFlow server running on port ' + PORT);
});
