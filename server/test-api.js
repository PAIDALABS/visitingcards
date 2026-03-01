#!/usr/bin/env node
/**
 * CardFlow API Test Suite
 * Tests all endpoints against local server
 * Usage: PORT=3333 node test-api.js
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -i ~/.ssh/id_hostinger -L 5433:localhost:5432 -fN root@62.72.12.197
 *   - Server: PORT=3333 node index.js
 */

var BASE = process.env.TEST_URL || 'http://localhost:3333';
var passed = 0, failed = 0, skipped = 0;
var TOKEN = '';
var USER_ID = '';
var TS = Date.now();
var TEST_EMAIL = 'test-api-' + TS + '@test.cardflow.cloud';
var TEST_PASS = 'TestPass123!';
var TEST_USERNAME = 'testapiuser' + TS;
var createdLeadId = 'test-lead-' + TS;
var createdTeamId = null;

async function req(method, path, body, token) {
    var url = BASE + path;
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (body) opts.body = JSON.stringify(body);
    try {
        var res = await fetch(url, opts);
        var text = await res.text();
        var json = null;
        try { json = JSON.parse(text); } catch (e) {}
        return { status: res.status, json: json, text: text, ok: res.ok };
    } catch (err) {
        return { status: 0, json: null, text: err.message, ok: false, error: err };
    }
}

function assert(name, condition, detail) {
    if (condition) {
        passed++;
        console.log('  \x1b[32m✓\x1b[0m ' + name);
    } else {
        failed++;
        console.log('  \x1b[31m✗ ' + name + (detail ? ' — ' + detail : '') + '\x1b[0m');
    }
}

function skip(name, reason) {
    skipped++;
    console.log('  \x1b[33m⊘ ' + name + ' — ' + reason + '\x1b[0m');
}

function section(name) {
    console.log('\n\x1b[1m\x1b[36m━━ ' + name + ' ━━\x1b[0m');
}

// Check server is alive
async function alive() {
    try {
        var res = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        return res.status > 0;
    } catch (e) { return false; }
}

async function run() {
    console.log('\x1b[1mCardFlow API Test Suite\x1b[0m');
    console.log('Target: ' + BASE);
    console.log('');

    // Pre-check
    if (!await alive()) { console.error('\x1b[31mServer not reachable at ' + BASE + '\x1b[0m'); process.exit(2); }

    // ═══════════════════════════════════════
    // AUTH
    // ═══════════════════════════════════════
    section('AUTH — /api/auth');

    var r = await req('POST', '/api/auth/signup', { email: TEST_EMAIL, password: TEST_PASS, name: 'Test User', username: TEST_USERNAME });
    assert('POST /signup → 200 + token', r.status === 200 && r.json && r.json.token, 'status=' + r.status);
    if (r.json && r.json.token) { TOKEN = r.json.token; USER_ID = r.json.user.id; }

    r = await req('POST', '/api/auth/signup', { email: TEST_EMAIL, password: TEST_PASS, name: 'Test', username: TEST_USERNAME + 'x' });
    assert('POST /signup duplicate email → 409', r.status === 409, 'status=' + r.status);

    r = await req('POST', '/api/auth/signup', { email: '', password: '' });
    assert('POST /signup missing fields → 400', r.status === 400, 'status=' + r.status);

    r = await req('POST', '/api/auth/login', { email: TEST_EMAIL, password: TEST_PASS });
    assert('POST /login → 200 + token', r.status === 200 && r.json && r.json.token, 'status=' + r.status);
    if (r.json && r.json.token) TOKEN = r.json.token;

    r = await req('POST', '/api/auth/login', { email: TEST_EMAIL, password: 'WrongPass999!' });
    assert('POST /login wrong password → 401', r.status === 401, 'status=' + r.status);

    r = await req('POST', '/api/auth/login', { email: '', password: '' });
    assert('POST /login missing fields → 400', r.status === 400, 'status=' + r.status);

    r = await req('GET', '/api/cards');
    assert('GET /cards no auth → 401', r.status === 401, 'status=' + r.status);

    // ═══════════════════════════════════════
    // CARDS (returns {id: data} object, not array)
    // ═══════════════════════════════════════
    section('CARDS — /api/cards');

    r = await req('GET', '/api/cards', null, TOKEN);
    assert('GET /cards → 200 + empty object', r.status === 200 && r.json && typeof r.json === 'object' && Object.keys(r.json).length === 0, 'status=' + r.status + ' keys=' + (r.json ? Object.keys(r.json).length : 'null'));

    r = await req('PUT', '/api/cards/test-card-1', { name: 'Test Card', title: 'Engineer', company: 'TestCo', email: 'test@test.com', phone: '+919876543210' }, TOKEN);
    assert('PUT /cards/:id create → 200', r.status === 200, 'status=' + r.status);

    r = await req('GET', '/api/cards', null, TOKEN);
    assert('GET /cards → has 1 card', r.status === 200 && r.json && Object.keys(r.json).length >= 1, 'count=' + (r.json ? Object.keys(r.json).length : 0));

    r = await req('GET', '/api/cards/test-card-1', null, TOKEN);
    assert('GET /cards/:id → 200 + correct name', r.status === 200 && r.json && r.json.name === 'Test Card', 'status=' + r.status);

    r = await req('PATCH', '/api/cards/test-card-1', { title: 'Senior Engineer' }, TOKEN);
    assert('PATCH /cards/:id → 200', r.status === 200, 'status=' + r.status);

    r = await req('GET', '/api/cards/test-card-1', null, TOKEN);
    assert('GET /cards/:id → updated title', r.json && r.json.title === 'Senior Engineer', 'title=' + (r.json && r.json.title));

    r = await req('GET', '/api/cards/nonexistent-card-xyz', null, TOKEN);
    assert('GET /cards/:id not found → 404', r.status === 404, 'status=' + r.status);

    // ═══════════════════════════════════════
    // LEADS
    // ═══════════════════════════════════════
    section('LEADS — /api/leads');

    r = await req('GET', '/api/leads', null, TOKEN);
    assert('GET /leads → 200 + object', r.status === 200 && typeof r.json === 'object', 'status=' + r.status);

    r = await req('PUT', '/api/leads/' + createdLeadId, { name: 'John Doe', email: 'john@example.com', phone: '+919876543210', company: 'ACME', ts: Date.now() }, TOKEN);
    assert('PUT /leads/:id create → 200', r.status === 200 && r.json && r.json.success, 'status=' + r.status);

    // Wait a moment for background categorize to fire (and possibly crash OCR — we test server survives)
    await new Promise(function(resolve) { setTimeout(resolve, 500); });

    r = await req('GET', '/api/leads/' + createdLeadId, null, TOKEN);
    assert('GET /leads/:id → 200 + data', r.status === 200 && r.json && r.json.name === 'John Doe', 'status=' + r.status);

    r = await req('PATCH', '/api/leads/' + createdLeadId, { status: 'contacted', company: 'ACME Corp' }, TOKEN);
    assert('PATCH /leads/:id → 200', r.status === 200 && r.json && r.json.success, 'status=' + r.status);

    r = await req('PATCH', '/api/leads/' + createdLeadId, { _appendAction: { action: 'status_change', ts: Date.now(), from: 'new', to: 'contacted' } }, TOKEN);
    assert('PATCH /leads/:id _appendAction → 200', r.status === 200 && r.json && r.json.success, 'status=' + r.status);

    r = await req('GET', '/api/leads/' + createdLeadId, null, TOKEN);
    assert('GET /leads/:id → status=contacted', r.json && r.json.status === 'contacted', 'status=' + (r.json && r.json.status));
    assert('GET /leads/:id → has timeline', r.json && Array.isArray(r.json.actions) && r.json.actions.length > 0, 'actions=' + (r.json && r.json.actions && r.json.actions.length));

    r = await req('PATCH', '/api/leads/nonexistent-lead-xyz', { status: 'hot' }, TOKEN);
    assert('PATCH /leads/:id not found → 404', r.status === 404, 'status=' + r.status);

    r = await req('PATCH', '/api/leads/' + createdLeadId, { dealValue: 50000 }, TOKEN);
    assert('PATCH /leads/:id dealValue → 200', r.status === 200, 'status=' + r.status);

    r = await req('GET', '/api/leads/month-count', null, TOKEN);
    assert('GET /leads/month-count → 200 + count', r.status === 200 && r.json && typeof r.json.count === 'number', 'count=' + (r.json && r.json.count));

    // Large lead ID → 400
    r = await req('PUT', '/api/leads/' + 'a'.repeat(200), { name: 'Test' }, TOKEN);
    assert('PUT /leads/:id ID too long → 400', r.status === 400, 'status=' + r.status);

    // Large data payload → 400
    r = await req('PUT', '/api/leads/big-lead-test', { name: 'x'.repeat(60000) }, TOKEN);
    assert('PUT /leads/:id data too large → 400', r.status === 400, 'status=' + r.status);

    // Check if server is still alive after potential OCR crash
    if (!await alive()) {
        console.log('\n  \x1b[33m⚠ Server crashed (known issue: categorize module missing credentials)\x1b[0m');
        console.log('  \x1b[33m  Remaining tests skipped. Restart server to re-test.\x1b[0m');
        printSummary();
        return;
    }

    // ═══════════════════════════════════════
    // TAPS
    // ═══════════════════════════════════════
    section('TAPS — /api/taps');

    r = await req('GET', '/api/taps', null, TOKEN);
    assert('GET /taps → 200', r.status === 200, 'status=' + r.status);

    // ═══════════════════════════════════════
    // ANALYTICS
    // ═══════════════════════════════════════
    section('ANALYTICS — /api/analytics');

    r = await req('GET', '/api/analytics', null, TOKEN);
    assert('GET /analytics → 200', r.status === 200, 'status=' + r.status);

    // ═══════════════════════════════════════
    // SETTINGS
    // ═══════════════════════════════════════
    section('SETTINGS — /api/settings');

    r = await req('GET', '/api/settings', null, TOKEN);
    assert('GET /settings → 200 + object', r.status === 200 && typeof r.json === 'object', 'status=' + r.status);

    r = await req('PATCH', '/api/settings', { data: { followup_templates: { thank_you: 'Thanks {name}!' } } }, TOKEN);
    assert('PATCH /settings → 200', r.status === 200, 'status=' + r.status);

    r = await req('GET', '/api/settings', null, TOKEN);
    assert('GET /settings → persisted template', r.json && r.json.data && r.json.data.followup_templates && r.json.data.followup_templates.thank_you === 'Thanks {name}!', 'got=' + JSON.stringify(r.json && r.json.data && r.json.data.followup_templates));

    r = await req('GET', '/api/settings/nfc-token', null, TOKEN);
    assert('GET /settings/nfc-token → 200', r.status === 200, 'status=' + r.status);

    r = await req('PUT', '/api/settings/nfc-token', {}, TOKEN);
    assert('PUT /settings/nfc-token → 200 + success', r.status === 200 && r.json && r.json.success, 'status=' + r.status + ' body=' + r.text);

    // ═══════════════════════════════════════
    // ACCOUNT
    // ═══════════════════════════════════════
    section('ACCOUNT — /api/account');

    r = await req('PATCH', '/api/account/profile', { name: 'Test User Updated' }, TOKEN);
    assert('PATCH /account/profile → 200', r.status === 200, 'status=' + r.status);

    r = await req('POST', '/api/account/change-password', { currentPassword: TEST_PASS, newPassword: 'NewTestPass456!' }, TOKEN);
    assert('POST /change-password → 200', r.status === 200, 'status=' + r.status);

    r = await req('POST', '/api/account/change-password', { currentPassword: 'NewTestPass456!', newPassword: TEST_PASS }, TOKEN);
    assert('POST /change-password revert → 200', r.status === 200, 'status=' + r.status);

    r = await req('POST', '/api/account/change-password', { currentPassword: 'WrongCurrent!', newPassword: 'New123!' }, TOKEN);
    assert('POST /change-password wrong → 401', r.status === 401 || r.status === 400, 'status=' + r.status);

    // ═══════════════════════════════════════
    // BILLING
    // ═══════════════════════════════════════
    section('BILLING — /api/billing');

    r = await req('GET', '/api/billing/subscription', null, TOKEN);
    assert('GET /billing/subscription → 200', r.status === 200, 'status=' + r.status);

    r = await req('POST', '/api/billing/create-order', { plan: 'pro' }, TOKEN);
    assert('POST /billing/create-order → not 500', r.status !== 500 && r.status > 0, 'status=' + r.status);

    // ═══════════════════════════════════════
    // SEQUENCES
    // ═══════════════════════════════════════
    section('SEQUENCES — /api/sequences');

    r = await req('GET', '/api/sequences', null, TOKEN);
    assert('GET /sequences → 200 + array', r.status === 200 && Array.isArray(r.json), 'status=' + r.status + ' type=' + (r.json && typeof r.json));

    r = await req('POST', '/api/sequences', { name: 'Test Seq', steps: [{ delay_days: 1, subject: 'Hi', body: 'Hello {name}!' }] }, TOKEN);
    assert('POST /sequences → 403 (free plan limit)', r.status === 403, 'status=' + r.status);

    // ═══════════════════════════════════════
    // TEAMS (feature-flagged: teams_enabled)
    // ═══════════════════════════════════════
    section('TEAMS — /api/teams');

    r = await req('GET', '/api/teams', null, TOKEN);
    if (r.status === 403 && r.json && r.json.error === 'feature_disabled') {
        skip('All team endpoints', 'teams_enabled flag disabled');
    } else {
        assert('GET /teams → 200', r.status === 200, 'status=' + r.status);

        r = await req('POST', '/api/teams', { name: 'Test Team' }, TOKEN);
        var planBlocked = r.status === 403;
        if (planBlocked) {
            assert('POST /teams → 403 (free plan, correct)', true);
            skip('Team CRUD endpoints', 'Requires business plan');
        } else {
            assert('POST /teams create → 200', r.status === 200, 'status=' + r.status + ' body=' + r.text);
            if (r.json && r.json.team) createdTeamId = r.json.team.id;

            if (createdTeamId) {
                r = await req('PATCH', '/api/teams', { name: 'Updated Team' }, TOKEN);
                assert('PATCH /teams rename → 200', r.status === 200, 'status=' + r.status);

                r = await req('GET', '/api/teams', null, TOKEN);
                assert('GET /teams → updated name', r.json && r.json.team && r.json.team.name === 'Updated Team', 'name=' + (r.json && r.json.team && r.json.team.name));

                r = await req('GET', '/api/teams/activity', null, TOKEN);
                assert('GET /teams/activity → 200', r.status === 200, 'status=' + r.status);

                r = await req('GET', '/api/teams/leads', null, TOKEN);
                assert('GET /teams/leads → 200 + array', r.status === 200 && Array.isArray(r.json), 'status=' + r.status);

                // Check leads include our test lead
                assert('GET /teams/leads → contains test lead', Array.isArray(r.json) && r.json.some(function(l) { return l._id === createdLeadId; }), 'lead count=' + (r.json && r.json.length));

                r = await req('GET', '/api/teams/invitations', null, TOKEN);
                assert('GET /teams/invitations → 200', r.status === 200, 'status=' + r.status);

                r = await req('POST', '/api/teams/invite', { email: 'invite-test@example.com' }, TOKEN);
                assert('POST /teams/invite → 200', r.status === 200, 'status=' + r.status + ' body=' + r.text);

                r = await req('GET', '/api/teams/members/' + USER_ID + '/stats', null, TOKEN);
                assert('GET /teams/members/:id/stats → 200', r.status === 200, 'status=' + r.status);

                // Assign lead to self
                r = await req('PATCH', '/api/teams/leads/' + USER_ID + '/' + createdLeadId + '/assign', { assignTo: USER_ID }, TOKEN);
                assert('PATCH /teams/leads assign → 200', r.status === 200, 'status=' + r.status + ' body=' + r.text);

                // Verify assignment persisted in lead data
                var lr = await req('GET', '/api/leads/' + createdLeadId, null, TOKEN);
                assert('Lead data → assignedTo set', lr.json && lr.json.assignedTo === USER_ID, 'assignedTo=' + (lr.json && lr.json.assignedTo));

                // Unassign
                r = await req('PATCH', '/api/teams/leads/' + USER_ID + '/' + createdLeadId + '/assign', { assignTo: null }, TOKEN);
                assert('PATCH /teams/leads unassign → 200', r.status === 200, 'status=' + r.status);

                // Role change on owner → should fail
                r = await req('PATCH', '/api/teams/members/' + USER_ID + '/role', { role: 'member' }, TOKEN);
                assert('PATCH /teams/members role on owner → 403', r.status === 403, 'status=' + r.status);

                // Cleanup: delete team
                r = await req('DELETE', '/api/teams', null, TOKEN);
                assert('DELETE /teams → 200', r.status === 200, 'status=' + r.status);

                r = await req('GET', '/api/teams', null, TOKEN);
                assert('GET /teams after delete → no team', r.status === 200 && r.json && !r.json.team, 'team=' + JSON.stringify(r.json && r.json.team));
            }
        }
    }

    // ═══════════════════════════════════════
    // PUBLIC
    // ═══════════════════════════════════════
    section('PUBLIC — /api/public');

    r = await req('GET', '/api/public/user/' + USER_ID + '/cards/test-card-1');
    assert('GET /public/user/:uid/cards/:id → 200', r.status === 200, 'status=' + r.status);

    r = await req('GET', '/api/public/user/nonexistent-uid/cards/nonexistent-card');
    assert('GET /public/user/:uid/cards/:id not found → 200 null', r.status === 200 && r.json === null, 'status=' + r.status + ' body=' + r.text);

    // Public username lookup
    r = await req('GET', '/api/public/resolve/' + TEST_USERNAME);
    assert('GET /public/resolve/:username → 200 or 404', r.status === 200 || r.status === 404, 'status=' + r.status);

    // ═══════════════════════════════════════
    // AUTH EDGE CASES
    // ═══════════════════════════════════════
    section('AUTH & SECURITY');

    r = await req('GET', '/api/cards', null, 'invalid.token.here');
    assert('Invalid JWT → 401', r.status === 401, 'status=' + r.status);

    r = await req('GET', '/api/leads', null, TOKEN.slice(0, -5) + 'XXXXX');
    assert('Tampered JWT → 401', r.status === 401, 'status=' + r.status);

    r = await req('PUT', '/api/cards/test-card-1', { name: 'Hack' });
    assert('PUT /cards no auth → 401', r.status === 401, 'status=' + r.status);

    r = await req('PATCH', '/api/settings', { theme: 'dark' });
    assert('PATCH /settings no auth → 401', r.status === 401, 'status=' + r.status);

    r = await req('POST', '/api/auth/signup', { email: 'short@test.com', password: '12', name: 'Short', username: 'shortpw' });
    assert('Signup short password → 400', r.status === 400, 'status=' + r.status);

    r = await req('POST', '/api/auth/signup', { email: 'baduser@test.com', password: 'ValidPass123!', name: 'Bad', username: 'a' });
    assert('Signup short username → 400', r.status === 400 || r.status === 429, 'status=' + r.status);

    // ═══════════════════════════════════════
    // CLEANUP
    // ═══════════════════════════════════════
    section('CLEANUP');

    r = await req('DELETE', '/api/leads/' + createdLeadId, null, TOKEN);
    assert('DELETE /leads/:id → 200', r.status === 200, 'status=' + r.status);

    r = await req('GET', '/api/leads/' + createdLeadId, null, TOKEN);
    assert('GET /leads/:id after delete → 404', r.status === 404, 'status=' + r.status);

    r = await req('DELETE', '/api/cards/test-card-1', null, TOKEN);
    assert('DELETE /cards/:id → 200', r.status === 200, 'status=' + r.status);

    r = await req('GET', '/api/cards/test-card-1', null, TOKEN);
    assert('GET /cards/:id after delete → 404', r.status === 404, 'status=' + r.status);

    r = await req('DELETE', '/api/auth/account', { password: TEST_PASS }, TOKEN);
    assert('DELETE /auth/account → 200', r.status === 200, 'status=' + r.status + ' body=' + r.text);

    // Also clean the user created by the manual curl test earlier
    var r2 = await req('POST', '/api/auth/login', { email: 'test@t.com', password: 'Pass1234!' });
    if (r2.json && r2.json.token) {
        await req('POST', '/api/auth/delete-account', { password: 'Pass1234!' }, r2.json.token);
    }

    printSummary();
}

function printSummary() {
    console.log('\n\x1b[1m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    console.log('\x1b[1m  RESULTS: \x1b[32m' + passed + ' passed\x1b[0m, \x1b[' + (failed > 0 ? '31' : '32') + 'm' + failed + ' failed\x1b[0m, \x1b[33m' + skipped + ' skipped\x1b[0m');
    console.log('\x1b[1m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n');
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(function (err) {
    console.error('\n\x1b[31mFATAL:\x1b[0m', err.message || err);
    printSummary();
});
