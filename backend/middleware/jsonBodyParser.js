const express = require('express');

// The assistant accepts at most 30k CV + 20k offer UTF-16 code units. Even
// JSON's worst-case six-byte escaping fits below 512 KiB with room for fields.
const ASSISTANT_JSON_LIMIT_BYTES = 512 * 1024;
const standardJson = express.json(); // Keep Express's 100 KiB default elsewhere.
const assistantJson = express.json({ limit: ASSISTANT_JSON_LIMIT_BYTES });
const largerBodies = new Set([
  '/api/assistant/cv-analyses',
  '/api/assistant/conversations',
]);

module.exports = function jsonBodyParser(req, res, next) {
  const parser = req.method === 'POST' && largerBodies.has(req.path) ? assistantJson : standardJson;
  return parser(req, res, next);
};
module.exports.ASSISTANT_JSON_LIMIT_BYTES = ASSISTANT_JSON_LIMIT_BYTES;
