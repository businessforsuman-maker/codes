const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const { runAutomation, runAutomationForRecipients } = require('./services/automationService');
const pool = require('./config/database');
const { verifyToken, generateToken } = require('./middleware/auth');
const { findUserByEmail, searchUsers, getTotalUserCount } = require('./services/dbService');
const { sendEmail, getEmailStats, loadBrevoAccounts } = require('./services/emailService');
const { getAllTemplates, getTemplateById, renderTemplate } = require('./services/templates');

const app = express();
const PORT = process.env.PORT || 3016;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== SCHEDULER SETUP ====================
const scheduledJobs = new Map();

function scheduleAutomation(automationId, scheduleData, emailInterval = 10) {
  try {
    const { date, time, repeat } = scheduleData;
    
    // Combine date and time - ADD TIMEZONE OFFSET
    // User enters time in IST (UTC+5:30), convert to UTC
    const scheduleDateTime = new Date(`${date}T${time}:00+05:30`);
    
    console.log(`Scheduling automation ${automationId}:`);
    console.log(`- User entered: ${date} ${time} (IST)`);
    console.log(`- Converted to: ${scheduleDateTime.toISOString()} (UTC)`);
    console.log(`- Server time: ${new Date().toISOString()} (UTC)`);
    
    // If the date is in the past for "once" repeat, don't schedule
    if (repeat === 'once' && scheduleDateTime < new Date()) {
      console.log(`Schedule time is in the past (UTC), not scheduling.`);
      return;
    }
    
    const jobFunction = async () => {
      try {
        console.log(`Running scheduled automation ${automationId} at ${new Date()}`);
        
        // Get automation details
        const connection = await pool.getConnection();
        const [automations] = await connection.execute(
          'SELECT * FROM automations WHERE id = ? AND enabled = 1',
          [automationId]
        );
        connection.release();
        
        if (automations.length === 0) {
          console.log(`Automation ${automationId} not found or disabled, skipping.`);
          return;
        }
        
        const automation = automations[0];
        const recipients = automation.recipients ? JSON.parse(automation.recipients) : [];
        const interval = automation.email_interval || emailInterval;
        
        // Run the automation
        if (recipients.length > 0) {
          await runAutomationForRecipients(automationId, recipients, interval);
        } else {
          await runAutomation(automationId, 100, interval);
        }
        
        console.log(`Completed scheduled automation ${automationId}`);
        
        // Handle repeat schedules
        if (repeat !== 'once') {
          scheduleNextRecurringJob(automationId, scheduleData, repeat, emailInterval);
        } else {
          // For one-time schedules, disable after running
          const connection = await pool.getConnection();
          await connection.execute(
            'UPDATE automations SET enabled = 0 WHERE id = ?',
            [automationId]
          );
          connection.release();
          unscheduleAutomation(automationId);
        }
      } catch (err) {
        console.error(`Error running scheduled automation ${automationId}:`, err);
      }
    };
    
    // Schedule the job
    const timeout = scheduleDateTime.getTime() - Date.now();
    
    if (timeout > 0) {
      const jobId = setTimeout(jobFunction, timeout);
      scheduledJobs.set(automationId, { jobId, scheduleData, repeat });
      console.log(`Scheduled automation ${automationId} for ${scheduleDateTime}`);
    } else {
      console.log(`Schedule time for automation ${automationId} is in the past`);
    }
  } catch (err) {
    console.error(`Error scheduling automation ${automationId}:`, err);
  }
}

function scheduleNextRecurringJob(automationId, scheduleData, repeat, emailInterval) {
  try {
        // Calculate next date based on IST to avoid off-by-one errors // <-- MODIFIED BLOCK START
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const istOffset = 330 * 60000; // 5 hours 30 minutes in milliseconds
    let nextDate = new Date(utc + istOffset);
    // <-- MODIFIED BLOCK END
    
    switch (repeat) {
      case 'daily':
        nextDate.setDate(nextDate.getDate() + 1);
        break;
      case 'weekly':
        nextDate.setDate(nextDate.getDate() + 7);
        break;
      case 'monthly':
        nextDate.setMonth(nextDate.getMonth() + 1);
        break;
      default:
        return;
    }
    
    const nextScheduleData = {
      ...scheduleData,
      // Format to YYYY-MM-DD using IST components // <-- MODIFIED LINE
      date: nextDate.getFullYear() + '-' + String(nextDate.getMonth() + 1).padStart(2, '0') + '-' + String(nextDate.getDate()).padStart(2, '0') // <-- MODIFIED LINE
    };
    
    // Reschedule
    scheduleAutomation(automationId, nextScheduleData, emailInterval);
  } catch (err) {
    console.error(`Error scheduling next job for automation ${automationId}:`, err);
  }
}

function unscheduleAutomation(automationId) {
  try {
    const job = scheduledJobs.get(automationId);
    if (job) {
      clearTimeout(job.jobId);
      scheduledJobs.delete(automationId);
      console.log(`Unscheduled automation ${automationId}`);
    }
  } catch (err) {
    console.error(`Error unscheduling automation ${automationId}:`, err);
  }
}

// Load scheduled automations on server start
async function loadScheduledAutomations() {
  try {
    const connection = await pool.getConnection();
    const [automations] = await connection.execute(
      'SELECT id, schedule_data, email_interval FROM automations WHERE enabled = 1 AND trigger_type = "scheduled" AND schedule_data IS NOT NULL'
    );
    connection.release();
    
    for (const auto of automations) {
      try {
        const scheduleData = JSON.parse(auto.schedule_data);
        const emailInterval = auto.email_interval || 10;
        scheduleAutomation(auto.id, scheduleData, emailInterval);
      } catch (err) {
        console.error(`Error loading schedule for automation ${auto.id}:`, err);
      }
    }
  } catch (err) {
    console.error('Error loading scheduled automations:', err);
  }
}
// Reset all 'running' automations to 'pending' on server start // <-- ADDED BLOCK START
async function resetRunningAutomations() {
  try {
    const connection = await pool.getConnection();
    // Update the status in automation_state
    const [result] = await connection.execute(
      'UPDATE automation_state SET status = ? WHERE status = ?',
      ['pending', 'running']
    );
    connection.release();
    console.log(`Reset ${result.affectedRows} running automations to pending status.`);
  } catch (err) {
    console.error('Error resetting running automations:', err);
  }
}
// <-- ADDED BLOCK END
// ==================== AUTHENTICATION ROUTES ====================

// Admin Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const connection = await pool.getConnection();
    const [admins] = await connection.execute(
      'SELECT * FROM admins WHERE email = ?',
      [email]
    );
    connection.release();

    if (admins.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const admin = admins[0];
    const passwordMatch = await bcrypt.compare(password, admin.password);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken({ id: admin.id, email: admin.email });

    res.json({
      success: true,
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin Logout
app.post('/api/auth/logout', verifyToken, (req, res) => {
  res.json({ success: true, message: 'Logged out successfully' });
});

// Get current admin
app.get('/api/auth/me', verifyToken, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [admins] = await connection.execute(
      'SELECT id, email, name FROM admins WHERE id = ?',
      [req.user.id]
    );
    connection.release();

    if (admins.length === 0) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    res.json({ admin: admins[0] });
  } catch (err) {
    console.error('Error fetching admin:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== TEMPLATE ROUTES ====================

// Get all templates
app.get('/api/templates', verifyToken, (req, res) => {
  try {
    const templates = getAllTemplates();
    res.json({ templates });
  } catch (err) {
    console.error('Error fetching templates:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get template by ID
app.get('/api/templates/:id', verifyToken, (req, res) => {
  try {
    const template = getTemplateById(req.params.id);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    res.json({ template });
  } catch (err) {
    console.error('Error fetching template:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Preview template with variables
app.post('/api/templates/:id/preview', verifyToken, (req, res) => {
  try {
    const { variables } = req.body;
    const rendered = renderTemplate(req.params.id, variables || {});
    res.json({ preview: rendered });
  } catch (err) {
    console.error('Error rendering template:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== AUTOMATION ROUTES (UPDATED) ====================

// Create automation
app.post('/api/automations', verifyToken, async (req, res) => {
  try {
    const { 
      name, 
      template_id, 
      trigger_type, 
      recipients, 
      enabled,
      schedule_data,
      email_interval = 10 
    } = req.body;

    if (!name || !template_id || !trigger_type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate schedule data for scheduled automations
    if (trigger_type === 'scheduled') {
      if (!schedule_data || !schedule_data.date || !schedule_data.time) {
        return res.status(400).json({ error: 'Schedule date and time required for scheduled automations' });
      }
    }

    const connection = await pool.getConnection();
    const [result] = await connection.execute(
      `INSERT INTO automations (
        name, 
        template_id, 
        trigger_type, 
        recipients, 
        enabled, 
        schedule_data,
        email_interval,
        created_by, 
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        name, 
        template_id, 
        trigger_type, 
        JSON.stringify(recipients || []), 
        enabled ? 1 : 0,
        schedule_data ? JSON.stringify(schedule_data) : null,
        parseInt(email_interval),
        req.user.id
      ]
    );
    
    const automationId = result.insertId;
    connection.release();

    // Schedule the automation if it's enabled and scheduled
    if (enabled && trigger_type === 'scheduled' && schedule_data) {
      await scheduleAutomation(automationId, schedule_data, email_interval);
    }

    res.json({ 
      success: true, 
      message: 'Automation created',
      automationId 
    });
  } catch (err) {
    console.error('Error creating automation:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all automations
app.get('/api/automations', verifyToken, async (req, res) => {
  try {
    const connection = await pool.getConnection();
const [automations] = await connection.execute(
  `SELECT 
      a.*, 
      COALESCE(a.email_interval, 10) as email_interval,
      s.status AS state_status
    FROM automations a
    LEFT JOIN automation_state s 
      ON s.campaign_id = a.id
    ORDER BY a.created_at DESC`
);

    connection.release();

    // Parse schedule_data from JSON string
    const parsedAutomations = automations.map(auto => {
      try {
        return {
          ...auto,
          schedule_data: auto.schedule_data ? JSON.parse(auto.schedule_data) : null,
          recipients: auto.recipients ? JSON.parse(auto.recipients) : []
        };
      } catch (parseError) {
        console.error(`Error parsing data for automation ${auto.id}:`, parseError);
        return {
          ...auto,
          schedule_data: null,
          recipients: []
        };
      }
    });

    res.json({ automations: parsedAutomations });
  } catch (err) {
    console.error('Error fetching automations:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get automation by ID
app.get('/api/automations/:id', verifyToken, async (req, res) => {
  try {
    const connection = await pool.getConnection();
const [automations] = await connection.execute(
  `SELECT 
      a.*, 
      COALESCE(a.email_interval, 10) as email_interval,
      s.status AS state_status
    FROM automations a
    LEFT JOIN automation_state s 
      ON s.campaign_id = a.id
    WHERE a.id = ?`,
  [req.params.id]
);

    connection.release();

    if (automations.length === 0) {
      return res.status(404).json({ error: 'Automation not found' });
    }

    const automation = {
      ...automations[0],
      schedule_data: automations[0].schedule_data ? JSON.parse(automations[0].schedule_data) : null,
      recipients: automations[0].recipients ? JSON.parse(automations[0].recipients) : []
    };

    res.json({ automation });
  } catch (err) {
    console.error('Error fetching automation:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update automation
app.put('/api/automations/:id', verifyToken, async (req, res) => {
  try {
    const { 
      name, 
      template_id, 
      trigger_type, 
      recipients, 
      enabled,
      schedule_data,
      email_interval = 10 
    } = req.body;

    // Validate schedule data for scheduled automations
    if (trigger_type === 'scheduled') {
      if (!schedule_data || !schedule_data.date || !schedule_data.time) {
        return res.status(400).json({ error: 'Schedule date and time required for scheduled automations' });
      }
    }

    const connection = await pool.getConnection();
    
    // First, get current automation to check if we need to unschedule
    const [currentAutomations] = await connection.execute(
      'SELECT trigger_type, enabled FROM automations WHERE id = ?',
      [req.params.id]
    );
    
    if (currentAutomations.length === 0) {
      connection.release();
      return res.status(404).json({ error: 'Automation not found' });
    }
    
    const currentAutomation = currentAutomations[0];
    
    // Update the automation
    await connection.execute(
      `UPDATE automations SET 
        name = ?, 
        template_id = ?, 
        trigger_type = ?, 
        recipients = ?, 
        enabled = ?,
        schedule_data = ?,
        email_interval = ?,
        updated_at = NOW()
       WHERE id = ?`,
      [
        name, 
        template_id, 
        trigger_type, 
        JSON.stringify(recipients || []), 
        enabled ? 1 : 0,
        schedule_data ? JSON.stringify(schedule_data) : null,
        parseInt(email_interval),
        req.params.id
      ]
    );
    connection.release();

    // Handle scheduling/unscheduling
    if (currentAutomation.trigger_type === 'scheduled') {
      // Unschedule previous schedule
      unscheduleAutomation(req.params.id);
    }
    
    if (enabled && trigger_type === 'scheduled' && schedule_data) {
      // Schedule new automation
      scheduleAutomation(req.params.id, schedule_data, email_interval);
    }

    res.json({ success: true, message: 'Automation updated' });
  } catch (err) {
    console.error('Error updating automation:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete automation
app.delete('/api/automations/:id', verifyToken, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    
    // First check if it's a scheduled automation to unschedule it
    const [automations] = await connection.execute(
      'SELECT trigger_type FROM automations WHERE id = ?',
      [req.params.id]
    );
    
    if (automations.length > 0 && automations[0].trigger_type === 'scheduled') {
      unscheduleAutomation(req.params.id);
    }
    
    // Then delete the automation
    await connection.execute('DELETE FROM automations WHERE id = ?', [req.params.id]);
    connection.release();

    res.json({ success: true, message: 'Automation deleted' });
  } catch (err) {
    console.error('Error deleting automation:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Enable automation
app.put('/api/automations/:id/enable', verifyToken, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    
    // Get automation details to check if it's scheduled
    const [automations] = await connection.execute(
      'SELECT trigger_type, schedule_data, email_interval FROM automations WHERE id = ?',
      [req.params.id]
    );
    
    if (automations.length === 0) {
      connection.release();
      return res.status(404).json({ error: 'Automation not found' });
    }
    
    const automation = automations[0];
    
    // Update enabled status
    await connection.execute(
      'UPDATE automations SET enabled = 1 WHERE id = ?',
      [req.params.id]
    );
    connection.release();

    // If it's a scheduled automation, schedule it
    if (automation.trigger_type === 'scheduled' && automation.schedule_data) {
      try {
        const scheduleData = JSON.parse(automation.schedule_data);
        const emailInterval = automation.email_interval || 10;
        scheduleAutomation(req.params.id, scheduleData, emailInterval);
      } catch (parseError) {
        console.error(`Error parsing schedule data for automation ${req.params.id}:`, parseError);
      }
    }

    res.json({ success: true, message: 'Automation enabled' });
  } catch (err) {
    console.error('Error enabling automation:', err);
    res.status(500).json({ error: 'Failed to enable automation' });
  }
});

// Disable automation
app.put('/api/automations/:id/disable', verifyToken, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    
    // Get automation details to check if it's scheduled
    const [automations] = await connection.execute(
      'SELECT trigger_type FROM automations WHERE id = ?',
      [req.params.id]
    );
    
    if (automations.length === 0) {
      connection.release();
      return res.status(404).json({ error: 'Automation not found' });
    }
    
    const automation = automations[0];
    
    // Update enabled status
    await connection.execute(
      'UPDATE automations SET enabled = 0 WHERE id = ?',
      [req.params.id]
    );
    connection.release();

    // If it's a scheduled automation, unschedule it
    if (automation.trigger_type === 'scheduled') {
      unscheduleAutomation(req.params.id);
    }

    res.json({ success: true, message: 'Automation disabled' });
  } catch (err) {
    console.error('Error disabling automation:', err);
    res.status(500).json({ error: 'Failed to disable automation' });
  }
});

// ==================== EMAIL SENDING ROUTES ====================

// Send test email
app.post('/api/email/send-test', verifyToken, async (req, res) => {
  try {
    const { to, subject, template_id, variables } = req.body;

    if (!to || !subject) {
      return res.status(400).json({ error: 'Email and subject required' });
    }

    // 1. Check if email exists in users or admins table
    const user = await findUserByEmail(to);
    if (!user) {
      return res.status(404).json({ error: `Email ${to} not found in users or admins table.` });
    }

    let finalSubject = subject;
    let htmlContent = subject; // Default to subject if no template is used

    if (template_id) {
      // Pass user data to variables for personalization
      const templateVariables = { ...variables, user };
      const rendered = renderTemplate(template_id, templateVariables || {});
      finalSubject = rendered.subject;
      htmlContent = rendered.html;
    }

    const result = await sendEmail(to, finalSubject, htmlContent);

    res.json({
      success: true,
      message: `Test email sent to ${user.type} ${user.name || user.email}`,
      result
    });
  } catch (err) {
    console.error('Error sending test email:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== AUTOMATION RUNNER ROUTE (UPDATED) ====================

// Run automation (with email interval support)
app.post('/api/automation/run/:id', verifyToken, async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id);
    const { chunkSize = 100, recipients = [], emailInterval = 10 } = req.body;

    if (isNaN(campaignId)) {
      return res.status(400).json({ error: 'Invalid campaign ID' });
    }

    // Check if automation is enabled
    const connection = await pool.getConnection();
    const [automations] = await connection.execute(
      'SELECT enabled FROM automations WHERE id = ?',
      [campaignId]
    );
    connection.release();
    
    if (automations.length === 0) {
      return res.status(404).json({ error: 'Automation not found' });
    }
    
    if (!automations[0].enabled) {
      return res.status(400).json({ error: 'Automation is disabled. Please enable it first.' });
    }

    // Check if specific recipients are provided
    if (recipients && recipients.length > 0) {
      const result = await runAutomationForRecipients(campaignId, recipients, parseInt(emailInterval));
      res.json({
        success: true,
        ...result
      });
    } else {
      // Run for all users
      const result = await runAutomation(campaignId, parseInt(chunkSize), parseInt(emailInterval));
      res.json({
        success: true,
        ...result
      });
    }
  } catch (err) {
    console.error('Error running automation:', err);
    res.status(500).json({ error: err.message });
  }
});

// Send bulk email (Manual/Selected Users)
app.post('/api/email/send-bulk', verifyToken, async (req, res) => {
  try {
    const { recipients, subject, template_id, variables } = req.body;

    if (!recipients || recipients.length === 0) {
      return res.status(400).json({ error: 'Recipients required' });
    }

    if (!subject || !template_id) {
      return res.status(400).json({ error: 'Subject and template required' });
    }

    const results = [];
    for (const recipient of recipients) {
      try {
        const rendered = renderTemplate(template_id, { ...variables, email: recipient });
        const finalSubject = rendered.subject;
        const htmlContent = rendered.html;
        
        const result = await sendEmail(recipient, finalSubject, htmlContent);
        results.push({ email: recipient, success: true, ...result });
      } catch (err) {
        results.push({ email: recipient, success: false, error: err.message });
      }
    }

    res.json({
      success: true,
      message: `Sent ${results.filter(r => r.success).length}/${results.length} emails`,
      results
    });
  } catch (err) {
    console.error('Error sending bulk email:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get email statistics
app.get('/api/email/stats', verifyToken, async (req, res) => {
  try {
    const stats = await getEmailStats();
    res.json(stats);
  } catch (err) {
    console.error('Error fetching email stats:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== USER ROUTES ====================

app.get('/api/users', verifyToken, async (req, res) => {
  try {
    const { page = 1, limit = 100, search = '' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const parsedLimit = parseInt(limit);

    const users = await searchUsers(search, parsedLimit, offset);
    const totalCount = await getTotalUserCount(search);

    res.json({
      success: true,
      users,
      pagination: {
        page: parseInt(page),
        limit: parsedLimit,
        total: totalCount,
        pages: Math.ceil(totalCount / parsedLimit)
      }
    });
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ADMIN ROUTES ====================

// Get all admins
app.get('/api/admins', verifyToken, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [admins] = await connection.execute(
      'SELECT id, email, name, created_at FROM admins'
    );
    connection.release();

    res.json({ admins });
  } catch (err) {
    console.error('Error fetching admins:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new admin
app.post('/api/admins', verifyToken, async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const connection = await pool.getConnection();
    await connection.execute(
      'INSERT INTO admins (email, password, name, created_at) VALUES (?, ?, ?, NOW())',
      [email, hashedPassword, name || email]
    );
    connection.release();

    res.json({ success: true, message: 'Admin created' });
  } catch (err) {
    console.error('Error creating admin:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete admin
app.delete('/api/admins/:id', verifyToken, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await connection.execute('DELETE FROM admins WHERE id = ?', [req.params.id]);
    connection.release();

    res.json({ success: true, message: 'Admin deleted' });
  } catch (err) {
    console.error('Error deleting admin:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== HEALTH CHECK ====================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Serve index.html for all other routes
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, async () => {
  console.log(`✓ Email Automation Server running on http://localhost:${PORT}`);
  console.log(`✓ API endpoints available at http://localhost:${PORT}/api`);
  
  // Load scheduled automations on server start
  try {
    loadBrevoAccounts(); // Load Brevo accounts from ENV
    await loadScheduledAutomations();
    await resetRunningAutomations();
    console.log('✓ Scheduled automations loaded');
  } catch (err) {
    console.error('Error loading scheduled automations:', err);
  }
});

module.exports = app;
