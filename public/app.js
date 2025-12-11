// ==================== STATE MANAGEMENT ====================

let authToken = localStorage.getItem('authToken');
let currentAdmin = null;
let editingAutomationId = null;
let automationsCache = [];

// ==================== API HELPERS ====================

async function apiCall(endpoint, method = 'GET', data = null) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken && { 'Authorization': `Bearer ${authToken}` })
    }
  };

  if (data) {
    options.body = JSON.stringify(data);
  }

  try {
    const response = await fetch(`/api${endpoint}`, options);
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'API error');
    }

    return result;
  } catch (error) {
    console.error('API Error:', error);
    showNotification(error.message, 'error');
    throw error;
  }
}

// ==================== NOTIFICATIONS ====================

function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 15px 20px;
    background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
    color: white;
    border-radius: 6px;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
    z-index: 2000;
    animation: slideIn 0.3s ease;
  `;

  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// ==================== AUTHENTICATION ====================

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  try {
    const result = await apiCall('/auth/login', 'POST', { email, password });
    authToken = result.token;
    localStorage.setItem('authToken', authToken);
    currentAdmin = result.admin;

    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('dashboard').style.display = 'flex';
    document.getElementById('admin-name').textContent = `Welcome, ${currentAdmin.name || currentAdmin.email}`;

    showNotification('Login successful!', 'success');
    loadDashboard();
  } catch (error) {
    showNotification('Login failed. Check your credentials.', 'error');
  }
}

async function handleLogout() {
  try {
    await apiCall('/auth/logout', 'POST');
    authToken = null;
    localStorage.removeItem('authToken');
    currentAdmin = null;

    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('dashboard').style.display = 'none';
    document.getElementById('login-form').reset();

    showNotification('Logged out successfully', 'success');
  } catch (error) {
    console.error('Logout error:', error);
  }
}

// ==================== DASHBOARD ====================

async function loadDashboard() {
  try {
    // Load email stats
	    const stats = await apiCall('/email/stats');
	    const totalSent = stats.hostinger.sent + stats.brevo.sent;
	    const totalLimit = stats.hostinger.limit + stats.brevo.limit;
	    
	    // Update total emails sent today
	    document.getElementById('emails-today').textContent = `${totalSent}/${totalLimit}`;
	    
	    // Update individual provider usage
	    document.getElementById('hostinger-used').textContent = `${stats.hostinger.sent}/${stats.hostinger.limit}`;
	    document.getElementById('brevo-used').textContent = `${stats.brevo.sent}/${stats.brevo.limit}`;

    // Load automations
    const automations = await apiCall('/automations');
    const activeCount = automations.automations.filter(a => a.enabled).length;
    document.getElementById('active-automations').textContent = activeCount;

    // Load templates
    await loadTemplates();

    // Load admins
    await loadAdmins();
  } catch (error) {
    console.error('Error loading dashboard:', error);
  }
}

// ==================== TEMPLATES ====================

async function loadTemplates() {
  try {
    const result = await apiCall('/templates');
    const templatesList = document.getElementById('templates-list');
    const testTemplateSelect = document.getElementById('test-template');
    const autoTemplateSelect = document.getElementById('auto-template');

    templatesList.innerHTML = '';
    testTemplateSelect.innerHTML = '<option value="">Custom Email</option>';
    autoTemplateSelect.innerHTML = '';

    result.templates.forEach(template => {
      // Add to templates grid
      const card = document.createElement('div');
      card.className = 'template-card';
      card.innerHTML = `
        <div class="template-icon">
          <i class="fas fa-envelope"></i>
        </div>
        <h3>${template.name}</h3>
        <p>${template.description}</p>
        <div class="template-variables">
          ${template.variables.map(v => `<span class="template-var">${v}</span>`).join('')}
        </div>
        <button class="btn btn-primary btn-block" onclick="previewTemplate('${template.id}')">
          <i class="fas fa-eye"></i> Preview
        </button>
      `;
      templatesList.appendChild(card);

      // Add to selects
      const option = document.createElement('option');
      option.value = template.id;
      option.textContent = template.name;
      testTemplateSelect.appendChild(option.cloneNode(true));
      autoTemplateSelect.appendChild(option);
    });
  } catch (error) {
    console.error('Error loading templates:', error);
  }
}

async function previewTemplate(templateId) {
  try {
    const result = await apiCall(`/templates/${templateId}`);
    const template = result.template;

    const previewWindow = window.open('', 'preview', 'width=800,height=600');
    previewWindow.document.write(`
      <html>
        <head>
          <title>${template.name} Preview</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            .preview { max-width: 600px; margin: 0 auto; }
            .header { background: #f0f0f0; padding: 20px; border-radius: 6px; margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <div class="header">
            <h2>${template.name}</h2>
            <p><strong>Subject:</strong> ${template.subject}</p>
            <p><strong>Variables:</strong> ${template.variables.join(', ')}</p>
          </div>
          <div class="preview">
            ${template.html}
          </div>
        </body>
      </html>
    `);
    previewWindow.document.close();
  } catch (error) {
    console.error('Error previewing template:', error);
  }
}

async function loadAutomations() {
  try {
    const result = await apiCall('/automations');
    const automationsList = document.getElementById('automations-list');
    
    automationsCache = result.automations || [];
    
    if (automationsCache.length === 0) {
      automationsList.innerHTML = '<p class="empty-state">No automations yet. Create one to get started!</p>';
      return;
    }
    
    automationsList.innerHTML = automationsCache.map(auto => {
  let scheduleInfo = '';
  if (auto.trigger_type === 'scheduled' && auto.schedule_data) {
    try {
      const schedule = typeof auto.schedule_data === 'string' 
        ? JSON.parse(auto.schedule_data) 
        : auto.schedule_data;
      scheduleInfo = `<p><strong>Schedule:</strong> ${schedule.date} ${schedule.time} (${schedule.repeat})</p>`;
    } catch (e) {
      scheduleInfo = '<p><strong>Schedule:</strong> Invalid schedule data</p>';
    }
  }
  
  const isScheduled = auto.trigger_type === 'scheduled';
  const stateStatus = auto.state_status || null;
  const isRunning = stateStatus === 'running' && auto.enabled;
  const isCompleted = stateStatus === 'completed';

  return `
  <div class="automation-card" data-automation-id="${auto.id}">
    <h3>${auto.name}</h3>
    <p><strong>Template:</strong> ${auto.template_id}</p>
    <p><strong>Trigger:</strong> ${auto.trigger_type}</p>
    ${scheduleInfo}
    <p><strong>Email Interval:</strong> ${auto.email_interval || 10} seconds</p>
    <p><strong>Recipients:</strong> ${getRecipientsCount(auto.recipients) > 0 ? 
      `${getRecipientsCount(auto.recipients)} specific users` : 'All Users'}</p>
    
    <div class="automation-status-row">
      <span class="automation-status ${auto.enabled ? 'enabled' : 'disabled'}">
        ${auto.enabled ? 'Enabled' : 'Disabled'}
      </span>
      
      <div class="automation-actions">
        ${
          // ⏱ BUTTON FOR MANUAL TRIGGER
          !isScheduled
            ? (
              isRunning
                ? `
                  <button class="btn btn-secondary run-now-btn"
                          disabled
                          style="opacity: 0.7; cursor: not-allowed;">
                    <i class="fas fa-spinner fa-spin"></i> Running...
                  </button>
                `
                : `
                  <button class="btn btn-success run-now-btn" 
                          onclick="runAutomationNow(${auto.id})"
                          ${(!auto.enabled || isCompleted) ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''}>
                    <i class="fas fa-play"></i> Run
                  </button>
                `
            )
            : (
              // ⏱ BUTTON FOR SCHEDULED TRIGGER
              isRunning
                ? `
                  <button class="btn btn-secondary"
                          disabled
                          style="opacity: 0.7; cursor: not-allowed;">
                    <i class="fas fa-spinner fa-spin"></i> Running...
                  </button>
                `
                : `
                  <button class="btn btn-info"
                          disabled
                          style="opacity: 0.5; cursor: not-allowed;">
                    <i class="fas fa-clock"></i> Scheduled
                  </button>
                `
            )
        }
        
        ${auto.enabled ? 
          `<button class="btn btn-warning" onclick="toggleAutomation(${auto.id}, false)">
            <i class="fas fa-stop"></i> Stop
          </button>` : 
          `<button class="btn btn-success" onclick="toggleAutomation(${auto.id}, true)">
            <i class="fas fa-play"></i> Enable
          </button>`}
          
        <button class="btn btn-secondary" onclick="editAutomation(${auto.id})">
          <i class="fas fa-edit"></i> Edit
        </button>
        
        <button class="btn btn-danger" onclick="deleteAutomation(${auto.id})">
          <i class="fas fa-trash"></i> Delete
        </button>
      </div>
    </div>
  </div>
`}).join('');
  } catch (error) {
    console.error('Error loading automations:', error);
  }
}
async function deleteAutomation(id) {
  if (!confirm('Are you sure you want to delete this automation?')) return;

  try {
    await apiCall(`/automations/${id}`, 'DELETE');
    showNotification('Automation deleted successfully!', 'success');
    loadAutomations();
  } catch (error) {
    showNotification('Error deleting automation', 'error');
  }
}

// ==================== ADMIN MANAGEMENT ====================

async function loadAdmins() {
  try {
    const result = await apiCall('/admins');
    const adminsList = document.getElementById('admins-list');

    if (result.admins.length === 0) {
      adminsList.innerHTML = '<p class="empty-state">No admins found</p>';
      return;
    }

    adminsList.innerHTML = result.admins.map(admin => `
      <div class="admin-card">
        <h3>${admin.name || admin.email}</h3>
        <p><strong>Email:</strong> ${admin.email}</p>
        <p><strong>Created:</strong> ${new Date(admin.created_at).toLocaleDateString()}</p>
        <div class="admin-actions">
          <button class="btn btn-danger" onclick="deleteAdmin(${admin.id})">
            <i class="fas fa-trash"></i> Delete
          </button>
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Error loading admins:', error);
  }
}

async function handleCreateAdmin(e) {
  e.preventDefault();
  const email = document.getElementById('admin-email').value;
  const name = document.getElementById('admin-name').value;
  const password = document.getElementById('admin-password').value;

  try {
    await apiCall('/admins', 'POST', { email, name, password });
    showNotification('Admin created successfully!', 'success');
    closeAdminModal();
    loadAdmins();
  } catch (error) {
    showNotification('Error creating admin', 'error');
  }
}

async function deleteAdmin(id) {
  if (!confirm('Are you sure you want to delete this admin?')) return;

  try {
    await apiCall(`/admins/${id}`, 'DELETE');
    showNotification('Admin deleted successfully!', 'success');
    loadAdmins();
  } catch (error) {
    showNotification('Error deleting admin', 'error');
  }
}

// ==================== EMAIL SENDING ====================

async function handleSendTest(e) {
  e.preventDefault();
  const to = document.getElementById('test-email').value;
  const subject = document.getElementById('test-subject').value;
  const template_id = document.getElementById('test-template').value;

  try {
    const result = await apiCall('/email/send-test', 'POST', {
      to,
      subject,
      template_id: template_id || null,
      variables: {}
    });

    showNotification(`Test email sent via ${result.result.provider}!`, 'success');
    closeSendTestModal();
    document.getElementById('send-test-form').reset();
  } catch (error) {
    showNotification('Error sending test email', 'error');
  }
}
function updateScheduleFields() {
  const triggerType = document.getElementById('auto-trigger').value;
  const scheduleFields = document.getElementById('schedule-fields');
  
  if (triggerType === 'scheduled') {
    scheduleFields.style.display = 'block';
  } else {
    scheduleFields.style.display = 'none';
  }
}

function updateRunButton(automation) {
  // This function will be called when loading automations to update button states
  const automationCard = document.querySelector(`[data-automation-id="${automation.id}"]`);
  if (!automationCard) return;
  
  const runButton = automationCard.querySelector('.run-now-btn');
  if (runButton) {
    if (automation.enabled) {
      runButton.disabled = false;
      runButton.style.opacity = '1';
      runButton.style.cursor = 'pointer';
    } else {
      runButton.disabled = true;
      runButton.style.opacity = '0.5';
      runButton.style.cursor = 'not-allowed';
    }
  }
}

async function runAutomationNow(id) {
  const auto = automationsCache.find(a => a.id === id);
  
  if (!auto) return;
    if (auto.trigger_type === 'scheduled') {
    showNotification('Cannot run scheduled automation manually. It will run automatically at the scheduled time.', 'error');
    return;
  }
  // Check if automation is enabled
  if (!auto.enabled) {
    showNotification('Please enable the automation before running it', 'error');
    return;
  }
  
  const recipientsList = getRecipientsList(auto.recipients);
  const hasRecipients = recipientsList.length > 0;
  
  if (hasRecipients) {
    const confirmMessage = `This automation has ${recipientsList.length} specific recipients:\n${recipientsList.join(', ')}\n\nRun for these recipients only?`;
    if (!confirm(confirmMessage)) return;
  } else {
    if (!confirm('This automation has no specific recipients. Run for all users?')) return;
  }
  
  // Get email interval
  const emailInterval = auto.email_interval || 10;
  // All confirmations passed – NOW show Running...
const card = document.querySelector(`[data-automation-id="${id}"]`);
const runBtn = card ? card.querySelector('.run-now-btn') : null;

if (runBtn) {
  runBtn.disabled = true;
  runBtn.style.opacity = "0.7";
  runBtn.style.cursor = "not-allowed";
  runBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Running...';
}

  try {
    const payload = {
      chunkSize: 100,
      emailInterval: emailInterval,
      ...(hasRecipients && { recipients: recipientsList })
    };
    
    const result = await apiCall(`/automation/run/${id}`, 'POST', payload);
    
    const msg = result.message || 
      `Automation run completed. Sent ${result.totalSent || 0} emails${hasRecipients ? ' to specified recipients' : ' to all users'}.`;
    
    showNotification(msg, 'success');
    loadDashboard();
    loadAutomations();
  } catch (err) {
    console.error('Error running automation:', err);
    showNotification(err.message || 'Error running automation', 'error');
  }
}

async function editAutomation(id) {
  try {
    const result = await apiCall(`/automations/${id}`);
    const auto = result.automation;
    
    if (!auto) {
      showNotification('Automation not found', 'error');
      return;
    }
    
    editingAutomationId = id;
    
    // Prefill modal fields
    document.getElementById('auto-name').value = auto.name || '';
    document.getElementById('auto-template').value = auto.template_id || '';
    document.getElementById('auto-trigger').value = auto.trigger_type || 'manual';
    updateScheduleFields();
    // Set schedule fields if scheduled
    if (auto.trigger_type === 'scheduled' && auto.schedule_data) {
      try {
        const scheduleData = typeof auto.schedule_data === 'string' 
          ? JSON.parse(auto.schedule_data) 
          : auto.schedule_data;
        
        document.getElementById('schedule-date').value = scheduleData.date || '';
        document.getElementById('schedule-time').value = scheduleData.time || '';
        document.getElementById('schedule-repeat').value = scheduleData.repeat || 'once';
        document.getElementById('email-interval').value = auto.email_interval || 10;
      } catch (e) {
        console.error('Error parsing schedule data:', e);
      }
    }
    
    // Update recipients
    let recipientsList = [];
    try {
      if (typeof auto.recipients === 'string') {
        recipientsList = JSON.parse(auto.recipients);
      } else if (Array.isArray(auto.recipients)) {
        recipientsList = auto.recipients;
      }
    } catch (e) {
      recipientsList = typeof auto.recipients === 'string' ? 
        auto.recipients.split(',').map(e => e.trim()).filter(e => e) : 
        [];
    }
    document.getElementById('auto-recipients').value = recipientsList.join(', ');
    
    document.getElementById('auto-enabled').checked = !!auto.enabled;
    
    // Update schedule fields visibility
    updateScheduleFields();
    
    // Update modal title
    document.querySelector('#automation-modal .modal-header h2').innerHTML = 
      '<i class="fas fa-edit"></i> Edit Automation';
    
    // Update submit button
    const submitBtn = document.querySelector('#automation-form button[type="submit"]');
    submitBtn.innerHTML = '<i class="fas fa-save"></i> Update Automation';
    
    openAutomationModal();
  } catch (error) {
    console.error('Error loading automation for edit:', error);
    showNotification('Error loading automation', 'error');
  }
}

async function handleCreateAutomation(e) {
  e.preventDefault();
  const name = document.getElementById('auto-name').value;
  const template_id = document.getElementById('auto-template').value;
  const trigger_type = document.getElementById('auto-trigger').value;
  const recipients = document.getElementById('auto-recipients').value
    .split(',')
    .map(e => e.trim())
    .filter(e => e);
  const enabled = document.getElementById('auto-enabled').checked;
  const email_interval = document.getElementById('email-interval').value || 10;
  
  const payload = { 
    name, 
    template_id, 
    trigger_type, 
    recipients, 
    enabled,
    email_interval: parseInt(email_interval)
  };
  
  // Add schedule data if scheduled
  if (trigger_type === 'scheduled') {
    const scheduleData = {
      date: document.getElementById('schedule-date').value,
      time: document.getElementById('schedule-time').value,
      repeat: document.getElementById('schedule-repeat').value,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };
    
    if (!scheduleData.date || !scheduleData.time) {
      showNotification('Please select date and time for scheduled automation', 'error');
      return;
    }
    
    payload.schedule_data = scheduleData;
  }
  
  try {
    if (editingAutomationId) {
      await apiCall(`/automations/${editingAutomationId}`, 'PUT', payload);
      showNotification('Automation updated successfully!', 'success');
    } else {
      await apiCall('/automations', 'POST', payload);
      showNotification('Automation created successfully!', 'success');
    }
    
    closeAutomationModal();
    loadAutomations();
  } catch (error) {
    console.error('Error saving automation:', error);
    showNotification('Error saving automation', 'error');
  }
}

function closeAutomationModal() {
  document.getElementById('automation-modal').classList.remove('active');
  document.getElementById('automation-form').reset();
  
  // Reset modal title
  document.querySelector('#automation-modal .modal-header h2').innerHTML = 
    '<i class="fas fa-cog"></i> Create Automation';
  
  // Reset submit button
  const submitBtn = document.querySelector('#automation-form button[type="submit"]');
  submitBtn.innerHTML = '<i class="fas fa-save"></i> Create Automation';
  
  // Hide schedule fields
  document.getElementById('schedule-fields').style.display = 'none';
  
  editingAutomationId = null;
}

async function toggleAutomation(id, enabled) {
  const action = enabled ? 'enable' : 'disable';
  if (!confirm(`Are you sure you want to ${action} this automation?`)) return;
  
  try {
    await apiCall(`/automations/${id}/${action}`, 'PUT');
    showNotification(`Automation ${action}d successfully!`, 'success');
    
    // Update the automation in cache
    const autoIndex = automationsCache.findIndex(a => a.id === id);
    if (autoIndex !== -1) {
      automationsCache[autoIndex].enabled = enabled;
      updateRunButton(automationsCache[autoIndex]);
    }
    
    loadAutomations(); // Refresh the list
  } catch (error) {
    showNotification(`Error ${action}ing automation`, 'error');
  }
}
// Helper function to get recipient count
function getRecipientsCount(recipients) {
  if (!recipients) return 0;
  
  try {
    if (typeof recipients === 'string') {
      const parsed = JSON.parse(recipients);
      return Array.isArray(parsed) ? parsed.length : 0;
    } else if (Array.isArray(recipients)) {
      return recipients.length;
    }
  } catch (e) {
    // If not JSON, try to split by comma
    if (typeof recipients === 'string') {
      return recipients.split(',').filter(e => e.trim()).length;
    }
  }
  return 0;
}
// Helper function to get recipients as array
function getRecipientsList(recipients) {
  if (!recipients) return [];
  
  try {
    if (typeof recipients === 'string') {
      const parsed = JSON.parse(recipients);
      return Array.isArray(parsed) ? parsed : [];
    } else if (Array.isArray(recipients)) {
      return recipients;
    }
  } catch (e) {
    // If not JSON, try to split by comma
    if (typeof recipients === 'string') {
      return recipients.split(',').map(e => e.trim()).filter(e => e);
    }
  }
  return [];
}
// ==================== MODAL HANDLERS ====================

function openSendTestModal() {
  document.getElementById('send-test-modal').classList.add('active');
}

function closeSendTestModal() {
  document.getElementById('send-test-modal').classList.remove('active');
}

function openAutomationModal() {
  // Make sure the template select is populated
  if (document.getElementById('auto-template').options.length === 0) {
    loadTemplates();
  }
  
  // Set min date for schedule date picker
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('schedule-date').min = today;
  
  document.getElementById('automation-modal').classList.add('active');
}

function openAdminModal() {
  document.getElementById('admin-modal').classList.add('active');
}

function closeAdminModal() {
  document.getElementById('admin-modal').classList.remove('active');
  document.getElementById('admin-form').reset();
}

// Close modals on outside click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal')) {
    e.target.classList.remove('active');
  }
});


// ==================== USER SELECTION FEATURE ====================

let selectedUsers = [];

function openUserSearchModal() {
  document.getElementById('user-search-modal').classList.add('active');
  loadUsersForSelection();
}

function closeUserSearchModal() {
  document.getElementById('user-search-modal').classList.remove('active');
  selectedUsers = [];
}

async function loadUsersForSelection(searchTerm = '') {
  try {
    const result = await apiCall(`/users?search=${encodeURIComponent(searchTerm)}`);
    const usersTableBody = document.getElementById('users-table-body');
    
    // Check if the response structure is correct
    if (!result.users) {
      console.error('No users found in response:', result);
      usersTableBody.innerHTML = '<tr><td colspan="5">No users found or API response format incorrect</td></tr>';
      return;
    }
    
    usersTableBody.innerHTML = result.users.map(user => `
      <tr>
        <td>
          <input type="checkbox" class="user-checkbox" 
                 value="${user.id}"
                 onchange="updateSelectedUsers()"
                 ${selectedUsers.includes(user.id) ? 'checked' : ''}>
        </td>
        <td>${user.id}</td>
        <td>${user.email}</td>
        <td>${user.username || 'N/A'}</td>
        <td>${new Date(user.created_at).toLocaleDateString()}</td>
      </tr>
    `).join('');
    
    updateSelectedCount();
  } catch (error) {
    console.error('Error loading users:', error);
    const usersTableBody = document.getElementById('users-table-body');
    usersTableBody.innerHTML = '<tr><td colspan="5">Error loading users: ' + error.message + '</td></tr>';
  }
}

function searchUsers() {
  const searchTerm = document.getElementById('user-search').value;
  loadUsersForSelection(searchTerm);
}

function toggleSelectAllUsers(checkbox) {
  const checkboxes = document.querySelectorAll('.user-checkbox');
  checkboxes.forEach(cb => cb.checked = checkbox.checked);
  updateSelectedUsers();
}

function updateSelectedUsers() {
  const checkboxes = document.querySelectorAll('.user-checkbox:checked');
  selectedUsers = Array.from(checkboxes).map(cb => cb.value);
  updateSelectedCount();
}

function updateSelectedCount() {
  document.getElementById('selected-users-count').textContent = selectedUsers.length;
}

function useSelectedUsers() {
  if (selectedUsers.length === 0) {
    alert('Please select at least one user');
    return;
  }
  
  // Get all user emails from the table
  const selectedCheckboxes = document.querySelectorAll('.user-checkbox:checked');
  const userEmails = [];
  
  selectedCheckboxes.forEach(checkbox => {
    const row = checkbox.closest('tr');
    const emailCell = row.cells[2]; // Email is in the 3rd column (index 2)
    userEmails.push(emailCell.textContent);
  });
  
  const recipientsField = document.getElementById('auto-recipients');
  const currentValue = recipientsField.value.trim();
  const newValue = userEmails.join(', ');
  
  recipientsField.value = currentValue ? 
    `${currentValue}, ${newValue}` : 
    newValue;
  
  closeUserSearchModal();
}
// ==================== SECTION NAVIGATION ====================

function switchSection(sectionName) {
  // Hide all sections
  document.querySelectorAll('.section').forEach(section => {
    section.classList.remove('active');
  });

  // Remove active from nav items
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
  });

  // Show selected section
  const section = document.getElementById(`${sectionName}-section`);
  if (section) {
    section.classList.add('active');
    document.querySelector(`[data-section="${sectionName}"]`).classList.add('active');
    document.getElementById('section-title').textContent = 
      sectionName.charAt(0).toUpperCase() + sectionName.slice(1);

    // Load data for the section
    if (sectionName === 'automations') {
      loadAutomations();
    } else if (sectionName === 'templates') {
      loadTemplates();
    } else if (sectionName === 'admin') {
      loadAdmins();
    }
  }
}

// ==================== EVENT LISTENERS ====================

document.addEventListener('DOMContentLoaded', () => {
  // Check if already logged in
  if (authToken) {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('dashboard').style.display = 'flex';
    loadDashboard();
  }

  // Login form
  document.getElementById('login-form').addEventListener('submit', handleLogin);

  // Logout button
  document.getElementById('logout-btn').addEventListener('click', handleLogout);

  // Navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      switchSection(item.dataset.section);
    });
  });

  // Send test email form
  document.getElementById('send-test-form').addEventListener('submit', handleSendTest);

  // Create automation form
  document.getElementById('automation-form').addEventListener('submit', handleCreateAutomation);

  // Create admin form
  document.getElementById('admin-form').addEventListener('submit', handleCreateAdmin);

  // Refresh stats every 30 seconds
  setInterval(() => {
    if (authToken) {
      loadDashboard();
    }
  }, 30000);
});

// ==================== KEYBOARD SHORTCUTS ====================

document.addEventListener('keydown', (e) => {
  // ESC to close modals
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal.active').forEach(modal => {
      modal.classList.remove('active');
    });
  }
});

// ==================== ANIMATIONS ====================

const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(400px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  @keyframes slideOut {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(400px);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);
