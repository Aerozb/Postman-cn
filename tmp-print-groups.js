
const fs=require('fs');
const a=require('./tmp-i18n-todo.json');
const groups=[
 ['workspace',/workspace-sidebar-core|workspace-overview|workspace-create|view-all-workspaces|create-new-team|team-onboarding|home/],
 ['local',/local-filesystem|files-sidebar|workbench-mock-create-local/],
 ['monitor',/monitors-core|api-mock-core|self-managed-clusters/],
 ['vault',/vault/],
 ['workbench',/workbench-(?:core|request|example|mock|collection|folder)|sidebar-(?:collection|history)/],
 ['settings',/settings|proxy/],
 ['integration',/integrations|team-profile|team-settings|collaboration-errors|invite-flow/]
];
for(const [name,re] of groups){
 console.log('\n###'+name);
 let n=0;
 for(const x of a){
  const t=String(x.text||'').trim(), ns=(x.ns||[]).join(',');
  if(re.test(ns) && t && !/[{}]|<\/?[A-Za-z]|https?:\/\//.test(t) && !/^\(?\s*(?:optional|loading|not specified)\)?[.:…]*$/i.test(t) && !/^\s*(?:[A-Z][A-Z0-9 _+./:-]*|[a-z][a-z -]*)\s*$/.test(t) && t.length<=240){
   console.log(x.count+'\t'+t); if(++n>=180) break;
  }
 }
}

