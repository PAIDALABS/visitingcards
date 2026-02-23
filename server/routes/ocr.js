const express = require('express');
const rateLimit = require('express-rate-limit');
const { verifyAuth, requireNotSuspended } = require('../auth');
const db = require('../db');
const ocr = require('../ocr');

const router = express.Router();
router.use(verifyAuth);
router.use(requireNotSuspended);

// Plan gate: only Pro/Business users can use OCR
router.use(async function (req, res, next) {
    try {
        var result = await db.query('SELECT plan FROM users WHERE id = $1', [req.user.uid]);
        if (result.rows.length === 0 || result.rows[0].plan === 'free') {
            return res.status(403).json({ error: 'Pro or Business plan required for card scanning' });
        }
        next();
    } catch (err) {
        res.status(500).json({ error: 'Failed to check plan' });
    }
});

// Rate limit: 500 scans per 15 min per user (high for bulk scanning, plan-gated to Pro/Business)
var scanLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    keyGenerator: function (req) { return req.user.uid; },
    message: { error: 'Too many scans. Please try again in a few minutes.' }
});

// POST /api/ocr/scan-card — single image scan
router.post('/scan-card', scanLimiter, async function (req, res) {
    try {
        var image = req.body.image;
        if (!image || typeof image !== 'string') {
            return res.status(400).json({ error: 'Missing image data' });
        }
        // Basic size check (~5MB base64 limit)
        if (image.length > 7 * 1024 * 1024) {
            return res.status(400).json({ error: 'Image too large' });
        }
        var result = await ocr.ocrAndParse(image);
        res.json(result);
    } catch (err) {
        console.error('OCR scan-card error:', err.message);
        res.status(500).json({ error: 'OCR processing failed' });
    }
});

// POST /api/ocr/scan-bulk — batch scan (max 20 images)
router.post('/scan-bulk', scanLimiter, async function (req, res) {
    try {
        var images = req.body.images;
        if (!Array.isArray(images) || images.length === 0) {
            return res.status(400).json({ error: 'Missing images array' });
        }
        if (images.length > 20) {
            return res.status(400).json({ error: 'Maximum 20 images per batch' });
        }

        var results = [];
        for (var i = 0; i < images.length; i++) {
            try {
                if (typeof images[i] !== 'string' || images[i].length > 7 * 1024 * 1024) {
                    results.push({ fields: {}, rawText: '', method: 'error', error: 'Image too large or invalid' });
                    continue;
                }
                var result = await ocr.ocrAndParse(images[i]);
                results.push(result);
            } catch (err) {
                console.error('OCR bulk item ' + i + ' error:', err.message);
                results.push({ fields: { name: '', title: '', company: '', phone: '', email: '', website: '', address: '', linkedin: '', instagram: '', twitter: '' }, rawText: '', method: 'error', error: err.message });
            }
        }

        res.json({ results: results });
    } catch (err) {
        console.error('OCR scan-bulk error:', err.message);
        res.status(500).json({ error: 'Bulk OCR processing failed' });
    }
});

// POST /api/ocr/scan-card-multi — single image, multiple contacts
router.post('/scan-card-multi', scanLimiter, async function (req, res) {
    try {
        var image = req.body.image;
        if (!image || typeof image !== 'string') {
            return res.status(400).json({ error: 'Missing image data' });
        }
        if (image.length > 7 * 1024 * 1024) {
            return res.status(400).json({ error: 'Image too large' });
        }
        var result = await ocr.ocrAndParseMulti(image);
        res.json(result);
    } catch (err) {
        console.error('OCR scan-card-multi error:', err.message);
        res.status(500).json({ error: 'OCR processing failed' });
    }
});

// GET /api/ocr/status — check Ollama status
router.get('/status', async function (req, res) {
    try {
        var status = await ocr.checkOllamaStatus();
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: 'Failed to check OCR status' });
    }
});

module.exports = router;
