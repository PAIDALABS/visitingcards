const nodemailer = require('nodemailer');

var transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.hostinger.com',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: true,
    auth: {
        user: process.env.SMTP_USER || 'no-reply@cardflow.cloud',
        pass: process.env.SMTP_PASS
    }
});

var FROM = '"CardFlow" <no-reply@cardflow.cloud>';
var BASE_URL = process.env.BASE_URL || 'https://card.cardflow.cloud';

// ── Base HTML wrapper ──────────────────────────────────────────────
function wrapHtml(title, bodyContent) {
    return '<!DOCTYPE html>' +
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title></head>' +
    '<body style="margin:0;padding:0;background:#111827;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#111827;padding:40px 20px">' +
    '<tr><td align="center">' +
    '<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#1f2937;border-radius:12px;overflow:hidden">' +
    // Header
    '<tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px;text-align:center">' +
    '<h1 style="margin:0;color:#fff;font-size:28px;font-weight:700">CardFlow</h1>' +
    '</td></tr>' +
    // Body
    '<tr><td style="padding:32px;color:#e5e7eb;font-size:16px;line-height:1.6">' +
    bodyContent +
    '</td></tr>' +
    // Footer
    '<tr><td style="padding:24px 32px;border-top:1px solid #374151;text-align:center;color:#6b7280;font-size:13px">' +
    '<p style="margin:0 0 8px">&copy; ' + new Date().getFullYear() + ' CardFlow. All rights reserved.</p>' +
    '<p style="margin:0"><a href="' + BASE_URL + '" style="color:#818cf8;text-decoration:none">cardflow.cloud</a></p>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

function button(text, url) {
    return '<table cellpadding="0" cellspacing="0" style="margin:24px 0"><tr><td>' +
    '<a href="' + url + '" style="display:inline-block;padding:14px 32px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px">' +
    text + '</a></td></tr></table>';
}

// ── Core send function ─────────────────────────────────────────────
async function sendEmail(to, subject, html) {
    try {
        await transporter.sendMail({
            from: FROM,
            to: to,
            subject: subject,
            html: html
        });
        console.log('Email sent: ' + subject + ' → ' + to);
    } catch (err) {
        console.error('Email error (' + subject + ' → ' + to + '):', err.message);
    }
}

// ── Named senders ──────────────────────────────────────────────────

function sendWelcome(email, name) {
    var greeting = name ? ('Hi ' + name + ',') : 'Hi there,';
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">Welcome to CardFlow! 🎉</h2>' +
        '<p>' + greeting + '</p>' +
        '<p>Your account is ready. Create your first digital business card and start sharing it instantly.</p>' +
        button('Go to Dashboard', BASE_URL + '/admin.html') +
        '<p style="color:#9ca3af;font-size:14px">If you have any questions, just reply to this email.</p>';
    return sendEmail(email, 'Welcome to CardFlow!', wrapHtml('Welcome to CardFlow', body));
}

function sendEmailVerification(email, verifyUrl) {
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">Verify Your Email</h2>' +
        '<p>Please confirm your email address by clicking the button below:</p>' +
        button('Verify Email', verifyUrl) +
        '<p style="color:#9ca3af;font-size:14px">This link expires in 24 hours. If you didn\'t create an account, you can safely ignore this email.</p>';
    return sendEmail(email, 'Verify your CardFlow email', wrapHtml('Verify Email', body));
}

function sendPasswordReset(email, resetUrl) {
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">Reset Your Password</h2>' +
        '<p>We received a request to reset your password. Click the button below to set a new one:</p>' +
        button('Reset Password', resetUrl) +
        '<p style="color:#9ca3af;font-size:14px">This link expires in 1 hour. If you didn\'t request a password reset, you can safely ignore this email.</p>';
    return sendEmail(email, 'Reset your CardFlow password', wrapHtml('Reset Password', body));
}

function sendLeadNotification(ownerEmail, leadData) {
    var name = leadData.name || 'Someone';
    var leadEmail = leadData.email || '';
    var phone = leadData.phone || '';
    var card = leadData.cardName || '';

    var details = '<p><strong>' + name + '</strong> submitted their contact info' + (card ? ' via your card <strong>' + card + '</strong>' : '') + '.</p>';
    if (leadEmail) details += '<p>Email: <a href="mailto:' + leadEmail + '" style="color:#818cf8">' + leadEmail + '</a></p>';
    if (phone) details += '<p>Phone: ' + phone + '</p>';

    var body =
        '<h2 style="color:#fff;margin:0 0 16px">New Lead Captured! 🎯</h2>' +
        details +
        button('View Leads', BASE_URL + '/admin.html#leads') +
        '<p style="color:#9ca3af;font-size:14px">You received this because someone submitted a lead on your CardFlow card.</p>';
    return sendEmail(ownerEmail, 'New lead: ' + name, wrapHtml('New Lead', body));
}

function sendWaitlistConfirmation(email) {
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">You\'re on the List! 🚀</h2>' +
        '<p>Thanks for joining the CardFlow waitlist. We\'ll notify you as soon as your spot is ready.</p>' +
        '<p style="color:#9ca3af;font-size:14px">Stay tuned — great things are coming.</p>';
    return sendEmail(email, 'You\'re on the CardFlow waitlist!', wrapHtml('Waitlist Confirmed', body));
}

function sendSubscriptionConfirmed(email, plan) {
    var planName = plan.charAt(0).toUpperCase() + plan.slice(1);
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">Subscription Confirmed! ✅</h2>' +
        '<p>You\'re now on the <strong>' + planName + '</strong> plan. All premium features are unlocked.</p>' +
        button('Go to Dashboard', BASE_URL + '/admin.html') +
        '<p style="color:#9ca3af;font-size:14px">Manage your subscription anytime from the Billing section in your dashboard.</p>';
    return sendEmail(email, 'CardFlow ' + planName + ' plan activated', wrapHtml('Subscription Confirmed', body));
}

function sendPaymentFailed(email) {
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">Payment Failed ⚠️</h2>' +
        '<p>We couldn\'t process your latest payment. Please update your payment method to keep your subscription active.</p>' +
        button('Update Payment', BASE_URL + '/admin.html#billing') +
        '<p style="color:#9ca3af;font-size:14px">If you need help, just reply to this email.</p>';
    return sendEmail(email, 'CardFlow payment failed — action needed', wrapHtml('Payment Failed', body));
}

function sendOTP(email, code) {
    var body =
        '<h2 style="color:#fff;margin:0 0 16px;text-align:center">Your Login Code</h2>' +
        '<p style="text-align:center">Enter this code to sign in to CardFlow:</p>' +
        '<div style="text-align:center;margin:24px 0">' +
        '<span style="display:inline-block;padding:16px 32px;background:#1f2937;border-radius:12px;font-family:\'Courier New\',monospace;font-size:36px;font-weight:700;letter-spacing:8px;color:#fff;border:2px solid #4f46e5">' +
        code +
        '</span>' +
        '</div>' +
        '<p style="text-align:center;color:#9ca3af;font-size:14px">This code expires in 10 minutes. If you didn\'t request this, you can safely ignore this email.</p>';
    return sendEmail(email, 'Your CardFlow login code: ' + code, wrapHtml('Login Code', body));
}

module.exports = {
    sendEmail: sendEmail,
    sendWelcome: sendWelcome,
    sendEmailVerification: sendEmailVerification,
    sendPasswordReset: sendPasswordReset,
    sendLeadNotification: sendLeadNotification,
    sendWaitlistConfirmation: sendWaitlistConfirmation,
    sendSubscriptionConfirmed: sendSubscriptionConfirmed,
    sendPaymentFailed: sendPaymentFailed,
    sendOTP: sendOTP
};
