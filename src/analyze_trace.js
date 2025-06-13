// AITraceRemediator: analyze_trace.js
// Uses Genkit, OpenAI, and adm-zip to analyze Playwright trace.zip files

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { OpenAI } = require('openai');

const dotenv = require('dotenv');
dotenv.config();

// TODO: Replace with your OpenAI API key or use environment variable
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Analyze a Playwright trace.zip file and return a detailed analysis.
 * @param {string} zipPath - Path to the trace.zip file
 * @returns {Promise<object>} Analysis result
 */
async function analyzeTrace(zipPath) {
  const subfolder = path.dirname(zipPath);
  await generateTraceHtmlReport(zipPath, path.join(subfolder, 'trace.html'));
  return {}

  if (!fs.existsSync(zipPath)) {
    throw new Error(`File not found: ${zipPath}`);
  }
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  let logs = {};
  entries.forEach(entry => {
    if (entry.entryName.endsWith('.log') || entry.entryName.endsWith('.json')) {
      logs[entry.entryName] = zip.readAsText(entry);
    }
  });
  // Compose a prompt for GPT-4
  const prompt = `You are an expert Playwright test analyst. 
  Given the following logs and trace artifacts, determine if the failure is due to test code or application issue. 
  Provide a concise explanation, actionable fixes if test code, or further analysis steps if application issue. 
  Reference relevant logs.\n\n${Object.entries(logs).map(([name, content]) => `--- ${name} ---\n${content.substring(0, 2000)}`).join('\n\n')}`;
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are an expert Playwright test analyst.' },
      { role: 'user', content: prompt }
    ],
    max_tokens: 1000
  });
  return {
    explanation: completion.choices[0].message.content,
    referencedLogs: Object.keys(logs)
  };
}

/**
 * Analyze all trace.zip files in subfolders of a given directory.
 * @param {string} folderPath - Path to the parent folder
 * @returns {Promise<object[]>} Array of analysis results
 */
async function analyzeFolder(folderPath) {
  const results = [];
  const subfolders = fs.readdirSync(folderPath, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => path.join(folderPath, dirent.name));
  for (const subfolder of subfolders) {
    const traceZip = path.join(subfolder, 'trace.zip');
    if (fs.existsSync(traceZip)) {
      try {
        const analysis = await analyzeTrace(traceZip);
        results.push({ subfolder, ...analysis });
      } catch (err) {
        results.push({ subfolder, error: err.message });
      }
    }
  }
  return results;
}

/**
 * Generate a single HTML report from a Playwright trace.zip or unzipped trace folder.
 * Collapsible sections for each event, with network, log, console, source, and images.
 * @param {string} zipOrFolderPath - Path to trace.zip or unzipped trace folder
 * @param {string} outputHtmlPath - Path to output HTML file
 */
async function generateTraceHtmlReport(zipOrFolderPath, outputHtmlPath) {
  // Dependencies - make sure to install adm-zip: npm install adm-zip
  const fs = require('fs');
  const path = require('path');
  const AdmZip = require('adm-zip');

  // Helper to unzip if needed
  function isZip(p) { return p.endsWith('.zip'); }
  let tempDir = null;
  let traceFolder = zipOrFolderPath;
  if (isZip(zipOrFolderPath)) {
    const os = require('os');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-trace-'));
    console.log(`Unzipping trace to temporary folder: ${tempDir}`);
    const zip = new AdmZip(zipOrFolderPath);
    zip.extractAllTo(tempDir, true);
    traceFolder = tempDir;
  }

  // Find the main trace file (e.g., trace.trace or test.trace)
  let traceFile = 'trace.trace';
  if (!fs.existsSync(path.join(traceFolder, traceFile))) {
    const found = fs.readdirSync(traceFolder).find(f => f.endsWith('.trace'));
    if (found) {
      traceFile = found;
    } else {
      throw new Error('No .trace file found in the trace folder.');
    }
  }
  const testTracePath = path.join(traceFolder, traceFile);

  // Parse the main trace file
  const traceLines = fs.readFileSync(testTracePath, 'utf-8').split('\n').filter(Boolean);
  const events = traceLines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

  // Load all network events from .network files
  const networkFiles = fs.readdirSync(traceFolder).filter(f => f.endsWith('.network'));
  let networkEvents = [];
  for (const netFile of networkFiles) {
    const lines = fs.readFileSync(path.join(traceFolder, netFile), 'utf-8').split('\n').filter(Boolean);
    networkEvents.push(...lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean));
  }

  // Set up resource directory path
  const resourcesDir = path.join(traceFolder, 'resources');

  // HTML helpers
  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', '\'': '&#39;' }[c] || c));
  }
  function collapsible(title, content, open = false) {
    const detailsClass = title.includes('error') ? "class='error-summary'" : "";
    return `<details ${open ? 'open' : ''}><summary ${detailsClass}>${title}</summary>\n<div class="collapsible-content">${content}</div></details>`;
  }

  // --- REPLACED FUNCTION ---
  // This function now correctly builds the action tree using callId and parentId.
  function groupEvents(events) {
    const actionMap = new Map();
    const rootActions = [];
    const parentStack = []; // Use a stack to track the current parent action

    for (const event of events) {
      if (event.type === 'before') {
        const action = {
          type: 'action', // Custom type to identify this as a parsed action group
          callId: event.callId,
          parentId: event.parentId,
          title: event.apiName || `${event.class}.${event.method}`,
          params: event.params,
          // --- FIX: Use event.startTime instead of event.monotonicTime ---
          startTime: event.startTime,
          children: [],
          stack: event.stack,
        };
        actionMap.set(action.callId, action);

        if (event.parentId && actionMap.has(event.parentId)) {
          actionMap.get(event.parentId).children.push(action);
        } else {
          rootActions.push(action);
        }
        parentStack.push(action); // Push the current action onto the stack
      } else if (event.type === 'after') {
        const action = actionMap.get(event.callId);
        if (action) {
          // --- FIX: Use event.endTime instead of event.monotonicTime ---
          action.endTime = event.endTime;
          action.duration = action.endTime - action.startTime;
          action.error = event.error;
          action.attachments = event.attachments;
        }
        if (parentStack.length > 0 && parentStack[parentStack.length - 1].callId === event.callId) {
          parentStack.pop(); // Pop from stack when action is complete
        }
      } else {
        // For other events (like stdout), add them to the currently active action
        if (parentStack.length > 0) {
          parentStack[parentStack.length - 1].children.push(event);
        } else {
          rootActions.push(event);
        }
      }
    }
    return rootActions;
  }

  // --- UPDATED RENDERER ---
  // Renders a group or a single event, with parameters moved to the top summary line.
  function renderGroupOrEvent(item) {
    // Case 1: It's a parsed action with children
    if (item.type === 'action') {
      // --- CHANGE START ---
      // 1. Create a formatted string for the parameters.
      let paramsString = '';
      if (item.params) {
        // Convert params to a compact JSON string and escape it.
        const stringified = JSON.stringify(item.params);
        // We display the selector or other simple params directly.
        // For complex objects, we just show that it's an object.
        if (stringified.startsWith('"')) {
          paramsString = ` ${escapeHtml(JSON.parse(stringified))}`;
        } else if (stringified.startsWith('{') && stringified.includes('selector')) {
          paramsString = ` ${escapeHtml(item.params.selector)}`;
        } else if (!stringified.startsWith('{')) {
          paramsString = ` ${escapeHtml(stringified)}`;
        }
      }

      // 2. Add the formatted parameters to the main summary line.
      const duration = item.duration != null ? `(${item.duration.toFixed(2)}ms)` : '';
      const hasError = item.error ? ' [ERROR]' : '';
      const summary = `<b>${escapeHtml(item.title)}</b><i class="param-string">${escapeHtml(paramsString)}</i> ${duration}${hasError}`;

      let content = '';
      // 3. REMOVED the old parameter collapsible section from here.
      // if (item.params) { ... }

      // --- CHANGE END ---

      if (item.stack && item.stack.length > 0) {
        content += collapsible('Stack Trace', `<pre>${escapeHtml(JSON.stringify(item.stack, null, 2))}</pre>`);
      }
      if (item.error) {
        content += collapsible('Error', `<pre class="error">${escapeHtml(item.error.stack || item.error.message)}</pre>`, true);
      }

      // Find related network events that occurred during this action
      const relatedNet = networkEvents.filter(ne => ne.monotonicTime >= item.startTime && ne.monotonicTime <= item.endTime);
      if (relatedNet.length) {
        const netContent = relatedNet.map(ne => `<pre>${escapeHtml(JSON.stringify(ne, null, 2))}</pre>`).join('');
        content += collapsible(`Network (${relatedNet.length})`, netContent);
      }

      // Render attachments by embedding them into the report.
      if (item.attachments) {
        for (const att of item.attachments) {
          if (!att.path || !att.contentType) continue;

          const attPath = path.join(resourcesDir, path.basename(att.path));
          if (!fs.existsSync(attPath)) continue;

          content += `<b>${escapeHtml(att.name)}:</b>`;

          if (att.contentType.startsWith('image/')) {
            const imgData = fs.readFileSync(attPath).toString('base64');
            content += `<br><img src="data:${att.contentType};base64,${imgData}" loading="lazy">`;
          } else if (att.contentType.includes('json') || att.contentType.startsWith('text/')) {
            const textData = fs.readFileSync(attPath, 'utf-8');
            content += collapsible(att.contentType, `<pre>${escapeHtml(textData)}</pre>`);
          } else {
            content += ` <i>(Attachment type '${escapeHtml(att.contentType)}' not embedded)</i>`;
          }
        }
      }

      // Recursively render children
      for (const child of item.children) {
        content += renderGroupOrEvent(child);
      }

      return collapsible(summary, content, !!item.error);
    }

    // Case 2: It's a 'stdout' or 'stderr' event
    else if (item.type === 'stdout' || item.type === 'stderr') {
      return `<div class="log-entry ${item.type}"><pre>${escapeHtml(item.text)}</pre></div>`;
    }

    // Case 3: It's a screencast frame - embed the image
    else if (item.type === 'screencast-frame') {
      const framePath = path.join(resourcesDir, item.sha1);
      const summary = `Event: Screencast Frame at ${item.timestamp || 'N/A'}`;
      if (fs.existsSync(framePath)) {
        const imgData = fs.readFileSync(framePath).toString('base64');
        // Screencast frames are jpeg
        const content = `<img src="data:image/jpeg;base64,${imgData}" loading="lazy" style="max-width: 100%;">`;
        return collapsible(summary, content);
      }
      return collapsible(summary, '<i>Image not found in trace resources.</i>');
    }

    // Case 4: Any other event type
    else {
      return collapsible(`Event: ${item.type}`, `<pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre>`);
    }
  }

  // Build the final HTML
  const grouped = groupEvents(events);
  let html = `<!DOCTYPE html><html><head><meta charset='utf-8'><title>Playwright Trace Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; margin: 2em; }
    h1 { font-size: 1.5em; }
    .controls { margin-bottom: 1em; display: flex; align-items: center; }
    button { padding: 0.5em 1em; font-size: 14px; cursor: pointer; margin-right: 0.5em; border-radius: 4px; border: 1px solid #ccc; background-color: #f0f0f0; }
    button:hover { background-color: #e0e0e0; }
    button.active { background-color: #d4e3ff; border-color: #a8b9e0; font-weight: 500; }
    details { border: 1px solid #ccc; border-radius: 4px; margin-bottom: 0.5em; overflow: hidden; }
    summary { background-color: #f0f0f0; padding: 0.5em; cursor: pointer; font-weight: 500; }
    summary:hover { background-color: #e0e0e0; }
    .collapsible-content { padding: 0.5em 1em; border-top: 1px solid #ccc; }
    pre { background: #f8f8f8; padding: 8px; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; font-family: "Consolas", "Menlo", monospace; font-size: 12px; }
    img { max-width: 800px; display: block; margin: 8px 0; border: 1px solid #ddd; }
    .log-entry.stdout { margin-left: 1em; }
    .log-entry pre { background-color: #e8f4e8; }
    .error { color: #c00; }
    .error-summary { background-color: #fff0f0; color: #c00; font-weight: bold; }
    .param-string {
      color: #555;
      font-style: italic;
      font-weight: normal;
      margin-left: 0.5em;
    }
  </style>
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      // --- ELEMENTS ---
      const traceContainer = document.getElementById('trace-container');
      const allEntries = Array.from(traceContainer.children);

      const expandAllBtn = document.getElementById('expand-all');
      const collapseAllBtn = document.getElementById('collapse-all');
      const sortLatestBtn = document.getElementById('sort-latest');
      const sortEarliestBtn = document.getElementById('sort-earliest');
      const filterBtns = document.querySelectorAll('.filter-btn');

      // --- STATE ---
      let isLatestFirst = false;
      let currentFilter = 'all';

      // --- FUNCTIONS ---
      function updateView() {
        let visibleEntries = (currentFilter === 'all') ? allEntries : allEntries.slice(-currentFilter);
        const sortedEntries = isLatestFirst ? [...visibleEntries].reverse() : visibleEntries;

        traceContainer.innerHTML = '';
        sortedEntries.forEach(entry => traceContainer.appendChild(entry));

        sortLatestBtn.classList.toggle('active', isLatestFirst);
        sortEarliestBtn.classList.toggle('active', !isLatestFirst);
        filterBtns.forEach(btn => btn.classList.toggle('active', String(currentFilter) === btn.dataset.filter));
        
        updateExpandCollapseButtons();
      }

      function updateExpandCollapseButtons() {
        const details = Array.from(traceContainer.querySelectorAll(':scope > details'));
        if (details.length === 0) return;
        const allExpanded = details.every(d => d.open);
        const allCollapsed = details.every(d => !d.open);
        expandAllBtn.classList.toggle('active', allExpanded);
        collapseAllBtn.classList.toggle('active', allCollapsed);
      }

      // --- EVENT LISTENERS ---
      sortLatestBtn.addEventListener('click', () => { if (!isLatestFirst) { isLatestFirst = true; updateView(); } });
      sortEarliestBtn.addEventListener('click', () => { if (isLatestFirst) { isLatestFirst = false; updateView(); } });
      
      filterBtns.forEach(btn => btn.addEventListener('click', () => {
        const newFilter = btn.dataset.filter;
        if (currentFilter !== newFilter) {
          currentFilter = (newFilter === 'all') ? 'all' : Number(newFilter);
          updateView();
        }
      }));

      expandAllBtn.addEventListener('click', () => {
        traceContainer.querySelectorAll(':scope > details').forEach(d => d.open = true);
        updateExpandCollapseButtons();
      });
      collapseAllBtn.addEventListener('click', () => {
        traceContainer.querySelectorAll(':scope > details').forEach(d => d.open = false);
        updateExpandCollapseButtons();
      });

      traceContainer.addEventListener('toggle', (e) => {
        if (e.target.matches('#trace-container > details')) updateExpandCollapseButtons();
        if (e.target.parentElement === traceContainer && e.target.open) {
          e.target.querySelectorAll('details').forEach(child => child.open = true);
        }
      }, true);

      // --- INITIAL STATE ---
      isLatestFirst = true;
      updateView();
    });
  </script>
  </head><body><h1>Playwright Trace Report</h1>
  <div class="controls">
    <button id="expand-all">Expand All</button>
    <button id="collapse-all">Collapse All</button>
    <span style="margin: 0 0.5em; border-left: 1px solid #ccc;"></span>
    <button id="sort-latest">Latest First</button>
    <button id="sort-earliest">Earliest First</button>
    <span style="margin: 0 0.5em; border-left: 1px solid #ccc;"></span>
    <span style="margin-right: 0.5em;">Show:</span>
    <button data-filter="all" class="filter-btn">All</button>
    <button data-filter="50" class="filter-btn">Last 50</button>
    <button data-filter="10" class="filter-btn">Last 10</button>
  </div>
  <div id="trace-container">`;
  for (const item of grouped) {
    html += renderGroupOrEvent(item);
  }
  html += '</div></body></html>';

  // Write the report and clean up
  fs.writeFileSync(outputHtmlPath, html, 'utf-8');
  console.log(`HTML report generated at: ${outputHtmlPath}`);
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`Cleaned up temporary folder: ${tempDir}`);
  }
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node analyze_trace.js <trace.zip | folder>');
    process.exit(1);
  }
  (async () => {
    const target = args[0];
    if (fs.lstatSync(target).isDirectory()) {
      const results = await analyzeFolder(target);
      console.log(JSON.stringify(results, null, 2));
    } else if (target.endsWith('.zip')) {
      const result = await analyzeTrace(target);
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error('Invalid input: must be a trace.zip file or a folder containing subfolders with trace.zip');
      process.exit(1);
    }
  })();
}

module.exports = { analyzeTrace, analyzeFolder, generateTraceHtmlReport }; 