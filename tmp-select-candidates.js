const all = require('./tmp-i18n-todo.json');
const fs = require('fs');
const technical = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT|HTTP(?:\/\d(?:\.\d)?)?|HTTPS|URL|URI|JSON|XML|HTML|YAML|Base64|Hex|SHA[- ]?\d+|OAuth(?:\s+[12](?:\.\d+)?)?|GraphQL|gRPC|WebSocket|Socket\.IO|MQTT|MCP|API|SDK|CLI|Git|JavaScript|TypeScript|Python|Java|Ruby|PHP|Rust|Markdown|Postbot|Postman|AWS|Azure|MySQL|Postgres|SQL Server|Dracula|Monokai|Ayu (?:Light|Dark)|Night Owl (?:Light|Dark)|Solarized (?:Light|Dark))$/i;
const skip = /https?:\/\/|^[`<>{}\[\]]|[{}]|<\d+>|\b(?:CRL|HTTP\/2|TLSA|GOAWAY|DANE|SCT|nginx|IE7|WebDAV|PKCS|PEM|JWT|qop|WWW-Authenticate|content-length|CORS|BYOK)\b/i;
const nsKeep = /^(?:workspace|api-client|app-header|settings|vault|monitors|workbench|sidebar|local-filesystem|workspace-overview|team-settings|integrations|unified-api|agent|performance|pull-request|version-control|import|cookies|global|service-accounts|user-onboarding|home|description|private-network|files|status|datasets|mcp|grpc|websocket|mqtt|kafka|proxy)/i;
const out = all.filter((x) => {
  const t = String(x.text || '').trim();
  if (!t || !/[A-Za-z]/.test(t) || x.count < 1) return false;
  if (/[{}]|<\d+>|<\/?[A-Za-z]/.test(t) || skip.test(t)) return false;
  if (/^[a-z][a-z -]*$/.test(t) || technical.test(t)) return false;
  if (/^[A-Za-z0-9_.:/-]+$/.test(t) && !/[ ]/.test(t)) return false;
  if (/^\(?\s*(?:optional|loading|no query|not specified)\s*\)?[.:…]*$/i.test(t)) return false;
  if (/^[A-Z\d][A-Z\d _+./:-]*$/.test(t) && t.length < 24) return false;
  return nsKeep.test((x.ns || []).join(','));
});
out.sort((a, b) => b.count - a.count || a.text.length - b.text.length);
console.log('count', out.length);
fs.writeFileSync('tmp-selected.json', JSON.stringify(out, null, 2), 'utf8');
for (const x of out) console.log(`${x.count}\t[${(x.ns || []).join(',')}]\t${x.text}`);
