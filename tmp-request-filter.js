const fs = require('fs');
const a = JSON.parse(fs.readFileSync('tmp-cat-request.json', 'utf8'));
const re = /workbench-request|workbench-example|cookies-modal/;
const bad = /^(?:Something went wrong|Just a faulty wire|Unable|Could not|Couldn't|Couldn’t|Cannot|Can't|Can't|Failed|An error|Error|The server|Connection|Response has already|Unsupported|Invalid|No results|No longer|The request has|This is a [1-5]xx|HTTP|TLS|SSL|Certificate|A stream|Trailing|Maximum|Offset|Path length|Hostname|Authorization helper|Access token|Username|Key contains|Response timed out|The requested resource|Requested resource|Cloud Agent|Parental|Mixed content|Socket|Syntax|Parse|Request Size|Local Address|Remote Address|TCP|Waiting \(TTFB\)|Certificate CN|Network|Response Loading|Loading response|Response time unavailable|Maximum response|Content-Type|User-Agent|Cache-Control|Accept:|The Cookie|The Cross-Site|The range|The method|The media|The identity|The expectation|The returned metadata|The URL|An entity|A general header|Indicates|Specifies|Can be used|Used to|Lets websites|Many HTTP|Stops pages|Determines|Contains information|For accurate|For a full|It was taking|The origin|The resource|This request was sent|When testing|A collection lets|A random|The field|Description only|The language selected|XHR|Postman uses|Postman can|Postbot|Named profile|The Azure|Service definition|UTC time|The User-Agent|The Content-Type)/i;
for (const x of a) {
  const t = String(x.text || '').replace(/\n/g, ' ');
  if (!re.test((x.ns || []).join(',')) || !t || bad.test(t)) continue;
  if (/[{}]|<\d+>/.test(t)) continue;
  if (/^[A-Za-z0-9_.:/-]+$/.test(t) && !/\s/.test(t)) continue;
  console.log(`${x.count}\t${t}`);
}
