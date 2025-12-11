const nodemailer = require('nodemailer');
const pool = require('../config/database');
require('dotenv').config();

// Global array to hold Brevo account configurations and a counter for rotation
let brevoAccounts = [];
let accountIndex = 0;

// Function to load accounts from environment variables
const loadBrevoAccounts = () => {
    brevoAccounts = [];
    const host = process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com';
    const port = process.env.BREVO_SMTP_PORT || 587;
    
    // Loop through environment variables to find all accounts
    for (let i = 1; ; i++) {
        const user = process.env[`BREVO_${i}_USER`];
        const pass = process.env[`BREVO_${i}_PASS`];
        const fromName = process.env[`BREVO_${i}_FROM_NAME`];
        const fromEmail = process.env[`BREVO_${i}_FROM_EMAIL`];
        const dailyLimit = parseInt(process.env[`BREVO_${i}_DAILY_LIMIT`] || 300);

        if (!user || !pass) {
            // Stop when a numbered account is missing
            break;
        }

        const transporter = nodemailer.createTransport({
            host,
            port,
            secure: false,
            auth: { user, pass },
            tls: { rejectUnauthorized: false }
        });

        brevoAccounts.push({
            id: i,
            provider: `brevo_${i}`, // Unique identifier for logging
            transporter,
            fromName: fromName || 'Animerulz',
            fromEmail: fromEmail || user,
            dailyLimit
        });
    }

    if (brevoAccounts.length === 0) {
        console.error("No Brevo accounts loaded from environment variables. Email sending will fail.");
    } else {
        console.log(`Loaded ${brevoAccounts.length} Brevo accounts.`);
    }
};

// Load accounts on startup
loadBrevoAccounts();

// Function to get the next account in a round-robin fashion
const getNextBrevoAccount = () => {
    if (brevoAccounts.length === 0) {
        return null;
    }
    const account = brevoAccounts[accountIndex];
    accountIndex = (accountIndex + 1) % brevoAccounts.length; // Round-robin
    return account;
};

/**
 * Sends an email using the next available Brevo account.
 * @param {string} to - Recipient email.
 * @param {string} subject - Email subject.
 * @param {string} htmlContent - Email HTML content.
 * @param {string} [textContent=null] - Email plain text content.
 * @param {number} [campaignId=null] - ID of the automation campaign.
 * @returns {Promise<{success: boolean, messageId: string, provider: string, timestamp: Date}>}
 */
async function sendEmail(to, subject, htmlContent, textContent = null, campaignId = null) {
    try {
        const account = getNextBrevoAccount();

        if (!account) {
            throw new Error('No Brevo accounts are configured or loaded.');
        }

        const info = await account.transporter.sendMail({
            from: `${account.fromName} <${account.fromEmail}>`,
            to,
            subject,
            html: htmlContent,
            text: textContent || htmlContent.replace(/<[^>]*>/g, '')
        });

        // Log to database using the unique provider ID (e.g., brevo_1)
        await logEmailSent(to, subject, account.provider, info.messageId, campaignId);

        return {
            success: true,
            messageId: info.messageId,
            provider: account.provider,
            timestamp: new Date()
        };

    } catch (error) {
        console.error('Email sending error:', error);
        await logEmailFailed(to, subject, error?.message || 'Brevo account failed', campaignId);
        throw error;
    }
}

// Log successful email
async function logEmailSent(to, subject, provider, messageId, campaignId = null) {
    try {
        const connection = await pool.getConnection();
        await connection.execute(
            `INSERT INTO email_logs (campaign_id, recipient, subject, provider, message_id, status, sent_at) 
             VALUES (?, ?, ?, ?, ?, 'sent', NOW())`,
            [campaignId, to, subject, provider, messageId]
        );
        connection.release();
    } catch (err) {
        console.error('Error logging email:', err);
    }
}

// Log failed email
async function logEmailFailed(to, subject, error, campaignId = null) {
    try {
        const connection = await pool.getConnection();
        await connection.execute(
            `INSERT INTO email_logs (campaign_id, recipient, subject, status, error_message, sent_at) 
             VALUES (?, ?, ?, 'failed', ?, NOW())`,
            [campaignId, to, subject, error]
        );
        connection.release();
    } catch (err) {
        console.error('Error logging failed email:', err);
    }
}

// Get email statistics for all Brevo accounts
async function getEmailStats() {
    try {
        const connection = await pool.getConnection();
        
        // Get today's sent counts for all brevo_X providers
        const [rows] = await connection.execute(
            `SELECT provider, COUNT(*) as count, status FROM email_logs 
             WHERE DATE(sent_at) = CURDATE() AND provider LIKE 'brevo_%'
             GROUP BY provider, status`
        );
        connection.release();

        const stats = {};
        
        // Initialize stats for all loaded accounts
        for (const account of brevoAccounts) {
            stats[account.provider] = {
                sent: 0,
                failed: 0,
                limit: account.dailyLimit,
                fromEmail: account.fromEmail
            };
        }

        // Populate sent/failed counts from the database
        for (const row of rows) {
            if (stats[row.provider]) {
                if (row.status === 'sent') {
                    stats[row.provider].sent = row.count;
                } else if (row.status === 'failed') {
                    stats[row.provider].failed = row.count;
                }
            }
        }

        // Calculate remaining and structure the final output
        const finalStats = {
            today: new Date().toDateString(),
            totalRemaining: 0,
            accounts: {}
        };

        for (const provider in stats) {
            const accountStats = stats[provider];
            accountStats.remaining = Math.max(0, accountStats.limit - accountStats.sent);
            finalStats.totalRemaining += accountStats.remaining;
            finalStats.accounts[provider] = accountStats;
        }

        return finalStats;

    } catch (err) {
        console.error('Error getting email stats:', err);
        return { error: err.message };
    }
}

module.exports = {
    sendEmail,
    getEmailStats,
    loadBrevoAccounts // Export this in case it needs to be reloaded
};
