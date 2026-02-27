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

// ── HTML escaping helper ──────────────────────────────────────────
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
        if (process.env.NODE_ENV !== 'production') console.log('Email sent: ' + subject + ' → ' + to);
    } catch (err) {
        console.error('Email error (' + subject + ' → ' + to + '):', err.message);
    }
}

// ── Named senders ──────────────────────────────────────────────────

function sendWelcome(email, name) {
    var safeName = escapeHtml(name);
    var greeting = safeName ? ('Hi ' + safeName + ',') : 'Hi there,';
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">Welcome to CardFlow! 🎉</h2>' +
        '<p>' + greeting + '</p>' +
        '<p>Your account is ready. Create your first digital business card and start sharing it instantly.</p>' +
        button('Go to Dashboard', BASE_URL + '/dashboard') +
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
    var name = escapeHtml(leadData.name) || 'Someone';
    var leadEmail = escapeHtml(leadData.email) || '';
    var phone = escapeHtml(leadData.phone) || '';
    var card = escapeHtml(leadData.cardName) || '';

    var details = '<p><strong>' + name + '</strong> submitted their contact info' + (card ? ' via your card <strong>' + card + '</strong>' : '') + '.</p>';
    if (leadEmail) details += '<p>Email: <a href="mailto:' + encodeURI(leadData.email || '') + '" style="color:#818cf8">' + leadEmail + '</a></p>';
    if (phone) details += '<p>Phone: ' + phone + '</p>';

    var body =
        '<h2 style="color:#fff;margin:0 0 16px">New Lead Captured! 🎯</h2>' +
        details +
        button('View Leads', BASE_URL + '/dashboard#leads') +
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
        button('Go to Dashboard', BASE_URL + '/dashboard') +
        '<p style="color:#9ca3af;font-size:14px">Manage your subscription anytime from the Billing section in your dashboard.</p>';
    return sendEmail(email, 'CardFlow ' + planName + ' plan activated', wrapHtml('Subscription Confirmed', body));
}

function sendPaymentFailed(email) {
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">Payment Failed ⚠️</h2>' +
        '<p>We couldn\'t process your latest payment. Please update your payment method to keep your subscription active.</p>' +
        button('Update Payment', BASE_URL + '/dashboard#billing') +
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

function sendReferralInvite(toEmail, referrerName, referralLink) {
    var safeReferrerName = escapeHtml(referrerName);
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">' + (safeReferrerName || 'Your friend') + ' invited you to CardFlow!</h2>' +
        '<p>' + (safeReferrerName || 'Someone') + ' thinks you\'d love CardFlow — the easiest way to create and share digital business cards.</p>' +
        '<p style="color:#818cf8;font-weight:600">Sign up using their link and you both get 1 free month of Pro!</p>' +
        button('Accept Invite', referralLink) +
        '<p style="color:#9ca3af;font-size:14px">Pro includes 5 cards, unlimited leads, full analytics, and more.</p>';
    return sendEmail(toEmail, (safeReferrerName || 'Your friend') + ' invited you to CardFlow', wrapHtml('Invitation', body));
}

function sendReferralReward(toEmail, userName, friendIdentifier) {
    var safeUserName = escapeHtml(userName);
    var safeFriendIdentifier = escapeHtml(friendIdentifier);
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">You earned a free month of Pro! 🎉</h2>' +
        '<p>Great news, ' + (safeUserName || 'there') + '! ' + (safeFriendIdentifier || 'Your friend') + ' signed up using your referral.</p>' +
        '<p>You\'ve been upgraded to <strong style="color:#818cf8">Pro</strong> for 1 free month. Enjoy unlimited leads, up to 5 cards, and full analytics.</p>' +
        button('Go to Dashboard', BASE_URL + '/dashboard') +
        '<p style="color:#9ca3af;font-size:14px">Keep inviting friends to earn more free months!</p>';
    return sendEmail(toEmail, 'You earned a free month of Pro!', wrapHtml('Referral Reward', body));
}

function sendWeeklyDigest(email, name, stats) {
    var safeName = escapeHtml(name);
    var greeting = safeName ? ('Hi ' + safeName + ',') : 'Hi there,';

    function statBox(label, value, color) {
        return '<td style="text-align:center;padding:12px">' +
            '<div style="font-size:32px;font-weight:700;color:' + color + '">' + value + '</div>' +
            '<div style="font-size:13px;color:#9ca3af;margin-top:4px">' + label + '</div>' +
            '</td>';
    }

    var statsRow =
        '<table width="100%" cellpadding="0" cellspacing="0" style="background:#111827;border-radius:8px;margin:20px 0">' +
        '<tr>' +
        statBox('Views', stats.views || 0, '#818cf8') +
        statBox('Leads', stats.leads || 0, '#4ade80') +
        statBox('Saves', stats.saves || 0, '#f59e0b') +
        '</tr></table>';

    var topCard = '';
    if (stats.topCard) {
        topCard = '<p style="margin:16px 0;padding:12px 16px;background:#111827;border-radius:8px;border-left:3px solid #818cf8">' +
            'Top card: <strong style="color:#fff">' + escapeHtml(stats.topCard) + '</strong> with ' + stats.topCardViews + ' views</p>';
    }

    var trend = '';
    if (stats.prevViews !== undefined && stats.prevViews > 0) {
        var change = Math.round(((stats.views - stats.prevViews) / stats.prevViews) * 100);
        if (change > 0) {
            trend = '<p style="color:#4ade80">Views are up ' + change + '% compared to last week.</p>';
        } else if (change < 0) {
            trend = '<p style="color:#f87171">Views are down ' + Math.abs(change) + '% compared to last week.</p>';
        } else {
            trend = '<p style="color:#9ca3af">Views are steady compared to last week.</p>';
        }
    }

    var body =
        '<h2 style="color:#fff;margin:0 0 16px">Your Weekly Recap</h2>' +
        '<p>' + greeting + '</p>' +
        '<p>Here\'s how your cards performed this week:</p>' +
        statsRow +
        topCard +
        trend +
        button('View Full Analytics', BASE_URL + '/dashboard#analytics') +
        '<p style="color:#9ca3af;font-size:13px">You\'re receiving this because you have weekly digests enabled. ' +
        '<a href="' + BASE_URL + '/dashboard#settings" style="color:#818cf8;text-decoration:none">Unsubscribe</a></p>';

    return sendEmail(email, 'Your CardFlow weekly recap — ' + (stats.views || 0) + ' views, ' + (stats.leads || 0) + ' leads', wrapHtml('Weekly Recap', body));
}

// ── Event Emails ──

function sendExhibitorInvite(toEmail, eventName, organizerName, setupUrl) {
    var safeOrganizerName = escapeHtml(organizerName);
    var safeEventName = escapeHtml(eventName);
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">You\'re Invited to Exhibit!</h2>' +
        '<p>' + (safeOrganizerName || 'An event organizer') + ' has invited you to exhibit at <strong>' + (safeEventName || 'an event') + '</strong> on CardFlow Events.</p>' +
        '<p>Set up your booth profile, add your products, and get ready to capture leads with badge scanning.</p>' +
        button('Set Up Your Booth', setupUrl) +
        '<p style="color:#9ca3af;font-size:14px">You need a CardFlow account to accept this invitation.</p>';
    return sendEmail(toEmail, 'You\'re invited to exhibit at ' + safeEventName, wrapHtml('Exhibitor Invitation', body));
}

function sendEventRegistration(toEmail, name, eventName, badgeUrl) {
    var safeName = escapeHtml(name);
    var safeEventName = escapeHtml(eventName);
    var greeting = safeName ? ('Hi ' + safeName + ',') : 'Hi there,';
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">Registration Confirmed!</h2>' +
        '<p>' + greeting + '</p>' +
        '<p>You\'re registered for <strong>' + (safeEventName || 'the event') + '</strong>. Your digital badge is ready.</p>' +
        '<p>Show your badge QR code at exhibitor booths to instantly share your contact info.</p>' +
        button('View My Badge', badgeUrl) +
        '<p style="color:#9ca3af;font-size:14px">Save your badge to your home screen for quick access at the event.</p>';
    return sendEmail(toEmail, 'Registered for ' + safeEventName, wrapHtml('Registration Confirmed', body));
}

function sendEventReminder(toEmail, name, eventName, eventUrl, daysUntil) {
    var safeName = escapeHtml(name);
    var safeEventName = escapeHtml(eventName);
    var greeting = safeName ? ('Hi ' + safeName + ',') : 'Hi there,';
    var timeText = daysUntil === 1 ? 'tomorrow' : 'in ' + daysUntil + ' days';
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">Event Reminder</h2>' +
        '<p>' + greeting + '</p>' +
        '<p><strong>' + (safeEventName || 'Your event') + '</strong> starts ' + timeText + '!</p>' +
        '<p>Make sure you have your digital badge ready for the event.</p>' +
        button('View Event', eventUrl) +
        '<p style="color:#9ca3af;font-size:14px">See you there!</p>';
    return sendEmail(toEmail, safeEventName + ' starts ' + timeText, wrapHtml('Event Reminder', body));
}

function sendAdminEmail(toEmail, subject, messageBody, adminName) {
    var safeAdminName = escapeHtml(adminName);
    var safeBody = escapeHtml(messageBody).replace(/\n/g, '<br>');
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">Message from CardFlow Admin</h2>' +
        '<p>' + safeBody + '</p>' +
        '<p style="color:#9ca3af;font-size:14px;margin-top:24px">— ' + (safeAdminName || 'CardFlow Admin Team') + '</p>' +
        '<p style="color:#9ca3af;font-size:12px;margin-top:16px;border-top:1px solid #374151;padding-top:12px">This message was sent by a CardFlow administrator. If you believe this was sent in error, please contact support.</p>';
    return sendEmail(toEmail, subject, wrapHtml(subject, body));
}

function sendTeamInvitation(toEmail, inviterName, teamName) {
    var safeInviterName = escapeHtml(inviterName);
    var safeTeamName = escapeHtml(teamName);
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">You\'re Invited to a Team!</h2>' +
        '<p>' + (safeInviterName || 'A team admin') + ' has invited you to join <strong>' + (safeTeamName || 'their team') + '</strong> on CardFlow.</p>' +
        '<p>Log in to your CardFlow dashboard to accept the invitation and start collaborating with your team.</p>' +
        button('View Invitation', BASE_URL + '/dashboard#teams') +
        '<p style="color:#9ca3af;font-size:14px">If you don\'t have a CardFlow account yet, sign up first and the invitation will be waiting for you.</p>';
    return sendEmail(toEmail, (safeInviterName || 'Someone') + ' invited you to join ' + (safeTeamName || 'a team') + ' on CardFlow', wrapHtml('Team Invitation', body));
}

// ── Card Verification Emails ──────────────────────────────────────

function sendCardVerificationOTP(email, code, cardName) {
    var safeName = escapeHtml(cardName);
    var body =
        '<h2 style="color:#fff;margin:0 0 16px;text-align:center">Verify Your Card Email</h2>' +
        '<p style="text-align:center">You\'re verifying that you own the email on your card <strong>' + safeName + '</strong>. Enter this code in CardFlow to continue:</p>' +
        '<div style="text-align:center;margin:24px 0">' +
        '<span style="display:inline-block;padding:16px 32px;background:#1f2937;border-radius:12px;font-family:\'Courier New\',monospace;font-size:36px;font-weight:700;letter-spacing:8px;color:#fff;border:2px solid #059669">' +
        code +
        '</span>' +
        '</div>' +
        '<p style="text-align:center;color:#9ca3af;font-size:14px">This code expires in 10 minutes. If you didn\'t request this, you can safely ignore this email.</p>';
    return sendEmail(email, 'Verify your card email: ' + code, wrapHtml('Card Verification', body));
}

function sendVerificationApproved(email, cardName) {
    var safeName = escapeHtml(cardName);
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">Your Card is Verified!</h2>' +
        '<p>Great news! Your card <strong>' + safeName + '</strong> has been verified.</p>' +
        '<p>It now shows a <span style="color:#10b981;font-weight:600">verified badge</span> to everyone who views it, building trust with your contacts.</p>' +
        button('View Dashboard', BASE_URL + '/dashboard');
    return sendEmail(email, 'Your card ' + safeName + ' is verified!', wrapHtml('Verified', body));
}

function sendVerificationRejected(email, cardName, reason) {
    var safeName = escapeHtml(cardName);
    var safeReason = escapeHtml(reason);
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">Card Verification Update</h2>' +
        '<p>We couldn\'t verify your card <strong>' + safeName + '</strong> at this time.</p>' +
        (safeReason ? '<p style="padding:12px 16px;background:#1f2937;border-radius:8px;border-left:3px solid #ef4444"><strong>Reason:</strong> ' + safeReason + '</p>' : '') +
        '<p>You can submit a new verification request with different or clearer documents.</p>' +
        button('Try Again', BASE_URL + '/dashboard');
    return sendEmail(email, 'Card verification update for ' + safeName, wrapHtml('Verification Update', body));
}

function sendVerificationRevoked(email, cardName) {
    var safeName = escapeHtml(cardName);
    var body =
        '<h2 style="color:#fff;margin:0 0 16px">Card Verification Revoked</h2>' +
        '<p>Your card <strong>' + safeName + '</strong> was previously verified, but a key field (name, email, or company) has been changed.</p>' +
        '<p>For security, the <span style="color:#f59e0b;font-weight:600">verified badge</span> has been removed. You can re-verify your card at any time.</p>' +
        button('Re-verify Card', BASE_URL + '/dashboard');
    return sendEmail(email, 'Verification revoked for ' + safeName, wrapHtml('Verification Revoked', body));
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
    sendOTP: sendOTP,
    sendReferralInvite: sendReferralInvite,
    sendReferralReward: sendReferralReward,
    sendWeeklyDigest: sendWeeklyDigest,
    sendExhibitorInvite: sendExhibitorInvite,
    sendEventRegistration: sendEventRegistration,
    sendEventReminder: sendEventReminder,
    sendTeamInvitation: sendTeamInvitation,
    sendAdminEmail: sendAdminEmail,
    sendCardVerificationOTP: sendCardVerificationOTP,
    sendVerificationApproved: sendVerificationApproved,
    sendVerificationRejected: sendVerificationRejected,
    sendVerificationRevoked: sendVerificationRevoked
};
