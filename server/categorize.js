/**
 * Lead Auto-Categorization — heuristic-first with Claude Haiku AI fallback
 *
 * Categorizes leads by industry based on title, company, email domain.
 * Runs async (fire-and-forget) after lead creation.
 */

var db = require('./db');
var sse = require('./sse');
var { getClaudeClientAsync } = require('./ocr');

var CATEGORIZE_MODEL = process.env.CLAUDE_CATEGORIZE_MODEL || 'claude-haiku-4-5';

var VALID_CATEGORIES = [
    'Technology', 'Finance', 'Healthcare', 'Real Estate',
    'Manufacturing', 'Marketing & Advertising', 'Legal', 'Education',
    'Retail', 'Consulting', 'Hospitality', 'Transportation',
    'Construction', 'Government', 'Agriculture', 'Logistics & Shipping',
    'Engineering', 'Other'
];

var CATEGORY_LOWER = {};
VALID_CATEGORIES.forEach(function (c) { CATEGORY_LOWER[c.toLowerCase()] = c; });

// ── Heuristic categorization (no AI needed) ──

function heuristicCategorize(data, emailDomain) {
    var signals = ((data.title || '') + ' ' + (data.company || '') + ' ' + emailDomain).toLowerCase();

    // Domain-based
    if (emailDomain.endsWith('.edu') || emailDomain.endsWith('.ac.in') || emailDomain.endsWith('.edu.in')) return 'Education';
    if (emailDomain.endsWith('.gov') || emailDomain.endsWith('.gov.in') || emailDomain.endsWith('.mil')) return 'Government';

    var rules = [
        { cat: 'Technology', re: /\b(software|developer|engineer|tech|cto|saas|devops|fullstack|frontend|backend|data scientist|cyber|cloud|startup|app\b|it manager|it director|programmer)\b/i },
        { cat: 'Finance', re: /\b(bank|financ|invest|trading|insurance|cfo|accountant|audit|wealth|asset|capital|fintech|chartered|ca\b)\b/i },
        { cat: 'Healthcare', re: /\b(doctor|hospital|medical|pharma|health|clinic|nurse|dental|biotech|surgical|patient|dr\.\s)/i },
        { cat: 'Real Estate', re: /\b(real estate|realty|property|architect|housing)\b/i },
        { cat: 'Agriculture', re: /\b(agro|agri|farm|seeds|fertilizer|pesticide|crop|dairy|poultry|nursery|horticulture)\b/i },
        { cat: 'Logistics & Shipping', re: /\b(logistics|shipping|freight|cargo|courier|transport|warehouse|supply chain|customs|clearance|forwarder|3pl)\b/i },
        { cat: 'Engineering', re: /\b(engineering|engineers|mechanical|electrical|civil|structural|automation|hvac|fabrication|consultants)\b/i },
        { cat: 'Manufacturing', re: /\b(manufactur|factory|industrial|production|steel|textile|automotive|machining|foundry|industries|ind\.|exports|manufacturer|products)\b/i },
        { cat: 'Construction', re: /\b(construction|infrastructure|contractor|interiors|fit-out|builders|builder|housing|interior)\b/i },
        { cat: 'Marketing & Advertising', re: /\b(marketing|advertis|creative|brand|agency|media|content|seo|social media|cmo|pr agency)\b/i },
        { cat: 'Legal', re: /\b(lawyer|legal|law firm|attorney|advocate|solicitor|barrister|counsel|notary)\b/i },
        { cat: 'Education', re: /\b(professor|teacher|university|college|school|academic|education|principal|dean|lecturer|tutor)\b/i },
        { cat: 'Retail', re: /\b(retail|store|shop|ecommerce|merchandise|wholesale|distributor|supermarket)\b/i },
        { cat: 'Consulting', re: /\b(consulting|consultant|advisory|strategy|management consult)\b/i },
        { cat: 'Government', re: /\b(government|municipal|civil service|ministry|public sector|bureau|commissioner)\b/i }
    ];

    for (var i = 0; i < rules.length; i++) {
        if (rules[i].re.test(signals)) return rules[i].cat;
    }
    return null;
}

// ── Fuzzy match AI response to valid category ──

function matchCategory(text) {
    if (!text) return 'Other';
    var lower = text.toLowerCase().trim();
    // Exact match
    if (CATEGORY_LOWER[lower]) return CATEGORY_LOWER[lower];
    // Partial match
    for (var i = 0; i < VALID_CATEGORIES.length; i++) {
        if (lower.indexOf(VALID_CATEGORIES[i].toLowerCase()) !== -1) return VALID_CATEGORIES[i];
    }
    return 'Other';
}

// ── Update lead category in DB + SSE ──

function updateLeadCategory(userId, leadId, category, method, subcategory) {
    return db.query('SELECT data FROM leads WHERE user_id = $1 AND id = $2', [userId, leadId])
        .then(function (result) {
            if (result.rows.length === 0) return;
            var data = result.rows[0].data;
            data.category = category;
            data.categoryMethod = method;
            if (subcategory) {
                data.subcategory = subcategory;
            }
            // Timeline event
            if (!Array.isArray(data.actions)) data.actions = [];
            data.actions.push({type:'system', action:'auto_categorized', ts:Date.now(), category:category});
            return db.query(
                'UPDATE leads SET data = $1, updated_at = NOW() WHERE user_id = $2 AND id = $3',
                [JSON.stringify(data), userId, leadId]
            );
        }).then(function () {
            sse.publish('leads:' + userId, { id: leadId, data: { category: category, subcategory: subcategory || null }, categoryUpdate: true });
        }).catch(function (err) {
            console.error('Categorize: DB update failed for lead ' + leadId + ':', err.message);
        });
}

// ── Main categorization function (async, fire-and-forget) ──

function categorizeLead(userId, leadId, leadData) {
    // Skip if already categorized
    if (leadData.category && VALID_CATEGORIES.indexOf(leadData.category) !== -1) return;
    // Skip if no useful data
    if (!leadData.name && !leadData.company && !leadData.title && !leadData.email) return;

    // Extract email domain
    var emails = Array.isArray(leadData.email) ? leadData.email : (leadData.email ? [leadData.email] : []);
    var emailDomain = '';
    if (emails.length > 0 && typeof emails[0] === 'string' && emails[0].indexOf('@') !== -1) {
        emailDomain = emails[0].split('@')[1] || '';
    }

    // Try heuristic first
    var heuristic = heuristicCategorize(leadData, emailDomain);
    if (heuristic) {
        updateLeadCategory(userId, leadId, heuristic, 'heuristic', null);
        return;
    }

    // AI fallback
    var prompt = 'Categorize this business contact into an industry category and specific subcategory.\n\n' +
        'Contact:\n' +
        '- Name: ' + (leadData.name || 'unknown') + '\n' +
        '- Title: ' + (leadData.title || 'unknown') + '\n' +
        '- Company: ' + (leadData.company || 'unknown') + '\n' +
        '- Email domain: ' + (emailDomain || 'unknown') + '\n' +
        '- Website: ' + (leadData.website || 'unknown') + '\n\n' +
        'Top-level categories: ' + VALID_CATEGORIES.join(', ') + '\n\n' +
        'Return ONLY a JSON object with "category" (one of the above) and "subcategory" (a specific industry segment, 2-4 words, e.g. "HVAC Equipment", "Solar Energy", "Commercial Banking", "Civil Engineering", "Mobile App Development").\n' +
        'Example: {"category":"Manufacturing","subcategory":"HVAC Equipment"}\n' +
        'Return ONLY the JSON object, no explanation.';

    getClaudeClientAsync().then(function (client) {
        return client.messages.create({
            model: CATEGORIZE_MODEL,
            max_tokens: 60,
            messages: [{ role: 'user', content: prompt }]
        });
    }).then(function (response) {
        var text = (response.content && response.content[0] && response.content[0].text || '').trim();
        var category = 'Other';
        var subcategory = null;
        try {
            // Strip markdown code blocks if present
            var cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
            var jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                var parsed = JSON.parse(jsonMatch[0]);
                category = matchCategory(parsed.category || '');
                if (parsed.subcategory && typeof parsed.subcategory === 'string' && parsed.subcategory.trim()) {
                    subcategory = parsed.subcategory.trim();
                }
            } else {
                // Fallback: treat entire text as category name (old behaviour)
                category = matchCategory(text);
            }
        } catch (e) {
            category = matchCategory(text);
        }
        return updateLeadCategory(userId, leadId, category, 'ai', subcategory);
    }).catch(function (err) {
        console.error('Categorize: AI failed for lead ' + leadId + ':', err.message);
    });
}

module.exports = {
    categorizeLead: categorizeLead,
    VALID_CATEGORIES: VALID_CATEGORIES
};
