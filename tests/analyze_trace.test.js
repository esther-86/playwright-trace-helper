const { analyzeTrace } = require('../src/analyze_trace');
const path = require('path');

test('analyzeTrace returns expected structure for a sample trace.zip', async () => {
  // This test assumes you have a sample trace.zip at ./sample_data/trace.zip
  const sampleZip = path.join(__dirname, 'sample_data', 'trace.zip');
  if (!require('fs').existsSync(sampleZip)) {
    console.warn('Sample trace.zip not found, skipping test.');
    return;
  }
  const result = await analyzeTrace(sampleZip);
  expect(result).toHaveProperty('explanation');
  expect(result).toHaveProperty('referencedLogs');
}); 