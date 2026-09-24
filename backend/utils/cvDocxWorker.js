const { parentPort, workerData } = require('node:worker_threads');
const { extractDocxText } = require('./cvDocxText');
try { parentPort.postMessage({ text: extractDocxText(Buffer.from(workerData)) }); }
catch (error) { parentPort.postMessage({ code: error.code === 'CV_DOCX_LIMIT' ? error.code : 'CV_DOCX_INVALID' }); }
