const express = require('express');
const rateLimit = require('express-rate-limit');
const { verifyAuth } = require('../auth');
const ocr = require('../ocr');

const router = express.Router();
router.use(verifyAuth);

// Rate limit: 20 scans per 15 min per user
var scanLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
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
