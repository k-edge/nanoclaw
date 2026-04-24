// NanoClaw Dashboard — vanilla JS, no framework
(function () {
  const API = '';

  // --- Tab Navigation ---
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  // --- Helpers ---
  function timeAgo(ts) {
    if (!ts) return '—';
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  function formatDuration(ms) {
    if (!ms) return '—';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return (ms / 60000).toFixed(1) + 'm';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- API Calls ---
  async function fetchJSON(url) {
    const res = await fetch(API + url);
    return res.json();
  }

  // --- Stats ---
  async function loadStats() {
    try {
      const stats = await fetchJSON('/api/dashboard/stats');
      document.getElementById('stat-agents').textContent = stats.totalAgents || 0;
      document.getElementById('stat-tasks').textContent = stats.totalTasks || 0;
      document.getElementById('stat-completed').textContent = stats.completedTasks || 0;
      document.getElementById('stat-running').textContent = stats.runningTasks || 0;
    } catch {
      // silent fail
    }
  }

  // --- Agents Grid (Overview) ---
  async function loadAgentsOverview() {
    try {
      const agents = await fetchJSON('/api/agents');
      const grid = document.getElementById('agents-grid');
      grid.innerHTML = agents
        .map(
          (a) => `
        <div class="agent-card">
          <div class="agent-card-header">
            <div class="agent-name">${escapeHtml(a.name)}</div>
            <span class="agent-role ${a.is_orchestrator ? 'orchestrator' : ''}">
              ${a.is_orchestrator ? 'Orchestrator' : 'Specialist'}
            </span>
          </div>
          <div class="agent-desc">${escapeHtml(a.description || '')}</div>
          <div class="agent-skills">
            ${(a.skills || []).map((s) => `<span class="skill-tag">${escapeHtml(s)}</span>`).join('')}
          </div>
        </div>
      `,
        )
        .join('');
    } catch {
      // silent fail
    }
  }

  // --- Agents Detail ---
  async function loadAgentsDetail() {
    try {
      const agents = await fetchJSON('/api/agents');
      const container = document.getElementById('agents-detail');
      const cards = [];

      for (const a of agents) {
        let ratingsHtml = '';
        try {
          const ratings = await fetchJSON('/api/agents/' + a.id + '/ratings');
          if (ratings.length > 0) {
            const avg = ratings.reduce((s, r) => s + r.score, 0) / ratings.length;
            const pct = (avg / 5) * 100;
            ratingsHtml = `
              <div class="detail-section">
                <h4>Rating (${ratings.length} reviews)</h4>
                <div class="rating-bar">
                  <div class="rating-bar-track"><div class="rating-bar-fill" style="width:${pct}%"></div></div>
                  <span>${avg.toFixed(1)}/5</span>
                </div>
              </div>
            `;
          }
        } catch {
          // no ratings
        }

        const tasksHtml =
          a.recentTasks && a.recentTasks.length > 0
            ? `<div class="detail-section">
                <h4>Recent Tasks</h4>
                ${a.recentTasks
                  .slice(0, 5)
                  .map(
                    (t) => `
                  <div class="task-item" style="padding:8px">
                    <div class="task-info">
                      <div class="task-prompt">${escapeHtml((t.prompt || '').slice(0, 80))}</div>
                      <div class="task-meta">${timeAgo(t.started_at)} · ${formatDuration(t.duration_ms)}</div>
                    </div>
                    <span class="status-badge status-${t.status}">${t.status}</span>
                  </div>
                `,
                  )
                  .join('')}
              </div>`
            : '';

        cards.push(`
          <div class="agent-detail-card">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <h3>${escapeHtml(a.name)}</h3>
              <span class="agent-role ${a.is_orchestrator ? 'orchestrator' : ''}">
                ${a.is_orchestrator ? 'Orchestrator' : 'Specialist'}
              </span>
            </div>
            <div class="description">${escapeHtml(a.description || '')}</div>
            <div class="agent-skills">
              ${(a.skills || []).map((s) => `<span class="skill-tag">${escapeHtml(s)}</span>`).join('')}
            </div>
            ${ratingsHtml}
            ${tasksHtml}
          </div>
        `);
      }

      container.innerHTML = cards.join('');
    } catch {
      // silent fail
    }
  }

  // --- Tasks ---
  async function loadTasks() {
    try {
      const tasks = await fetchJSON('/api/tasks');
      const list = document.getElementById('task-list');
      if (tasks.length === 0) {
        list.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:32px">No tasks yet</div>';
        return;
      }
      list.innerHTML = tasks
        .map(
          (t) => `
        <div class="task-item">
          <div class="task-info">
            <div class="task-prompt">${escapeHtml((t.prompt || '').slice(0, 120))}</div>
            <div class="task-meta">
              ${escapeHtml(t.agent_id)} · ${timeAgo(t.started_at)} · ${formatDuration(t.duration_ms)}
              ${t.task_id ? ' · ' + t.task_id : ''}
            </div>
          </div>
          <span class="status-badge status-${t.status}">${t.status}</span>
        </div>
      `,
        )
        .join('');
    } catch {
      // silent fail
    }
  }

  // --- Task Submission ---
  document.getElementById('task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const textarea = document.getElementById('task-prompt');
    const prompt = textarea.value.trim();
    if (!prompt) return;

    try {
      const res = await fetch(API + '/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      textarea.value = '';
      addLogEntry('Task submitted: ' + data.taskId, 'info');
      loadTasks();
      loadStats();
    } catch (err) {
      addLogEntry('Failed to submit task: ' + err.message, 'error');
    }
  });

  // --- Live Logs (SSE) ---
  const logStream = document.getElementById('log-stream');
  const badge = document.getElementById('connection-badge');

  function addLogEntry(message, level) {
    const entry = document.createElement('div');
    entry.className = 'log-entry log-' + (level || 'info');

    const time = new Date().toLocaleTimeString();
    entry.innerHTML = `<span class="log-time">${time}</span>${escapeHtml(message)}`;

    if (logStream.children.length === 1 && logStream.children[0].textContent.includes('Waiting')) {
      logStream.innerHTML = '';
    }
    logStream.appendChild(entry);

    // Keep last 200 entries
    while (logStream.children.length > 200) {
      logStream.removeChild(logStream.firstChild);
    }
    logStream.scrollTop = logStream.scrollHeight;
  }

  function connectSSE() {
    const evtSource = new EventSource(API + '/api/events');

    evtSource.addEventListener('connected', () => {
      badge.textContent = 'Connected';
      badge.className = 'badge connected';
      addLogEntry('Dashboard connected to NanoClaw', 'success');
    });

    evtSource.addEventListener('task_created', (e) => {
      const data = JSON.parse(e.data);
      addLogEntry(`Task created: ${data.taskId} → ${data.agentId}`, 'info');
      loadTasks();
      loadStats();
    });

    evtSource.addEventListener('task_started', (e) => {
      const data = JSON.parse(e.data);
      addLogEntry(`Task started: ${data.taskId}`, 'info');
      loadTasks();
      loadStats();
    });

    evtSource.addEventListener('task_completed', (e) => {
      const data = JSON.parse(e.data);
      addLogEntry(
        `Task completed: ${data.taskId} (${data.agentId}, ${formatDuration(data.durationMs)})`,
        'success',
      );
      loadTasks();
      loadStats();
      loadAgentsDetail();
    });

    evtSource.addEventListener('task_failed', (e) => {
      const data = JSON.parse(e.data);
      addLogEntry(`Task failed: ${data.taskId} — ${data.error}`, 'error');
      loadTasks();
      loadStats();
    });

    evtSource.onerror = () => {
      badge.textContent = 'Disconnected';
      badge.className = 'badge disconnected';
      evtSource.close();
      setTimeout(connectSSE, 3000);
    };
  }

  // --- Initial Load ---
  loadStats();
  loadAgentsOverview();
  loadTasks();
  loadAgentsDetail();
  connectSSE();

  // Periodic refresh
  setInterval(() => {
    loadStats();
    loadTasks();
  }, 15000);
})();
