// AITraceRemediator: analyze_trace.js
// Uses Genkit, OpenAI, and adm-zip to analyze Playwright trace.zip files

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { genkit } = require('genkit');
const { openAI, gpt4o } = require('genkitx-openai');

// src/analyze_trace.js show that dotenv loads the OPENAI_API_KEY from a .env file. The genkitx-openai plugin will then automatically use this key. Since the user has the correct .env setup, all they need to do is run the application
const dotenv = require('dotenv');
dotenv.config();

// Add crypto for generating hashes
const crypto = require('crypto');

const ai = genkit({
  plugins: [
    openAI(),
  ],
  // model: gemini20Flash, // set default model
  model: gpt4o,
});


// Optimized filtering to include only essential data for LLM analysis
function extractEssentialData(action) {
  const essential = {
    title: action.title,
    startTime: action.startTime,
    endTime: action.endTime,
    duration: action.duration
  };

  // Include error information if present
  if (action.error) {
    essential.error = {
      message: action.error.message,
      stack: action.error.stack?.split('\n')[0] // Only first line of stack for brevity
    };
  }

  // Include essential parameters based on action type
  if (action.params) {
    const params = {};

    // For navigation actions, include URL
    if (action.title.includes('goto') || action.title.includes('navigate')) {
      if (action.params.url) params.url = action.params.url;
    }

    // For interaction actions, include selector and value
    if (action.title.includes('click') || action.title.includes('fill') || action.title.includes('type')) {
      if (action.params.selector) params.selector = action.params.selector;
      if (action.params.value) params.value = action.params.value;
      if (action.params.text) params.text = action.params.text;
    }

    // For wait actions, include selector and condition
    if (action.title.includes('wait')) {
      if (action.params.selector) params.selector = action.params.selector;
      if (action.params.state) params.state = action.params.state;
      if (action.params.timeout) params.timeout = action.params.timeout;
    }

    // For keyboard actions, include key
    if (action.title.includes('press') || action.title.includes('key')) {
      if (action.params.key) params.key = action.params.key;
    }

    // For assertions and checks, include expected values
    if (action.title.includes('expect') || action.title.includes('assert')) {
      if (action.params.expected) params.expected = action.params.expected;
      if (action.params.actual) params.actual = action.params.actual;
    }

    // Only include params if we found relevant ones
    if (Object.keys(params).length > 0) {
      essential.params = params;
    }
  }

  return essential;
}

// Function to extract context options from trace title
function extractContextOptions(rootActions) {
  const contextOptions = {
    title: null,
    testName: null,
    metadata: null,
    ticket: null,
    tcs: null,
    taskName: null
  };

  // Find the first action that might contain title information
  for (const action of rootActions) {
    if (action.title && action.title.includes('›')) {
      contextOptions.title = action.title;

      // Extract test name (part before the JSON)
      const parts = action.title.split(' {');
      if (parts.length > 0) {
        contextOptions.testName = parts[0].trim();
      }

      // Extract JSON metadata if present
      const jsonMatch = action.title.match(/\{.*\}$/);
      if (jsonMatch) {
        try {
          const jsonStr = jsonMatch[0];
          contextOptions.metadata = JSON.parse(jsonStr);

          // Extract specific fields for easy access
          if (contextOptions.metadata.ticket) {
            contextOptions.ticket = contextOptions.metadata.ticket;
          }
          if (contextOptions.metadata.tcs) {
            contextOptions.tcs = contextOptions.metadata.tcs;
          }
          if (contextOptions.metadata.taskName) {
            contextOptions.taskName = contextOptions.metadata.taskName;
          }
        } catch (e) {
          console.warn('Failed to parse JSON metadata from title:', e.message);
        }
      }
      break; // Use the first matching title
    }
  }

  return contextOptions;
}

// Function to normalize stack trace for comparison
function normalizeStackTrace(stackTrace) {
  if (!stackTrace) return '';

  return stackTrace
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0) // Remove empty lines
    .map(line => {
      // Keep error messages and stack trace lines, but normalize file paths
      if (line.startsWith('TimeoutError:') || line.startsWith('Error:')) {
        // Normalize timeout values and selectors for comparison
        return line.replace(/\d+ms/g, 'XXXms')
          .replace(/"[^"]*"/g, '"SELECTOR"')
          .replace(/'[^']*'/g, "'SELECTOR'");
      }
      if (line.startsWith('Call log:')) {
        return line;
      }
      if (line.startsWith('- ') || line.startsWith('waiting for')) {
        // Normalize selectors in waiting conditions
        return line.replace(/locator\('[^']*'\)/g, "locator('SELECTOR')")
          .replace(/locator\("[^"]*"\)/g, 'locator("SELECTOR")')
          .replace(/"[^"]*"/g, '"SELECTOR"')
          .replace(/'[^']*'/g, "'SELECTOR'");
      }
      if (line.startsWith('at ')) {
        // Normalize file paths and line numbers
        return line.replace(/\/[^:]+:/g, '/PATH:')
          .replace(/:\d+:\d+/g, ':XX:XX')
          .replace(/"[^"]*"/g, '"SELECTOR"')
          .replace(/'[^']*'/g, "'SELECTOR'");
      }
      return line;
    })
    .join('\n');
}

// Function to generate a hash for similar stacktrace detection
function generateStackTraceHash(stackTrace) {
  const normalized = normalizeStackTrace(stackTrace);
  return crypto.createHash('md5').update(normalized).digest('hex');
}

// Function to save context options and stack trace
function saveAnalysisContext(analysisResult, folderPath) {
  const contextData = {
    ...analysisResult, // Save the entire analysis result
    stackTraceHash: generateStackTraceHash(analysisResult.stackTrace),
    folderPath,
    timestamp: new Date().toISOString(),
    normalizedStackTrace: normalizeStackTrace(analysisResult.stackTrace)
  };

  const contextFile = path.join(path.dirname(folderPath), 'analysis_contexts.json');
  let contexts = [];

  // Load existing contexts if file exists
  if (fs.existsSync(contextFile)) {
    try {
      const existingData = fs.readFileSync(contextFile, 'utf-8');
      contexts = JSON.parse(existingData);
    } catch (error) {
      console.warn('Failed to load existing contexts:', error.message);
      contexts = [];
    }
  }

  // Add new context
  contexts.push(contextData);

  // Save updated contexts
  try {
    fs.writeFileSync(contextFile, JSON.stringify(contexts, null, 2), 'utf-8');
    console.log(`Saved analysis context to: ${contextFile}`);
  } catch (error) {
    console.error('Failed to save analysis context:', error.message);
  }

  return contextData;
}

// Function to find similar stacktrace in saved contexts
function findSimilarStackTrace(normalizedStackTrace, folderPath, threshold = 0.8) {
  const contextsFile = path.join(folderPath, 'analysis_contexts.json');

  if (!fs.existsSync(contextsFile)) {
    return null;
  }

  try {
    const contexts = JSON.parse(fs.readFileSync(contextsFile, 'utf-8'));

    for (const context of contexts) {
      if (context.normalizedStackTrace) {
        const similarity = calculateStackTraceSimilarity(normalizedStackTrace, context.normalizedStackTrace);
        if (similarity >= threshold) {
          return {
            similarity: similarity,
            // Return the complete analysis result from the context
            skipped: context.skipped || false,
            explanation: context.explanation || '',
            contextOptions: context.contextOptions || {},
            stackTrace: context.stackTrace || '',
            folderPath: context.folderPath,
            timestamp: context.timestamp,
            stackTraceHash: context.stackTraceHash
          };
        }
      }
    }
  } catch (error) {
    console.error('Error reading analysis contexts:', error);
  }

  return null;
}

// Function to calculate similarity between two normalized stack traces
function calculateStackTraceSimilarity(stackTrace1, stackTrace2) {
  if (!stackTrace1 || !stackTrace2) return 0;

  const lines1 = stackTrace1.split('\n').filter(line => line.trim());
  const lines2 = stackTrace2.split('\n').filter(line => line.trim());

  if (lines1.length === 0 || lines2.length === 0) return 0;

  let matchingLines = 0;
  const maxLines = Math.max(lines1.length, lines2.length);

  // Compare each line
  for (let i = 0; i < Math.min(lines1.length, lines2.length); i++) {
    if (lines1[i] === lines2[i]) {
      matchingLines++;
    } else {
      // Check for partial matches (e.g., same error type, same function calls)
      const similarity = calculateLineSimilarity(lines1[i], lines2[i]);
      if (similarity > 0.7) {
        matchingLines += similarity;
      }
    }
  }

  return matchingLines / maxLines;
}

// Function to calculate similarity between two lines
function calculateLineSimilarity(line1, line2) {
  if (line1 === line2) return 1.0;

  // Extract key parts for comparison
  const extractKeyParts = (line) => {
    // Extract error types, function names, etc.
    const parts = [];

    // Error type
    if (line.includes('Error:')) {
      parts.push(line.split('Error:')[0] + 'Error');
    }

    // Function calls in stack trace
    if (line.includes('at ')) {
      const atMatch = line.match(/at\s+([^(]+)/);
      if (atMatch) {
        parts.push(atMatch[1].trim());
      }
    }

    // Selectors and waiting conditions
    if (line.includes('waiting for')) {
      parts.push('waiting_for');
    }

    return parts;
  };

  const parts1 = extractKeyParts(line1);
  const parts2 = extractKeyParts(line2);

  if (parts1.length === 0 || parts2.length === 0) return 0;

  const commonParts = parts1.filter(part => parts2.includes(part));
  return commonParts.length / Math.max(parts1.length, parts2.length);
}

async function analyzeTrace(zipPath) {
  let prompt; let completion; let explanation;

  const subfolder = path.dirname(zipPath);
  const result = await generateTraceHtmlReport(zipPath, path.join(subfolder, 'trace.html'));
  const rootActions = result.grouped;
  const traceFolder = result.traceFolder;

  // Sort rootActions by timestamp (latest first) before processing
  const latestFirstRootActions = [...rootActions].sort((a, b) => {
    const timeA = a.timestamp || a.startTime || a.monotonicTime || 0;
    const timeB = b.timestamp || b.startTime || b.monotonicTime || 0;
    return timeB - timeA;
  });

  // Extract context options from the trace
  const contextOptions = extractContextOptions(latestFirstRootActions);

  const stackTrace = composeStackTraceFromFirstError(traceFolder);

  // Check for similar stacktraces
  const normalizedStackTrace = normalizeStackTrace(stackTrace);
  const similarStackTrace = findSimilarStackTrace(normalizedStackTrace, path.dirname(subfolder));

  if (similarStackTrace) {
    const matchType = similarStackTrace.similarity === 1.0 ? 'identical' : 'similar';
    const similarityPercentage = Math.round(similarStackTrace.similarity * 100);

    // Create explanation string for similar stack trace
    const explanation = `

    🔍 Found ${matchType} stacktrace (${similarityPercentage}% match)
    
    *THIS Stack Trace:*
    ${stackTrace}

    ⏭️ Original analysis: ${similarStackTrace.contextOptions.tcs} [${similarStackTrace.folderPath}]
    ${similarStackTrace.contextOptions.tcs}
    ${similarStackTrace.explanation || 'No detailed explanation available from original analysis.'}
    
    `;

    // Clean up temporary folder
    if (traceFolder) {
      fs.rmSync(traceFolder, { recursive: true, force: true });
      console.log(`🧹 Cleaned up temporary folder: ${traceFolder}`);
    }

    return {
      skipped: true,
      explanation: explanation,
      contextOptions: contextOptions,
      stackTrace: stackTrace,
      similarContext: similarStackTrace
    };
  }

  // No similar stacktrace found, proceed with analysis and save context
  console.log('\n🆕 New stacktrace detected - proceeding with analysis');

  const traceInfo = JSON.stringify(
    rootActions
      .filter(action => action.title && action.type === 'action')
      .map(extractEssentialData)
      .filter(action =>
        // Only include actions that are likely relevant for UI flow analysis
        action.title.includes('goto') ||
        action.title.includes('click') ||
        action.title.includes('fill') ||
        action.title.includes('type') ||
        action.title.includes('press') ||
        action.title.includes('wait') ||
        action.title.includes('expect') ||
        action.title.includes('newPage') ||
        action.title.includes('navigate') ||
        action.error // Always include actions with errors
      ),
    null,
    2
  );

  fs.writeFileSync(path.join(subfolder, 'trace_info.json'), traceInfo, 'utf-8');
  console.log(`Optimized trace info length: ${traceInfo.length}`);

  // 6/20/2025 - disabled analyzeHtmlSnapshots for now: Saw that the HTML that has the "We were unable to process your request, please try again later" was in the trace,
  // but in the middle, not the last few snapshots as desired, so the LLM analysis was not useful.
  // Extract HTML content from rootActions
  // const htmlSnapshots = extractHtmlSnapshots(rootActions, 3);
  // await analyzeHtmlSnapshots(htmlSnapshots);

  if (traceFolder) {
    fs.rmSync(traceFolder, { recursive: true, force: true });
    console.log(`Cleaned up temporary folder: ${traceFolder}`);
  }

  // DO NOT DELETE.
  // Read system prompt from file
  const systemPromptPath = path.join(__dirname, '..', 'prompts', 'systemPrompt.txt');
  const systemPrompt = fs.readFileSync(systemPromptPath, 'utf-8');

  completion = await ai.generate({
    system: systemPrompt,
    prompt: traceInfo,
    messages: [
    ],
    maxTurns: 1000
  });

  let testFlow = completion.messages[completion.messages.length - 1].content[0].text
  testFlow = testFlow.replace('[trace path here]', zipPath)

  // Format the output by preserving blank lines and original spacing
  explanation = testFlow
    .split('\n')
    .map(line => line.trimEnd()) // Only trim trailing whitespace, preserve leading spaces
    .join('\n');

  explanation = `

${explanation}

*Stack Trace:*
${stackTrace}

  `

  const analysisResult = {
    skipped: false,
    explanation: explanation,
    contextOptions: contextOptions,
    stackTrace: stackTrace
  };

  // Save the complete analysis result for future comparisons
  const savedContext = saveAnalysisContext(analysisResult, subfolder);
  console.log(`💾 Saved context with hash: ${savedContext.stackTraceHash.substring(0, 8)}...`);

  return {
    ...analysisResult,
    savedContext: savedContext
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

  let totalAnalyzed = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const subfolder of subfolders) {
    const traceZip = path.join(subfolder, 'trace.zip');
    if (fs.existsSync(traceZip)) {
      try {
        const analysis = await analyzeTrace(traceZip);
        console.log(`
          
          ${analysis.explanation}
          
        `);
        results.push({ subfolder, ...analysis });

        if (analysis.skipped) {
          totalSkipped++;
        } else {
          totalAnalyzed++;
        }
      } catch (err) {
        results.push({ subfolder, error: err.message });
        totalErrors++;
      }
    }
  }

  // Display summary
  console.log('\n' + '='.repeat(80));
  console.log('📊 ANALYSIS SUMMARY');
  console.log('='.repeat(80));
  console.log(`📈 Total folders processed: ${results.length}`);
  console.log(`🆕 New analyses performed: ${totalAnalyzed}`);
  console.log(`⏭️  Skipped (similar stacktraces): ${totalSkipped}`);
  console.log(`❌ Errors encountered: ${totalErrors}`);

  if (totalSkipped > 0) {
    console.log('\n💡 Tip: Similar stacktraces were detected and skipped to avoid redundant analysis.');
    console.log('   Check the analysis_contexts.json file to review saved contexts.');
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

  // Store trace folder path before cleanup
  const traceFolderPath = traceFolder;

  /*
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`Cleaned up temporary folder: ${tempDir}`);
  }
  */

  return { grouped, traceFolder: traceFolderPath };
}

async function analyzeHtmlSnapshots(htmlSnapshots) {

  // Prepare HTML content for LLM analysis
  let htmlContentForLLM = '';
  htmlSnapshots.forEach((snapshot, index) => {
    console.log(`\n=== HTML Snapshot ${index + 1} ===`);
    console.log(`Source: ${snapshot.source}`);
    console.log(`Action: ${snapshot.actionTitle}`);

    htmlContentForLLM += `\n=== HTML Snapshot ${index + 1} ===\n`;
    htmlContentForLLM += `Source: ${snapshot.source}\n`;
    htmlContentForLLM += `Action: ${snapshot.actionTitle}\n`;
    htmlContentForLLM += `Timestamp: ${snapshot.timestamp}\n`;

    if (snapshot.html) {
      const htmlString = JSON.stringify(snapshot.html, null, 2);
      console.log('HTML DOM:', htmlString);
      htmlContentForLLM += `HTML Content:\n${htmlString}\n`;
    }
    if (snapshot.attachment) {
      console.log('Attachment:', snapshot.attachment);
      htmlContentForLLM += `Attachment: ${JSON.stringify(snapshot.attachment, null, 2)}\n`;
    }
    htmlContentForLLM += '\n' + '='.repeat(50) + '\n';
  });

  // Send HTML content to LLM for analysis
  if (htmlContentForLLM.trim()) {
    console.log('\nSending HTML content to LLM for analysis...');

    const htmlAnalysis = await ai.generate({
      system: `You are an expert web developer and UI/UX analyst. Analyze the provided HTML content and describe:
1. What page or screen is being displayed
2. Key UI elements visible (buttons, forms, inputs, text, etc.)
3. Any error messages, warnings, or issues visible on the page
4. The overall state of the application
5. Any loading states, modals, or overlays present
6. Form validation states or error indicators
7. Navigation elements and their state

Be concise but thorough in your analysis. Focus on identifying any problems or errors that might indicate test failures.`,
      prompt: `Please analyze the following HTML content from a Playwright test trace and describe what you see. 
      Pay special attention to any errors, warnings, or issues that might be visible on the page:
      
      ${htmlContentForLLM}`,
      messages: [],
      maxTurns: 1
    });

    const analysis = htmlAnalysis.messages[htmlAnalysis.messages.length - 1].content[0].text;
    console.log('\n=== LLM HTML Analysis ===');
    console.log(analysis);
  }
}

// Function to extract HTML content from rootActions
function extractHtmlSnapshots(latestFirstRootActions, numSnapshots = 3) {
  const htmlSnapshots = [];

  // Recursively search through all actions and their children for HTML content
  function findHtml(actions, depth = 0) {
    for (const action of actions) {
      // Stop if we already found enough snapshots
      if (htmlSnapshots.length >= numSnapshots) {
        return true; // Signal to stop processing
      }

      // Debug: log action types and properties to understand the structure
      if (depth === 0) {
        // console.log(`Action type: ${action.type}, title: ${action.title}`);
        if (action.type !== 'action') {
          // console.log(`Non-action properties:`, Object.keys(action));
        }
      }

      // Look for HTML content in various possible locations
      if (action.html) {
        htmlSnapshots.push({
          timestamp: action.timestamp || action.startTime,
          monotonicTime: action.monotonicTime,
          html: action.html,
          actionTitle: action.title,
          source: 'direct_html'
        });
        // console.log(`Found HTML in direct property for action: ${action.title}`);

        // Check if we've found enough after adding this one
        if (htmlSnapshots.length >= numSnapshots) {
          return true; // Signal to stop processing
        }
      }

      // Look for HTML content in attachments
      if (action.attachments) {
        for (const attachment of action.attachments) {
          if (htmlSnapshots.length >= numSnapshots) {
            return true; // Signal to stop processing
          }

          // console.log(`Checking attachment: ${attachment.name}, contentType: ${attachment.contentType}`);
          if (attachment.name === 'trace' ||
            attachment.name === 'dom-snapshot' ||
            attachment.name === 'page' ||
            (attachment.contentType && attachment.contentType.includes('html')) ||
            (attachment.contentType && attachment.contentType.includes('json'))) {
            htmlSnapshots.push({
              timestamp: action.timestamp || action.startTime,
              monotonicTime: action.monotonicTime,
              attachment: attachment,
              actionTitle: action.title,
              source: 'attachment'
            });
            // console.log(`Found HTML attachment: ${attachment.name}`);

            // Check if we've found enough after adding this one
            if (htmlSnapshots.length >= numSnapshots) {
              return true; // Signal to stop processing
            }
          }
        }
      }

      // Look for DOM or page content in other properties
      if (action.page || action.dom || action.snapshot) {
        htmlSnapshots.push({
          timestamp: action.timestamp || action.startTime,
          monotonicTime: action.monotonicTime,
          html: action.page || action.dom || action.snapshot,
          actionTitle: action.title,
          source: 'page_dom_snapshot'
        });
        // console.log(`Found HTML in page/dom/snapshot property for action: ${action.title}`);

        // Check if we've found enough after adding this one
        if (htmlSnapshots.length >= numSnapshots) {
          return true; // Signal to stop processing
        }
      }

      // Search in children if they exist and we haven't found enough snapshots
      if (action.children && action.children.length > 0 && htmlSnapshots.length < numSnapshots) {
        const shouldStop = findHtml(action.children, depth + 1);
        if (shouldStop) {
          return true; // Propagate the stop signal up
        }
      }
    }

    return false; // Continue processing
  }

  // If looking for 3 HTML snapshots:
  // - Finds 1st HTML action → continues
  // - Finds 2nd HTML action → continues  
  // - Finds 3rd HTML action → STOPS immediately
  // - Never processes remaining actions/children
  findHtml(latestFirstRootActions);

  console.log(`Found ${htmlSnapshots.length} HTML snapshots (stopped after finding ${numSnapshots} or reaching end)`);

  return htmlSnapshots;
}

/**
 * Compose a stack trace from the first error found in the test.trace file.
 * This function reads the trace file directly instead of using rootActions.
 * @param {string} traceFolder - Path to the trace folder containing test.trace
 * @returns {string} Formatted stack trace or message if no error found
 */
function composeStackTraceFromFirstError(traceFolder) {
  // Helper function to extract stack trace from test.trace file
  function extractStackTraceFromTrace(traceFilePath) {
    if (!fs.existsSync(traceFilePath)) {
      console.log(`Error: Trace file not found: ${traceFilePath}`);
      return null;
    }

    let firstError = null;

    try {
      const traceContent = fs.readFileSync(traceFilePath, 'utf-8');
      const lines = traceContent.split('\n');

      for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum].trim();
        if (!line) continue;

        try {
          const traceEntry = JSON.parse(line);

          // Look for entries with error information
          if (traceEntry.error && traceEntry.error.message) {
            const errorInfo = traceEntry.error;

            // This is our first error - extract the information
            firstError = {
              lineNumber: lineNum + 1,
              callId: traceEntry.callId || 'unknown',
              apiName: traceEntry.apiName || 'unknown',
              errorMessage: errorInfo.message || '',
              errorStack: errorInfo.stack || '',
              params: traceEntry.params || {},
              stackTrace: traceEntry.stack || []
            };
            break;
          }
        } catch (jsonError) {
          // Skip non-JSON lines
          continue;
        }
      }
    } catch (fileError) {
      console.log(`Error reading trace file: ${fileError.message}`);
      return null;
    }

    return firstError;
  }

  // Helper function to compose readable stack trace from error information
  function composeStackTrace(errorInfo) {
    if (!errorInfo) {
      return "No error found in trace data.";
    }

    // Extract the main error message
    const errorMessage = errorInfo.errorMessage;
    const errorStack = errorInfo.errorStack;

    // Start composing the stack trace
    const stackTraceLines = [];

    // Add the main error message
    if (errorMessage) {
      // Clean up ANSI escape sequences
      let cleanMessage = errorMessage
        .replace(/\u001b\[2m/g, '')
        .replace(/\u001b\[22m/g, '')
        .replace(/\u001b\[39m/g, '')
        .replace(/\u001b\[31m/g, '')
        .replace(/\u001b\[[0-9;]*m/g, '');

      // Check if this is a timeout error and construct the proper format
      if (cleanMessage.includes('Timeout') && cleanMessage.includes('exceeded')) {
        // Extract timeout value if present
        const timeoutMatch = cleanMessage.match(/(\d+)ms/);
        const timeout = timeoutMatch ? timeoutMatch[1] : '30000';

        // Construct the proper TimeoutError format
        if (errorInfo.apiName && errorInfo.apiName !== 'unknown') {
          cleanMessage = `TimeoutError: ${errorInfo.apiName}: Timeout ${timeout}ms exceeded.`;
        }
      }

      stackTraceLines.push(cleanMessage);
    }

    // Add call log if available in the error stack
    if (errorStack && errorStack.includes('Call log:')) {
      const callLogMatch = errorStack.match(/Call log:([\s\S]*?)(?=\n\s*at|$)/);
      if (callLogMatch) {
        stackTraceLines.push('Call log:');
        const callLogLines = callLogMatch[1].split('\n');
        for (const line of callLogLines) {
          if (line.trim()) {
            // Clean the line and add proper indentation
            let cleanLine = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
            if (cleanLine.startsWith('- ')) {
              stackTraceLines.push(`  ${cleanLine}`);
            } else if (cleanLine) {
              stackTraceLines.push(`  - ${cleanLine}`);
            }
          }
        }
      }
    } else {
      // If no call log in error stack, try to construct one from params
      if (errorInfo.params && errorInfo.params.selector) {
        stackTraceLines.push('Call log:');
        let selectorText = errorInfo.params.selector;

        // Add additional context based on API name
        if (errorInfo.apiName && errorInfo.apiName.includes('click')) {
          if (errorInfo.params.options && errorInfo.params.options.first) {
            selectorText += "').first()";
          }
          stackTraceLines.push(`  - waiting for locator('${selectorText}')`);
        } else if (errorInfo.apiName && errorInfo.apiName.includes('textContent')) {
          stackTraceLines.push(`  - waiting for locator('${selectorText}')`);
        } else {
          stackTraceLines.push(`  - waiting for locator('${selectorText}')`);
        }
      }
    }

    // Extract and format the stack trace (clean format)
    // Filter out Playwright internal calls and keep only test-related calls
    if (errorStack) {
      // Split by lines and look for stack trace entries (lines starting with "at")
      const stackLines = errorStack.split('\n');
      let foundStackTrace = false;

      for (const line of stackLines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('at ')) {
          // Clean the line and remove ANSI escape sequences
          let cleanLine = trimmedLine.replace(/\u001b\[[0-9;]*m/g, '');

          // Filter out Playwright internal calls - keep only test code
          const isPlaywrightInternal = false;
          /*
          DO NOT DELETE THIS COMMENT
          cleanLine.includes('node_modules/playwright') ||
            cleanLine.includes('playwright-core/lib') ||
            cleanLine.includes('/server/') ||
            cleanLine.includes('/dispatchers/') ||
            cleanLine.includes('ProgressController') ||
            cleanLine.includes('FrameDispatcher') ||
            cleanLine.includes('DispatcherConnection');
          */

          // Only include test-related stack trace entries
          if (!isPlaywrightInternal) {
            if (!foundStackTrace) {
              stackTraceLines.push(''); // Add blank line before stack trace
              foundStackTrace = true;
            }
            stackTraceLines.push(`    ${cleanLine}`);
          }
        }
      }
    }

    // If we didn't find any test-related stack trace in the error stack,
    // try to use the trace entry's stack property
    if (!stackTraceLines.some(line => line.trim().startsWith('at ')) && errorInfo.stackTrace && Array.isArray(errorInfo.stackTrace)) {
      stackTraceLines.push(''); // Add blank line

      for (const stackEntry of errorInfo.stackTrace) {
        if (typeof stackEntry === 'object' && stackEntry.file) {
          // Filter out Playwright internal files
          if (!stackEntry.file.includes('node_modules/playwright') &&
            !stackEntry.file.includes('playwright-core')) {
            const location = `${stackEntry.file}:${stackEntry.line}:${stackEntry.column}`;
            const func = stackEntry.function ? ` (${stackEntry.function})` : '';
            stackTraceLines.push(`    at ${location}${func}`);
          }
        } else if (typeof stackEntry === 'string') {
          // Filter out Playwright internal entries
          if (!stackEntry.includes('node_modules/playwright') &&
            !stackEntry.includes('playwright-core')) {
            stackTraceLines.push(`    ${stackEntry}`);
          }
        }
      }
    }

    return stackTraceLines.join('\n');
  }

  // Determine the trace file path
  let traceFilePath;
  if (typeof traceFolder === 'string') {
    // Find the main trace file (e.g., trace.trace or test.trace)
    let traceFile = 'test.trace';
    if (!fs.existsSync(path.join(traceFolder, traceFile))) {
      traceFile = 'trace.trace';
      if (!fs.existsSync(path.join(traceFolder, traceFile))) {
        const foundFiles = fs.readdirSync(traceFolder).filter(f => f.endsWith('.trace'));
        if (foundFiles.length > 0) {
          traceFile = foundFiles[0];
        } else {
          return "No .trace file found in the trace folder.";
        }
      }
    }
    traceFilePath = path.join(traceFolder, traceFile);
  } else {
    // Legacy support: if traceFolder is actually rootActions, return message
    return "Legacy rootActions parameter detected. Please use trace folder path instead.";
  }

  // console.log(`DEBUG - Reading trace file: ${traceFilePath}`);

  // Extract the first error from the trace file
  const errorInfo = extractStackTraceFromTrace(traceFilePath);

  if (!errorInfo) {
    return "No errors found in trace data.";
  }

  // console.log(`DEBUG - First error found at line ${errorInfo.lineNumber} in trace:`);
  // console.log(`DEBUG - API Call: ${errorInfo.apiName}`);
  // console.log(`DEBUG - Call ID: ${errorInfo.callId}`);
  // console.log(`DEBUG - Error message: ${errorInfo.errorMessage}`);

  // Compose and return the stack trace
  const stackTrace = composeStackTrace(errorInfo);

  // console.log('DEBUG - Final composed stack trace:');
  // console.log(stackTrace);

  return stackTrace;
}

// Utility function to list all saved analysis contexts
function listSavedContexts(folderPath) {
  const contextFile = path.join(folderPath, 'analysis_contexts.json');

  if (!fs.existsSync(contextFile)) {
    console.log('No saved analysis contexts found.');
    return [];
  }

  try {
    const existingData = fs.readFileSync(contextFile, 'utf-8');
    const contexts = JSON.parse(existingData);

    console.log('\n📋 SAVED ANALYSIS CONTEXTS');
    console.log('='.repeat(60));

    contexts.forEach((context, index) => {
      console.log(`\n${index + 1}. Hash: ${context.stackTraceHash.substring(0, 12)}...`);
      console.log(`   Folder: ${context.folderPath}`);
      console.log(`   Timestamp: ${context.timestamp}`);
      if (context.contextOptions) {
        console.log(`   Test: ${context.contextOptions.testName || 'N/A'}`);
        console.log(`   Ticket: ${context.contextOptions.ticket || 'N/A'}`);
        console.log(`   TCS: ${context.contextOptions.tcs || 'N/A'}`);
      }
    });

    return contexts;
  } catch (error) {
    console.error('Failed to load saved contexts:', error.message);
    return [];
  }
}

// Utility function to clear saved analysis contexts
function clearSavedContexts(folderPath) {
  const contextFile = path.join(folderPath, 'analysis_contexts.json');

  if (fs.existsSync(contextFile)) {
    try {
      fs.unlinkSync(contextFile);
      console.log('✅ Cleared all saved analysis contexts.');
    } catch (error) {
      console.error('❌ Failed to clear saved contexts:', error.message);
    }
  } else {
    console.log('No saved contexts file found.');
  }
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node analyze_trace.js <trace.zip | folder>');
    console.log('       node analyze_trace.js --list-contexts <folder>');
    console.log('       node analyze_trace.js --clear-contexts <folder>');
    process.exit(1);
  }

  (async () => {
    const command = args[0];
    const target = args[1];

    if (command === '--list-contexts') {
      if (!target) {
        console.error('Please specify a folder path to list contexts from');
        process.exit(1);
      }
      listSavedContexts(target);
      return;
    }

    if (command === '--clear-contexts') {
      if (!target) {
        console.error('Please specify a folder path to clear contexts from');
        process.exit(1);
      }
      clearSavedContexts(target);
      return;
    }

    // Original analysis functionality
    const analysisTarget = command;
    if (fs.lstatSync(analysisTarget).isDirectory()) {
      const results = await analyzeFolder(analysisTarget);
      // Format output for better readability
      for (const result of results) {
        console.log('\n' + '='.repeat(80));
        console.log(`FOLDER: ${result.subfolder}`);
        console.log('='.repeat(80));
        if (result.error) {
          console.log(`ERROR: ${result.error}`);
        } else if (result.skipped) {
          console.log(`Original analysis: ${result.similarContext.folderPath}`);
          console.log(`SKIPPED: 
              ${result.explanation}`);
        } else if (result.explanation) {
          console.log(result.explanation);
        } else {
          console.log('Analysis completed - no explanation generated');
        }
      }
    } else if (analysisTarget.endsWith('.zip')) {
      const result = await analyzeTrace(analysisTarget);
      console.log('\n' + '='.repeat(80));
      console.log('TRACE ANALYSIS RESULT');
      console.log('='.repeat(80));
      if (result.error) {
        console.log(`ERROR: ${result.error}`);
      } else if (result.skipped) {
        console.log(`SKIPPED: ${result.explanation}`);
      } else if (result.explanation) {
        console.log(result.explanation);
      } else {
        console.log('Analysis completed - no explanation generated');
      }
    } else {
      console.error('Invalid input: must be a trace.zip file or a folder containing subfolders with trace.zip');
      process.exit(1);
    }
  })();
}

module.exports = {
  analyzeTrace,
  analyzeFolder,
  generateTraceHtmlReport,
  listSavedContexts,
  clearSavedContexts,
  findSimilarStackTrace,
  normalizeStackTrace,
  generateStackTraceHash,
  calculateStackTraceSimilarity
}; 