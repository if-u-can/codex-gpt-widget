import fs from 'node:fs';
import path from 'node:path';

export function isSubscriptionAccount(connection, auth={}) {
  if(connection.key || connection.id!=='openai')return false;
  if(typeof auth.OPENAI_API_KEY==='string'&&auth.OPENAI_API_KEY.trim())return false;
  if(auth.auth_mode==='apikey')return false;
  let official=false;
  try{official=new URL(connection.baseUrl||'https://api.openai.com/v1').origin==='https://api.openai.com';}catch{}
  return official && (auth.auth_mode==='chatgpt' || !!auth.tokens?.access_token);
}
export function detectDisplayMode(config) {
  let connection;
  try{connection=config.resolve();}catch{return 'api';}
  if(connection.key)return 'api';
  let auth={};
  try{const file=path.join(config.codexHome,'auth.json');if(fs.statSync(file).size<1024*1024)auth=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  return isSubscriptionAccount(connection,auth)?'subscription':'api';
}
