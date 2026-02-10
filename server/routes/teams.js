const express = require('express');
const db = require('../db');
const { verifyAuth } = require('../auth');
const email = require('../email');

const router = express.Router();
router.use(verifyAuth);

// GET /api/teams — get user's team
router.get('/', async function (req, res) {
    try {
        var uid = req.user.uid;
        // Check if user is in a team
        var membership = await db.query(
            'SELECT tm.team_id, tm.role, t.name, t.owner_id FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = $1',
            [uid]
        );
        if (membership.rows.length === 0) {
            return res.json({ team: null });
        }
        var team = membership.rows[0];
        var isAdmin = team.role === 'admin' || team.owner_id === uid;

        // Get members
        var members = await db.query(
            "SELECT tm.user_id, tm.role, tm.joined_at, u.name, u.email, u.username, u.plan FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = $1 ORDER BY tm.joined_at",
            [team.team_id]
        );

        // Get pending invitations (admin only)
        var invitations = [];
        if (isAdmin) {
            var invResult = await db.query(
                "SELECT id, email, status, created_at FROM team_invitations WHERE team_id = $1 AND status = 'pending' ORDER BY created_at DESC",
                [team.team_id]
            );
            invitations = invResult.rows;
        }

        // Get team-wide stats (admin only)
        var stats = null;
        if (isAdmin) {
            var memberIds = members.rows.map(function (m) { return m.user_id; });
            var totalCards = await db.query('SELECT count(*) FROM cards WHERE user_id = ANY($1)', [memberIds]);
            var totalLeads = await db.query('SELECT count(*) FROM leads WHERE user_id = ANY($1)', [memberIds]);
            var weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            var weekLeads = await db.query('SELECT count(*) FROM leads WHERE user_id = ANY($1) AND created_at >= $2', [memberIds, weekAgo]);
            stats = {
                totalCards: parseInt(totalCards.rows[0].count),
                totalLeads: parseInt(totalLeads.rows[0].count),
                weekLeads: parseInt(weekLeads.rows[0].count),
                totalMembers: members.rows.length
            };
        }

        res.json({
            team: {
                id: team.team_id,
                name: team.name,
                ownerId: team.owner_id,
                role: team.role,
                isAdmin: isAdmin,
                members: members.rows,
                invitations: invitations,
                stats: stats
            }
        });
    } catch (err) {
        console.error('Team fetch error:', err);
        res.status(500).json({ error: 'Failed to load team' });
    }
});

// POST /api/teams — create a team (Business plan only)
router.post('/', async function (req, res) {
    try {
        var uid = req.user.uid;
        var name = (req.body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Team name is required' });

        // Check plan
        var userResult = await db.query('SELECT plan FROM users WHERE id = $1', [uid]);
        if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        if (userResult.rows[0].plan !== 'business') {
            return res.status(403).json({ error: 'Business plan required to create a team' });
        }

        // Check not already in a team
        var existing = await db.query('SELECT team_id FROM team_members WHERE user_id = $1', [uid]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'You are already in a team' });
        }

        // Create team
        var teamResult = await db.query(
            'INSERT INTO teams (name, owner_id) VALUES ($1, $2) RETURNING id',
            [name, uid]
        );
        var teamId = teamResult.rows[0].id;

        // Add creator as admin member
        await db.query(
            "INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')",
            [teamId, uid]
        );

        // Update user's team_id
        await db.query('UPDATE users SET team_id = $1 WHERE id = $2', [teamId, uid]);

        res.json({ success: true, teamId: teamId });
    } catch (err) {
        console.error('Team create error:', err);
        res.status(500).json({ error: 'Failed to create team' });
    }
});

// PATCH /api/teams — update team name (admin only)
router.patch('/', async function (req, res) {
    try {
        var uid = req.user.uid;
        var name = (req.body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Team name is required' });

        var team = await getAdminTeam(uid);
        if (!team) return res.status(403).json({ error: 'Not a team admin' });

        await db.query('UPDATE teams SET name = $1, updated_at = NOW() WHERE id = $2', [name, team.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update team' });
    }
});

// POST /api/teams/invite — invite member by email (admin only)
router.post('/invite', async function (req, res) {
    try {
        var uid = req.user.uid;
        var inviteEmail = (req.body.email || '').trim().toLowerCase();
        if (!inviteEmail) return res.status(400).json({ error: 'Email is required' });

        var team = await getAdminTeam(uid);
        if (!team) return res.status(403).json({ error: 'Not a team admin' });

        // Check team size limit (max 50 members)
        var memberCount = await db.query('SELECT count(*) FROM team_members WHERE team_id = $1', [team.id]);
        if (parseInt(memberCount.rows[0].count) >= 50) {
            return res.status(400).json({ error: 'Team is at maximum capacity (50 members)' });
        }

        // Check if already a member
        var existingUser = await db.query('SELECT id FROM users WHERE email = $1', [inviteEmail]);
        if (existingUser.rows.length > 0) {
            var alreadyMember = await db.query(
                'SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2',
                [team.id, existingUser.rows[0].id]
            );
            if (alreadyMember.rows.length > 0) {
                return res.status(409).json({ error: 'User is already a team member' });
            }
        }

        // Create invitation
        await db.query(
            "INSERT INTO team_invitations (team_id, email, invited_by) VALUES ($1, $2, $3) ON CONFLICT (team_id, email) DO UPDATE SET status = 'pending', created_at = NOW()",
            [team.id, inviteEmail, uid]
        );

        // Get inviter name
        var inviter = await db.query('SELECT name FROM users WHERE id = $1', [uid]);
        var inviterName = (inviter.rows[0] && inviter.rows[0].name) || 'Your team admin';

        // If user exists, add them directly
        if (existingUser.rows.length > 0) {
            var inviteeId = existingUser.rows[0].id;
            await db.query(
                "INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
                [team.id, inviteeId]
            );
            await db.query('UPDATE users SET team_id = $1 WHERE id = $2', [team.id, inviteeId]);
            await db.query(
                "UPDATE team_invitations SET status = 'accepted' WHERE team_id = $1 AND email = $2",
                [team.id, inviteEmail]
            );
            res.json({ success: true, status: 'added' });
        } else {
            // Send invitation email
            var BASE_URL = process.env.BASE_URL || 'https://card.cardflow.cloud';
            email.sendEmail(
                inviteEmail,
                inviterName + ' invited you to join ' + team.name + ' on CardFlow',
                email.sendEmail ? undefined : undefined
            ).catch(function () {});
            res.json({ success: true, status: 'invited' });
        }
    } catch (err) {
        console.error('Team invite error:', err);
        res.status(500).json({ error: 'Failed to send invitation' });
    }
});

// DELETE /api/teams/members/:userId — remove member (admin only)
router.delete('/members/:userId', async function (req, res) {
    try {
        var uid = req.user.uid;
        var targetId = req.params.userId;

        var team = await getAdminTeam(uid);
        if (!team) return res.status(403).json({ error: 'Not a team admin' });

        // Can't remove the owner
        if (targetId === team.owner_id) {
            return res.status(400).json({ error: 'Cannot remove team owner' });
        }

        await db.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [team.id, targetId]);
        await db.query('UPDATE users SET team_id = NULL WHERE id = $1 AND team_id = $2', [targetId, team.id]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove member' });
    }
});

// POST /api/teams/leave — leave team (non-admin)
router.post('/leave', async function (req, res) {
    try {
        var uid = req.user.uid;
        var membership = await db.query(
            'SELECT tm.team_id, t.owner_id FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = $1',
            [uid]
        );
        if (membership.rows.length === 0) return res.status(404).json({ error: 'Not in a team' });

        var m = membership.rows[0];
        if (m.owner_id === uid) {
            return res.status(400).json({ error: 'Team owner cannot leave. Transfer ownership or delete the team.' });
        }

        await db.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [m.team_id, uid]);
        await db.query('UPDATE users SET team_id = NULL WHERE id = $1', [uid]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to leave team' });
    }
});

// DELETE /api/teams — delete team (owner only)
router.delete('/', async function (req, res) {
    try {
        var uid = req.user.uid;
        var teamResult = await db.query('SELECT id FROM teams WHERE owner_id = $1', [uid]);
        if (teamResult.rows.length === 0) return res.status(403).json({ error: 'Not a team owner' });

        var teamId = teamResult.rows[0].id;

        // Clear team_id from all members
        await db.query('UPDATE users SET team_id = NULL WHERE team_id = $1', [teamId]);
        // Delete team (cascades to members and invitations)
        await db.query('DELETE FROM teams WHERE id = $1', [teamId]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete team' });
    }
});

// GET /api/teams/members/:userId/stats — get member stats (admin only)
router.get('/members/:userId/stats', async function (req, res) {
    try {
        var uid = req.user.uid;
        var targetId = req.params.userId;

        var team = await getAdminTeam(uid);
        if (!team) return res.status(403).json({ error: 'Not a team admin' });

        // Verify target is a team member
        var isMember = await db.query(
            'SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2',
            [team.id, targetId]
        );
        if (isMember.rows.length === 0) return res.status(404).json({ error: 'Not a team member' });

        var cards = await db.query('SELECT count(*) FROM cards WHERE user_id = $1', [targetId]);
        var leads = await db.query('SELECT count(*) FROM leads WHERE user_id = $1', [targetId]);
        var weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        var weekLeads = await db.query('SELECT count(*) FROM leads WHERE user_id = $1 AND created_at >= $2', [targetId, weekAgo]);

        res.json({
            cards: parseInt(cards.rows[0].count),
            totalLeads: parseInt(leads.rows[0].count),
            weekLeads: parseInt(weekLeads.rows[0].count)
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load stats' });
    }
});

// Helper: get team where user is admin
async function getAdminTeam(uid) {
    var result = await db.query(
        "SELECT t.id, t.name, t.owner_id FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = $1 AND (tm.role = 'admin' OR t.owner_id = $1)",
        [uid]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
}

module.exports = router;
