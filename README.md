# AITraceRemediator

An AI-powered tool that analyzes Playwright test traces and automatically fixes failing tests. The tool uses OpenAI's GPT-4 to analyze test failures and suggest fixes, then attempts to apply them and verify the solution.

## Features
- Analyze Playwright `trace.zip` files (including network, console logs, etc.)
- Determine if the cause of the failure is a test code issue or an application issue
- Provide a detailed, but concise, explanation of the issue
- If it's an application issue, provide further failure analysis steps and recommendations
- If it's a test code issue, provide specific, actionable fixes for test failures including an updated test code
- Include references to the relevant network logs and console logs to support the decision
- Command-line interface for easy integration, both for folder and individual trace file

## Requirements
- Node.js 18+
- OpenAI API key (set as `OPENAI_API_KEY` environment variable)

## Installation
```
npm install
```

## Usage
Analyze a single trace file:
```
node analyze_trace.js /path/to/trace.zip
```

Analyze all trace.zip files in subfolders of a directory:
```
node src/analyze_trace.js /path/to/folder
```

## Output
The tool outputs a JSON object with the analysis, including:
- Explanation of the failure
- Whether it is a test or application issue
- Actionable fixes or further analysis steps
- References to relevant logs

## Example
```
node src/analyze_trace.js ./AITraceRemediator_artifacts/testing
```

## Testing
Unit tests should be added to ensure that trace.zip analysis output remains useful and accurate over time. 