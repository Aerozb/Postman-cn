const fs = require('fs');
const all = require('../_generated/i18n-en-unique.json');
const cats = {
  workspace: /workspace-sidebar-core|workspace-overview|workspace-create|view-all-workspaces|create-new-team|team-onboarding|home/,
  local: /local-filesystem|files-sidebar|workbench-mock-create-local/,
  monitor: /monitors-core|api-mock-core|self-managed-clusters/,
  vault: /vault/,
  settings: /settings|proxy/,
  integration: /integrations|team-profile|team-settings|collaboration-errors|invite-flow/,
  request: /workbench-request|workbench-core|workbench-example|sidebar-collection|sidebar-history|api-client-core/
};
const skip = [
  /https?:\/\//i, /[{}]/, /<\/?[A-Za-z]/, /^\s*[\[\]`]/,
  /\b(?:CRL|HTTP\/2|TLSA|GOAWAY|DANE|SCT|nginx|IE7|WebDAV|PKCS|PEM|JWT|qop|WWW-Authenticate|content-length|CORS|BYOK|requestAggregate|pm\.|JSONPath|XPath)\b/i,
  /^[a-z][a-z -]*$/, /^[A-Z\d][A-Z\d _+./:-]*$/, /^[A-Za-z0-9_.:/-]+$/,
  /^\(?\s*(?:optional|loading|not specified|no query)\s*\)?[.:…]*$/i
];
for (const [name, re] of Object.entries(cats)) {
  const out = all.filter((x) => {
    const t = String(x.text || '').trim();
    const ns = (x.ns || []).join(',');
    if (!re.test(ns) || !t || t.length < 12 || t.length > 260) return false;
    if (skip.some((s) => s.test(t))) return false;
    if (/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\b.*\b(?:request|response)\b/i.test(t) && t.length > 180) return false;
    return true;
  }).sort((a, b) => b.count - a.count || a.text.length - b.text.length);
  fs.writeFileSync(`tmp-cat-${name}.json`, JSON.stringify(out, null, 2), 'utf8');
  console.log(name, out.length);
}
