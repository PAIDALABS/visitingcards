var express = require('express');
var db = require('../db');
var { verifyAuth } = require('../auth');
var { sendExhibitorInvite } = require('../email');

var router = express.Router();
router.use(verifyAuth);

// ── Helpers ──

function csvSafe(v) {
    var s = (v || '').toString().replace(/"/g, '""');
    if (/^[=+\-@\t\r\n\0]/.test(s)) s = "'" + s;
    return '"' + s + '"';
}

function slugify(text) {
    return text.toString().toLowerCase().trim()
        .replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-')
        .substring(0, 100);
}

// Check if user owns this event
async function requireOrganizer(req, res) {
    var event = await db.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    if (event.rows.length === 0) { res.status(404).json({ error: 'Event not found' }); return null; }
    if (event.rows[0].organizer_id !== req.user.uid) { res.status(403).json({ error: 'Not your event' }); return null; }
    return event.rows[0];
}

// ── Event CRUD ──

// POST /api/events — create event
router.post('/', async function (req, res) {
    try {
        var b = req.body;
        if (!b.name || !b.start_date || !b.end_date) {
            return res.status(400).json({ error: 'Name, start_date and end_date are required' });
        }

        if (new Date(b.start_date) > new Date(b.end_date)) {
            return res.status(400).json({ error: 'Start date must be on or before end date' });
        }

        // Validate event status if provided
        var VALID_EVENT_STATUSES_CREATE = ['draft', 'published', 'live', 'completed', 'archived'];
        if (b.status && !VALID_EVENT_STATUSES_CREATE.includes(b.status)) {
            return res.status(400).json({ error: 'Invalid status. Allowed: ' + VALID_EVENT_STATUSES_CREATE.join(', ') });
        }

        // Generate unique slug with retry on unique constraint violation
        var baseSlug = slugify(b.name);
        var slug = baseSlug;
        var suffix = 1;
        var result;
        var maxRetries = 10;

        for (var attempt = 0; attempt < maxRetries; attempt++) {
            try {
                result = await db.query(
                    `INSERT INTO events (organizer_id, slug, name, description, venue, address, city, start_date, end_date, logo, cover_image, branding, categories, floor_plan_image, settings, status)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                     RETURNING *`,
                    [
                        req.user.uid, slug, b.name, b.description || null,
                        b.venue || null, b.address || null, b.city || null,
                        b.start_date, b.end_date,
                        b.logo || null, b.cover_image || null,
                        JSON.stringify(b.branding || {}), JSON.stringify(b.categories || []),
                        b.floor_plan_image || null, JSON.stringify(b.settings || {}),
                        b.status || 'draft'
                    ]
                );
                break; // Insert succeeded
            } catch (insertErr) {
                // 23505 = unique_violation — retry with incremented suffix
                if (insertErr.code === '23505' && insertErr.constraint && insertErr.constraint.includes('slug')) {
                    slug = baseSlug + '-' + suffix;
                    suffix++;
                    continue;
                }
                throw insertErr; // Re-throw non-slug errors
            }
        }
        if (!result) return res.status(500).json({ error: 'Failed to generate unique slug' });

        // Set user role to organizer if still 'user'
        await db.query("UPDATE users SET role = 'organizer' WHERE id = $1 AND role = 'user'", [req.user.uid]);

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Create event error:', err);
        res.status(500).json({ error: 'Failed to create event' });
    }
});

// GET /api/events — list my events
router.get('/', async function (req, res) {
    try {
        var result = await db.query(
            `SELECT e.*,
                (SELECT COUNT(*) FROM event_exhibitors WHERE event_id = e.id) as exhibitor_count,
                (SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id) as attendee_count
             FROM events e WHERE e.organizer_id = $1 ORDER BY e.start_date DESC`,
            [req.user.uid]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('List events error:', err);
        res.status(500).json({ error: 'Failed to load events' });
    }
});

// GET /api/events/:id — get event details
router.get('/:id', async function (req, res) {
    try {
        var event = await requireOrganizer(req, res);
        if (!event) return;

        // Get counts
        var counts = await db.query(
            `SELECT
                (SELECT COUNT(*) FROM event_exhibitors WHERE event_id = $1) as exhibitor_count,
                (SELECT COUNT(*) FROM event_attendees WHERE event_id = $1) as attendee_count,
                (SELECT COUNT(*) FROM event_exhibitors WHERE event_id = $1 AND status = 'approved') as approved_exhibitors,
                (SELECT COUNT(*) FROM event_attendees WHERE event_id = $1 AND checked_in_at IS NOT NULL) as checked_in_count,
                (SELECT COUNT(*) FROM booth_visits WHERE event_id = $1) as total_visits`,
            [req.params.id]
        );

        event.exhibitor_count = parseInt(counts.rows[0].exhibitor_count) || 0;
        event.attendee_count = parseInt(counts.rows[0].attendee_count) || 0;
        event.approved_exhibitors = parseInt(counts.rows[0].approved_exhibitors) || 0;
        event.checked_in_count = parseInt(counts.rows[0].checked_in_count) || 0;
        event.total_visits = parseInt(counts.rows[0].total_visits) || 0;

        res.json(event);
    } catch (err) {
        console.error('Get event error:', err);
        res.status(500).json({ error: 'Failed to load event' });
    }
});

// PATCH /api/events/:id — update event
router.patch('/:id', async function (req, res) {
    try {
        var event = await requireOrganizer(req, res);
        if (!event) return;

        var b = req.body;

        // Validate event status against allowed values
        var VALID_EVENT_STATUSES = ['draft', 'published', 'live', 'completed', 'archived'];
        if (b.status !== undefined && !VALID_EVENT_STATUSES.includes(b.status)) {
            return res.status(400).json({ error: 'Invalid status. Allowed: ' + VALID_EVENT_STATUSES.join(', ') });
        }

        var fields = [];
        var values = [];
        var idx = 1;

        var allowed = ['name', 'description', 'venue', 'address', 'city', 'start_date', 'end_date',
            'logo', 'cover_image', 'branding', 'categories', 'floor_plan_image', 'settings', 'status'];

        allowed.forEach(function (field) {
            if (b[field] !== undefined) {
                var val = b[field];
                if (['branding', 'categories', 'settings'].includes(field)) val = JSON.stringify(val);
                fields.push(field + ' = $' + idx);
                values.push(val);
                idx++;
            }
        });

        if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

        fields.push('updated_at = NOW()');
        values.push(req.params.id);

        var result = await db.query(
            'UPDATE events SET ' + fields.join(', ') + ' WHERE id = $' + idx + ' RETURNING *',
            values
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update event error:', err);
        res.status(500).json({ error: 'Failed to update event' });
    }
});

// DELETE /api/events/:id — delete event
router.delete('/:id', async function (req, res) {
    try {
        var event = await requireOrganizer(req, res);
        if (!event) return;

        await db.query('DELETE FROM events WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete event error:', err);
        res.status(500).json({ error: 'Failed to delete event' });
    }
});

// ── Exhibitor Management (Organizer) ──

// POST /api/events/:id/exhibitors/invite — invite exhibitor by email
router.post('/:id/exhibitors/invite', async function (req, res) {
    try {
        var event = await requireOrganizer(req, res);
        if (!event) return;

        var email = (req.body.email || '').toLowerCase().trim();
        if (!email) return res.status(400).json({ error: 'Email is required' });

        // Find or check user
        var userResult = await db.query('SELECT id, name, email FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found. They need a CardFlow account first.' });
        }

        var userId = userResult.rows[0].id;

        // Check if already an exhibitor
        var existing = await db.query(
            'SELECT id FROM event_exhibitors WHERE event_id = $1 AND user_id = $2',
            [req.params.id, userId]
        );
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'User is already an exhibitor for this event' });
        }

        var result = await db.query(
            `INSERT INTO event_exhibitors (event_id, user_id, company_name, booth_number, booth_size, category, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [
                req.params.id, userId,
                req.body.company_name || userResult.rows[0].name,
                req.body.booth_number || null,
                req.body.booth_size || null,
                req.body.category || null,
                req.body.auto_approve ? 'approved' : 'pending'
            ]
        );

        // Send invitation email (background)
        var setupUrl = (process.env.BASE_URL || 'https://card.cardflow.cloud') + '/booth-setup/' + req.params.id;
        sendExhibitorInvite(email, event.name, req.user.username, setupUrl).catch(function(e) {
            console.error('Invite email error:', e.message);
        });

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Invite exhibitor error:', err);
        res.status(500).json({ error: 'Failed to invite exhibitor' });
    }
});

// GET /api/events/:id/exhibitors — list exhibitors (organizer view)
router.get('/:id/exhibitors', async function (req, res) {
    try {
        var event = await requireOrganizer(req, res);
        if (!event) return;

        var result = await db.query(
            `SELECT ex.*, u.name as user_name, u.email as user_email, u.username, u.photo as user_photo
             FROM event_exhibitors ex
             JOIN users u ON u.id = ex.user_id
             WHERE ex.event_id = $1
             ORDER BY ex.created_at DESC`,
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('List exhibitors error:', err);
        res.status(500).json({ error: 'Failed to load exhibitors' });
    }
});

// PATCH /api/events/:id/exhibitors/:exhibitorId — update exhibitor (approve/reject, assign booth)
router.patch('/:id/exhibitors/:exhibitorId', async function (req, res) {
    try {
        var event = await requireOrganizer(req, res);
        if (!event) return;

        var b = req.body;

        // Validate exhibitor status against allowed values
        var VALID_EXHIBITOR_STATUSES = ['pending', 'approved', 'rejected'];
        if (b.status !== undefined && !VALID_EXHIBITOR_STATUSES.includes(b.status)) {
            return res.status(400).json({ error: 'Invalid status. Allowed: ' + VALID_EXHIBITOR_STATUSES.join(', ') });
        }

        var fields = [];
        var values = [];
        var idx = 1;

        var allowed = ['booth_number', 'booth_size', 'category', 'status'];
        allowed.forEach(function (field) {
            if (b[field] !== undefined) {
                fields.push(field + ' = $' + idx);
                values.push(b[field]);
                idx++;
            }
        });

        if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

        values.push(parseInt(req.params.exhibitorId));
        values.push(req.params.id);

        var result = await db.query(
            'UPDATE event_exhibitors SET ' + fields.join(', ') + ' WHERE id = $' + idx + ' AND event_id = $' + (idx + 1) + ' RETURNING *',
            values
        );

        if (result.rows.length === 0) return res.status(404).json({ error: 'Exhibitor not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update exhibitor error:', err);
        res.status(500).json({ error: 'Failed to update exhibitor' });
    }
});

// DELETE /api/events/:id/exhibitors/:exhibitorId — remove exhibitor
router.delete('/:id/exhibitors/:exhibitorId', async function (req, res) {
    try {
        var event = await requireOrganizer(req, res);
        if (!event) return;

        await db.query('DELETE FROM event_exhibitors WHERE id = $1 AND event_id = $2',
            [parseInt(req.params.exhibitorId), req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Remove exhibitor error:', err);
        res.status(500).json({ error: 'Failed to remove exhibitor' });
    }
});

// ── Attendee Management (Organizer) ──

// GET /api/events/:id/attendees — list attendees
router.get('/:id/attendees', async function (req, res) {
    try {
        var event = await requireOrganizer(req, res);
        if (!event) return;

        var search = req.query.search || '';
        var sql = `SELECT * FROM event_attendees WHERE event_id = $1`;
        var params = [req.params.id];

        if (search) {
            sql += ` AND (name ILIKE $2 OR email ILIKE $2 OR company ILIKE $2 OR badge_code ILIKE $2)`;
            params.push('%' + search + '%');
        }

        sql += ' ORDER BY registered_at DESC';

        var result = await db.query(sql, params);
        res.json(result.rows);
    } catch (err) {
        console.error('List attendees error:', err);
        res.status(500).json({ error: 'Failed to load attendees' });
    }
});

// GET /api/events/:id/attendees/export — CSV export
router.get('/:id/attendees/export', async function (req, res) {
    try {
        var event = await requireOrganizer(req, res);
        if (!event) return;

        var result = await db.query(
            'SELECT name, email, phone, company, title, badge_code, registered_at, checked_in_at FROM event_attendees WHERE event_id = $1 ORDER BY registered_at',
            [req.params.id]
        );

        var csv = 'Name,Email,Phone,Company,Title,Badge Code,Registered,Checked In\n';
        result.rows.forEach(function (r) {
            csv += [r.name, r.email, r.phone, r.company, r.title, r.badge_code,
                r.registered_at ? new Date(r.registered_at).toISOString() : '',
                r.checked_in_at ? new Date(r.checked_in_at).toISOString() : ''
            ].map(csvSafe).join(',') + '\n';
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="attendees-' + event.slug + '.csv"');
        res.send(csv);
    } catch (err) {
        console.error('Export attendees error:', err);
        res.status(500).json({ error: 'Failed to export attendees' });
    }
});

// ── Event Analytics (Organizer) ──

// GET /api/events/:id/analytics — event-wide stats
router.get('/:id/analytics', async function (req, res) {
    try {
        var event = await requireOrganizer(req, res);
        if (!event) return;

        var stats = await db.query(
            `SELECT
                (SELECT COUNT(*) FROM event_attendees WHERE event_id = $1) as total_registrations,
                (SELECT COUNT(*) FROM event_attendees WHERE event_id = $1 AND checked_in_at IS NOT NULL) as total_checkins,
                (SELECT COUNT(*) FROM booth_visits WHERE event_id = $1) as total_booth_visits,
                (SELECT COUNT(*) FROM event_exhibitors WHERE event_id = $1 AND status = 'approved') as total_exhibitors`,
            [req.params.id]
        );

        // Top exhibitors by booth visits
        var topExhibitors = await db.query(
            `SELECT ex.company_name, ex.booth_number, COUNT(bv.id) as visit_count
             FROM event_exhibitors ex
             LEFT JOIN booth_visits bv ON bv.exhibitor_id = ex.id
             WHERE ex.event_id = $1 AND ex.status = 'approved'
             GROUP BY ex.id, ex.company_name, ex.booth_number
             ORDER BY visit_count DESC
             LIMIT 10`,
            [req.params.id]
        );

        // Hourly traffic (booth visits grouped by hour)
        var hourlyTraffic = await db.query(
            `SELECT date_trunc('hour', created_at) as hour, COUNT(*) as visits
             FROM booth_visits WHERE event_id = $1
             GROUP BY hour ORDER BY hour`,
            [req.params.id]
        );

        // Category breakdown
        var categories = await db.query(
            `SELECT ex.category, COUNT(bv.id) as visit_count
             FROM event_exhibitors ex
             LEFT JOIN booth_visits bv ON bv.exhibitor_id = ex.id
             WHERE ex.event_id = $1 AND ex.category IS NOT NULL
             GROUP BY ex.category ORDER BY visit_count DESC`,
            [req.params.id]
        );

        res.json({
            overview: stats.rows[0],
            top_exhibitors: topExhibitors.rows,
            hourly_traffic: hourlyTraffic.rows,
            categories: categories.rows
        });
    } catch (err) {
        console.error('Event analytics error:', err);
        res.status(500).json({ error: 'Failed to load analytics' });
    }
});

// ── Check-in (Organizer) ──

// POST /api/events/:id/checkin — check in attendee (organizer scans badge at entrance)
router.post('/:id/checkin', async function (req, res) {
    try {
        var event = await requireOrganizer(req, res);
        if (!event) return;

        var badgeCode = (req.body.badge_code || '').trim().toUpperCase();
        if (!badgeCode) return res.status(400).json({ error: 'badge_code is required' });

        var result = await db.query(
            'UPDATE event_attendees SET checked_in_at = NOW() WHERE event_id = $1 AND badge_code = $2 AND checked_in_at IS NULL RETURNING *',
            [req.params.id, badgeCode]
        );

        if (result.rows.length === 0) {
            // Check if already checked in
            var existing = await db.query(
                'SELECT checked_in_at FROM event_attendees WHERE event_id = $1 AND badge_code = $2',
                [req.params.id, badgeCode]
            );
            if (existing.rows.length > 0 && existing.rows[0].checked_in_at) {
                return res.json({ already_checked_in: true, attendee: existing.rows[0] });
            }
            return res.status(404).json({ error: 'Badge not found for this event' });
        }

        res.json({ success: true, attendee: result.rows[0] });
    } catch (err) {
        console.error('Check-in error:', err);
        res.status(500).json({ error: 'Failed to check in' });
    }
});

module.exports = router;
