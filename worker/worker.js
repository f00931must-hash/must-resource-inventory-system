const encoder=new TextEncoder();
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
let oauth;
async function accessToken(env){
  if(oauth?.expires>Date.now()+60000&&oauth.project===env.FIREBASE_PROJECT_ID)return oauth.token;
  let account;try{account=JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)}catch{throw Error('Firebase Secret 格式錯誤')}
  if(account.project_id!==env.FIREBASE_PROJECT_ID)throw Error('Firebase 憑證專案不符');
  const now=Math.floor(Date.now()/1000),part=b64(encoder.encode(JSON.stringify({alg:'RS256',typ:'JWT'})))+'.'+b64(encoder.encode(JSON.stringify({iss:account.client_email,scope:'https://www.googleapis.com/auth/datastore',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})));
  const pem=account.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(pem),c=>c.charCodeAt(0)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const assertion=part+'.'+b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,encoder.encode(part)));
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
  const d=await r.json();if(!r.ok||!d.access_token)throw Error('Firebase 憑證無法登入');oauth={project:env.FIREBASE_PROJECT_ID,token:d.access_token,expires:Date.now()+d.expires_in*1000};return oauth.token;
}
function encodeValue(x){if(x===null)return {nullValue:null};if(typeof x==='boolean')return {booleanValue:x};if(typeof x==='number')return Number.isInteger(x)?{integerValue:String(x)}:{doubleValue:x};if(Array.isArray(x))return {arrayValue:{values:x.map(encodeValue)}};if(typeof x==='object')return {mapValue:{fields:encodeFields(x)}};return {stringValue:String(x)}}
const encodeFields=x=>Object.fromEntries(Object.entries(x).map(([k,v])=>[k,encodeValue(v)]));
function decodeValue(x){if('nullValue'in x)return null;if('integerValue'in x)return Number(x.integerValue);if('doubleValue'in x)return x.doubleValue;if('booleanValue'in x)return x.booleanValue;if('arrayValue'in x)return (x.arrayValue.values||[]).map(decodeValue);if('mapValue'in x)return decodeFields(x.mapValue.fields||{});return x.stringValue??x.timestampValue??''}
const decodeFields=x=>Object.fromEntries(Object.entries(x||{}).map(([k,v])=>[k,decodeValue(v)]));
async function rest(url,token,body){const r=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok){const e=Error('資料庫操作失敗：'+(d.error?.status||r.status));e.code=d.error?.status;e.status=r.status;throw e}return d}
function database(env,token){
  const root=`projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`,base='https://firestore.googleapis.com/v1/'+root;
  const snapshot=(ref,d)=>({id:ref.id,exists:Boolean(d),ref,version:d?.updateTime,data:()=>decodeFields(d?.fields)});
  const doc=path=>{const ref={path,id:path.split('/').at(-1)};ref.get=async()=>{try{return snapshot(ref,await rest(base+'/'+path.split('/').map(encodeURIComponent).join('/'),token))}catch(e){if(e.status===404)return snapshot(ref,null);throw e}};return ref};
  const collection=(name,filter=null,sort=null)=>({where:(key,op,value)=>collection(name,{fieldFilter:{field:{fieldPath:key},op:'EQUAL',value:encodeValue(value)}},sort),orderBy:(key,direction)=>collection(name,filter,{field:{fieldPath:key},direction:direction==='desc'?'DESCENDING':'ASCENDING'}),get:async()=>{const rows=await rest(base+':runQuery',token,{structuredQuery:{from:[{collectionId:name}],...(filter?{where:filter}:{}),...(sort?{orderBy:[sort]}:{})}});return {docs:rows.filter(x=>x.document).map(x=>snapshot(doc(name+'/'+x.document.name.split('/').at(-1)),x.document))}}});
  return {doc,collection,runTransaction:async fn=>{for(let attempt=0;attempt<5;attempt++){const reads=new Map(),writes=[];const get=async ref=>{const s=await ref.get();reads.set(ref.path,s);return s};const tx={get,getAll:(...refs)=>Promise.all(refs.map(get)),create:(ref,value)=>writes.push({update:{name:root+'/'+ref.path,fields:encodeFields(value)},currentDocument:{exists:false}}),update:(ref,value)=>{const s=reads.get(ref.path);if(!s?.exists)throw Error('更新前未讀取資料');writes.push({update:{name:root+'/'+ref.path,fields:encodeFields(value)},updateMask:{fieldPaths:Object.keys(value)},currentDocument:{updateTime:s.version}})}};try{const result=await fn(tx);if(writes.length)await rest(base+':commit',token,{writes});return result}catch(e){if(!['ABORTED','FAILED_PRECONDITION','ALREADY_EXISTS'].includes(e.code))throw e;if(attempt===4)throw Error('庫存正在更新，請稍後再試')}}}};
}
function allowed(profile){return profile&&profile.enabled!==false&&(profile.role==='admin'||profile.permissions?.resourceInventory===true||profile.allowedSystems?.includes('resourceInventory'))}
async function portalManager(request,env){
  const token=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');if(!token)throw Error('請先登入入口帳號');
  const project=env.PORTAL_FIREBASE_PROJECT_ID;if(project!=='must-resource-center-portal')throw Error('入口專案設定不符');
  const r=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=AIzaSyBCaAVWxKmIUHbm-X0Dk4pAcnCyoMHPm7o',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:token})});const account=(await r.json()).users?.[0];if(!r.ok||!account?.emailVerified||account.disabled)throw Error('入口登入已失效，請重新登入');
  const email=account.email.toLowerCase(),base=`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/`;
  const read=async mail=>decodeFields((await rest(base+'portalUsers/'+encodeURIComponent(mail),token)).fields);
  const profile=await read(email);if(!allowed(profile))throw Error('請在入口開通資教物資管理權限');
  let ownerEmail=email;if(profile.role==='assistant'){ownerEmail=String(profile.ownerEmail||'').toLowerCase();if(!ownerEmail||!allowed(await read(ownerEmail)))throw Error('所屬老師尚未開通物資管理權限')}
  return {...profile,email,ownerEmail};
}

function positive(value){const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)throw new Error('數量必須是正整數');return n}
function borrowStock(item,quantity){const n=positive(quantity);if(item.enabled===false||n>item.available)throw new Error('可借數量不足');return {available:item.available-n,borrowed:item.borrowed+n}}
function returnStock(item,loan,quantity){const n=positive(quantity);if(n>loan.remaining||n>item.borrowed)throw new Error('歸還數量超過尚未歸還數量');return {available:item.available+n,borrowed:item.borrowed-n,remaining:loan.remaining-n}}
function validateItem(row){for(const key of ['id','name','category'])if(!String(row[key]||'').trim())throw new Error('物品編號、名稱與分類不可空白');for(const key of ['total','borrowed','available'])if(!Number.isSafeInteger(row[key])||row[key]<0)throw new Error('庫存數量不可為負數或小數');if(row.total!==row.borrowed+row.available)throw new Error('原始庫存不等於借出加目前庫存');return row}

const text=(v,max=100)=>String(v??'').trim().slice(0,max);
const phone=v=>text(v,20).replace(/[() +\-]/g,'');
function id(v){const s=text(v,100);if(!s||s.includes('/'))throw Error('編號格式錯誤');return s}
function credential(b){const studentId=text(b.studentId),p=phone(b.phone);if(!studentId||p.length<8)throw Error('請填學號／員編與聯絡手機');return {studentId,phone:p}}
const publicItem=d=>({id:d.id,name:d.name,category:d.category,propertyId:d.propertyId||'',location:d.location||'',available:d.available,borrowed:d.borrowed,total:d.total,note:d.note||'',enabled:d.enabled!==false});
async function handler(req,res,db,manager){try{const route=req.path.replace(/^\//,'');const b=req.body||{};const getRoutes=['items','adminItems','me','loans'];if(req.method!==(getRoutes.includes(route)?'GET':'POST'))return res.status(405).json({error:'不支援的操作'});
if(route==='items'||route==='adminItems'){const u=route==='adminItems'?await manager(req):null;const snap=await db.collection('items').get();return res.json(snap.docs.filter(d=>!u||u.role==='admin'||d.data().createdBy===u.ownerEmail).map(d=>{const x=publicItem({id:d.id,...d.data()});return u?x:{id:x.id,name:x.name,category:x.category,propertyId:x.propertyId,location:x.location,available:x.available,enabled:x.enabled}}))}
if(route==='me'){const u=await manager(req);return res.json({name:u.name||u.displayName||u.email})}
if(route==='item'||route==='import'){const u=await manager(req);const rows=route==='item'?[b]:b.items;if(!Array.isArray(rows)||rows.length<1||rows.length>100)throw Error('每次限 1–100 筆');const clean=rows.map(r=>validateItem({...r,id:id(r.id),name:text(r.name,200),category:text(r.category),propertyId:text(r.propertyId),location:text(r.location,200),note:text(r.note,1000)}));if(new Set(clean.map(x=>x.id)).size!==clean.length)throw Error('物品編號重複');await db.runTransaction(async tx=>{const refs=clean.map(x=>db.doc('items/'+x.id));const old=await tx.getAll(...refs);if(old.some(x=>x.exists))throw Error('已有相同編號，不會覆蓋');clean.forEach((x,i)=>tx.create(refs[i],{...x,enabled:true,createdBy:u.ownerEmail,createdAt:new Date().toISOString()}))});return res.json({ok:true,count:clean.length})}
if(route==='loans'){const u=await manager(req);const s=await db.collection('loans').orderBy('borrowedAt','desc').get();return res.json(s.docs.filter(d=>u.role==='admin'||d.data().ownerEmail===u.ownerEmail).map(d=>({id:d.id,...d.data()})))}
if(route==='lookup'){const c=credential(b);const s=await db.collection('loans').where('studentId','==',c.studentId).get();return res.json(s.docs.filter(d=>d.data().phone===c.phone&&d.data().remaining>0).map(d=>{const x=d.data();return {id:d.id,itemName:x.itemName,remaining:x.remaining,borrowedAt:x.borrowedAt,dueDate:x.dueDate}}))}
if(route==='borrow'){const c=credential(b),quantity=positive(b.quantity),name=text(b.name),unit=text(b.unit);if(!name||!unit)throw Error('請填姓名與班級／單位');if(!['student','staff'].includes(b.identity))throw Error('身分格式錯誤');const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());if(!/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate)||!Number.isFinite(Date.parse(b.dueDate))||new Date(b.dueDate).toISOString().slice(0,10)!==b.dueDate||b.dueDate<today)throw Error('預計歸還日期不可早於今天');const ref=db.doc('items/'+id(b.itemId)),loan=db.doc('loans/'+id(b.requestId));const result=await db.runTransaction(async tx=>{const [s,prior]=await tx.getAll(ref,loan);if(prior.exists){if(prior.data().studentId!==c.studentId||prior.data().phone!==c.phone||prior.data().itemId!==ref.id||prior.data().quantity!==quantity)throw Error('單號重複');const p=prior.data();return {loanId:loan.id,itemName:p.itemName,quantity:p.quantity,borrowedAt:p.borrowedAt}}if(!s.exists)throw Error('找不到物品');const x=s.data(),next=borrowStock(x,quantity),at=new Date().toISOString();tx.update(ref,next);tx.create(loan,{...c,ownerEmail:x.createdBy||'',name,unit,identity:b.identity,itemId:ref.id,itemName:x.name,quantity,remaining:quantity,dueDate:b.dueDate,borrowedAt:at,note:text(b.note,500),returns:[]});return {loanId:loan.id,itemName:x.name,quantity,borrowedAt:at}});return res.json(result)}
if(route==='return'){const c=credential(b),quantity=positive(b.quantity),loan=db.doc('loans/'+id(b.loanId)),op=db.doc('returnOperations/'+id(b.requestId));const result=await db.runTransaction(async tx=>{const [s,prior]=await tx.getAll(loan,op);if(!s.exists||s.data().studentId!==c.studentId||s.data().phone!==c.phone)throw Error('找不到符合的借用紀錄');if(prior.exists){if(prior.data().loanId!==loan.id||prior.data().result.quantity!==quantity)throw Error('操作編號重複');return prior.data().result}const l=s.data(),ref=db.doc('items/'+l.itemId),stock=await tx.get(ref);if(!stock.exists)throw Error('找不到物品');const next=returnStock(stock.data(),l,quantity),at=new Date().toISOString(),result={quantity,remaining:next.remaining,returnedAt:at};tx.update(ref,{available:next.available,borrowed:next.borrowed});tx.update(loan,{remaining:next.remaining,returns:[...(l.returns||[]),{quantity,at}],...(next.remaining===0?{returnedAt:at}:{})});tx.create(op,{loanId:loan.id,result});return result});return res.json(result)}
return res.status(404).json({error:'找不到功能'});
}catch(e){res.status(400).json({error:e.message||'操作失敗'})}}

export default {async fetch(request,env){
 const origin=request.headers.get('Origin'),headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin'};
 if(origin&&origin!=='https://f00931must-hash.github.io')return new Response(JSON.stringify({error:'來源未允許'}),{status:403,headers});
 if(origin)headers['Access-Control-Allow-Origin']=origin;
 headers['Access-Control-Allow-Headers']='Content-Type, Authorization';headers['Access-Control-Allow-Methods']='GET, POST, OPTIONS';
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
 const route=new URL(request.url).pathname;
 if(route==='/health')return new Response(JSON.stringify({ok:true,version:'workers-1.0.0',configured:Boolean(env.FIREBASE_PROJECT_ID&&env.FIREBASE_SERVICE_ACCOUNT&&env.PORTAL_FIREBASE_PROJECT_ID)}),{headers});
 let status=200,result;const res={status(n){status=n;return this},json(d){result=d;return this}};
 try{if(request.method==='POST'&&Number(request.headers.get('Content-Length')||0)>250000)throw Error('檔案資料太大');const raw=request.method==='POST'?await request.text():'';if(raw.length>250000)throw Error('檔案資料太大');const body=raw?JSON.parse(raw):{};
 const db=database(env,await accessToken(env));await handler({path:route,method:request.method,body},res,db,()=>portalManager(request,env));
 }catch(e){status=400;result={error:e.message||'操作失敗'}}return new Response(JSON.stringify(result),{status,headers});
}};
