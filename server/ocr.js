/**
 * OCR Service — Claude Haiku vision (primary) with Tesseract.js + regex fallback
 *
 * Primary: Claude API reads card image directly → structured JSON
 * Fallback: Tesseract.js text extraction → Claude text parse → regex
 *
 * Auth: reads OAuth token from ~/.claude/.credentials.json (Claude Code CLI)
 *       Uses anthropic-beta: oauth-2025-04-20 header for OAuth support
 */

var fs = require('fs');
var path = require('path');
var Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

var CLAUDE_MODEL = process.env.CLAUDE_OCR_MODEL || 'claude-haiku-4-5-20251001';
var CREDENTIALS_PATH = path.join(process.env.HOME || '/root', '.claude', '.credentials.json');
var OAUTH_BETA_HEADER = 'oauth-2025-04-20';

var VALID_FIELDS = ['name', 'title', 'company', 'phone', 'email', 'website', 'address', 'linkedin', 'instagram', 'twitter'];

// ── OAuth token refresh ──

var OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
var OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
var OAUTH_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers';
var refreshingPromise = null;

function refreshOAuthToken() {
    if (refreshingPromise) return refreshingPromise;

    refreshingPromise = (function () {
        var creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
        var refreshToken = creds.claudeAiOauth && creds.claudeAiOauth.refreshToken;
        if (!refreshToken) return Promise.reject(new Error('No refresh token'));

        var https = require('https');
        var body = JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: OAUTH_CLIENT_ID,
            scope: OAUTH_SCOPES
        });

        return new Promise(function (resolve, reject) {
            var req = https.request(OAUTH_TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, function (res) {
                var data = '';
                res.on('data', function (chunk) { data += chunk; });
                res.on('end', function () {
                    if (res.statusCode !== 200) {
                        return reject(new Error('Token refresh failed: ' + res.statusCode + ' ' + data));
                    }
                    try {
                        var parsed = JSON.parse(data);
                        var newToken = parsed.access_token;
                        var newRefresh = parsed.refresh_token || refreshToken;
                        var expiresIn = parsed.expires_in || 3600;
                        var newExpiry = Date.now() + expiresIn * 1000;

                        // Update credentials file
                        creds.claudeAiOauth.accessToken = newToken;
                        creds.claudeAiOauth.refreshToken = newRefresh;
                        creds.claudeAiOauth.expiresAt = newExpiry;
                        fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));

                        console.log('OCR: Token refreshed, expires in ' + Math.round(expiresIn / 60) + 'min');
                        resolve({ token: newToken, expiry: newExpiry });
                    } catch (e) {
                        reject(new Error('Failed to parse refresh response'));
                    }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    })().finally(function () { refreshingPromise = null; });

    return refreshingPromise;
}

// ── Claude API client (lazy-init, auto-refresh token) ──

var claudeClient = null;
var claudeTokenExpiry = 0;

function getClaudeClient() {
    var now = Date.now();
    if (claudeClient && now < claudeTokenExpiry - 60000) return claudeClient;

    try {
        var creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
        var token = creds.claudeAiOauth && creds.claudeAiOauth.accessToken;
        var expiry = creds.claudeAiOauth && creds.claudeAiOauth.expiresAt;
        if (!token) throw new Error('No access token in credentials');

        // If expired or expiring within 5 min, trigger async refresh
        if (expiry && now > expiry - 300000) {
            console.log('OCR: Token expired or expiring soon, refreshing...');
            return null; // caller should use getClaudeClientAsync
        }

        claudeClient = new Anthropic({
            authToken: token,
            defaultHeaders: { 'anthropic-beta': OAUTH_BETA_HEADER }
        });
        claudeTokenExpiry = expiry || (now + 3600000);
        console.log('OCR: Claude client initialized (model: ' + CLAUDE_MODEL + ', expires in ' + Math.round((claudeTokenExpiry - now) / 60000) + 'min)');
        return claudeClient;
    } catch (err) {
        console.error('OCR: Failed to init Claude client:', err.message);
        claudeClient = null;
        return null;
    }
}

function getClaudeClientAsync() {
    var client = getClaudeClient();
    if (client) return Promise.resolve(client);

    return refreshOAuthToken().then(function (result) {
        claudeClient = new Anthropic({
            authToken: result.token,
            defaultHeaders: { 'anthropic-beta': OAUTH_BETA_HEADER }
        });
        claudeTokenExpiry = result.expiry;
        return claudeClient;
    });
}

// ── Vision prompt ──

var VISION_PROMPT = 'Read this business card image carefully. Extract ALL visible contact information.\n' +
    'Return ONLY a JSON object — no markdown, no explanation, no extra text:\n' +
    '{"name":"","title":"","company":"","phone":"","email":"","website":"","address":"","linkedin":"","instagram":"","twitter":"","crop":{"x":0,"y":0,"w":100,"h":100}}\n\n' +
    'Rules:\n' +
    '- name: Full person name only (NOT company name, NOT job title)\n' +
    '- title: Job title or designation (e.g. CEO, Senior Manager, Director of Sales)\n' +
    '- company: Organization or company name\n' +
    '- phone: Full phone number with country code if visible. If multiple phones, pick the mobile/cell number\n' +
    '- email: Full email address exactly as shown, lowercase\n' +
    '- website: Full URL. Add https:// if not shown\n' +
    '- address: Full street/office address as one line\n' +
    '- linkedin: LinkedIn username only (not full URL). Extract from linkedin.com/in/USERNAME\n' +
    '- instagram: Instagram handle only (no @ prefix, no URL)\n' +
    '- twitter: Twitter/X handle only (no @ prefix, no URL)\n' +
    '- crop: Bounding box of the business card in the image as percentage coordinates (0-100). x=left edge %, y=top edge %, w=width %, h=height %. If the card fills the whole image, use {x:0,y:0,w:100,h:100}\n' +
    '- Use "" for any field not found on the card\n' +
    '- Read ALL text carefully — small text, rotated text, text on edges';

// ── Claude vision: send image directly ──

function claudeVisionParse(imageBase64) {
    var raw = imageBase64;
    if (raw.indexOf(',') !== -1) raw = raw.split(',')[1];

    // Detect media type from data URL prefix
    var mediaType = 'image/jpeg';
    if (imageBase64.indexOf('data:image/png') === 0) mediaType = 'image/png';
    else if (imageBase64.indexOf('data:image/webp') === 0) mediaType = 'image/webp';

    return getClaudeClientAsync().then(function (client) {
        return client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        messages: [{
            role: 'user',
            content: [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data: raw } },
                { type: 'text', text: VISION_PROMPT }
            ]
        }]
    }).then(function (response) {
            var text = '';
            if (response.content && response.content.length > 0) {
                text = response.content[0].text || '';
            }
            return text;
        });
    });
}

// ── Claude text parse (for Tesseract fallback path) ──

var TEXT_PROMPT = 'Extract contact information from this business card text. Return ONLY a JSON object — no markdown, no explanation:\n' +
    '{"name":"","title":"","company":"","phone":"","email":"","website":"","address":"","linkedin":"","instagram":"","twitter":""}\n' +
    'Rules:\n' +
    '- name: Full person name only (NOT company name, NOT job title)\n' +
    '- title: Job title / designation\n' +
    '- company: Organization / company name\n' +
    '- phone: Full number with country code if present\n' +
    '- email: Full email address, lowercase\n' +
    '- website: Full URL\n' +
    '- Use "" for fields not found\n\n' +
    'Business card text:\n';

function claudeTextParse(rawText) {
    return getClaudeClientAsync().then(function (client) {
        return client.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: 1024,
            messages: [{
                role: 'user',
                content: TEXT_PROMPT + rawText
            }]
        });
    }).then(function (response) {
        var text = '';
        if (response.content && response.content.length > 0) {
            text = response.content[0].text || '';
        }
        return parseJsonResponse(text);
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
    var fixed = text.replace(/'/g, '"').replace(/,\s*\}/g, '}').replace(/,\s*\]/g, ']');
    try { return normalizeFields(JSON.parse(fixed)); } catch (e) {}
    var fixMatch = fixed.match(/\{[\s\S]*?\}/);
    if (fixMatch) {
        try { return normalizeFields(JSON.parse(fixMatch[0])); } catch (e) {}
    }
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
        if (val === '""' || val === 'N/A' || val === 'n/a' || val === 'none' || val === 'None' || val === 'null' || val === 'undefined' || val === '-') val = '';
        result[f] = val;
    });
    return cleanFields(result);
}

// ── Deep field cleaning and cross-validation ──

var COMPANY_SUFFIXES = /\b(inc|llc|ltd|pvt|corp|co|plc|gmbh|ag|sa|srl|llp|lp|pte|pty|limited|private|incorporated|corporation|group|holdings|enterprises|solutions|technologies|consulting|services|international|industries|associates|partners|ventures|labs|studio|agency|foundation)\b\.?/i;
var PERSON_TITLE_PREFIXES = /^(mr|mrs|ms|miss|dr|prof|sir|shri|smt|er)\b\.?\s*/i;

function cleanFields(c) {
    if (c.email) {
        c.email = c.email.toLowerCase().replace(/\s/g, '');
        c.email = c.email.replace(/\[at\]/gi, '@').replace(/\[dot\]/gi, '.');
        if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(c.email)) c.email = '';
    }

    if (c.phone) {
        c.phone = c.phone.replace(/[^\d+\-\s\(\)]/g, '').replace(/\s+/g, ' ').trim();
        var digits = c.phone.replace(/[^\d]/g, '');
        if (digits.length < 7 || digits.length > 15) c.phone = '';
    }

    if (c.website) {
        c.website = c.website.replace(/[,;]+$/, '').trim();
        if (!/^https?:\/\//i.test(c.website)) {
            if (/^www\./i.test(c.website) || /\.\w{2,}/.test(c.website)) {
                c.website = 'https://' + c.website.replace(/^\/\//, '');
            }
        }
        if (!/\.\w{2,}/.test(c.website)) c.website = '';
    }

    ['linkedin', 'instagram', 'twitter'].forEach(function (f) {
        if (c[f]) {
            c[f] = c[f].replace(/^https?:\/\/(www\.)?(linkedin\.com\/in\/|instagram\.com\/|twitter\.com\/|x\.com\/)/i, '')
                .replace(/^@/, '').replace(/\/+$/, '').trim();
        }
    });

    if (c.name) {
        c.name = c.name.replace(PERSON_TITLE_PREFIXES, '').trim();
        if (c.name === c.name.toUpperCase() && c.name.length > 2) {
            c.name = c.name.toLowerCase().replace(/\b\w/g, function (l) { return l.toUpperCase(); });
        }
    }

    if (c.title && c.title === c.title.toUpperCase() && c.title.length > 3) {
        c.title = c.title.toLowerCase().replace(/\b\w/g, function (l) { return l.toUpperCase(); });
        c.title = c.title.replace(/\b(Ceo|Cto|Cfo|Coo|Vp|Hr|It|Pr|Ui|Ux)\b/g, function (m) { return m.toUpperCase(); });
    }

    if (c.company) {
        c.company = c.company.replace(/[.,;]+$/, '').trim();
        if (c.company === c.company.toUpperCase() && c.company.length > 3) {
            if (c.company.length > 6) {
                c.company = c.company.toLowerCase().replace(/\b\w/g, function (l) { return l.toUpperCase(); });
            }
        }
    }

    // Cross-field validation
    if (c.name && c.name.indexOf('@') !== -1) {
        if (!c.email) c.email = c.name.toLowerCase();
        c.name = '';
    }
    if (c.name && /^[\d\+\-\s\(\)]{8,}$/.test(c.name)) {
        if (!c.phone) c.phone = c.name;
        c.name = '';
    }
    if (c.name && /^(https?:\/\/|www\.)/i.test(c.name)) {
        if (!c.website) c.website = c.name;
        c.name = '';
    }
    if (c.name && COMPANY_SUFFIXES.test(c.name)) {
        if (!c.company || (!COMPANY_SUFFIXES.test(c.company) && /^[A-Za-z]+\s+[A-Za-z]+$/.test(c.company))) {
            var tmp = c.company;
            c.company = c.name;
            c.name = tmp || '';
        }
    }
    if (!c.name && c.company && /^[A-Za-z]+(\s+[A-Za-z]+){1,2}$/.test(c.company) && !COMPANY_SUFFIXES.test(c.company)) {
        c.name = c.company;
        c.company = '';
    }
    if (c.title && c.title.indexOf('@') !== -1) {
        if (!c.email) c.email = c.title.toLowerCase().replace(/\s/g, '');
        c.title = '';
    }

    VALID_FIELDS.forEach(function (f) { if (c[f]) c[f] = c[f].trim(); });
    return c;
}

// Validate a contact has real data
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

    var addressMatch = fullText.match(/\d+[^,\n]*(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|floor|suite|ste|block|sector|plot|nagar|marg)[^,\n]*/i);
    if (addressMatch) result.address = addressMatch[0].trim();

    var titleWords = /\b(ceo|cto|cfo|coo|cmo|director|manager|engineer|developer|designer|founder|co-?founder|president|vp|vice\s*president|head|lead|chief|officer|consultant|analyst|associate|partner|advisor|specialist|coordinator|executive|administrator|intern|assistant|supervisor|architect|scientist|professor|doctor|md|managing\s+director)\b/i;
    var candidateLines = [];

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.match(/@/)) continue;
        if (line.replace(/[^\d]/g, '').length > 6) continue;
        if (/^(https?:\/\/|www\.)/i.test(line)) continue;
        if (/linkedin|instagram|twitter|facebook/i.test(line)) continue;
        if (line.length <= 2 || line.length > 80) continue;
        if (/\b(street|st|avenue|ave|road|rd|floor|suite|pin|zip|sector|plot|nagar|marg)\b/i.test(line) && /\d/.test(line)) continue;

        var isTitle = titleWords.test(line);
        var isCompany = COMPANY_SUFFIXES.test(line);
        var isPersonName = /^[A-Za-z][A-Za-z.\-']+(\s+[A-Za-z][A-Za-z.\-']+){0,3}$/.test(line) && !/\d/.test(line) && !isCompany;

        candidateLines.push({ text: line, isTitle: isTitle, isCompany: isCompany, isPersonName: isPersonName, idx: i });
    }

    for (var j = 0; j < candidateLines.length; j++) {
        if (candidateLines[j].isTitle && !result.title) {
            result.title = candidateLines[j].text;
            candidateLines[j].used = true;
        } else if (candidateLines[j].isCompany && !result.company) {
            result.company = candidateLines[j].text;
            candidateLines[j].used = true;
        }
    }

    for (var k = 0; k < candidateLines.length; k++) {
        if (candidateLines[k].used) continue;
        if (candidateLines[k].isPersonName) {
            result.name = candidateLines[k].text;
            candidateLines[k].used = true;
            break;
        }
    }

    for (var l = 0; l < candidateLines.length; l++) {
        if (candidateLines[l].used) continue;
        if (!result.name) { result.name = candidateLines[l].text; candidateLines[l].used = true; }
        else if (!result.company) { result.company = candidateLines[l].text; candidateLines[l].used = true; }
        if (result.name && result.company) break;
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

// ── Tesseract + Claude/regex pipeline (fallback) ──

function tesseractPipeline(imageBase64) {
    var raw = imageBase64;
    if (raw.indexOf(',') !== -1) raw = raw.split(',')[1];
    var buffer = Buffer.from(raw, 'base64');
    var rawText = '';
    var t0 = Date.now();

    return extractText(buffer).then(function (text) {
        rawText = text;
        console.log('OCR: Tesseract done in ' + (Date.now() - t0) + 'ms, text length: ' + text.length);
        return claudeTextParse(text).then(function (fields) {
            console.log('OCR: Claude text parse done in ' + (Date.now() - t0) + 'ms');
            return { fields: fields, rawText: rawText, method: 'tesseract+claude' };
        }).catch(function () {
            console.log('OCR: Claude text parse failed, using regex');
            return { fields: regexParse(rawText), rawText: rawText, method: 'tesseract+regex' };
        });
    });
}

// ── Extract crop coordinates from Claude response ──

function extractCrop(text) {
    var cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    try {
        var parsed = JSON.parse(cleaned);
        if (parsed && parsed.crop) return validateCrop(parsed.crop);
    } catch (e) {}
    // Try to find the outermost JSON object (greedy)
    var match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
        try {
            var parsed2 = JSON.parse(match[0]);
            if (parsed2 && parsed2.crop) return validateCrop(parsed2.crop);
        } catch (e) {}
    }
    return null;
}

function validateCrop(c) {
    if (!c || typeof c !== 'object') return null;
    var x = Number(c.x), y = Number(c.y), w = Number(c.w), h = Number(c.h);
    if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) return null;
    if (w < 10 || h < 10) return null; // too small — skip
    if (x === 0 && y === 0 && w === 100 && h === 100) return null; // full image — no crop needed
    x = Math.max(0, Math.min(100, x));
    y = Math.max(0, Math.min(100, y));
    w = Math.min(100 - x, w);
    h = Math.min(100 - y, h);
    return { x: x, y: y, w: w, h: h };
}

// ── Main entry: ocrAndParse — image → structured fields ──

function mergeFields(primary, secondary) {
    var merged = {};
    VALID_FIELDS.forEach(function (f) {
        var a = primary[f] || '';
        var b = secondary[f] || '';
        if (!a) { merged[f] = b; return; }
        if (!b) { merged[f] = a; return; }
        if (f === 'email') {
            var aValid = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(a);
            var bValid = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(b);
            merged[f] = aValid ? a : (bValid ? b : a);
        } else if (f === 'phone') {
            var aDigits = a.replace(/[^\d]/g, '').length;
            var bDigits = b.replace(/[^\d]/g, '').length;
            merged[f] = (aDigits >= 7 && aDigits <= 15) ? a : (bDigits >= 7 && bDigits <= 15) ? b : a;
        } else {
            merged[f] = a.length >= b.length ? a : b;
        }
    });
    return merged;
}

function ocrAndParse(imageBase64) {
    var t0 = Date.now();

    // Primary: Claude vision
    return claudeVisionParse(imageBase64).then(function (response) {
        var fields = parseJsonResponse(response);
        var crop = extractCrop(response);
        console.log('OCR: Claude vision done in ' + (Date.now() - t0) + 'ms' + (crop ? ' (crop: ' + JSON.stringify(crop) + ')' : ''));

        if (isValidContact(fields)) {
            return { fields: fields, crop: crop, rawText: response, method: 'claude' };
        }

        // Claude gave partial result — enrich with Tesseract
        var fieldCount = VALID_FIELDS.filter(function (f) { return fields[f]; }).length;
        console.log('OCR: Claude partial (' + fieldCount + ' fields), enriching with Tesseract');
        return tesseractPipeline(imageBase64).then(function (fallback) {
            var merged = mergeFields(fields, fallback.fields);
            return { fields: merged, crop: crop, rawText: response, method: 'claude+' + fallback.method };
        }).catch(function () {
            return { fields: fields, crop: crop, rawText: response, method: 'claude' };
        });
    }).catch(function (err) {
        console.log('OCR: Claude vision failed (' + err.message + '), using Tesseract pipeline');
        return tesseractPipeline(imageBase64);
    });
}

// ── Multi-contact entry: ocrAndParseMulti ──

function ocrAndParseMulti(imageBase64) {
    var t0 = Date.now();

    return claudeVisionParse(imageBase64).then(function (response) {
        var crop = extractCrop(response);
        console.log('OCR: Claude vision multi done in ' + (Date.now() - t0) + 'ms');
        try {
            var fields = parseJsonResponse(response);
            if (isValidContact(fields)) {
                return { contacts: [fields], crop: crop, rawText: response, method: 'claude' };
            }
        } catch (e) {}
        try {
            var contacts = parseJsonArrayResponse(response);
            contacts = contacts.filter(isValidContact);
            if (contacts.length > 0) {
                if (contacts.length > 4) contacts = contacts.slice(0, 4);
                return { contacts: contacts, crop: crop, rawText: response, method: 'claude' };
            }
        } catch (e) {}
        throw new Error('Claude result not valid');
    }).catch(function (err) {
        console.log('OCR: Claude vision multi failed (' + err.message + '), using Tesseract pipeline');

        var raw = imageBase64;
        if (raw.indexOf(',') !== -1) raw = raw.split(',')[1];
        var buffer = Buffer.from(raw, 'base64');

        return extractText(buffer).then(function (text) {
            console.log('OCR: Tesseract done in ' + (Date.now() - t0) + 'ms');
            var contacts = regexParseMulti(text);
            return { contacts: contacts, crop: null, rawText: text, method: 'regex' };
        });
    });
}

// ── Status check ──

function checkOcrStatus() {
    return getClaudeClientAsync().then(function () {
        return {
            provider: 'claude',
            model: CLAUDE_MODEL,
            available: true,
            tokenExpiry: claudeTokenExpiry ? new Date(claudeTokenExpiry).toISOString() : null
        };
    }).catch(function () {
        return {
            provider: 'claude',
            model: CLAUDE_MODEL,
            available: false,
            tokenExpiry: claudeTokenExpiry ? new Date(claudeTokenExpiry).toISOString() : null
        };
    });
}

module.exports = {
    ocrAndParse: ocrAndParse,
    ocrAndParseMulti: ocrAndParseMulti,
    extractText: extractText,
    claudeTextParse: claudeTextParse,
    regexParse: regexParse,
    regexParseMulti: regexParseMulti,
    checkOcrStatus: checkOcrStatus
};
