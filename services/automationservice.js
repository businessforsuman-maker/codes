const { sendEmail, getEmailStats } = require('./emailService');
const { getAutomationState, updateAutomationState, getUsersBatch, getTotalUserCount, hasUserReceivedEmail, getAutomationDetails } = require('./dbService'); 
const pool = require('../config/database');
function getISTMySQLDatetime() {
    const now = new Date();
    // Calculate IST time (UTC + 5 hours 30 minutes)
    // getTimezoneOffset() returns difference in minutes from UTC to local time, so we add it to get UTC
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const istOffset = 330 * 60000; // 5 hours 30 minutes in milliseconds
    const istTime = new Date(utc + istOffset);

    // Format to YYYY-MM-DD HH:MM:SS.mmm (MySQL DATETIME format)
    const year = istTime.getFullYear();
    const month = String(istTime.getMonth() + 1).padStart(2, '0');
    const day = String(istTime.getDate()).padStart(2, '0');
    const hours = String(istTime.getHours()).padStart(2, '0');
    const minutes = String(istTime.getMinutes()).padStart(2, '0');
    const seconds = String(istTime.getSeconds()).padStart(2, '0');
    const milliseconds = String(istTime.getMilliseconds()).padStart(3, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}
function getISTMySQLDate() { // <-- ADDED FUNCTION
    const istTime = new Date(new Date().getTime() + (new Date().getTimezoneOffset() * 60000) + (330 * 60000));
    const year = istTime.getFullYear();
    const month = String(istTime.getMonth() + 1).padStart(2, '0');
    const day = String(istTime.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
const { renderTemplate } = require('./templates');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
/**
 * Main function to run the email automation campaign.
 * Handles single-send logic, daily limits, failover, and resume.
 * @param {number} campaignId - The ID of the automation record.
 * @param {number} chunkSize - The number of users to process in one batch.
 * @returns {Promise<{success: boolean, message: string, totalSent: number, totalUsers: number}>}
 */
async function runAutomation(campaignId, chunkSize = 100, emailInterval = 10) {
    const totalUsers = await getTotalUserCount();
    let state = await getAutomationState(campaignId);
    
    const now = new Date();
    const currentTimeStr = now.toTimeString().split(' ')[0]; // HH:MM:SS
    const currentDateStr = getISTMySQLDate(); // <-- MODIFIED LINE

    // 1. Initialize or reset state
    if (!state) {
        state = {
            campaign_id: campaignId,
            last_user_id: 0,
            emails_sent_today: 0,
            last_reset_date: currentDateStr,
            status: 'pending' // <-- MODIFIED LINE
        };
        // Store start time when first run
        await updateAutomationState(campaignId, 0, 0, 'pending', currentTimeStr, getISTMySQLDatetime(), currentDateStr); // <-- MODIFIED LINE
    } else {
        // Check if 24 hours have passed since start
        // Remove 24-hour check, rely solely on date change for daily reset.
        // The daily reset logic below handles the continuation.
    }

	if (state.last_reset_date !== currentDateStr) {
            // Daily reset: Reset total sent count, update reset date, and set status to running
            state.emails_sent_today = 0;
            state.last_reset_date = currentDateStr;
            state.status = 'running';
            await updateAutomationState(
                campaignId, 
                state.last_user_id, 
                0, 
                'running',
                state.start_time || currentTimeStr, // Preserve or set start time
                getISTMySQLDatetime(),
                currentDateStr
            );
        }


    if (state.status === 'completed') {
        return { success: true, message: 'Automation already completed.', totalSent: totalUsers, totalUsers };
    }
    
    if (state.status === 'stopped' || state.status === 'disabled') {
        return { success: false, message: `Automation is currently in ${state.status} state. Cannot run.`, totalSent: 0, totalUsers };
    }

	    let currentLastUserId = state.last_user_id;
	    let emailsSentToday = state.emails_sent_today;
	    let totalSentInRun = 0;
	    let isPaused = false;
	    
	    // Ensure status is 'running' before starting the loop, unless it was 'paused' by limit
	    if (state.status !== 'paused') {
	        await updateAutomationState(campaignId, currentLastUserId, emailsSentToday, 'running', state.start_time, getISTMySQLDatetime(), currentDateStr);
	    }

    const connection = await pool.getConnection();
    const [automations] = await connection.execute(
        'SELECT template_id FROM automations WHERE id = ?',
        [campaignId]
    );
    connection.release();

    if (automations.length === 0) {
        throw new Error(`Automation with ID ${campaignId} not found.`);
    }
    const templateId = automations[0].template_id;

	    while (true) {
	        const automationDetails = await getAutomationDetails(campaignId);
	        if (!automationDetails || automationDetails.enabled === 0) {
	            await updateAutomationState(campaignId, currentLastUserId, emailsSentToday, 'stopped', state.start_time, getISTMySQLDatetime(), currentDateStr);
	            return { success: false, message: 'Automation stopped by user or disabled.', totalSent: totalSentInRun, totalUsers };
	        }
	        let currentState = await getAutomationState(campaignId);
	        if (currentState.status === 'stopped' || currentState.status === 'disabled' || currentState.status === 'paused') {
	            // If status is 'paused', it means limits were hit in a previous run.
	            // We only continue if the date has reset, which is handled by the initial check.
	            if (currentState.status === 'paused' && currentState.last_reset_date === currentDateStr) {
	                return { success: false, message: `Automation paused. Daily limit reached for all providers. Resuming tomorrow from user ID ${currentLastUserId}.`, totalSent: totalSentInRun, totalUsers };
	            }
	            if (currentState.status !== 'paused') {
	                return { success: false, message: `Automation stopped by user.`, totalSent: totalSentInRun, totalUsers };
	            }
	        }
	
	        const stats = await getEmailStats();
	        const hostingerRemaining = stats.hostinger.remaining;
	        const brevoRemaining = stats.brevo.remaining;
	
	        let providerToUse = null;
	        let providerRemaining = 0;
	
	        // Failover logic: Hostinger first, then Brevo
	        if (hostingerRemaining > 0) {
	            providerToUse = 'hostinger';
	            providerRemaining = hostingerRemaining;
	        } else if (brevoRemaining > 0) {
	            providerToUse = 'brevo';
	            providerRemaining = brevoRemaining;
	        } else {
	            // Both limits exhausted
	            await updateAutomationState(campaignId, currentLastUserId, emailsSentToday, 'paused', state.start_time, getISTMySQLDatetime(), currentDateStr);
	            return { success: false, message: `Automation paused. Daily limit reached for all providers. Resuming tomorrow from user ID ${currentLastUserId}.`, totalSent: totalSentInRun, totalUsers };
	        }
	
	        // Determine the batch size: min(chunkSize, providerRemaining)
	        const batchLimit = Math.min(chunkSize, providerRemaining);
	        
	        // Fetch the next batch of users (resume logic)
	        const usersBatch = await getUsersBatch(currentLastUserId, batchLimit);
	
	        if (usersBatch.length === 0) {
	            // All users processed
	            await updateAutomationState(campaignId, totalUsers, emailsSentToday, 'completed', state.start_time, getISTMySQLDatetime(), currentDateStr);
	            return { success: true, message: 'Automation completed successfully.', totalSent: totalUsers, totalUsers };
	        }
	
	        let batchSentCount = 0;
	        for (const user of usersBatch) {
	            const email = user.email;
	            
	            // Check if user has already received this email for this campaign
	            const alreadySent = await hasUserReceivedEmail(campaignId, email);
	            if (alreadySent) {
	                console.log(`Skipping user ${email} for campaign ${campaignId}: already sent.`);
	                currentLastUserId = user.id; // Crucial: Mark user as processed
	                continue;
	            }
	            
	            // Re-check provider limit before sending each email
	            if (batchSentCount >= providerRemaining) {
	                console.log(`Provider ${providerToUse} limit reached. Breaking batch.`);
	                break; // Break the inner loop to re-evaluate providers in the next outer loop iteration
	            }
	
	            try {
	                // 1. Render template with user-specific variables
	                const rendered = renderTemplate(templateId, { email: user.email, user });
	                const finalSubject = rendered.subject;
	                const htmlContent = rendered.html;
	
	                // 2. Send email using the determined provider
	                await sendEmail(user.email, finalSubject, htmlContent, null, providerToUse, campaignId);
	                
	                // 3. Add delay between emails
	                if (emailInterval > 0) {
	                    await delay(emailInterval * 1000);
	                }
	                
	                // 4. Update state counters
	                currentLastUserId = user.id;
	                emailsSentToday++;
	                totalSentInRun++;
	                batchSentCount++;
	
	            } catch (err) {
	                // Log error but continue to the next user
	                console.error(`Error sending email to ${user.email}:`, err.message);
	            }
	        }
	
	        // Update state after processing the batch
	        await updateAutomationState(campaignId, currentLastUserId, emailsSentToday, 'running', state.start_time, getISTMySQLDatetime(), currentDateStr);
	
	        // If the inner loop broke due to a limit (batchSentCount < usersBatch.length), 
	        // the outer loop will re-evaluate limits and switch provider if possible.
	        // If the batch was fully processed (batchSentCount === usersBatch.length), 
	        // the outer loop continues to the next batch.
	        // If the batch was less than batchLimit and all users were processed (handled by usersBatch.length === 0 check), the function returns.
	    }

	    // This part is unreachable due to the infinite loop structure and returns inside the loop.
	    // Keeping it as a fallback, though the logic is now handled inside the while(true) loop.
	    return {
	        success: false,
	        message: `Automation stopped/paused unexpectedly.`,
	        totalSent: totalSentInRun,
	        totalUsers
	    };
	}
// services/automationService.js - Add this function
/**
 * Run automation for specific recipients only
 */
async function runAutomationForRecipients(campaignId, recipients, emailInterval = 10) {
  const connection = await pool.getConnection();
  
  try {
    // Fetch automation details
    const [automations] = await connection.execute(
      'SELECT template_id FROM automations WHERE id = ?',
      [campaignId]
    );
    
    if (automations.length === 0) {
      throw new Error(`Automation with ID ${campaignId} not found.`);
    }
    
    const templateId = automations[0].template_id;
    const stats = await getEmailStats();
    let totalSent = 0;
    
    // Process each recipient
	    // Process each recipient
	    for (let i = 0; i < recipients.length; i++) {
	      const email = recipients[i];
	      try {
	        // Re-fetch stats inside the loop to get updated remaining counts
	        const currentStats = await getEmailStats();
	        
	        // Determine provider based on remaining limits
	        let provider = null;
	        if (currentStats.hostinger.remaining > 0) {
	          provider = 'hostinger';
	        } else if (currentStats.brevo.remaining > 0) {
	          provider = 'brevo';
	        } else {
	          // If limits are reached, stop processing the rest of the recipients
	          console.log('Daily limits reached for all providers. Stopping recipient run.');
	          // Return success=false to indicate partial completion due to limit
	          return {
	            success: false,
	            message: `Daily limits reached for all providers. Sent ${totalSent}/${recipients.length} emails.`,
	            totalSent,
	            totalUsers: recipients.length
	          };
	        }
	        
	        // Check if user has already received this email for this campaign
	        const alreadySent = await hasUserReceivedEmail(campaignId, email);
	        if (alreadySent) {
	            console.log(`Skipping recipient ${email} for campaign ${campaignId}: already sent.`);
	            continue;
	        }
	        
	        // Get user details if they exist
	        const [users] = await connection.execute(
	          'SELECT id, email, username FROM users WHERE email = ?',
	          [email]
	        );
	        
	        const user = users.length > 0 ? users[0] : { email };
	        
	        // Render template
	        const rendered = renderTemplate(templateId, { email: user.email, user });
	        
	        // Send email
	        await sendEmail(user.email, rendered.subject, rendered.html, null, provider, campaignId);
	        
	        // Add delay between emails if not the last one
	        if (emailInterval > 0 && i < recipients.length - 1) {
	          await delay(emailInterval * 1000);
	        }
	        totalSent++;
	        
	      } catch (err) {
	        console.error(`Error sending to ${email}:`, err.message);
	      }
	    }
    
    return {
      success: true,
      message: `Sent ${totalSent}/${recipients.length} emails to specified recipients`,
      totalSent,
      totalUsers: recipients.length
    };
    
  } finally {
    connection.release();
  }
}
module.exports = {
  runAutomation,
  runAutomationForRecipients
};
