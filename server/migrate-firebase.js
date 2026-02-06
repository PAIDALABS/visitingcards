/**
 * One-time Firebase → PostgreSQL Migration Script
 *
 * Usage:
 *   1. Set FIREBASE_DB_URL env var (or it defaults to the existing one)
 *   2. Set FIREBASE_SECRET env var (Firebase database secret for auth)
 *   3. Ensure DATABASE_URL is set or defaults to local
 *   4. Run: FIREBASE_SECRET=your_secret node migrate-firebase.js
 *
 * Note: Firebase Auth password hashes cannot be exported.
 * Existing users must use "Forgot Password" or Google OAuth on first login.
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://cardflow:cardflow@localhost:5432/cardflow'
});

const FB_DB = process.env.FIREBASE_DB_URL || 'https://visiting-cards-8020e-default-rtdb.firebaseio.com';
const FB_SECRET = process.env.FIREBASE_SECRET || '';

async function fetchFirebase(path) {
    var url = FB_DB + path + '.json';
    if (FB_SECRET) url += '?auth=' + FB_SECRET;
    const res = await fetch(url);
    return res.json();
}

async function migrate() {
    console.log('Starting Firebase → PostgreSQL migration...');
    console.log('Firebase DB:', FB_DB);

    // 1. Fetch all users
    const usersData = await fetchFirebase('/users');
    if (!usersData) {
        console.log('No users found in Firebase.');
        return;
    }

    const userIds = Object.keys(usersData);
    console.log('Found ' + userIds.length + ' users to migrate.');

    for (const uid of userIds) {
        const userData = usersData[uid];
        const profile = userData.profile || {};

        console.log('\nMigrating user: ' + uid + ' (' + (profile.email || 'no email') + ')');

        try {
            // Insert user (no password_hash — Firebase hashes are not portable)
            await pool.query(
                `INSERT INTO users (id, email, name, username, plan, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (id) DO UPDATE SET name = $3, plan = $5`,
                [
                    uid,
                    profile.email || uid + '@migrated.local',
                    profile.name || '',
                    profile.username || uid.substring(0, 20),
                    profile.plan || 'free',
                    profile.createdAt ? new Date(profile.createdAt) : new Date()
                ]
            );

            // Migrate cards
            if (userData.cards) {
                for (const cardId of Object.keys(userData.cards)) {
                    const card = userData.cards[cardId];
                    if (!card || typeof card !== 'object') continue;
                    await pool.query(
                        `INSERT INTO cards (user_id, id, data) VALUES ($1, $2, $3)
                         ON CONFLICT (user_id, id) DO UPDATE SET data = $3`,
                        [uid, cardId, JSON.stringify(card)]
                    );
                }
                console.log('  Cards: ' + Object.keys(userData.cards).length);
            }

            // Migrate leads
            if (userData.leads) {
                for (const leadId of Object.keys(userData.leads)) {
                    const lead = userData.leads[leadId];
                    if (!lead || typeof lead !== 'object') continue;
                    await pool.query(
                        `INSERT INTO leads (user_id, id, data) VALUES ($1, $2, $3)
                         ON CONFLICT (user_id, id) DO UPDATE SET data = $3`,
                        [uid, leadId, JSON.stringify(lead)]
                    );
                }
                console.log('  Leads: ' + Object.keys(userData.leads).length);
            }

            // Migrate taps
            if (userData.taps) {
                for (const tapId of Object.keys(userData.taps)) {
                    const tap = userData.taps[tapId];
                    if (!tap || typeof tap !== 'object') continue;
                    await pool.query(
                        `INSERT INTO taps (user_id, id, data) VALUES ($1, $2, $3)
                         ON CONFLICT (user_id, id) DO UPDATE SET data = $3`,
                        [uid, tapId, JSON.stringify(tap)]
                    );
                }
                console.log('  Taps: ' + Object.keys(userData.taps).length);
            }

            // Migrate analytics
            if (userData.analytics) {
                for (const cardId of Object.keys(userData.analytics)) {
                    const metrics = userData.analytics[cardId];
                    if (!metrics || typeof metrics !== 'object') continue;
                    for (const metric of Object.keys(metrics)) {
                        const data = metrics[metric];
                        // Firebase analytics are stored as {pushId: {ts, action, ...}}
                        // Convert to array
                        var dataArray = [];
                        if (typeof data === 'object' && !Array.isArray(data)) {
                            dataArray = Object.values(data);
                        } else if (Array.isArray(data)) {
                            dataArray = data;
                        }
                        await pool.query(
                            `INSERT INTO analytics (user_id, card_id, metric, data) VALUES ($1, $2, $3, $4)
                             ON CONFLICT (user_id, card_id, metric) DO UPDATE SET data = $4`,
                            [uid, cardId, metric, JSON.stringify(dataArray)]
                        );
                    }
                }
                console.log('  Analytics migrated');
            }

            // Migrate settings
            const settings = userData.settings || {};
            await pool.query(
                `INSERT INTO user_settings (user_id, default_card, nfc_token, data)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (user_id) DO UPDATE SET default_card = $2, nfc_token = $3, data = $4`,
                [
                    uid,
                    settings.defaultCard || null,
                    settings.nfcToken || null,
                    JSON.stringify(settings)
                ]
            );

            // Migrate subscription
            if (userData.subscription) {
                const sub = userData.subscription;
                await pool.query(
                    `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = $2, plan = $4, status = $5`,
                    [
                        uid,
                        sub.stripeCustomerId || null,
                        sub.stripeSubscriptionId || null,
                        sub.plan || 'free',
                        sub.status || 'none',
                        sub.currentPeriodEnd || null
                    ]
                );
            }

            // Migrate latest tap
            if (userData.latest) {
                await pool.query(
                    `INSERT INTO latest_tap (user_id, data) VALUES ($1, $2)
                     ON CONFLICT (user_id) DO UPDATE SET data = $2`,
                    [uid, JSON.stringify(userData.latest)]
                );
            }

        } catch (err) {
            console.error('  Error migrating user ' + uid + ':', err.message);
        }
    }

    // 2. Migrate public NFC tokens
    console.log('\nMigrating public NFC tokens...');
    const nfcTokens = await fetchFirebase('/public-nfc');
    if (nfcTokens) {
        for (const token of Object.keys(nfcTokens)) {
            try {
                await pool.query(
                    `INSERT INTO public_nfc_tokens (token, user_id) VALUES ($1, $2)
                     ON CONFLICT (token) DO UPDATE SET user_id = $2`,
                    [token, nfcTokens[token]]
                );
            } catch (err) {
                console.error('  NFC token error:', err.message);
            }
        }
        console.log('NFC tokens: ' + Object.keys(nfcTokens).length);
    }

    // 3. Migrate waitlist
    console.log('\nMigrating waitlist...');
    const waitlist = await fetchFirebase('/waitlist');
    if (waitlist) {
        for (const key of Object.keys(waitlist)) {
            const entry = waitlist[key];
            if (!entry || !entry.email) continue;
            try {
                await pool.query(
                    'INSERT INTO waitlist (email, created_at) VALUES ($1, $2)',
                    [entry.email, entry.ts ? new Date(entry.ts) : new Date()]
                );
            } catch (err) {
                // Ignore duplicates
            }
        }
        console.log('Waitlist entries: ' + Object.keys(waitlist).length);
    }

    console.log('\nMigration complete!');
    console.log('NOTE: Firebase Auth passwords cannot be exported.');
    console.log('Existing users must use "Forgot Password" or Google OAuth on first login.');

    await pool.end();
}

migrate().catch(function(err) {
    console.error('Migration failed:', err);
    process.exit(1);
});
