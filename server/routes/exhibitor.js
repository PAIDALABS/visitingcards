var express = require('express');
var db = require('../db');
var sse = require('../sse');
var { verifyAuth } = require('../auth');
var { sendPush } = require('../push');

var router = express.Router();
router.use(verifyAuth);

function csvSafe(v) {
    var s = (v || '').toString().replace(/"/g, '""');
    if (/^[=+\-@\t\r\n\0]/.test(s)) s = "'" + s;
    return '"' + s + '"';
}

// ── Exhibitor Self-Service ──

// GET /api/exhibitor/events — events I'm exhibiting at
router.get('/events', async function (req, res) {
    try {
        var result = await db.query(
            `SELECT ex.*, e.name as event_name, e.slug as event_slug, e.start_date, e.end_date,
                    e.venue, e.city, e.status as event_status, e.logo as event_logo,
                    (SELECT COUNT(*) FROM booth_visits WHERE exhibitor_id = ex.id) as lead_count
             FROM event_exhibitors ex
             JOIN events e ON e.id = ex.event_id
             WHERE ex.user_id = $1
             ORDER BY e.start_date DESC`,
            [req.user.uid]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Get exhibitor events error:', err);
        res.status(500).json({ error: 'Failed to load events' });
    }
});

// GET /api/exhibitor/event/:eventId — my booth details for an event
router.get('/event/:eventId', async function (req, res) {
    try {
        var result = await db.query(
            `SELECT ex.*, e.name as event_name, e.slug as event_slug, e.start_date, e.end_date,
                    e.venue, e.city, e.status as event_status, e.branding as event_branding
             FROM event_exhibitors ex
             JOIN events e ON e.id = ex.event_id
             WHERE ex.event_id = $1 AND ex.user_id = $2`,
            [req.params.eventId, req.user.uid]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not an exhibitor for this event' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Get booth details error:', err);
        res.status(500).json({ error: 'Failed to load booth details' });
    }
});

// PATCH /api/exhibitor/event/:eventId — update my booth profile
router.patch('/event/:eventId', async function (req, res) {
    try {
        // Verify exhibitor
        var check = await db.query(
            'SELECT id FROM event_exhibitors WHERE event_id = $1 AND user_id = $2',
            [req.params.eventId, req.user.uid]
        );
        if (check.rows.length === 0) return res.status(404).json({ error: 'Not an exhibitor for this event' });

        var b = req.body;

        // Field length limits
        if (b.company_name && b.company_name.length > 200) return res.status(400).json({ error: 'Company name too long (max 200 chars)' });
        if (b.company_description && b.company_description.length > 5000) return res.status(400).json({ error: 'Description too long (max 5000 chars)' });
        if (b.website && b.website.length > 500) return res.status(400).json({ error: 'Website URL too long (max 500 chars)' });
        if (b.brochure_url && b.brochure_url.length > 500) return res.status(400).json({ error: 'Brochure URL too long (max 500 chars)' });
        if (b.logo && b.logo.length > 500000) return res.status(400).json({ error: 'Logo data too large (max 500KB)' });
        if (b.products && JSON.stringify(b.products).length > 50000) return res.status(400).json({ error: 'Products data too large (max 50KB)' });

        var fields = [];
        var values = [];
        var idx = 1;

        var allowed = ['company_name', 'company_description', 'products', 'brochure_url', 'logo', 'website', 'settings'];
        allowed.forEach(function (field) {
            if (b[field] !== undefined) {
                var val = b[field];
                if (['products', 'settings'].includes(field)) val = JSON.stringify(val);
                fields.push(field + ' = $' + idx);
                values.push(val);
                idx++;
            }
        });

        if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

        values.push(req.params.eventId);
        values.push(req.user.uid);

        var result = await db.query(
            'UPDATE event_exhibitors SET ' + fields.join(', ') + ' WHERE event_id = $' + idx + ' AND user_id = $' + (idx + 1) + ' RETURNING *',
            values
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update booth error:', err);
        res.status(500).json({ error: 'Failed to update booth profile' });
    }
});

// ── Badge Lookup (Authenticated) ──

// GET /api/exhibitor/badge/:code — full badge lookup (requires approved exhibitor for the event)
router.get('/badge/:code', async function (req, res) {
    try {
        var result = await db.query(
            `SELECT ea.name, ea.email, ea.phone, ea.company, ea.title, ea.badge_code, ea.event_id,
                    e.name as event_name, e.slug as event_slug
             FROM event_attendees ea
             JOIN events e ON e.id = ea.event_id
             WHERE ea.badge_code = $1`,
            [req.params.code.toUpperCase()]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Badge not found' });

        var badge = result.rows[0];

        // Verify caller is an approved exhibitor for this event, or the event organizer
        var exCheck = await db.query(
            "SELECT id FROM event_exhibitors WHERE event_id = $1 AND user_id = $2 AND status = 'approved'",
            [badge.event_id, req.user.uid]
        );
        if (exCheck.rows.length === 0) {
            var orgCheck = await db.query(
                'SELECT id FROM events WHERE id = $1 AND organizer_id = $2',
                [badge.event_id, req.user.uid]
            );
            if (orgCheck.rows.length === 0) {
                return res.status(403).json({ error: 'Not authorized to view badge details for this event' });
            }
        }

        res.json(badge);
    } catch (err) {
        console.error('Badge lookup error:', err);
        res.status(500).json({ error: 'Failed to look up badge' });
    }
});

// ── Badge Scanning ──

// In-memory debounce cache for badge scans: key = "exhibitorId:badgeCode" => timestamp
var scanDebounce = {};
// Clean up debounce cache every 5 minutes
setInterval(function () {
    var cutoff = Date.now() - 60000;
    Object.keys(scanDebounce).forEach(function (key) {
        if (scanDebounce[key] < cutoff) delete scanDebounce[key];
    });
}, 5 * 60 * 1000);

// POST /api/exhibitor/event/:eventId/scan — scan a badge code
router.post('/event/:eventId/scan', async function (req, res) {
    try {
        var badgeCode = (req.body.badge_code || '').trim().toUpperCase();
        if (!badgeCode) return res.status(400).json({ error: 'badge_code is required' });

        // Verify exhibitor
        var exCheck = await db.query(
            'SELECT id, company_name, booth_number FROM event_exhibitors WHERE event_id = $1 AND user_id = $2 AND status = $3',
            [req.params.eventId, req.user.uid, 'approved']
        );
        if (exCheck.rows.length === 0) return res.status(403).json({ error: 'Not an approved exhibitor for this event' });
        var exhibitor = exCheck.rows[0];

        // Fix #8: Validate event status is live or published
        var eventCheck = await db.query(
            "SELECT status FROM events WHERE id = $1",
            [req.params.eventId]
        );
        if (eventCheck.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
        var eventStatus = eventCheck.rows[0].status;
        if (eventStatus !== 'live' && eventStatus !== 'published') {
            return res.status(403).json({ error: 'Badge scanning is only available for live or published events' });
        }

        // Fix #6: In-memory debounce — same badge scanned by same exhibitor within 30 seconds
        var debounceKey = exhibitor.id + ':' + badgeCode;
        if (scanDebounce[debounceKey] && (Date.now() - scanDebounce[debounceKey]) < 30000) {
            // Return existing recent visit instead of creating duplicate
            var recentVisit = await db.query(
                `SELECT bv.*, ea.name, ea.email, ea.company, ea.title, ea.badge_code
                 FROM booth_visits bv
                 LEFT JOIN event_attendees ea ON ea.id = bv.attendee_id
                 WHERE bv.exhibitor_id = $1 AND bv.event_id = $2
                 ORDER BY bv.created_at DESC LIMIT 1`,
                [exhibitor.id, req.params.eventId]
            );
            if (recentVisit.rows.length > 0) {
                return res.json({
                    duplicate: true,
                    visit: recentVisit.rows[0],
                    attendee: { name: recentVisit.rows[0].name, email: recentVisit.rows[0].email, company: recentVisit.rows[0].company, title: recentVisit.rows[0].title, badge_code: recentVisit.rows[0].badge_code }
                });
            }
        }

        // Look up attendee by badge code
        var attendee = await db.query(
            'SELECT * FROM event_attendees WHERE badge_code = $1 AND event_id = $2',
            [badgeCode, req.params.eventId]
        );
        if (attendee.rows.length === 0) return res.status(404).json({ error: 'Badge not found for this event' });
        var att = attendee.rows[0];

        // Fix #7: Check for duplicate visit within last 5 minutes (database-level)
        var dupVisit = await db.query(
            "SELECT bv.*, ea.name, ea.email, ea.company, ea.title, ea.badge_code FROM booth_visits bv LEFT JOIN event_attendees ea ON ea.id = bv.attendee_id WHERE bv.exhibitor_id = $1 AND bv.attendee_id = $2 AND bv.created_at > NOW() - INTERVAL '5 minutes' LIMIT 1",
            [exhibitor.id, att.id]
        );
        if (dupVisit.rows.length > 0) {
            scanDebounce[debounceKey] = Date.now();
            return res.json({
                duplicate: true,
                visit: dupVisit.rows[0],
                attendee: { name: dupVisit.rows[0].name, email: dupVisit.rows[0].email, company: dupVisit.rows[0].company, title: dupVisit.rows[0].title, badge_code: dupVisit.rows[0].badge_code }
            });
        }

        // Validate scan data size
        var scanData = req.body.data || {};
        if (JSON.stringify(scanData).length > 50000) {
            return res.status(400).json({ error: 'Scan data too large (max 50KB)' });
        }

        // Create booth visit record
        var visit = await db.query(
            `INSERT INTO booth_visits (event_id, exhibitor_id, attendee_id, visitor_id, scanned_by, data)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [
                req.params.eventId, exhibitor.id, att.id, att.visitor_id,
                req.user.uid,
                JSON.stringify(scanData)
            ]
        );

        // Update debounce cache
        scanDebounce[debounceKey] = Date.now();

        // Create lead in existing leads table for CRM integration
        var leadId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        var leadData = {
            name: att.name,
            email: att.email || '',
            phone: att.phone || '',
            company: att.company || '',
            title: att.title || '',
            source: 'badge_scan',
            event_id: req.params.eventId,
            booth_number: exhibitor.booth_number,
            badge_code: badgeCode,
            notes: req.body.notes || ''
        };

        await db.query(
            'INSERT INTO leads (user_id, id, data, visitor_id, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW()) ON CONFLICT (user_id, id) DO NOTHING',
            [req.user.uid, leadId, JSON.stringify(leadData), att.visitor_id]
        );

        // SSE: notify exhibitor's booth dashboard
        sse.publish('booth:' + req.params.eventId + ':' + exhibitor.id, {
            type: 'new_scan',
            visit: visit.rows[0],
            attendee: { name: att.name, email: att.email, company: att.company, title: att.title },
            lead_id: leadId
        });

        // SSE: notify exhibitor's leads stream
        sse.publish('leads:' + req.user.uid, { id: leadId, data: leadData });

        // Push notification (background)
        sendPush(req.user.uid, {
            title: 'Badge Scanned',
            body: att.name + (att.company ? ' from ' + att.company : '') + ' visited your booth'
        }).catch(function () {});

        res.status(201).json({
            visit: visit.rows[0],
            attendee: { name: att.name, email: att.email, company: att.company, title: att.title, badge_code: att.badge_code },
            lead_id: leadId
        });
    } catch (err) {
        console.error('Badge scan error:', err);
        res.status(500).json({ error: 'Failed to process badge scan' });
    }
});

// GET /api/exhibitor/event/:eventId/leads — leads captured at this event
router.get('/event/:eventId/leads', async function (req, res) {
    try {
        var exCheck = await db.query(
            'SELECT id FROM event_exhibitors WHERE event_id = $1 AND user_id = $2',
            [req.params.eventId, req.user.uid]
        );
        if (exCheck.rows.length === 0) return res.status(403).json({ error: 'Not an exhibitor for this event' });

        var result = await db.query(
            `SELECT bv.*, ea.name, ea.email, ea.phone, ea.company, ea.title, ea.badge_code
             FROM booth_visits bv
             LEFT JOIN event_attendees ea ON ea.id = bv.attendee_id
             WHERE bv.exhibitor_id = $1 AND bv.event_id = $2
             ORDER BY bv.created_at DESC`,
            [exCheck.rows[0].id, req.params.eventId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Get event leads error:', err);
        res.status(500).json({ error: 'Failed to load leads' });
    }
});

// PATCH /api/exhibitor/event/:eventId/leads/:visitId — update lead notes/rating
router.patch('/event/:eventId/leads/:visitId', async function (req, res) {
    try {
        var exCheck = await db.query(
            'SELECT id FROM event_exhibitors WHERE event_id = $1 AND user_id = $2',
            [req.params.eventId, req.user.uid]
        );
        if (exCheck.rows.length === 0) return res.status(403).json({ error: 'Not an exhibitor for this event' });

        // Merge data
        var existing = await db.query('SELECT data FROM booth_visits WHERE id = $1 AND exhibitor_id = $2',
            [parseInt(req.params.visitId), exCheck.rows[0].id]);
        if (existing.rows.length === 0) return res.status(404).json({ error: 'Visit not found' });

        var data = Object.assign({}, existing.rows[0].data, req.body.data || req.body);
        if (JSON.stringify(data).length > 50000) {
            return res.status(400).json({ error: 'Lead data too large (max 50KB)' });
        }
        var result = await db.query(
            'UPDATE booth_visits SET data = $1 WHERE id = $2 AND exhibitor_id = $3 RETURNING *',
            [JSON.stringify(data), parseInt(req.params.visitId), exCheck.rows[0].id]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update lead error:', err);
        res.status(500).json({ error: 'Failed to update lead' });
    }
});

// GET /api/exhibitor/event/:eventId/leads/export — CSV export
router.get('/event/:eventId/leads/export', async function (req, res) {
    try {
        var exCheck = await db.query(
            'SELECT id, company_name FROM event_exhibitors WHERE event_id = $1 AND user_id = $2',
            [req.params.eventId, req.user.uid]
        );
        if (exCheck.rows.length === 0) return res.status(403).json({ error: 'Not an exhibitor for this event' });

        var result = await db.query(
            `SELECT ea.name, ea.email, ea.phone, ea.company, ea.title, ea.badge_code, bv.created_at, bv.data as notes
             FROM booth_visits bv
             LEFT JOIN event_attendees ea ON ea.id = bv.attendee_id
             WHERE bv.exhibitor_id = $1 AND bv.event_id = $2
             ORDER BY bv.created_at`,
            [exCheck.rows[0].id, req.params.eventId]
        );

        var csv = 'Name,Email,Phone,Company,Title,Badge Code,Scanned At,Notes\n';
        result.rows.forEach(function (r) {
            var notes = r.notes ? (r.notes.notes || '') : '';
            csv += [r.name, r.email, r.phone, r.company, r.title, r.badge_code,
                r.created_at ? new Date(r.created_at).toISOString() : '', notes
            ].map(csvSafe).join(',') + '\n';
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="booth-leads.csv"');
        res.send(csv);
    } catch (err) {
        console.error('Export leads error:', err);
        res.status(500).json({ error: 'Failed to export leads' });
    }
});

// ── Booth Analytics ──

// GET /api/exhibitor/event/:eventId/analytics — booth stats
router.get('/event/:eventId/analytics', async function (req, res) {
    try {
        var exCheck = await db.query(
            'SELECT id FROM event_exhibitors WHERE event_id = $1 AND user_id = $2',
            [req.params.eventId, req.user.uid]
        );
        if (exCheck.rows.length === 0) return res.status(403).json({ error: 'Not an exhibitor for this event' });
        var exId = exCheck.rows[0].id;

        var stats = await db.query(
            `SELECT
                (SELECT COUNT(*) FROM booth_visits WHERE exhibitor_id = $1) as total_leads,
                (SELECT COUNT(*) FROM booth_visits WHERE exhibitor_id = $1 AND created_at >= NOW() - INTERVAL '24 hours') as leads_today`,
            [exId]
        );

        // Leads over time (hourly)
        var hourly = await db.query(
            `SELECT date_trunc('hour', created_at) as hour, COUNT(*) as count
             FROM booth_visits WHERE exhibitor_id = $1
             GROUP BY hour ORDER BY hour`,
            [exId]
        );

        // Team member leaderboard
        var team = await db.query(
            `SELECT u.name, u.username, COUNT(*) as scans
             FROM booth_visits bv
             JOIN users u ON u.id = bv.scanned_by
             WHERE bv.exhibitor_id = $1
             GROUP BY u.id, u.name, u.username
             ORDER BY scans DESC`,
            [exId]
        );

        res.json({
            overview: stats.rows[0],
            hourly: hourly.rows,
            team_leaderboard: team.rows
        });
    } catch (err) {
        console.error('Booth analytics error:', err);
        res.status(500).json({ error: 'Failed to load analytics' });
    }
});

module.exports = router;
