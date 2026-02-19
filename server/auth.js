const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('FATAL: JWT_SECRET environment variable is not set'); process.exit(1); }

// In-memory SSE ticket store (ticket → { uid, email, username, exp })
var sseTickets = new Map();

// Cleanup expired tickets every 60 seconds
setInterval(function() {
    var now = Date.now();
    for (var entry of sseTickets) { if (entry[1].exp < now) sseTickets.delete(entry[0]); }
}, 60000);

function signToken(user) {
    return jwt.sign(
        { uid: user.id, email: user.email, username: user.username },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
}

function issueSSETicket(user) {
    var ticket = crypto.randomUUID();
    sseTickets.set(ticket, { uid: user.uid, email: user.email, username: user.username, exp: Date.now() + 30000 });
    return ticket;
}

function verifyAuth(req, res, next) {
    // 1. Check for one-time SSE ticket (query param)
    if (req.query.ticket) {
        var entry = sseTickets.get(req.query.ticket);
        if (!entry) return res.status(401).json({ error: 'Invalid or expired ticket' });
        if (entry.exp < Date.now()) {
            sseTickets.delete(req.query.ticket);
            return res.status(401).json({ error: 'Ticket expired' });
        }
        sseTickets.delete(req.query.ticket); // single-use
        req.user = { uid: entry.uid, email: entry.email, username: entry.username };
        return next();
    }

    // 2. Bearer token in Authorization header
    var token;
    var header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
        token = header.slice(7);
    }
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        var decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

// Feature flag middleware factory with 30s TTL cache
var _flagCache = {};
function requireFeatureFlag(key) {
    return function (req, res, next) {
        var cached = _flagCache[key];
        if (cached && cached.exp > Date.now()) {
            if (!cached.enabled) return res.status(503).json({ error: 'This feature is currently disabled' });
            return next();
        }
        db.query('SELECT enabled FROM feature_flags WHERE key = $1', [key])
            .then(function (result) {
                var enabled = result.rows.length > 0 ? result.rows[0].enabled : true; // default enabled if flag missing
                _flagCache[key] = { enabled: enabled, exp: Date.now() + 30000 };
                if (!enabled) return res.status(503).json({ error: 'This feature is currently disabled' });
                next();
            })
            .catch(function (err) {
                console.error('requireFeatureFlag error:', err);
                next(); // fail open — don't block on DB errors
            });
    };
}

function requireSuperAdmin(req, res, next) {
    db.query('SELECT role, suspended_at FROM users WHERE id = $1', [req.user.uid])
        .then(function (result) {
            if (result.rows.length === 0 || result.rows[0].role !== 'superadmin' || result.rows[0].suspended_at) {
                return res.status(403).json({ error: 'Forbidden: superadmin access required' });
            }
            next();
        })
        .catch(function (err) {
            console.error('requireSuperAdmin error:', err);
            res.status(500).json({ error: 'Authorization check failed' });
        });
}

module.exports = { signToken, verifyAuth, requireSuperAdmin, requireFeatureFlag, issueSSETicket };
