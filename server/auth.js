const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('FATAL: JWT_SECRET environment variable is not set'); process.exit(1); }

function signToken(user) {
    return jwt.sign(
        { uid: user.id, email: user.email, username: user.username },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
}

function verifyAuth(req, res, next) {
    var token;
    var header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
        token = header.slice(7);
    } else if (req.query.token) {
        // Support token as query param for SSE (EventSource can't set headers)
        token = req.query.token;
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

module.exports = { signToken, verifyAuth, requireSuperAdmin };
