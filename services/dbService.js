const pool = require('../config/database');

// ==================== USER QUERIES ====================

/**
 * Finds a user or admin by email address.
 * @param {string} email - The email address to search for.
 * @returns {Promise<{id: number, email: string, name: string, type: 'user'|'admin'}|null>}
 */
async function findUserByEmail(email) {
    const connection = await pool.getConnection();
    try {
        // Check users table
        let [users] = await connection.execute(
            'SELECT id, email, username as name FROM users WHERE email = ?',
            [email]
        );

        if (users.length > 0) {
            return { ...users[0], type: 'user' };
        }

        // Check admins table
        let [admins] = await connection.execute(
            'SELECT id, email, name FROM admins WHERE email = ?',
            [email]
        );

        if (admins.length > 0) {
            return { ...admins[0], type: 'admin' };
        }

        return null;
    } finally {
        connection.release();
    }
}

/**
 * Fetches a batch of users for a campaign, starting from the last sent user ID.
 * @param {number} lastUserId - The ID of the last user sent to.
 * @param {number} limit - The number of users to fetch.
 * @returns {Promise<Array<{id: number, email: string}>>}
 */
async function getUsersBatch(lastUserId, limit) {
    const connection = await pool.getConnection();
    try {
        // This is the core logic for resuming: fetch users whose ID is greater than the last sent ID.
        const [users] = await connection.execute(
            'SELECT id, email FROM users WHERE id > ? ORDER BY id ASC LIMIT ?',
            [lastUserId, limit]
        );
        return users;
    } finally {
        connection.release();
    }
}

/**
 * Searches and fetches users with pagination. (For selective sending UI)
 * @param {string} query - Search query for username or email.
 * @param {number} limit - Number of users to fetch.
 * @param {number} offset - Offset for pagination.
 * @returns {Promise<Array<{id: number, email: string, username: string}>>}
 */
async function searchUsers(query, limit, offset) {
    const connection = await pool.getConnection();
    try {
        let sql = 'SELECT id, email, username FROM users';
        const params = [];

        if (query) {
            sql += ' WHERE username LIKE ? OR email LIKE ?';
            params.push(`%${query}%`, `%${query}%`);
        }

        sql += ' ORDER BY id ASC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const [users] = await connection.execute(sql, params);
        return users;
    } finally {
        connection.release();
    }
}

/**
 * Gets the total count of users, optionally filtered by a search query.
 * @param {string} [query] - Optional search query for username or email.
 * @returns {Promise<number>}
 */
async function getTotalUserCount(query) {
    const connection = await pool.getConnection();
    try {
        let sql = 'SELECT COUNT(id) as count FROM users';
        const params = [];

        if (query) {
            sql += ' WHERE username LIKE ? OR email LIKE ?';
            params.push(`%${query}%`, `%${query}%`);
        }

        const [rows] = await connection.execute(sql, params);
        return rows[0].count;
    } finally {
        connection.release();
    }
}
// ==================== EMAIL LOGS QUERIES ====================

/**
 * Checks if a user has already received an email for a specific campaign.
 * @param {number} campaignId - The ID of the automation campaign.
 * @param {string} email - The email address of the recipient.
 * @returns {Promise<boolean>} - True if an email log exists, false otherwise.
 */
async function hasUserReceivedEmail(campaignId, email) {
    const connection = await pool.getConnection();
    try {
        const [rows] = await connection.execute(
            'SELECT 1 FROM email_logs WHERE campaign_id = ? AND recipient = ? LIMIT 1',
            [campaignId, email]
        );
        return rows.length > 0;
    } finally {
        connection.release();
    }
}
// ==================== AUTOMATION STATE QUERIES ====================

/**
 * Gets the current state of an automation campaign.
 */
async function getAutomationState(campaignId) {
    const connection = await pool.getConnection();
    try {
        const [rows] = await connection.execute(
            'SELECT * FROM automation_state WHERE campaign_id = ?',
            [campaignId]
        );
        return rows.length > 0 ? rows[0] : null;
    } finally {
        connection.release();
    }
}

/**
 * Creates or updates the state of an automation campaign.
 */
async function updateAutomationState(campaignId, lastUserId, emailsSentToday, status, startTime = null, lastRunTime = null, istDate = null) { // <-- MODIFIED LINE
    const connection = await pool.getConnection();
    try {
        // Use the IST date passed from automationService for consistency
        const today = istDate; // <-- MODIFIED LINE
        const now = lastRunTime; // lastRunTime is already IST formatted // <-- MODIFIED LINE
        
        await connection.execute(
            `INSERT INTO automation_state 
             (campaign_id, last_user_id, emails_sent_today, last_reset_date, status, start_time, last_run_time)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
             last_user_id = ?, 
             emails_sent_today = ?, 
             last_reset_date = ?, 
             status = ?,
             last_run_time = ?`,
            [
                campaignId, lastUserId, emailsSentToday, today, status, startTime, now, // <-- MODIFIED LINE
                lastUserId, emailsSentToday, today, status, now // <-- MODIFIED LINE
            ]
        );
    } finally {
	        connection.release();
	    }
	}

/**
 * Gets the details of an automation campaign.
 */
async function getAutomationDetails(campaignId) {
    const connection = await pool.getConnection();
    try {
        const [rows] = await connection.execute(
            'SELECT id, enabled FROM automations WHERE id = ?',
            [campaignId]
        );
        return rows.length > 0 ? rows[0] : null;
    } finally {
        connection.release();
    }
}

module.exports = {
    findUserByEmail,
    getUsersBatch,
    searchUsers,
    getTotalUserCount,
    getAutomationState,
    updateAutomationState,
    hasUserReceivedEmail,
    getAutomationDetails,
};
