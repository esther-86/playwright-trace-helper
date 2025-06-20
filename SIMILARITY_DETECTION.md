# Stacktrace Similarity Detection

This feature automatically detects similar stacktraces to avoid redundant analysis when processing multiple Playwright trace files.

## How it Works

1. **Context Extraction**: Each trace analysis extracts:
   - `contextOptions`: Test metadata (title, ticket, TCS, task name)
   - `stackTrace`: The error stacktrace from the trace

2. **Normalization**: Stacktraces are normalized by:
   - Replacing specific selectors with generic placeholders
   - Normalizing file paths and line numbers
   - Standardizing timeout values
   - Removing variable content while preserving structure

3. **Similarity Detection**: Uses MD5 hashing of normalized stacktraces for:
   - **Exact matches**: Identical normalized stacktraces (100% similarity)
   - **Similar matches**: Structural similarity above 80% threshold

4. **Context Saving**: Analysis contexts are saved to `analysis_contexts.json` containing:
   - Original context options and stacktrace
   - Normalized stacktrace and hash
   - Folder path and timestamp

## Usage

### Basic Analysis
```bash
# Analyze a single trace
node src/analyze_trace.js path/to/trace.zip

# Analyze all traces in subfolders
node src/analyze_trace.js path/to/parent/folder
```

### Managing Saved Contexts
```bash
# List all saved analysis contexts
node src/analyze_trace.js --list-contexts path/to/parent/folder

# Clear all saved contexts
node src/analyze_trace.js --clear-contexts path/to/parent/folder
```

## Example Output

When a similar stacktrace is detected:
```
🔍 Found identical stacktrace (100% match)
📁 Original analysis: /path/to/original/folder
📅 Original timestamp: 2025-01-20T10:30:00.000Z

🚫 Skipping re-analysis - same root problem as saved context

📋 Context Options from similar analysis:
   Test: ci-lumos/lumos-complete-task.spec.ts:10 › Validate...
   Ticket: TA-2989,@lumosTaskCompletion
   TCS: PJT-T507,SSP-T20,SSP-T21...
   Task: PJT - All Screens Site Task
```

## Benefits

- **Efficiency**: Avoids redundant LLM analysis calls
- **Cost Savings**: Reduces API usage for similar errors
- **Pattern Recognition**: Identifies recurring issues across test runs
- **Time Savings**: Faster processing of large trace collections

## File Structure

```
parent-folder/
├── analysis_contexts.json     # Saved contexts for similarity detection
├── subfolder1/
│   ├── trace.zip
│   ├── trace.html
│   └── trace_info.json
├── subfolder2/
│   ├── trace.zip
│   └── ...
└── ...
```

## Similarity Threshold

The default similarity threshold is 80%. Stacktraces with similarity above this threshold are considered "similar" and will skip re-analysis. This can be adjusted in the `findSimilarStackTrace` function if needed. 