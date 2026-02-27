const express = require('express');
const { URL } = require('url');
const dns = require('dns');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { verifyAuth, requireNotSuspended } = require('../auth');
const { getClaudeClientAsync } = require('../ocr');
const { sendVerificationRevoked } = require('../email');

const router = express.Router();
router.use(verifyAuth);
router.use(requireNotSuspended);

// Plan card limits (shared with billing webhook)
var PLAN_LIMITS = { free: 1, pro: 5, business: -1 };

// Max card data payload size (500KB stringified)
var MAX_CARD_DATA_SIZE = 500 * 1024;

// Strip internal/dangerous fields from card data
function sanitizeCardData(data) {
    if (typeof data !== 'object' || data === null) return {};
    delete data._inactive;
    delete data.__proto__;
    delete data.constructor;
    delete data.prototype;
    return data;
}

function validateCardKeys(data) {
    return typeof data === 'object' && data !== null && Object.keys(data).length <= 100;
}

// GET /api/cards — all cards (includes active flag)
router.get('/', async function (req, res) {
    try {
        var result = await db.query('SELECT id, data, active, verified_at FROM cards WHERE user_id = $1', [req.user.uid]);
        var cards = {};
        result.rows.forEach(function (row) {
            var card = row.data;
            if (!row.active) card._inactive = true;
            if (row.verified_at) card._verifiedAt = row.verified_at;
            cards[row.id] = card;
        });
        res.json(cards);
    } catch (err) {
        console.error('Get cards error:', err);
        res.status(500).json({ error: 'Failed to load cards' });
    }
});

// Validate resource ID length (shared for cards)
function validateId(req, res) {
    if (req.params.id && req.params.id.length > 128) {
        res.status(400).json({ error: 'ID too long (max 128 chars)' });
        return false;
    }
    return true;
}

// GET /api/cards/:id
router.get('/:id', async function (req, res) {
    if (!validateId(req, res)) return;
    try {
        var result = await db.query('SELECT data, active, verified_at FROM cards WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Card not found' });
        var card = result.rows[0].data;
        if (!result.rows[0].active) card._inactive = true;
        if (result.rows[0].verified_at) card._verifiedAt = result.rows[0].verified_at;
        res.json(card);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load card' });
    }
});

// PUT /api/cards/:id — create or replace card
router.put('/:id', async function (req, res) {
    if (!validateId(req, res)) return;
    try {
        var data = sanitizeCardData(req.body);
        if (!validateCardKeys(data)) {
            return res.status(400).json({ error: 'Too many fields in card data (max 100)' });
        }
        var dataStr = JSON.stringify(data);
        if (dataStr.length > MAX_CARD_DATA_SIZE) {
            return res.status(400).json({ error: 'Card data too large (max 500KB)' });
        }

        // Check if this is a new card (not an update to existing)
        var existingCard = await db.query('SELECT id, active, verified_at, data FROM cards WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);

        if (existingCard.rows.length === 0) {
            // New card — enforce plan limits with advisory lock to prevent race condition
            var client = await db.connect();
            try {
                await client.query('BEGIN');
                // Advisory lock keyed on user ID hash to serialize card creation per user
                await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [req.user.uid]);

                var countResult = await client.query('SELECT COUNT(*) FROM cards WHERE user_id = $1 AND active = true', [req.user.uid]);
                var cardCount = parseInt(countResult.rows[0].count) || 0;

                var userResult = await client.query('SELECT plan FROM users WHERE id = $1', [req.user.uid]);
                var plan = userResult.rows.length > 0 ? userResult.rows[0].plan : 'free';
                var maxCards = PLAN_LIMITS[plan] || 1;

                if (maxCards !== -1 && cardCount >= maxCards) {
                    await client.query('ROLLBACK');
                    return res.status(403).json({ error: 'Card limit reached for your plan' });
                }

                await client.query(
                    'INSERT INTO cards (user_id, id, data, updated_at) VALUES ($1, $2, $3, NOW())',
                    [req.user.uid, req.params.id, JSON.stringify(data)]
                );
                await client.query('COMMIT');
            } catch (txErr) {
                try { await client.query('ROLLBACK'); } catch (e) {}
                throw txErr;
            } finally {
                client.release();
            }
        } else {
            // Existing card — block edits to inactive cards
            if (!existingCard.rows[0].active) {
                return res.status(403).json({ error: 'This card is deactivated. Upgrade your plan to reactivate it.' });
            }
            await db.query(
                'UPDATE cards SET data = $1, updated_at = NOW() WHERE user_id = $2 AND id = $3',
                [JSON.stringify(data), req.user.uid, req.params.id]
            );
            // Revoke verification if key fields changed
            if (existingCard.rows[0].verified_at) {
                var old = existingCard.rows[0].data;
                if (data.email !== old.email || data.name !== old.name || data.company !== old.company) {
                    await db.query('UPDATE cards SET verified_at = NULL WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
                    sendVerificationRevoked(old.email || data.email, data.name || old.name || 'your card').catch(function () {});
                }
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Put card error:', err);
        res.status(500).json({ error: 'Failed to save card' });
    }
});

// PATCH /api/cards/:id — partial update
router.patch('/:id', async function (req, res) {
    if (!validateId(req, res)) return;
    try {
        var result = await db.query('SELECT data, active, verified_at FROM cards WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Card not found' });
        if (!result.rows[0].active) return res.status(403).json({ error: 'This card is deactivated. Upgrade your plan to reactivate it.' });
        var oldData = result.rows[0].data;
        var data = Object.assign({}, oldData, sanitizeCardData(req.body));
        if (!validateCardKeys(data)) {
            return res.status(400).json({ error: 'Too many fields in card data (max 100)' });
        }
        var dataStr = JSON.stringify(data);
        if (dataStr.length > MAX_CARD_DATA_SIZE) {
            return res.status(400).json({ error: 'Card data too large (max 500KB)' });
        }
        await db.query('UPDATE cards SET data = $1, updated_at = NOW() WHERE user_id = $2 AND id = $3', [JSON.stringify(data), req.user.uid, req.params.id]);
        // Revoke verification if key fields changed
        if (result.rows[0].verified_at) {
            if (data.email !== oldData.email || data.name !== oldData.name || data.company !== oldData.company) {
                await db.query('UPDATE cards SET verified_at = NULL WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
                sendVerificationRevoked(oldData.email || data.email, data.name || oldData.name || 'your card').catch(function () {});
            }
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update card' });
    }
});

// DELETE /api/cards/:id
router.delete('/:id', async function (req, res) {
    if (!validateId(req, res)) return;
    try {
        await db.query('DELETE FROM cards WHERE user_id = $1 AND id = $2', [req.user.uid, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete card' });
    }
});

// ── SSRF protection (shared pattern from settings.js) ──
function isPrivateIP(ip) {
    if (ip === '::1' || ip === '::' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    var parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) return false;
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (ip === '0.0.0.0') return true;
    return false;
}

async function validateFetchUrl(urlStr) {
    try {
        var parsed = new URL(urlStr);
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;
        if (parsed.hostname === 'localhost') return false;
        var v4 = await new Promise(function (resolve) { dns.resolve4(parsed.hostname, function (err, addrs) { resolve(addrs || []); }); });
        var v6 = await new Promise(function (resolve) { dns.resolve6(parsed.hostname, function (err, addrs) { resolve(addrs || []); }); });
        var allAddrs = v4.concat(v6);
        if (allAddrs.length === 0) return false;
        return !allAddrs.some(isPrivateIP);
    } catch (e) { return false; }
}

function stripHtmlToText(html) {
    var text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
    text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ');
    text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ');
    text = text.replace(/<!--[\s\S]*?-->/g, ' ');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/&nbsp;/gi, ' ');
    text = text.replace(/&amp;/gi, '&');
    text = text.replace(/&lt;/gi, '<');
    text = text.replace(/&gt;/gi, '>');
    text = text.replace(/&quot;/gi, '"');
    text = text.replace(/&#39;/gi, "'");
    text = text.replace(/&#\d+;/g, ' ');
    text = text.replace(/&\w+;/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    return text;
}

var DESC_PROMPT = 'You are a professional copywriter. Based on the website content below, write a concise professional bio/description for a digital business card.\n\n' +
    'Rules:\n' +
    '- Write 2-4 sentences maximum\n' +
    '- Professional, third-person tone\n' +
    '- Focus on what the person or company does, their expertise, and value proposition\n' +
    '- Do not include contact details, URLs, or social media handles\n' +
    '- Do not use marketing buzzwords or superlatives\n' +
    '- Return ONLY the description text, no quotes, no labels, no preamble';

var descGenLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: function (req) { return req.user.uid; },
    message: { error: 'Too many requests. Please try again in a few minutes.' }
});

// POST /api/cards/generate-description — scrape website and generate bio
router.post('/generate-description', descGenLimiter, async function (req, res) {
    var url = (req.body.url || '').trim();
    if (!url) return res.status(400).json({ error: 'Website URL is required' });

    // Add protocol if missing
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    var parsed;
    try { parsed = new URL(url); } catch (e) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ error: 'Only HTTP/HTTPS URLs are supported' });
    }

    var isSafe = await validateFetchUrl(url);
    if (!isSafe) return res.status(400).json({ error: 'Could not reach this website' });

    // Fetch website with timeout and size limit
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 10000);
    var html;
    try {
        var response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'CardFlow-Bot/1.0 (+https://cardflow.cloud)', 'Accept': 'text/html,application/xhtml+xml,*/*' },
            redirect: 'follow'
        });
        clearTimeout(timeout);
        if (!response.ok) return res.status(502).json({ error: 'Website returned HTTP ' + response.status });
        var ct = response.headers.get('content-type') || '';
        if (!ct.includes('text/html') && !ct.includes('text/plain') && !ct.includes('application/xhtml')) {
            return res.status(400).json({ error: 'URL does not point to an HTML page' });
        }
        var reader = response.body.getReader();
        var chunks = [];
        var totalSize = 0;
        var MAX_SIZE = 100 * 1024;
        while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;
            totalSize += chunk.value.length;
            chunks.push(chunk.value);
            if (totalSize >= MAX_SIZE) break;
        }
        reader.cancel().catch(function () {});
        html = Buffer.concat(chunks).toString('utf8');
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') return res.status(504).json({ error: 'Website took too long to respond' });
        return res.status(502).json({ error: 'Could not reach the website' });
    }

    var text = stripHtmlToText(html);
    if (text.length < 50) return res.status(400).json({ error: 'Could not extract enough content from the website' });
    if (text.length > 50000) text = text.substring(0, 50000);

    try {
        var client = await getClaudeClientAsync();
        var result = await client.messages.create({
            model: process.env.CLAUDE_OCR_MODEL || 'claude-sonnet-4-6',
            max_tokens: 300,
            messages: [{ role: 'user', content: DESC_PROMPT + '\n\nWebsite URL: ' + url + '\n\nWebsite content:\n' + text }]
        });
        var description = (result.content && result.content[0] && result.content[0].text || '').trim();
        if (!description) return res.status(500).json({ error: 'Could not generate a description' });
        res.json({ description: description });
    } catch (err) {
        console.error('Description generation error:', err.message);
        res.status(500).json({ error: 'AI processing failed. Please try again.' });
    }
});

module.exports = router;
module.exports.PLAN_LIMITS = PLAN_LIMITS;
