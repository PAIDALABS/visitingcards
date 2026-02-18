/**
 * OCR Service — Tesseract.js (text extraction) + Ollama LLM (intelligent parsing) + regex fallback
 */

var OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
var OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';

// ── Tesseract.js worker (lazy-init, reused, auto-terminate after 10 min idle) ──

var tesseractWorker = null;
var tesseractIdleTimer = null;
var tesseractInitializing = false;
var tesseractQueue = [];

function getWorker() {
    if (tesseractWorker) {
        resetIdleTimer();
        return Promise.resolve(tesseractWorker);
    }
    return new Promise(function (resolve, reject) {
        tesseractQueue.push({ resolve: resolve, reject: reject });
        if (tesseractInitializing) return;
        tesseractInitializing = true;

        var Tesseract = require('tesseract.js');
        Tesseract.createWorker('eng').then(function (worker) {
            tesseractWorker = worker;
            tesseractInitializing = false;
            resetIdleTimer();
            var q = tesseractQueue.splice(0);
            q.forEach(function (p) { p.resolve(worker); });
        }).catch(function (err) {
            tesseractInitializing = false;
            var q = tesseractQueue.splice(0);
            q.forEach(function (p) { p.reject(err); });
        });
    });
}

function resetIdleTimer() {
    if (tesseractIdleTimer) clearTimeout(tesseractIdleTimer);
    tesseractIdleTimer = setTimeout(function () {
        if (tesseractWorker) {
            tesseractWorker.terminate().catch(function () {});
            tesseractWorker = null;
            console.log('Tesseract worker terminated (idle)');
        }
    }, 10 * 60 * 1000); // 10 minutes
}

// ── extractText: image buffer → raw OCR text ──

function extractText(imageBuffer) {
    return getWorker().then(function (worker) {
        return worker.recognize(imageBuffer);
    }).then(function (result) {
        return result.data.text;
    });
}

// ── LLM prompt for structured extraction ──

var LLM_PROMPT = 'Extract contact information from this business card text. Return ONLY valid JSON with these fields (use empty string if not found):\n' +
    '{"name":"","title":"","company":"","phone":"","email":"","website":"","address":"","linkedin":"","instagram":"","twitter":""}\n\n' +
    'Rules:\n' +
    '- name: full person name only\n' +
    '- title: job title/designation\n' +
    '- company: organization name\n' +
    '- phone: include country code if present, digits and + only\n' +
    '- email: full email address\n' +
    '- website: full URL (add https:// if missing)\n' +
    '- address: physical address\n' +
    '- linkedin/instagram/twitter: username or full URL\n\n' +
    'Business card text:\n';

// ── llmParse: raw OCR text → structured fields via Ollama ──

function llmParse(rawText) {
    var body = JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: LLM_PROMPT + rawText,
        stream: false,
        options: { temperature: 0.1 }
    });

    return fetch(OLLAMA_URL + '/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        signal: AbortSignal.timeout(30000)
    }).then(function (res) {
        if (!res.ok) throw new Error('Ollama returned ' + res.status);
        return res.json();
    }).then(function (data) {
        return parseJsonResponse(data.response || '');
    });
}

// Robust JSON parser — handles code fences, trailing text, partial JSON
function parseJsonResponse(text) {
    // Strip markdown code fences
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

    // Try direct parse
    try { return normalizeFields(JSON.parse(text)); } catch (e) {}

    // Try extracting JSON object from surrounding text
    var match = text.match(/\{[\s\S]*\}/);
    if (match) {
        try { return normalizeFields(JSON.parse(match[0])); } catch (e) {}
    }

    throw new Error('Could not parse LLM response as JSON');
}

var VALID_FIELDS = ['name', 'title', 'company', 'phone', 'email', 'website', 'address', 'linkedin', 'instagram', 'twitter'];

function normalizeFields(obj) {
    var result = {};
    VALID_FIELDS.forEach(function (f) {
        result[f] = (typeof obj[f] === 'string') ? obj[f].trim() : '';
    });
    return result;
}

// ── Regex fallback — port of client-side parseBusinessCardOCR ──

function regexParse(text) {
    var result = { name: '', title: '', company: '', phone: '', email: '', website: '', address: '', linkedin: '', instagram: '', twitter: '' };
    var lines = text.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 1; });
    var fullText = text.replace(/\n/g, ' ');

    // Email
    var emailMatch = fullText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) result.email = emailMatch[0].toLowerCase();

    // Phone (must start and end with digit)
    var phoneMatch = fullText.match(/(?:\+?\d[\d\s\-\(\)]{8,}\d)/);
    if (phoneMatch) result.phone = phoneMatch[0].replace(/[^\d+]/g, '');

    // URL
    var urlMatch = fullText.match(/https?:\/\/[^\s]+|www\.[^\s]+/i);
    if (urlMatch) result.website = urlMatch[0];

    // Social media
    var linkedinMatch = fullText.match(/linkedin\.com\/in\/([^\s\/]+)/i);
    if (linkedinMatch) result.linkedin = linkedinMatch[1];
    var instaMatch = fullText.match(/instagram\.com\/([^\s\/]+)/i);
    if (instaMatch) result.instagram = instaMatch[1];
    var twitterMatch = fullText.match(/(?:twitter|x)\.com\/([^\s\/]+)/i);
    if (twitterMatch) result.twitter = twitterMatch[1];

    // Title keywords
    var titleWords = /\b(ceo|cto|cfo|coo|director|manager|engineer|developer|designer|founder|president|vp|vice\s*president|head|lead|chief|officer|consultant|analyst|associate|partner|advisor|specialist|coordinator|executive|administrator|intern|assistant|supervisor|architect|scientist|professor|doctor)\b/i;

    // Classify lines
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.match(/@/) || line.match(/^[\d\+\(\s\-\)]{8,}$/) || line.match(/^http/i) || line.match(/^www\./i)) continue;
        if (line.length <= 2) continue;

        if (!result.name) {
            result.name = line;
        } else if (!result.title && titleWords.test(line)) {
            result.title = line;
        } else if (!result.company && line !== result.name) {
            result.company = line;
        }
        if (result.name && result.company && result.title) break;
    }

    return result;
}

// ── Main entry: ocrAndParse — base64 image → structured fields ──

function ocrAndParse(imageBase64) {
    // Strip data URL prefix if present
    var raw = imageBase64;
    if (raw.indexOf(',') !== -1) raw = raw.split(',')[1];
    var buffer = Buffer.from(raw, 'base64');

    var rawText = '';
    return extractText(buffer).then(function (text) {
        rawText = text;

        // Try LLM parsing first
        return llmParse(text).then(function (fields) {
            return { fields: fields, rawText: rawText, method: 'llm' };
        }).catch(function (err) {
            console.log('LLM parse failed, using regex fallback:', err.message);
            return { fields: regexParse(rawText), rawText: rawText, method: 'regex' };
        });
    });
}

// ── Check Ollama status ──

function checkOllamaStatus() {
    return fetch(OLLAMA_URL + '/api/tags', {
        signal: AbortSignal.timeout(5000)
    }).then(function (res) {
        if (!res.ok) throw new Error('Ollama returned ' + res.status);
        return res.json();
    }).then(function (data) {
        var models = (data.models || []).map(function (m) { return m.name; });
        return { running: true, models: models, configured: OLLAMA_MODEL };
    }).catch(function () {
        return { running: false, models: [], configured: OLLAMA_MODEL };
    });
}

module.exports = {
    ocrAndParse: ocrAndParse,
    extractText: extractText,
    llmParse: llmParse,
    regexParse: regexParse,
    checkOllamaStatus: checkOllamaStatus
};
