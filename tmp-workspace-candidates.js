
const a=require('../_generated/i18n-todo.json');
const ns=/workspace-sidebar-core|workspace-overview|workspace-create|view-all-workspaces|create-new-team|team-onboarding|home/;
let n=0;
for(const x of a){
 const t=String(x.text||'').trim();
 if(!ns.test((x.ns||[]).join(','))) continue;
 if(!t||/[{}]|<\/?[A-Za-z]|https?:\/\//.test(t))continue;
 if(/^\(?\s*(?:optional|loading|not specified)\)?[.:…]*$/i.test(t))continue;
 if(/^[A-Z][A-Z0-9 _+./:-]*$/.test(t)&&t.length<24)continue;
 if(/^[a-z][a-z -]*$/.test(t))continue;
 console.log(JSON.stringify({count:x.count,text:t})); if(++n>=300)break;
}

