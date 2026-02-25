#!/usr/bin/env node
// CardFlow Programmatic Flow Test
// Tests all major modules against the live server

var BASE = process.env.BASE_URL || 'https://cardflow.cloud';
var TEST_EMAIL = 'flowtest_' + Date.now() + '@test.cardflow.cloud';
var TEST_PASS = 'TestFlow!2026x';
var TEST_USERNAME = 'flowtest' + Date.now();
var token = '';
var userId = '';
var cardId = 'test-card-' + Date.now();
var leadId = 'test-lead-' + Date.now();
var tapId = '';
var verificationId = '';
var results = [];
var startTime = Date.now();

// ── Helpers ──

async function api(method, path, body, authToken) {
    var opts = {
        method: method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (authToken) opts.headers['Authorization'] = 'Bearer ' + authToken;
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    var url = BASE + '/api' + path;
    try {
        var res = await fetch(url, opts);
        var text = await res.text();
        var data;
        try { data = JSON.parse(text); } catch(e) { data = { _raw: text }; }
        return { status: res.status, ok: res.ok, data: data };
    } catch(err) {
        return { status: 0, ok: false, data: { error: err.message } };
    }
}

function log(module, test, passed, detail) {
    var icon = passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    var msg = icon + ' [' + module + '] ' + test;
    if (detail && !passed) msg += ' — ' + detail;
    console.log(msg);
    results.push({ module: module, test: test, passed: passed, detail: detail || '' });
}

function assert(module, test, condition, detail) {
    log(module, test, !!condition, detail);
    return !!condition;
}

// ── 1. AUTH MODULE ──

async function testAuth() {
    console.log('\n\x1b[1m━━ AUTH ━━\x1b[0m');

    // Signup
    var r = await api('POST', '/auth/signup', {
        name: 'Flow Test User', email: TEST_EMAIL, password: TEST_PASS, username: TEST_USERNAME
    });
    var signupOk = assert('Auth', 'Signup creates account', r.ok && r.data.token, 'status=' + r.status + ' ' + JSON.stringify(r.data).slice(0,100));
    if (signupOk) {
        token = r.data.token;
        userId = r.data.uid || r.data.userId || '';
    }

    // Duplicate signup
    r = await api('POST', '/auth/signup', {
        name: 'Dupe', email: TEST_EMAIL, password: TEST_PASS, username: TEST_USERNAME
    });
    assert('Auth', 'Duplicate signup rejected', !r.ok, 'status=' + r.status);

    // Login
    r = await api('POST', '/auth/login', { email: TEST_EMAIL, password: TEST_PASS });
    assert('Auth', 'Login returns token', r.ok && r.data.token, 'status=' + r.status);
    if (r.ok && r.data.token) token = r.data.token;

    // Get profile
    r = await api('GET', '/auth/me', null, token);
    assert('Auth', 'GET /me returns profile', r.ok && r.data.email, 'status=' + r.status + ' data=' + JSON.stringify(r.data).slice(0,100));
    if (r.ok && r.data.uid) userId = r.data.uid;
    assert('Auth', 'Profile email matches', r.ok && r.data.email === TEST_EMAIL, 'got=' + (r.data.email || ''));
    assert('Auth', 'Profile username matches', r.ok && r.data.username === TEST_USERNAME, 'got=' + (r.data.username || ''));

    // Refresh token
    r = await api('POST', '/auth/refresh', null, token);
    assert('Auth', 'Token refresh works', r.ok && r.data.token, 'status=' + r.status);
    if (r.ok && r.data.token) token = r.data.token;

    // SSE ticket
    r = await api('GET', '/auth/sse-ticket', null, token);
    assert('Auth', 'SSE ticket issued', r.ok && r.data.ticket, 'status=' + r.status);

    // Unauthorized access
    r = await api('GET', '/auth/me', null, 'invalid-token');
    assert('Auth', 'Invalid token rejected', !r.ok, 'status=' + r.status);

    // Change password
    r = await api('POST', '/auth/change-password', {
        currentPassword: TEST_PASS, newPassword: TEST_PASS + '2'
    }, token);
    assert('Auth', 'Change password works', r.ok, 'status=' + r.status + ' ' + JSON.stringify(r.data).slice(0,100));

    // Login with new password
    r = await api('POST', '/auth/login', { email: TEST_EMAIL, password: TEST_PASS + '2' });
    assert('Auth', 'Login with new password works', r.ok && r.data.token, 'status=' + r.status);
    if (r.ok && r.data.token) token = r.data.token;
}

// ── 2. CARDS MODULE ──

async function testCards() {
    console.log('\n\x1b[1m━━ CARDS ━━\x1b[0m');

    // Create card
    var r = await api('PUT', '/cards/' + cardId, {
        name: 'Test User', email: 'test@example.com', phone: '+1234567890',
        company: 'Test Corp', title: 'Engineer', website: 'https://example.com'
    }, token);
    assert('Cards', 'Create card (PUT)', r.ok, 'status=' + r.status + ' ' + JSON.stringify(r.data).slice(0,100));

    // Get card
    r = await api('GET', '/cards/' + cardId, null, token);
    assert('Cards', 'Get card by ID', r.ok && r.data.name === 'Test User', 'status=' + r.status);

    // List cards (returns object map: {cardId: cardData})
    r = await api('GET', '/cards', null, token);
    assert('Cards', 'List cards returns object', r.ok && typeof r.data === 'object', 'status=' + r.status);
    assert('Cards', 'Card appears in list', r.ok && r.data[cardId], 'keys=' + Object.keys(r.data || {}).join(','));

    // Update card (PATCH)
    r = await api('PATCH', '/cards/' + cardId, { title: 'Senior Engineer' }, token);
    assert('Cards', 'Patch card', r.ok, 'status=' + r.status);

    // Verify update
    r = await api('GET', '/cards/' + cardId, null, token);
    assert('Cards', 'Patch persisted', r.ok && r.data.title === 'Senior Engineer', 'title=' + (r.data.title || ''));

    // Full update (PUT)
    r = await api('PUT', '/cards/' + cardId, {
        name: 'Test User Updated', email: 'test@example.com', phone: '+1234567890',
        company: 'Test Corp', title: 'Lead Engineer', website: 'https://example.com'
    }, token);
    assert('Cards', 'Full update (PUT)', r.ok, 'status=' + r.status);

    // Verify full update
    r = await api('GET', '/cards/' + cardId, null, token);
    assert('Cards', 'Full update persisted', r.ok && r.data.name === 'Test User Updated', 'name=' + (r.data.name || ''));

    // Card without auth
    r = await api('GET', '/cards', null, null);
    assert('Cards', 'Unauthenticated access blocked', !r.ok, 'status=' + r.status);
}

// ── 3. LEADS MODULE ──

async function testLeads() {
    console.log('\n\x1b[1m━━ LEADS ━━\x1b[0m');

    // Create lead
    var r = await api('PUT', '/leads/' + leadId, {
        name: 'Lead Person', email: ['lead@example.com', 'alt@example.com'],
        phone: ['+9876543210'], company: 'Lead Corp', source: 'test'
    }, token);
    assert('Leads', 'Create lead (PUT)', r.ok, 'status=' + r.status + ' ' + JSON.stringify(r.data).slice(0,100));

    // Get lead
    r = await api('GET', '/leads/' + leadId, null, token);
    assert('Leads', 'Get lead by ID', r.ok && r.data.name === 'Lead Person', 'status=' + r.status);

    // Verify array fields preserved
    assert('Leads', 'Email stored as array', r.ok && Array.isArray(r.data.email), 'type=' + typeof r.data.email);
    assert('Leads', 'Phone stored as array', r.ok && Array.isArray(r.data.phone), 'type=' + typeof r.data.phone);
    assert('Leads', 'Multiple emails preserved', r.ok && r.data.email && r.data.email.length === 2, 'count=' + ((r.data.email || []).length));

    // List leads (returns object map: {leadId: leadData})
    r = await api('GET', '/leads', null, token);
    assert('Leads', 'List leads returns object', r.ok && typeof r.data === 'object', 'status=' + r.status);
    assert('Leads', 'Lead appears in list', r.ok && r.data[leadId], 'keys=' + Object.keys(r.data || {}).slice(0,3).join(','));

    // Month count
    r = await api('GET', '/leads/month-count', null, token);
    assert('Leads', 'Month count works', r.ok && typeof r.data.count === 'number', 'data=' + JSON.stringify(r.data));

    // Patch lead
    r = await api('PATCH', '/leads/' + leadId, { company: 'Updated Corp' }, token);
    assert('Leads', 'Patch lead', r.ok, 'status=' + r.status);

    r = await api('GET', '/leads/' + leadId, null, token);
    assert('Leads', 'Patch persisted', r.ok && r.data.company === 'Updated Corp', 'company=' + (r.data.company || ''));
}

// ── 4. SETTINGS MODULE ──

async function testSettings() {
    console.log('\n\x1b[1m━━ SETTINGS ━━\x1b[0m');

    // Get settings
    var r = await api('GET', '/settings', null, token);
    assert('Settings', 'Get settings', r.ok, 'status=' + r.status);

    // Update settings
    r = await api('PATCH', '/settings', { defaultCard: cardId }, token);
    assert('Settings', 'Update default card', r.ok, 'status=' + r.status);

    // Verify
    r = await api('GET', '/settings', null, token);
    assert('Settings', 'Default card persisted', r.ok && r.data.defaultCard === cardId, 'got=' + (r.data.defaultCard || ''));

    // NFC token
    r = await api('GET', '/settings/nfc-token', null, token);
    assert('Settings', 'Get NFC token', r.ok, 'status=' + r.status);
}

// ── 5. ANALYTICS MODULE ──

async function testAnalytics() {
    console.log('\n\x1b[1m━━ ANALYTICS ━━\x1b[0m');

    var r = await api('GET', '/analytics', null, token);
    assert('Analytics', 'Get analytics', r.ok, 'status=' + r.status + ' data=' + JSON.stringify(r.data).slice(0,100));
}

// ── 6. TAPS MODULE ──

async function testTaps() {
    console.log('\n\x1b[1m━━ TAPS ━━\x1b[0m');

    var r = await api('GET', '/taps', null, token);
    assert('Taps', 'List taps', r.ok && Array.isArray(r.data), 'status=' + r.status);
}

// ── 7. PUBLIC MODULE ──

async function testPublic() {
    console.log('\n\x1b[1m━━ PUBLIC ━━\x1b[0m');

    // Resolve username (returns plain userId string)
    var r = await api('GET', '/public/username/' + TEST_USERNAME);
    assert('Public', 'Resolve username', r.ok && typeof r.data === 'string', 'status=' + r.status + ' data=' + JSON.stringify(r.data).slice(0,80));
    if (r.ok && typeof r.data === 'string' && !userId) userId = r.data;

    // Check username availability (taken)
    r = await api('GET', '/public/check-username/' + TEST_USERNAME);
    assert('Public', 'Username taken check', r.ok && r.data.available === false, 'data=' + JSON.stringify(r.data));

    // Check username availability (free)
    r = await api('GET', '/public/check-username/zzz_nonexistent_' + Date.now());
    assert('Public', 'Username available check', r.ok && r.data.available === true, 'data=' + JSON.stringify(r.data));

    if (!userId) {
        log('Public', 'Skipping user-dependent tests (no userId)', false, 'signup may have failed');
        return;
    }

    // Get public cards (returns object map)
    r = await api('GET', '/public/user/' + userId + '/cards');
    assert('Public', 'Get public cards', r.ok && typeof r.data === 'object', 'status=' + r.status);
    assert('Public', 'Public card has data', r.ok && r.data[cardId] && r.data[cardId].name, 'keys=' + Object.keys(r.data || {}).join(','));

    // Get specific public card
    r = await api('GET', '/public/user/' + userId + '/cards/' + cardId);
    assert('Public', 'Get specific public card', r.ok && r.data.name, 'status=' + r.status);

    // Get public settings
    r = await api('GET', '/public/user/' + userId + '/settings');
    assert('Public', 'Get public settings', r.ok, 'status=' + r.status);

    // Get public profile
    r = await api('GET', '/public/user/' + userId + '/profile');
    assert('Public', 'Get public profile', r.ok && r.data.username, 'status=' + r.status + ' data=' + JSON.stringify(r.data).slice(0,80));

    // Create tap
    r = await api('POST', '/public/user/' + userId + '/taps', { cardId: cardId, ua: 'test-bot' });
    assert('Public', 'Create tap session', r.ok && r.data.id, 'status=' + r.status + ' data=' + JSON.stringify(r.data).slice(0,80));
    if (r.ok && r.data.id) tapId = r.data.id;

    // Poll tap status
    if (tapId) {
        r = await api('GET', '/public/user/' + userId + '/taps/' + tapId);
        assert('Public', 'Poll tap status', r.ok, 'status=' + r.status);
    }

    // Submit lead (public)
    var publicLeadId = 'pub-lead-' + Date.now();
    r = await api('POST', '/public/user/' + userId + '/leads', {
        id: publicLeadId, cardId: cardId,
        name: 'Public Visitor', email: ['visitor@example.com'], phone: ['+1111111111']
    });
    assert('Public', 'Submit public lead', r.ok, 'status=' + r.status + ' data=' + JSON.stringify(r.data).slice(0,100));

    // Increment analytics
    r = await api('POST', '/public/user/' + userId + '/analytics/' + cardId + '/views', {});
    assert('Public', 'Increment view count', r.ok, 'status=' + r.status);

    r = await api('POST', '/public/user/' + userId + '/analytics/' + cardId + '/saves', {});
    assert('Public', 'Increment save count', r.ok, 'status=' + r.status);

    // Get metric count
    r = await api('GET', '/public/user/' + userId + '/analytics/' + cardId + '/views/count');
    assert('Public', 'Get view count', r.ok && typeof r.data.count === 'number', 'data=' + JSON.stringify(r.data));

    // VAPID key
    r = await api('GET', '/public/vapid-key');
    assert('Public', 'Get VAPID key', r.ok && r.data.publicKey, 'status=' + r.status);

    // Announcements
    r = await api('GET', '/public/announcements');
    assert('Public', 'Get announcements', r.ok, 'status=' + r.status);

    // Invalid analytics metric
    r = await api('POST', '/public/user/' + userId + '/analytics/' + cardId + '/invalid_metric', {});
    assert('Public', 'Invalid metric rejected', !r.ok, 'status=' + r.status);
}

// ── 8. BILLING MODULE ──

async function testBilling() {
    console.log('\n\x1b[1m━━ BILLING ━━\x1b[0m');

    // Get subscription status
    var r = await api('GET', '/billing/subscription', null, token);
    assert('Billing', 'Get subscription status', r.ok, 'status=' + r.status + ' data=' + JSON.stringify(r.data).slice(0,100));
    assert('Billing', 'Free plan by default', r.ok && r.data.plan === 'free', 'plan=' + (r.data.plan || ''));

    // Create order (should work but we won't complete payment)
    r = await api('POST', '/billing/create-order', { plan: 'pro' }, token);
    assert('Billing', 'Create order returns order_id', r.ok && r.data.orderId, 'status=' + r.status + ' data=' + JSON.stringify(r.data).slice(0,100));

    // Verify with bad signature (should fail)
    r = await api('POST', '/billing/verify-payment', {
        razorpay_order_id: 'fake', razorpay_payment_id: 'fake', razorpay_signature: 'fake'
    }, token);
    assert('Billing', 'Invalid payment rejected', !r.ok, 'status=' + r.status);
}

// ── 9. ACCOUNT MODULE ──

async function testAccount() {
    console.log('\n\x1b[1m━━ ACCOUNT ━━\x1b[0m');

    var r = await api('PATCH', '/account/profile', { name: 'Flow Test User' }, token);
    assert('Account', 'Update profile name', r.ok, 'status=' + r.status);

    r = await api('GET', '/auth/me', null, token);
    assert('Account', 'Profile name persisted', r.ok && r.data.name === 'Flow Test User', 'name=' + (r.data.name || ''));
}

// ── 10. REFERRALS MODULE ──

async function testReferrals() {
    console.log('\n\x1b[1m━━ REFERRALS ━━\x1b[0m');

    var r = await api('GET', '/referrals/code', null, token);
    // May fail if feature flag is off
    if (r.status === 403 || r.status === 404) {
        log('Referrals', 'Feature flag off (skipped)', true, 'status=' + r.status);
        return;
    }
    assert('Referrals', 'Get referral code', r.ok && r.data.code, 'status=' + r.status + ' data=' + JSON.stringify(r.data).slice(0,80));

    r = await api('GET', '/referrals/stats', null, token);
    assert('Referrals', 'Get referral stats', r.ok, 'status=' + r.status);
}

// ── 11. TEAMS MODULE ──

async function testTeams() {
    console.log('\n\x1b[1m━━ TEAMS ━━\x1b[0m');

    var r = await api('GET', '/teams', null, token);
    if (r.status === 403 || r.status === 404) {
        log('Teams', 'Feature flag off or plan restricted (skipped)', true, 'status=' + r.status);
        return;
    }
    assert('Teams', 'Get team info', r.ok || r.status === 404, 'status=' + r.status);

    r = await api('GET', '/teams/invitations', null, token);
    assert('Teams', 'Get invitations', r.ok, 'status=' + r.status);
}

// ── 12. EXCHANGES MODULE ──

async function testExchanges() {
    console.log('\n\x1b[1m━━ EXCHANGES ━━\x1b[0m');

    var r = await api('GET', '/exchanges', null, token);
    if (r.status === 403 || r.status === 404) {
        log('Exchanges', 'Feature flag off (skipped)', true, 'status=' + r.status);
        return;
    }
    assert('Exchanges', 'Get exchanges', r.ok, 'status=' + r.status);
}

// ── 13. VERIFICATION MODULE ──

async function testVerification() {
    console.log('\n\x1b[1m━━ VERIFICATION ━━\x1b[0m');

    // Check status (no existing verification)
    var r = await api('GET', '/verification/status/' + cardId, null, token);
    assert('Verification', 'Check status (none)', r.ok && r.data.exists === false, 'data=' + JSON.stringify(r.data).slice(0,80));

    // Request verification
    r = await api('POST', '/verification/request', { cardId: cardId }, token);
    assert('Verification', 'Request starts verification', r.ok && r.data.id, 'status=' + r.status + ' data=' + JSON.stringify(r.data).slice(0,100));
    if (r.ok && r.data.id) verificationId = r.data.id;
    assert('Verification', 'Returns masked email', r.ok && r.data.email && r.data.email.indexOf('*') !== -1, 'email=' + (r.data.email || ''));

    // Check status (now pending)
    r = await api('GET', '/verification/status/' + cardId, null, token);
    assert('Verification', 'Status is pending', r.ok && r.data.status === 'pending', 'status=' + (r.data.status || ''));

    // Bad OTP
    if (verificationId) {
        r = await api('POST', '/verification/verify-email', { verificationId: verificationId, code: '000000' }, token);
        assert('Verification', 'Wrong OTP rejected', !r.ok, 'status=' + r.status);
    }

    // Upload without email verify (should fail)
    if (verificationId) {
        r = await api('POST', '/verification/upload-documents', {
            verificationId: verificationId, documents: [{ label: 'Test', data: 'data:image/png;base64,iVBOR' }]
        }, token);
        assert('Verification', 'Upload blocked before email verify', !r.ok, 'status=' + r.status + ' ' + JSON.stringify(r.data).slice(0,80));
    }
}

// ── 14. OCR MODULE ──

async function testOCR() {
    console.log('\n\x1b[1m━━ OCR ━━\x1b[0m');

    // OCR requires Pro/Business plan — should fail for free user
    var r = await api('POST', '/ocr/scan-card', {
        image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    }, token);
    assert('OCR', 'Free plan blocked from OCR', !r.ok && (r.status === 403 || r.status === 402), 'status=' + r.status);
}

// ── 15. EVENTS MODULE ──

async function testEvents() {
    console.log('\n\x1b[1m━━ EVENTS ━━\x1b[0m');

    // List events (may be empty, or feature-gated)
    var r = await api('GET', '/events', null, token);
    if (r.status === 403) {
        log('Events', 'Feature flag off or plan restricted (skipped)', true, 'status=' + r.status);
        return;
    }
    assert('Events', 'List events', r.ok, 'status=' + r.status);

    // Create event (requires Pro/Business)
    r = await api('POST', '/events', {
        name: 'Test Event ' + Date.now(),
        description: 'Flow test event',
        start_date: new Date(Date.now() + 86400000).toISOString(),
        end_date: new Date(Date.now() + 172800000).toISOString()
    }, token);
    assert('Events', 'Create event (plan-gated)', !r.ok && (r.status === 403 || r.status === 402), 'status=' + r.status);
}

// ── 16. EXHIBITOR MODULE ──

async function testExhibitor() {
    console.log('\n\x1b[1m━━ EXHIBITOR ━━\x1b[0m');

    var r = await api('GET', '/exhibitor/events', null, token);
    if (r.status === 403 || r.status === 404) {
        log('Exhibitor', 'Feature flag off (skipped)', true, 'status=' + r.status);
        return;
    }
    assert('Exhibitor', 'List exhibitor events', r.ok, 'status=' + r.status);
}

// ── CLEANUP ──

async function cleanup() {
    console.log('\n\x1b[1m━━ CLEANUP ━━\x1b[0m');

    // Delete lead
    var r = await api('DELETE', '/leads/' + leadId, null, token);
    assert('Cleanup', 'Delete test lead', r.ok, 'status=' + r.status);

    // Delete card
    r = await api('DELETE', '/cards/' + cardId, null, token);
    assert('Cleanup', 'Delete test card', r.ok, 'status=' + r.status);

    // Verify card deleted
    r = await api('GET', '/cards/' + cardId, null, token);
    assert('Cleanup', 'Card confirmed deleted', !r.ok || r.status === 404, 'status=' + r.status);

    // Delete account
    r = await api('DELETE', '/auth/account', { password: TEST_PASS + '2' }, token);
    assert('Cleanup', 'Delete test account', r.ok, 'status=' + r.status + ' ' + JSON.stringify(r.data).slice(0,80));

    // Verify account deleted
    r = await api('POST', '/auth/login', { email: TEST_EMAIL, password: TEST_PASS + '2' });
    assert('Cleanup', 'Account confirmed deleted', !r.ok, 'status=' + r.status);
}

// ── SUMMARY ──

function printSummary() {
    var passed = results.filter(function(r) { return r.passed; }).length;
    var failed = results.filter(function(r) { return !r.passed; }).length;
    var total = results.length;
    var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n\x1b[1m' + '═'.repeat(50) + '\x1b[0m');
    console.log('\x1b[1m  RESULTS: ' + passed + '/' + total + ' passed' + (failed ? ', \x1b[31m' + failed + ' FAILED\x1b[0m' : '') + '\x1b[0m');
    console.log('  Time: ' + elapsed + 's');
    console.log('\x1b[1m' + '═'.repeat(50) + '\x1b[0m');

    if (failed > 0) {
        console.log('\n\x1b[31mFailed tests:\x1b[0m');
        results.filter(function(r) { return !r.passed; }).forEach(function(r) {
            console.log('  ✗ [' + r.module + '] ' + r.test + (r.detail ? ' — ' + r.detail : ''));
        });
    }

    // Module summary
    var modules = {};
    results.forEach(function(r) {
        if (!modules[r.module]) modules[r.module] = { pass: 0, fail: 0 };
        if (r.passed) modules[r.module].pass++;
        else modules[r.module].fail++;
    });
    console.log('\n\x1b[1mModule Summary:\x1b[0m');
    Object.keys(modules).forEach(function(m) {
        var s = modules[m];
        var icon = s.fail === 0 ? '\x1b[32m●\x1b[0m' : '\x1b[31m●\x1b[0m';
        console.log('  ' + icon + ' ' + m.padEnd(14) + ' ' + s.pass + '/' + (s.pass + s.fail));
    });

    process.exit(failed > 0 ? 1 : 0);
}

// ── MAIN ──

async function main() {
    console.log('\x1b[1m╔══════════════════════════════════════╗\x1b[0m');
    console.log('\x1b[1m║   CardFlow Programmatic Flow Tests   ║\x1b[0m');
    console.log('\x1b[1m╚══════════════════════════════════════╝\x1b[0m');
    console.log('Target: ' + BASE);
    console.log('Test user: ' + TEST_EMAIL);

    await testAuth();
    await testCards();
    await testLeads();
    await testSettings();
    await testAnalytics();
    await testTaps();
    await testPublic();
    await testBilling();
    await testAccount();
    await testReferrals();
    await testTeams();
    await testExchanges();
    await testVerification();
    await testOCR();
    await testEvents();
    await testExhibitor();
    await cleanup();
    printSummary();
}

main().catch(function(err) {
    console.error('\x1b[31mFatal error:\x1b[0m', err);
    process.exit(2);
});
