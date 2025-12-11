const nodemailer = require('nodemailer');
const pool = require('../config/database');
require('dotenv').config();

// Create Hostinger transporter
const createHostingerTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.HOSTINGER_SMTP_HOST || 'smtp.hostinger.com',
    port: process.env.HOSTINGER_SMTP_PORT || 587,
    secure: false,
    auth: {
      user: process.env.HOSTINGER_SMTP_USER,
      pass: process.env.HOSTINGER_SMTP_PASS
    },
    tls: {
      rejectUnauthorized: false
    }
  });
};

// Create Brevo transporter
const createBrevoTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com',
    port: process.env.BREVO_SMTP_PORT || 587,
    secure: false,
    auth: {
      user: process.env.BREVO_SMTP_USER,
      pass: process.env.BREVO_SMTP_PASS
    },
    tls: {
      rejectUnauthorized: false
    }
  });
};

/**
 * Sends an email using a specific provider or attempts failover if provider is null.
 * The caller is responsible for checking daily limits and updating the state.
 * @param {string} to - Recipient email.
 * @param {string} subject - Email subject.
 * @param {string} htmlContent - Email HTML content.
 * @param {string} [textContent=null] - Email plain text content.
 * @param {string} [provider=null] - 'hostinger' or 'brevo'. If null, attempts Hostinger then Brevo.
 * @param {number} [campaignId=null] - ID of the automation campaign.
 * @returns {Promise<{success: boolean, messageId: string, provider: string, timestamp: Date}>}
 */
async function sendEmail(to, subject, htmlContent, textContent = null, provider = null, campaignId = null) {
  try {
    let lastError = null;
    const providers = provider ? [provider] : ['hostinger', 'brevo']; // Default failover for test emails

    for (const p of providers) {
      try {
        let transporter, fromName, fromEmail;
        if (p === 'hostinger') {
          transporter = createHostingerTransporter();
          fromName = process.env.HOSTINGER_FROM_NAME;
          fromEmail = process.env.HOSTINGER_FROM_EMAIL;
        } else if (p === 'brevo') {
          transporter = createBrevoTransporter();
          fromName = process.env.BREVO_FROM_NAME;
          fromEmail = process.env.BREVO_FROM_EMAIL;
        } else {
          continue;
        }

        const info = await transporter.sendMail({
          from: `${fromName} <${fromEmail}>`,
          to,
          subject,
          html: htmlContent,
          text: textContent || htmlContent.replace(/<[^>]*>/g, '')
        });

        // Log to database
        await logEmailSent(to, subject, p, info.messageId, campaignId);

        return {
          success: true,
          messageId: info.messageId,
          provider: p,
          timestamp: new Date()
        };
      } catch (err) {
        lastError = err;
        console.error(`${p} SMTP failed:`, err.message);
        if (provider) {
          // If a specific provider was requested, fail immediately
          break;
        }
        // Otherwise, continue to the next provider in the loop
      }
    }

    // All attempts failed
    await logEmailFailed(to, subject, lastError?.message || 'All email providers failed', campaignId);
    throw lastError || new Error('All email providers failed');

  } catch (error) {
    console.error('Email sending error:', error);
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

// Get email statistics
async function getEmailStats() {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.execute(
      `SELECT provider, COUNT(*) as count, status FROM email_logs 
       WHERE DATE(sent_at) = CURDATE() 
       GROUP BY provider, status`
    );
    connection.release();

    const stats = {
      hostinger: { sent: 0, failed: 0, limit: parseInt(process.env.HOSTINGER_DAILY_LIMIT || 1000) },
      brevo: { sent: 0, failed: 0, limit: parseInt(process.env.BREVO_DAILY_LIMIT || 300) },
    };

    for (const row of rows) {
      if (stats[row.provider]) {
        if (row.status === 'sent') {
          stats[row.provider].sent = row.count;
        } else if (row.status === 'failed') {
          stats[row.provider].failed = row.count;
        }
      }
    }

    return {
      today: new Date().toDateString(),
      hostinger: {
        ...stats.hostinger,
        remaining: Math.max(0, stats.hostinger.limit - stats.hostinger.sent)
      },
      brevo: {
        ...stats.brevo,
        remaining: Math.max(0, stats.brevo.limit - stats.brevo.sent)
      },
      logs: rows
    };
  } catch (err) {
    console.error('Error getting email stats:', err);
    return {
      error: err.message
    };
  }
}

module.exports = {
  sendEmail,
  getEmailStats,
};
