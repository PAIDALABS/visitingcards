const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { verifyAuth, requireNotSuspended } = require('../auth');
const { sendCardVerificationOTP, sendVerificationApproved, sendVerificationRejected } = require('../email');

const router = express.Router();
router.use(verifyAuth);
router.use(requireNotSuspended);

var verifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyGenerator: function (req) { return req.user.uid; },
    message: { error: 'Too many verification attempts. Please try again later.' }
});

var uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyGenerator: function (req) { return req.user.uid; },
    message: { error: 'Too many upload attempts. Please try again later.' }
});

// AI review prompt
var AI_REVIEW_PROMPT = 'You are verifying a digital business card. The card claims:\n' +
    '- Name: {NAME}\n' +
    '- Email: {EMAIL}\n' +
    '- Company: {COMPANY}\n' +
    '- Title: {TITLE}\n\n' +
    'The email ownership has already been verified via OTP. You are reviewing uploaded documents.\n\n' +
    'Analyze the documents and determine if they support the card\'s claims. Check:\n' +
    '1. Does any document show the person\'s name matching (or closely matching) the card name?\n' +
    '2. Does any document show the company name or association?\n' +
    '3. Do the documents appear authentic (not obviously edited/fabricated)?\n' +
    '4. Is the document type appropriate (government ID, company badge, business registration, letterhead, etc.)?\n\n' +
    'Return ONLY a JSON object:\n' +
    '{"decision":"approve","confidence":0.95,"reasoning":"Brief explanation","checks":{"name_match":true,"company_match":true,"document_authentic":true,"document_relevant":true}}\n\n' +
    'Rules:\n' +
    '- "approve" if name matches and documents appear legitimate\n' +
    '- "reject" if documents are clearly fake, irrelevant, or contradict the card\n' +
    '- "escalate" if unsure, partially matching, or ambiguous\n' +
    '- When in doubt, always escalate — do not reject unless clearly fraudulent\n' +
    '- Return ONLY valid JSON, no markdown';

// Mask email: a*****@gmail.com
function maskEmail(email) {
    var parts = email.split('@');
    if (parts[0].length <= 2) return parts[0][0] + '***@' + parts[1];
    return parts[0][0] + '*'.repeat(Math.min(parts[0].length - 2, 5)) + parts[0].slice(-1) + '@' + parts[1];
}

// POST /api/verification/request — start verification for a card
router.post('/request', verifyLimiter, async function (req, res) {
    try {
        var cardId = req.body.cardId;
        if (!cardId || typeof cardId !== 'string') {
            return res.status(400).json({ error: 'Card ID is required' });
        }

        // Verify card belongs to user and has email
        var cardResult = await db.query(
            'SELECT data, active FROM cards WHERE user_id = $1 AND id = $2',
            [req.user.uid, cardId]
        );
        if (cardResult.rows.length === 0) return res.status(404).json({ error: 'Card not found' });
        if (!cardResult.rows[0].active) return res.status(403).json({ error: 'Card is deactivated' });

        var cardData = cardResult.rows[0].data;
        var cardEmail = (cardData.email || '').trim().toLowerCase();
        if (!cardEmail || !/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(cardEmail)) {
            return res.status(400).json({ error: 'Card must have a valid email address to verify' });
        }

        // Expire stale verifications older than 48 hours (pending/email_verified/documents_uploaded)
        await db.query(
            "UPDATE card_verifications SET status = 'rejected', rejection_reason = 'Expired — verification not completed within 48 hours', reviewed_at = NOW() WHERE user_id = $1 AND card_id = $2 AND status IN ('pending', 'email_verified', 'documents_uploaded') AND created_at < NOW() - INTERVAL '48 hours'",
            [req.user.uid, cardId]
        );

        // Check for existing active verification
        var existing = await db.query(
            "SELECT id, status FROM card_verifications WHERE user_id = $1 AND card_id = $2 AND status NOT IN ('approved', 'rejected') ORDER BY created_at DESC LIMIT 1",
            [req.user.uid, cardId]
        );
        if (existing.rows.length > 0) {
            return res.json({ id: existing.rows[0].id, status: existing.rows[0].status, email: maskEmail(cardEmail) });
        }

        // Create verification request
        var result = await db.query(
            "INSERT INTO card_verifications (user_id, card_id, status, card_email) VALUES ($1, $2, 'pending', $3) RETURNING id",
            [req.user.uid, cardId, cardEmail]
        );
        var verificationId = result.rows[0].id;

        // Generate and send OTP
        await db.query("DELETE FROM otp_codes WHERE email = $1 AND purpose = 'card_verify' AND expires_at < NOW()", [cardEmail]);
        var code = crypto.randomInt(100000, 1000000).toString();
        await db.query(
            "INSERT INTO otp_codes (email, code, expires_at, purpose) VALUES ($1, $2, NOW() + INTERVAL '10 minutes', 'card_verify')",
            [cardEmail, code]
        );

        // Send OTP email in background
        var cardName = cardData.name || 'your card';
        sendCardVerificationOTP(cardEmail, code, cardName).catch(function (err) {
            console.error('Verification OTP email error:', err.message);
        });

        res.json({ id: verificationId, status: 'pending', email: maskEmail(cardEmail) });
    } catch (err) {
        console.error('Verification request error:', err);
        res.status(500).json({ error: 'Failed to start verification' });
    }
});

// POST /api/verification/verify-email — verify OTP code
router.post('/verify-email', verifyLimiter, async function (req, res) {
    try {
        var verificationId = req.body.verificationId;
        var code = (req.body.code || '').trim();
        if (!verificationId || !code) {
            return res.status(400).json({ error: 'Verification ID and code are required' });
        }

        // Get verification record
        var vResult = await db.query(
            'SELECT id, user_id, card_email, status FROM card_verifications WHERE id = $1',
            [verificationId]
        );
        if (vResult.rows.length === 0) return res.status(404).json({ error: 'Verification not found' });
        var v = vResult.rows[0];
        if (v.user_id !== req.user.uid) return res.status(403).json({ error: 'Not your verification' });
        if (v.status !== 'pending') return res.status(400).json({ error: 'Email already verified or verification in different state' });

        // Check OTP
        var otpResult = await db.query(
            "SELECT id, expires_at FROM otp_codes WHERE email = $1 AND code = $2 AND purpose = 'card_verify'",
            [v.card_email, code]
        );

        if (otpResult.rows.length === 0) {
            await db.query("UPDATE otp_codes SET attempts = COALESCE(attempts, 0) + 1 WHERE email = $1 AND purpose = 'card_verify'", [v.card_email]);
            await db.query("DELETE FROM otp_codes WHERE email = $1 AND purpose = 'card_verify' AND COALESCE(attempts, 0) >= 3", [v.card_email]);
            return res.status(401).json({ error: 'Invalid code' });
        }

        var otpRow = otpResult.rows[0];
        if (new Date(otpRow.expires_at) < new Date()) {
            await db.query('DELETE FROM otp_codes WHERE id = $1', [otpRow.id]);
            return res.status(401).json({ error: 'Code has expired. Please request a new one.' });
        }

        // Valid — update status
        await db.query("DELETE FROM otp_codes WHERE email = $1 AND purpose = 'card_verify'", [v.card_email]);
        await db.query(
            "UPDATE card_verifications SET status = 'email_verified', email_verified = true WHERE id = $1",
            [verificationId]
        );

        res.json({ success: true, status: 'email_verified' });
    } catch (err) {
        console.error('Verify email error:', err);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// POST /api/verification/resend-otp — resend OTP code
router.post('/resend-otp', verifyLimiter, async function (req, res) {
    try {
        var verificationId = req.body.verificationId;
        if (!verificationId) return res.status(400).json({ error: 'Verification ID is required' });

        var vResult = await db.query(
            'SELECT id, user_id, card_id, card_email, status FROM card_verifications WHERE id = $1',
            [verificationId]
        );
        if (vResult.rows.length === 0) return res.status(404).json({ error: 'Verification not found' });
        var v = vResult.rows[0];
        if (v.user_id !== req.user.uid) return res.status(403).json({ error: 'Not your verification' });
        if (v.status !== 'pending') return res.status(400).json({ error: 'Email already verified' });

        // Rate limit OTP sends
        var countResult = await db.query(
            "SELECT COUNT(*) FROM otp_codes WHERE email = $1 AND purpose = 'card_verify' AND created_at > NOW() - INTERVAL '15 minutes'",
            [v.card_email]
        );
        if (parseInt(countResult.rows[0].count) >= 3) {
            return res.status(429).json({ error: 'Too many OTP requests. Please wait.' });
        }

        var code = crypto.randomInt(100000, 1000000).toString();
        await db.query(
            "INSERT INTO otp_codes (email, code, expires_at, purpose) VALUES ($1, $2, NOW() + INTERVAL '10 minutes', 'card_verify')",
            [v.card_email, code]
        );

        var cardResult = await db.query('SELECT data FROM cards WHERE user_id = $1 AND id = $2', [v.user_id, v.card_id]);
        var cardName = (cardResult.rows[0] && cardResult.rows[0].data && cardResult.rows[0].data.name) || 'your card';
        sendCardVerificationOTP(v.card_email, code, cardName).catch(function () {});

        res.json({ success: true });
    } catch (err) {
        console.error('Resend OTP error:', err);
        res.status(500).json({ error: 'Failed to resend code' });
    }
});

// POST /api/verification/upload-documents — upload 1-3 document images
router.post('/upload-documents', uploadLimiter, express.json({ limit: '8mb' }), async function (req, res) {
    try {
        var verificationId = req.body.verificationId;
        var documents = req.body.documents;

        if (!verificationId) return res.status(400).json({ error: 'Verification ID is required' });
        if (!Array.isArray(documents) || documents.length === 0) {
            return res.status(400).json({ error: 'At least 1 document is required' });
        }
        if (documents.length > 3) {
            return res.status(400).json({ error: 'Maximum 3 documents allowed' });
        }

        // Validate each document
        for (var i = 0; i < documents.length; i++) {
            var doc = documents[i];
            if (!doc || typeof doc.data !== 'string') {
                return res.status(400).json({ error: 'Document ' + (i + 1) + ' is missing image data' });
            }
            if (!doc.data.startsWith('data:image/')) {
                return res.status(400).json({ error: 'Document ' + (i + 1) + ' must be an image' });
            }
            if (doc.data.length > 2.7 * 1024 * 1024) {
                return res.status(400).json({ error: 'Document ' + (i + 1) + ' is too large (max 2MB)' });
            }
            doc.label = (doc.label || 'Document').substring(0, 50);
            doc.uploaded_at = new Date().toISOString();
        }

        // Check verification ownership and status
        var vResult = await db.query(
            'SELECT id, user_id, status FROM card_verifications WHERE id = $1',
            [verificationId]
        );
        if (vResult.rows.length === 0) return res.status(404).json({ error: 'Verification not found' });
        var v = vResult.rows[0];
        if (v.user_id !== req.user.uid) return res.status(403).json({ error: 'Not your verification' });
        if (v.status !== 'email_verified' && v.status !== 'documents_uploaded') {
            return res.status(400).json({ error: 'Please verify your email first' });
        }

        await db.query(
            "UPDATE card_verifications SET documents = $1, status = 'documents_uploaded' WHERE id = $2",
            [JSON.stringify(documents), verificationId]
        );

        res.json({ success: true, status: 'documents_uploaded', documentCount: documents.length });
    } catch (err) {
        console.error('Upload documents error:', err);
        res.status(500).json({ error: 'Failed to upload documents' });
    }
});

// POST /api/verification/submit — submit for AI review
router.post('/submit', verifyLimiter, async function (req, res) {
    try {
        var verificationId = req.body.verificationId;
        if (!verificationId) return res.status(400).json({ error: 'Verification ID is required' });

        var vResult = await db.query(
            'SELECT * FROM card_verifications WHERE id = $1',
            [verificationId]
        );
        if (vResult.rows.length === 0) return res.status(404).json({ error: 'Verification not found' });
        var v = vResult.rows[0];
        if (v.user_id !== req.user.uid) return res.status(403).json({ error: 'Not your verification' });
        if (v.status !== 'documents_uploaded') {
            return res.status(400).json({ error: 'Please upload documents first' });
        }

        // Set to reviewing
        await db.query("UPDATE card_verifications SET status = 'ai_reviewing' WHERE id = $1", [verificationId]);

        // Return immediately, process in background
        res.json({ success: true, status: 'ai_reviewing' });

        // Background AI review
        reviewDocumentsWithAI(v).catch(function (err) {
            console.error('AI review background error:', err);
        });
    } catch (err) {
        console.error('Submit verification error:', err);
        res.status(500).json({ error: 'Failed to submit verification' });
    }
});

// GET /api/verification/status/:cardId — get verification status
router.get('/status/:cardId', async function (req, res) {
    try {
        var result = await db.query(
            "SELECT cv.id, cv.status, cv.email_verified, cv.ai_result, cv.rejection_reason, cv.admin_note, cv.created_at, cv.reviewed_at, cv.card_email, c.verified_at " +
            "FROM card_verifications cv " +
            "LEFT JOIN cards c ON c.user_id = cv.user_id AND c.id = cv.card_id " +
            "WHERE cv.user_id = $1 AND cv.card_id = $2 ORDER BY cv.created_at DESC LIMIT 1",
            [req.user.uid, req.params.cardId]
        );

        if (result.rows.length === 0) {
            return res.json({ exists: false });
        }

        var v = result.rows[0];
        // If verification was approved but card's verified_at was revoked (e.g. email changed),
        // report as revoked so the user can re-verify
        var status = v.status;
        if (status === 'approved' && !v.verified_at) {
            status = 'revoked';
        }
        res.json({
            exists: true,
            id: v.id,
            status: status,
            email: maskEmail(v.card_email),
            emailVerified: v.email_verified,
            aiResult: v.ai_result ? {
                decision: v.ai_result.decision,
                reasoning: v.ai_result.reasoning
            } : null,
            rejectionReason: v.rejection_reason,
            adminNote: v.admin_note,
            createdAt: v.created_at,
            reviewedAt: v.reviewed_at
        });
    } catch (err) {
        console.error('Verification status error:', err);
        res.status(500).json({ error: 'Failed to get verification status' });
    }
});

// ── AI Review Function ──

async function reviewDocumentsWithAI(verification) {
    try {
        var ocr = require('../ocr');
        var client = await ocr.getClaudeClientAsync();

        var cardResult = await db.query(
            'SELECT data FROM cards WHERE user_id = $1 AND id = $2',
            [verification.user_id, verification.card_id]
        );
        if (cardResult.rows.length === 0) throw new Error('Card not found');
        var cardData = cardResult.rows[0].data;

        var content = [];
        var docs = verification.documents || [];

        for (var i = 0; i < docs.length; i++) {
            var doc = docs[i];
            var raw = doc.data;
            var mediaType = 'image/jpeg';
            if (raw.indexOf('data:image/png') === 0) mediaType = 'image/png';
            else if (raw.indexOf('data:image/webp') === 0) mediaType = 'image/webp';
            if (raw.indexOf(',') !== -1) raw = raw.split(',')[1];

            content.push({
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: raw }
            });
            content.push({
                type: 'text',
                text: 'Document ' + (i + 1) + ': ' + (doc.label || 'Unlabeled')
            });
        }

        var prompt = AI_REVIEW_PROMPT
            .replace('{NAME}', cardData.name || '')
            .replace('{EMAIL}', verification.card_email || '')
            .replace('{COMPANY}', cardData.company || '')
            .replace('{TITLE}', cardData.title || '');

        content.push({ type: 'text', text: prompt });

        var response = await client.messages.create({
            model: process.env.CLAUDE_OCR_MODEL || 'claude-sonnet-4-6',
            max_tokens: 1024,
            messages: [{ role: 'user', content: content }]
        });

        var text = response.content[0].text || '';
        var jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON in AI response');

        var result = JSON.parse(jsonMatch[0]);
        console.log('Verification AI result for #' + verification.id + ':', JSON.stringify(result));

        // Store AI result
        await db.query(
            'UPDATE card_verifications SET ai_result = $1 WHERE id = $2',
            [JSON.stringify(result), verification.id]
        );

        if (result.decision === 'approve' && result.confidence >= 0.85) {
            // Auto-approve
            await db.query(
                "UPDATE card_verifications SET status = 'approved', reviewed_at = NOW() WHERE id = $1",
                [verification.id]
            );
            await db.query(
                'UPDATE cards SET verified_at = NOW() WHERE user_id = $1 AND id = $2',
                [verification.user_id, verification.card_id]
            );
            sendVerificationApproved(verification.card_email, cardData.name || 'Your card').catch(function () {});
            console.log('Verification #' + verification.id + ' auto-approved (confidence: ' + result.confidence + ')');
        } else if (result.decision === 'reject' && result.confidence >= 0.9) {
            // Auto-reject (high bar)
            await db.query(
                "UPDATE card_verifications SET status = 'rejected', rejection_reason = $1, reviewed_at = NOW() WHERE id = $2",
                [result.reasoning || 'Documents did not match card information', verification.id]
            );
            sendVerificationRejected(verification.card_email, cardData.name || 'Your card', result.reasoning || 'Documents did not match card information').catch(function () {});
            console.log('Verification #' + verification.id + ' auto-rejected (confidence: ' + result.confidence + ')');
        } else {
            // Escalate to admin
            await db.query(
                "UPDATE card_verifications SET status = 'escalated' WHERE id = $1",
                [verification.id]
            );
            console.log('Verification #' + verification.id + ' escalated to admin (decision: ' + result.decision + ', confidence: ' + result.confidence + ')');
        }
    } catch (err) {
        console.error('AI verification review error for #' + verification.id + ':', err.message);
        // On failure, escalate to admin rather than blocking
        await db.query(
            "UPDATE card_verifications SET status = 'escalated', ai_result = $1 WHERE id = $2",
            [JSON.stringify({ error: err.message }), verification.id]
        ).catch(function () {});
    }
}

module.exports = router;
