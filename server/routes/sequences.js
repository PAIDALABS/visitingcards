var express = require('express');
var db = require('../db');
var { verifyAuth, requireNotSuspended } = require('../auth');

var router = express.Router();
router.use(verifyAuth);
router.use(requireNotSuspended);

var SEQ_LIMITS = { free: 0, pro: 3, business: -1 };
var MAX_STEPS = 10;
var MAX_SUBJECT = 200;
var MAX_BODY = 5000;

function validateSteps(steps) {
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) return false;
    for (var i = 0; i < steps.length; i++) {
        var s = steps[i];
        if (typeof s.delay_days !== 'number' || s.delay_days < 0) return false;
        if (!s.subject || s.subject.length > MAX_SUBJECT) return false;
        if (!s.body || s.body.length > MAX_BODY) return false;
        if (i > 0 && s.delay_days < steps[i - 1].delay_days) return false;
    }
    return true;
}

// GET /api/sequences — list with enrollment stats
router.get('/', async function (req, res) {
    try {
        var seqs = await db.query(
            'SELECT id, name, steps, active, created_at FROM sequences WHERE user_id = $1 ORDER BY created_at DESC',
            [req.user.uid]
        );
        var stats = await db.query(
            "SELECT sequence_id, COUNT(*) as total, " +
            "COUNT(*) FILTER (WHERE status = 'active') as active_count, " +
            "COUNT(*) FILTER (WHERE status = 'completed') as completed_count " +
            "FROM sequence_enrollments WHERE user_id = $1 GROUP BY sequence_id",
            [req.user.uid]
        );
        var statsMap = {};
        stats.rows.forEach(function (r) { statsMap[r.sequence_id] = r; });
        var result = seqs.rows.map(function (s) {
            var st = statsMap[s.id] || { total: 0, active_count: 0, completed_count: 0 };
            return {
                id: s.id, name: s.name, steps: s.steps, active: s.active,
                created_at: s.created_at,
                stats: { total: parseInt(st.total), active: parseInt(st.active_count), completed: parseInt(st.completed_count) }
            };
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load sequences' });
    }
});

// POST /api/sequences — create
router.post('/', async function (req, res) {
    try {
        var userResult = await db.query('SELECT plan FROM users WHERE id = $1', [req.user.uid]);
        var plan = (userResult.rows.length > 0 && userResult.rows[0].plan) || 'free';
        var limit = SEQ_LIMITS[plan] !== undefined ? SEQ_LIMITS[plan] : 0;
        if (limit === 0) return res.status(403).json({ error: 'upgrade', message: 'Email sequences are available on Pro and Business plans.' });
        if (limit !== -1) {
            var countResult = await db.query('SELECT COUNT(*) as cnt FROM sequences WHERE user_id = $1', [req.user.uid]);
            if (parseInt(countResult.rows[0].cnt) >= limit) {
                return res.status(403).json({ error: 'limit', message: 'You can create up to ' + limit + ' sequences on your plan.' });
            }
        }
        var name = (req.body.name || '').trim();
        if (!name || name.length > 100) return res.status(400).json({ error: 'Name is required (max 100 chars)' });
        if (!validateSteps(req.body.steps)) return res.status(400).json({ error: 'Invalid steps' });
        var result = await db.query(
            'INSERT INTO sequences (user_id, name, steps) VALUES ($1, $2, $3) RETURNING id',
            [req.user.uid, name, JSON.stringify(req.body.steps)]
        );
        res.json({ id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create sequence' });
    }
});

// PUT /api/sequences/:id — update
router.put('/:id', async function (req, res) {
    try {
        var existing = await db.query('SELECT id FROM sequences WHERE id = $1 AND user_id = $2', [req.params.id, req.user.uid]);
        if (existing.rows.length === 0) return res.status(404).json({ error: 'Sequence not found' });
        var name = (req.body.name || '').trim();
        if (!name || name.length > 100) return res.status(400).json({ error: 'Name is required (max 100 chars)' });
        if (!validateSteps(req.body.steps)) return res.status(400).json({ error: 'Invalid steps' });
        await db.query(
            'UPDATE sequences SET name = $1, steps = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4',
            [name, JSON.stringify(req.body.steps), req.params.id, req.user.uid]
        );
        // Mark enrollments past new step count as completed
        var stepCount = req.body.steps.length;
        await db.query(
            "UPDATE sequence_enrollments SET status = 'completed' WHERE sequence_id = $1 AND user_id = $2 AND status = 'active' AND current_step >= $3",
            [req.params.id, req.user.uid, stepCount]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update sequence' });
    }
});

// DELETE /api/sequences/:id
router.delete('/:id', async function (req, res) {
    try {
        await db.query('DELETE FROM sequences WHERE id = $1 AND user_id = $2', [req.params.id, req.user.uid]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete sequence' });
    }
});

// PATCH /api/sequences/:id/toggle
router.patch('/:id/toggle', async function (req, res) {
    try {
        var seq = await db.query('SELECT active FROM sequences WHERE id = $1 AND user_id = $2', [req.params.id, req.user.uid]);
        if (seq.rows.length === 0) return res.status(404).json({ error: 'Sequence not found' });
        var newActive = !seq.rows[0].active;
        await db.query('UPDATE sequences SET active = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3', [newActive, req.params.id, req.user.uid]);
        if (!newActive) {
            await db.query("UPDATE sequence_enrollments SET status = 'paused' WHERE sequence_id = $1 AND user_id = $2 AND status = 'active'", [req.params.id, req.user.uid]);
        } else {
            // Resume paused enrollments and recompute next_send_at
            var paused = await db.query(
                "SELECT e.id, e.current_step, e.enrolled_at, s.steps FROM sequence_enrollments e " +
                "JOIN sequences s ON s.id = e.sequence_id WHERE e.sequence_id = $1 AND e.user_id = $2 AND e.status = 'paused'",
                [req.params.id, req.user.uid]
            );
            for (var i = 0; i < paused.rows.length; i++) {
                var row = paused.rows[i];
                var steps = row.steps;
                if (row.current_step >= steps.length) {
                    await db.query("UPDATE sequence_enrollments SET status = 'completed' WHERE id = $1", [row.id]);
                } else {
                    var delayDays = steps[row.current_step].delay_days;
                    var nextSend = new Date(Math.max(Date.now(), new Date(row.enrolled_at).getTime() + delayDays * 86400000));
                    await db.query("UPDATE sequence_enrollments SET status = 'active', next_send_at = $1 WHERE id = $2", [nextSend, row.id]);
                }
            }
        }
        res.json({ active: newActive });
    } catch (err) {
        res.status(500).json({ error: 'Failed to toggle sequence' });
    }
});

// POST /api/sequences/:id/enroll
router.post('/:id/enroll', async function (req, res) {
    try {
        var seq = await db.query('SELECT id, steps, active FROM sequences WHERE id = $1 AND user_id = $2', [req.params.id, req.user.uid]);
        if (seq.rows.length === 0) return res.status(404).json({ error: 'Sequence not found' });
        if (!seq.rows[0].active) return res.status(400).json({ error: 'Sequence is paused' });
        var leadId = req.body.leadId;
        if (!leadId) return res.status(400).json({ error: 'leadId required' });
        var lead = await db.query('SELECT data FROM leads WHERE user_id = $1 AND id = $2', [req.user.uid, leadId]);
        if (lead.rows.length === 0) return res.status(404).json({ error: 'Lead not found' });
        var leadData = lead.rows[0].data || {};
        var leadEmail = Array.isArray(leadData.email) ? leadData.email[0] : leadData.email;
        if (!leadEmail) return res.status(400).json({ error: 'Lead has no email address' });
        // Check not already enrolled
        var dup = await db.query(
            "SELECT id FROM sequence_enrollments WHERE sequence_id = $1 AND user_id = $2 AND lead_id = $3 AND status = 'active'",
            [req.params.id, req.user.uid, leadId]
        );
        if (dup.rows.length > 0) return res.status(409).json({ error: 'Lead already enrolled in this sequence' });
        var steps = seq.rows[0].steps;
        var delayMs = (steps[0] ? steps[0].delay_days : 0) * 86400000;
        var nextSend = new Date(Date.now() + delayMs);
        await db.query(
            'INSERT INTO sequence_enrollments (sequence_id, user_id, lead_id, next_send_at) VALUES ($1, $2, $3, $4)',
            [req.params.id, req.user.uid, leadId, nextSend]
        );
        res.json({ success: true });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Lead already enrolled' });
        res.status(500).json({ error: 'Failed to enroll lead' });
    }
});

// DELETE /api/sequences/enrollments/:id — stop enrollment
router.delete('/enrollments/:id', async function (req, res) {
    try {
        await db.query("DELETE FROM sequence_enrollments WHERE id = $1 AND user_id = $2", [req.params.id, req.user.uid]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove enrollment' });
    }
});

// GET /api/sequences/lead/:leadId — enrollments for a specific lead
router.get('/lead/:leadId', async function (req, res) {
    try {
        var result = await db.query(
            "SELECT e.id, e.sequence_id, e.current_step, e.status, e.enrolled_at, e.last_sent_at, " +
            "s.name as sequence_name, s.steps FROM sequence_enrollments e " +
            "JOIN sequences s ON s.id = e.sequence_id " +
            "WHERE e.user_id = $1 AND e.lead_id = $2 ORDER BY e.enrolled_at DESC",
            [req.user.uid, req.params.leadId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load enrollments' });
    }
});

module.exports = router;
