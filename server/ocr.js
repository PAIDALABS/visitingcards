/**
 * OCR Service — Vision model (direct image reading) with Tesseract.js + regex fallback
 *
 * Primary: Ollama vision model reads card image directly → structured JSON
 * Fallback: Tesseract.js text extraction → regex parsing
 *
 * Ollama request queue allows up to 2 concurrent requests.
 */

var OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
var OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'moondream';
var OLLAMA_TEXT_MODEL = process.env.OLLAMA_TEXT_MODEL || 'qwen2.5:1.5b';

var VALID_FIELDS = ['name', 'title', 'company', 'phone', 'email', 'website', 'address', 'linkedin', 'instagram', 'twitter'];

// ── Ollama request queue (max 2 concurrent) ──

var ollamaQueue = [];
var ollamaActive = 0;
var OLLAMA_CONCURRENCY = 2;

function ollamaRequest(body, timeoutMs) {
    return new Promise(function (resolve, reject) {
        ollamaQueue.push({ body: body, timeoutMs: timeoutMs || 120000, resolve: resolve, reject: reject });
        processOllamaQueue();
    });
}

function processOllamaQueue() {
    while (ollamaActive < OLLAMA_CONCURRENCY && ollamaQueue.length > 0) {
        ollamaActive++;
        var item = ollamaQueue.shift();
        (function (it) {
            fetch(OLLAMA_URL + '/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(it.body),
                signal: AbortSignal.timeout(it.timeoutMs)
            }).then(function (res) {
                if (!res.ok) throw new Error('Ollama returned ' + res.status);
                return res.json();
            }).then(function (data) {
                it.resolve(data);
            }).catch(function (err) {
                it.reject(err);
            }).finally(function () {
                ollamaActive--;
                processOllamaQueue();
            });
        })(item);
    }
}

// ── Vision prompt — structured for accuracy ──

var VISION_PROMPT = 'Read this business card image carefully. Extract ALL contact information.\n' +
    'Return ONLY a JSON object — no markdown, no explanation:\n' +
    '{"name":"","title":"","company":"","phone":"","email":"","website":"","address":"","linkedin":"","instagram":"","twitter":""}\n' +
    'Rules:\n' +
    '- name: Full person name only (not company name)\n' +
    '- phone: Include country code if visible, digits and + only\n' +
    '- email: Full email address, lowercase\n' +
    '- website: Full URL including https://\n' +
    '- linkedin/instagram/twitter: Username only, no URL prefix\n' +
    '- Use "" for fields not found on the card';

// ── Vision model: send image directly to Ollama ──

function visionParse(imageBase64) {
    var raw = imageBase64;
    if (raw.indexOf(',') !== -1) raw = raw.split(',')[1];

    return ollamaRequest({
        model: OLLAMA_VISION_MODEL,
        prompt: VISION_PROMPT,
        images: [raw],
        stream: false,
        options: { temperature: 0.1, num_predict: 512 }
    }, 120000).then(function (data) {
        return data.response || '';
    });
}

// ── JSON parsers ──

function parseJsonResponse(text) {
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    try { return normalizeFields(JSON.parse(text)); } catch (e) {}
    var match = text.match(/\{[\s\S]*?\}/);
    if (match) {
        try { return normalizeFields(JSON.parse(match[0])); } catch (e) {}
    }
    // Try to fix common JSON issues (unquoted keys, trailing commas)
    var fixed = text.replace(/'/g, '"').replace(/,\s*\}/g, '}').replace(/,\s*\]/g, ']');
    try { return normalizeFields(JSON.parse(fixed)); } catch (e) {}
    var fixMatch = fixed.match(/\{[\s\S]*?\}/);
    if (fixMatch) {
        try { return normalizeFields(JSON.parse(fixMatch[0])); } catch (e) {}
    }
    // Last resort: extract fields individually via regex
    var extracted = {};
    VALID_FIELDS.forEach(function (f) {
        var m = text.match(new RegExp('"' + f + '"\\s*:\\s*"([^"]*)"'));
        if (m) extracted[f] = m[1];
    });
    if (Object.keys(extracted).length >= 2) return normalizeFields(extracted);
    throw new Error('Could not parse response as JSON');
}

function parseJsonArrayResponse(text) {
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    try {
        var parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed.map(normalizeFields);
        if (typeof parsed === 'object' && parsed !== null) return [normalizeFields(parsed)];
    } catch (e) {}
    var arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) {
        try {
            var arr = JSON.parse(arrMatch[0]);
            if (Array.isArray(arr)) return arr.map(normalizeFields);
        } catch (e) {}
    }
    var objMatch = text.match(/\{[\s\S]*?\}/);
    if (objMatch) {
        try { return [normalizeFields(JSON.parse(objMatch[0]))]; } catch (e) {}
    }
    throw new Error('Could not parse response as JSON array');
}

function normalizeFields(obj) {
    var result = {};
    VALID_FIELDS.forEach(function (f) {
        var val = (typeof obj[f] === 'string') ? obj[f].trim() : '';
        // Clean up common vision model artifacts
        if (val === '""' || val === 'N/A' || val === 'n/a' || val === 'none' || val === 'None') val = '';
        result[f] = val;
    });
    return result;
}

// Validate a contact has real data (not all empty/hallucinated)
function isValidContact(c) {
    var hasName = c.name && c.name.length > 3 && /[a-zA-Z]/.test(c.name);
    var hasEmail = c.email && /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(c.email);
    var hasPhone = c.phone && c.phone.replace(/[^\d]/g, '').length >= 7;
    return (hasName && (hasEmail || hasPhone)) || (hasEmail && hasPhone) || (hasName && c.company && c.company.length > 1);
}

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
        }
    }, 10 * 60 * 1000);
}

function extractText(imageBuffer) {
    return getWorker().then(function (worker) {
        return worker.recognize(imageBuffer);
    }).then(function (result) {
        return result.data.text;
    });
}

// ── Text-based LLM parse (for Tesseract fallback path) ──

var LLM_PROMPT = 'Extract contact information from this business card text. Return ONLY valid JSON with these fields (use empty string if not found):\n' +
    '{"name":"","title":"","company":"","phone":"","email":"","website":"","address":"","linkedin":"","instagram":"","twitter":""}\n\n' +
    'Business card text:\n';

function llmParse(rawText) {
    return ollamaRequest({
        model: OLLAMA_TEXT_MODEL,
        prompt: LLM_PROMPT + rawText,
        stream: false,
        options: { temperature: 0.1, num_predict: 512 }
    }, 60000).then(function (data) {
        return parseJsonResponse(data.response || '');
    });
}

// ── Regex fallback ──

function regexParse(text) {
    var result = { name: '', title: '', company: '', phone: '', email: '', website: '', address: '', linkedin: '', instagram: '', twitter: '' };
    var lines = text.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 1; });
    var fullText = text.replace(/\n/g, ' ');

    var emailMatch = fullText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) result.email = emailMatch[0].toLowerCase();
    var phoneMatch = fullText.match(/(?:\+?\d[\d\s\-\(\)]{8,}\d)/);
    if (phoneMatch) result.phone = phoneMatch[0].replace(/[^\d+]/g, '');
    var urlMatch = fullText.match(/https?:\/\/[^\s]+|www\.[^\s]+/i);
    if (urlMatch) result.website = urlMatch[0];
    var linkedinMatch = fullText.match(/linkedin\.com\/in\/([^\s\/]+)/i);
    if (linkedinMatch) result.linkedin = linkedinMatch[1];
    var instaMatch = fullText.match(/instagram\.com\/([^\s\/]+)/i);
    if (instaMatch) result.instagram = instaMatch[1];
    var twitterMatch = fullText.match(/(?:twitter|x)\.com\/([^\s\/]+)/i);
    if (twitterMatch) result.twitter = twitterMatch[1];

    var titleWords = /\b(ceo|cto|cfo|coo|director|manager|engineer|developer|designer|founder|president|vp|vice\s*president|head|lead|chief|officer|consultant|analyst|associate|partner|advisor|specialist|coordinator|executive|administrator|intern|assistant|supervisor|architect|scientist|professor|doctor)\b/i;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.match(/@/) || line.match(/^[\d\+\(\s\-\)]{8,}$/) || line.match(/^http/i) || line.match(/^www\./i)) continue;
        if (line.length <= 2) continue;
        if (!result.name) result.name = line;
        else if (!result.title && titleWords.test(line)) result.title = line;
        else if (!result.company && line !== result.name) result.company = line;
        if (result.name && result.company && result.title) break;
    }
    return result;
}

function regexParseMulti(text) {
    var emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    var allEmails = [];
    var m;
    while ((m = emailRegex.exec(text)) !== null) {
        var email = m[0].toLowerCase();
        if (allEmails.indexOf(email) === -1) allEmails.push(email);
    }
    if (allEmails.length >= 2) {
        var contacts = [];
        for (var i = 0; i < allEmails.length; i++) {
            var start = i === 0 ? 0 : text.indexOf(allEmails[i - 1]) + allEmails[i - 1].length;
            var end = i === allEmails.length - 1 ? text.length : text.indexOf(allEmails[i + 1]);
            var parsed = regexParse(text.substring(start, end));
            if (!parsed.email) parsed.email = allEmails[i];
            contacts.push(parsed);
        }
        return contacts;
    }
    return [regexParse(text)];
}

// ── Tesseract + LLM/regex pipeline (used as fallback and for enrichment) ──

function tesseractPipeline(imageBase64) {
    var raw = imageBase64;
    if (raw.indexOf(',') !== -1) raw = raw.split(',')[1];
    var buffer = Buffer.from(raw, 'base64');
    var rawText = '';
    var t0 = Date.now();

    return extractText(buffer).then(function (text) {
        rawText = text;
        console.log('OCR: Tesseract done in ' + (Date.now() - t0) + 'ms, text length: ' + text.length);
        return llmParse(text).then(function (fields) {
            console.log('OCR: Text LLM done in ' + (Date.now() - t0) + 'ms');
            return { fields: fields, rawText: rawText, method: 'llm' };
        }).catch(function () {
            console.log('OCR: Text LLM failed, using regex');
            return { fields: regexParse(rawText), rawText: rawText, method: 'regex' };
        });
    });
}

// ── Main entry: ocrAndParse — image → structured fields ──

function ocrAndParse(imageBase64) {
    var t0 = Date.now();

    // Try vision model first
    return visionParse(imageBase64).then(function (response) {
        var fields = parseJsonResponse(response);
        console.log('OCR: Vision done in ' + (Date.now() - t0) + 'ms');
        // Validate: only fall back to Tesseract if vision returned almost nothing
        if (!isValidContact(fields)) {
            var fieldCount = VALID_FIELDS.filter(function (f) { return fields[f]; }).length;
            if (fieldCount < 2) {
                console.log('OCR: Vision result too sparse (' + fieldCount + ' fields), enriching with Tesseract');
                return tesseractPipeline(imageBase64).then(function (fallback) {
                    VALID_FIELDS.forEach(function (f) {
                        if (!fields[f] && fallback.fields[f]) fields[f] = fallback.fields[f];
                    });
                    return { fields: fields, rawText: response, method: 'vision+' + fallback.method };
                });
            }
            console.log('OCR: Vision partial (' + fieldCount + ' fields), skipping Tesseract');
        }
        return { fields: fields, rawText: response, method: 'vision' };
    }).catch(function (visionErr) {
        console.log('OCR: Vision failed (' + visionErr.message + '), using Tesseract pipeline');
        return tesseractPipeline(imageBase64);
    });
}

// ── Multi-contact entry: ocrAndParseMulti ──
// For scanner — uses vision model with single-contact prompt (more reliable),
// since most card photos contain just one card.

function ocrAndParseMulti(imageBase64) {
    var t0 = Date.now();

    // Use single-contact vision prompt (more reliable than multi-contact prompt)
    return visionParse(imageBase64).then(function (response) {
        console.log('OCR: Vision multi done in ' + (Date.now() - t0) + 'ms');
        // Try to parse as single object first (most common case)
        try {
            var fields = parseJsonResponse(response);
            if (isValidContact(fields)) {
                return { contacts: [fields], rawText: response, method: 'vision' };
            }
        } catch (e) {}
        // Try array parse
        try {
            var contacts = parseJsonArrayResponse(response);
            contacts = contacts.filter(isValidContact);
            if (contacts.length > 0) {
                // Cap at 4 contacts max per image (prevent hallucination)
                if (contacts.length > 4) contacts = contacts.slice(0, 4);
                return { contacts: contacts, rawText: response, method: 'vision' };
            }
        } catch (e) {}
        throw new Error('Vision result not valid');
    }).catch(function (visionErr) {
        console.log('OCR: Vision multi failed (' + visionErr.message + '), using Tesseract pipeline');

        var raw = imageBase64;
        if (raw.indexOf(',') !== -1) raw = raw.split(',')[1];
        var buffer = Buffer.from(raw, 'base64');

        return extractText(buffer).then(function (text) {
            console.log('OCR: Tesseract done in ' + (Date.now() - t0) + 'ms');
            // Use regex multi-parse (fast, reliable)
            var contacts = regexParseMulti(text);
            return { contacts: contacts, rawText: text, method: 'regex' };
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
        return { running: true, models: models, visionModel: OLLAMA_VISION_MODEL, textModel: OLLAMA_TEXT_MODEL, queueLength: ollamaQueue.length };
    }).catch(function () {
        return { running: false, models: [], visionModel: OLLAMA_VISION_MODEL, textModel: OLLAMA_TEXT_MODEL };
    });
}

module.exports = {
    ocrAndParse: ocrAndParse,
    ocrAndParseMulti: ocrAndParseMulti,
    extractText: extractText,
    llmParse: llmParse,
    regexParse: regexParse,
    regexParseMulti: regexParseMulti,
    checkOllamaStatus: checkOllamaStatus
};
