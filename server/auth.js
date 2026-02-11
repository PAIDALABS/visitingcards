const jwt = require('jsonwebtoken');

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

module.exports = { signToken, verifyAuth };
