const webpush = require('web-push');
const db = require('./db');

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        process.env.VAPID_EMAIL || 'mailto:no-reply@cardflow.cloud',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
} else {
    console.warn('VAPID keys not set — push notifications disabled');
}

async function sendPush(userId, payload) {
    try {
        var result = await db.query('SELECT push_subscription FROM user_settings WHERE user_id = $1', [userId]);
        if (result.rows.length === 0 || !result.rows[0].push_subscription) return;

        var subscription = result.rows[0].push_subscription;
        await webpush.sendNotification(subscription, JSON.stringify(payload));
    } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
            // Subscription expired or unsubscribed — clear it
            db.query('UPDATE user_settings SET push_subscription = NULL WHERE user_id = $1', [userId]).catch(function () {});
        }
        console.error('Push notification error (user ' + userId + '):', err.message);
    }
}

module.exports = { sendPush: sendPush };
