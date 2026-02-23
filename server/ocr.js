/**
 * OCR Service — Vision model (direct image reading) with Tesseract.js + regex fallback
 *
 * Primary: Ollama vision model reads card image directly → structured JSON
 * Fallback: Tesseract.js text extraction → regex parsing
 */

var OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
var OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'moondream';
var OLLAMA_TEXT_MODEL = process.env.OLLAMA_TEXT_MODEL || 'qwen2.5:1.5b';

var VALID_FIELDS = ['name', 'title', 'company', 'phone', 'email', 'website', 'address', 'linkedin', 'instagram', 'twitter'];

// ── Vision prompts ──

var VISION_PROMPT = 'Read this business card image carefully. Extract ALL contact information you can see.\n' +
    'Return ONLY valid JSON with these fields (use empty string "" if not found):\n' +
    '{"name":"","title":"","company":"","phone":"","email":"","website":"","address":"","linkedin":"","instagram":"","twitter":""}\n\n' +
    'Rules:\n' +
    '- name: full person name\n' +
    '- title: job title or designation\n' +
    '- company: organization/company name\n' +
    '- phone: full phone number with country code if visible, digits and + only\n' +
    '- email: complete email address\n' +
    '- website: full URL\n' +
    '- address: physical/mailing address\n' +
    '- linkedin/instagram/twitter: username or URL if visible\n' +
    'Return ONLY the JSON object, nothing else.';

var VISION_PROMPT_MULTI = 'Read this business card image carefully. There may be ONE or MULTIPLE business cards or contacts visible.\n' +
    'Extract ALL contact information for EVERY person/contact you can see.\n' +
    'Return ONLY a valid JSON ARRAY of objects. Each object has these fields (use empty string "" if not found):\n' +
    '[{"name":"","title":"","company":"","phone":"","email":"","website":"","address":"","linkedin":"","instagram":"","twitter":""}]\n\n' +
    'Rules:\n' +
    '- If you see multiple people/cards, return one object per person\n' +
    '- name: full person name\n' +
    '- title: job title or designation\n' +
    '- company: organization/company name\n' +
    '- phone: full phone number with country code, digits and + only\n' +
    '- email: complete email address\n' +
    '- website: full URL\n' +
    '- address: physical/mailing address\n' +
    '- linkedin/instagram/twitter: username or URL\n' +
    '- Always return an array, even for one contact: [{...}]\n' +
    'Return ONLY the JSON array, nothing else.';

// ── Vision model: send image directly to Ollama ──

function visionParse(imageBase64, prompt) {
    // Strip data URL prefix
    var raw = imageBase64;
    if (raw.indexOf(',') !== -1) raw = raw.split(',')[1];

    var body = JSON.stringify({
        model: OLLAMA_VISION_MODEL,
        prompt: prompt || VISION_PROMPT,
        images: [raw],
        stream: false,
        options: { temperature: 0.1 }
    });

    return fetch(OLLAMA_URL + '/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        signal: AbortSignal.timeout(90000)
    }).then(function (res) {
        if (!res.ok) throw new Error('Ollama vision returned ' + res.status);
        return res.json();
    }).then(function (data) {
        return data.response || '';
    });
}

// ── JSON parsers ──

function parseJsonResponse(text) {
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    try { return normalizeFields(JSON.parse(text)); } catch (e) {}
    var match = text.match(/\{[\s\S]*\}/);
    if (match) {
        try { return normalizeFields(JSON.parse(match[0])); } catch (e) {}
    }
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
    var objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
        try { return [normalizeFields(JSON.parse(objMatch[0]))]; } catch (e) {}
    }
    throw new Error('Could not parse response as JSON array');
}

function normalizeFields(obj) {
    var result = {};
    VALID_FIELDS.forEach(function (f) {
        result[f] = (typeof obj[f] === 'string') ? obj[f].trim() : '';
    });
    return result;
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
    var body = JSON.stringify({
        model: OLLAMA_TEXT_MODEL,
        prompt: LLM_PROMPT + rawText,
        stream: false,
        options: { temperature: 0.1 }
    });
    return fetch(OLLAMA_URL + '/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        signal: AbortSignal.timeout(60000)
    }).then(function (res) {
        if (!res.ok) throw new Error('Ollama returned ' + res.status);
        return res.json();
    }).then(function (data) {
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

// ── Main entry: ocrAndParse — image → structured fields ──
// Strategy: vision model first → Tesseract + text LLM → Tesseract + regex

function ocrAndParse(imageBase64) {
    var t0 = Date.now();

    // Try vision model first (reads image directly, no Tesseract needed)
    return visionParse(imageBase64, VISION_PROMPT).then(function (response) {
        var fields = parseJsonResponse(response);
        console.log('OCR: Vision model done in ' + (Date.now() - t0) + 'ms');
        return { fields: fields, rawText: response, method: 'vision' };
    }).catch(function (visionErr) {
        console.log('OCR: Vision failed (' + visionErr.message + '), falling back to Tesseract');

        // Fallback: Tesseract + text LLM/regex
        var raw = imageBase64;
        if (raw.indexOf(',') !== -1) raw = raw.split(',')[1];
        var buffer = Buffer.from(raw, 'base64');
        var rawText = '';

        return extractText(buffer).then(function (text) {
            rawText = text;
            console.log('OCR: Tesseract done in ' + (Date.now() - t0) + 'ms');
            return llmParse(text).then(function (fields) {
                console.log('OCR: Text LLM parse done in ' + (Date.now() - t0) + 'ms');
                return { fields: fields, rawText: rawText, method: 'llm' };
            }).catch(function () {
                console.log('OCR: Text LLM failed, using regex');
                return { fields: regexParse(rawText), rawText: rawText, method: 'regex' };
            });
        });
    });
}

// ── Multi-contact entry: ocrAndParseMulti ──

function ocrAndParseMulti(imageBase64) {
    var t0 = Date.now();

    return visionParse(imageBase64, VISION_PROMPT_MULTI).then(function (response) {
        var contacts = parseJsonArrayResponse(response);
        console.log('OCR: Vision multi done in ' + (Date.now() - t0) + 'ms, ' + contacts.length + ' contacts');
        return { contacts: contacts, rawText: response, method: 'vision' };
    }).catch(function (visionErr) {
        console.log('OCR: Vision multi failed (' + visionErr.message + '), falling back to Tesseract');

        var raw = imageBase64;
        if (raw.indexOf(',') !== -1) raw = raw.split(',')[1];
        var buffer = Buffer.from(raw, 'base64');
        var rawText = '';

        return extractText(buffer).then(function (text) {
            rawText = text;
            // Try text LLM multi-parse
            var body = JSON.stringify({
                model: OLLAMA_TEXT_MODEL,
                prompt: 'Extract contact information from this business card text. There may be ONE or MULTIPLE contacts.\n' +
                    'Return ONLY a valid JSON ARRAY: [{"name":"","title":"","company":"","phone":"","email":"","website":"","address":"","linkedin":"","instagram":"","twitter":""}]\n\n' +
                    'Business card text:\n' + text,
                stream: false,
                options: { temperature: 0.1 }
            });
            return fetch(OLLAMA_URL + '/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: body,
                signal: AbortSignal.timeout(60000)
            }).then(function (res) {
                if (!res.ok) throw new Error('Ollama returned ' + res.status);
                return res.json();
            }).then(function (data) {
                var contacts = parseJsonArrayResponse(data.response || '');
                return { contacts: contacts, rawText: rawText, method: 'llm' };
            }).catch(function () {
                return { contacts: regexParseMulti(rawText), rawText: rawText, method: 'regex' };
            });
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
        return { running: true, models: models, visionModel: OLLAMA_VISION_MODEL, textModel: OLLAMA_TEXT_MODEL };
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
