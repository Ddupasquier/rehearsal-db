/** Trusted worker programs copied verbatim into a read-only mount; never run on the host. */
export const KNEX_WORKER_CHILD_SOURCE = String.raw`
import {createRequire} from 'node:module';
let input=Buffer.alloc(0);
for await(const chunk of process.stdin){if(input.length+chunk.length>8192)process.exit(1);input=Buffer.concat([input,chunk]);}
try{
 const c=JSON.parse(input.toString('utf8'));input.fill(0);
 const load=createRequire(c.knexDirectory+'/package.json');
 const knex=load(c.knexDirectory)({client:'pg',connection:{host:'/tmp/rehearsal-pg',port:5432,user:c.user,password:c.password,database:c.database,ssl:false,application_name:'rehearsal-knex-worker',connectionTimeoutMillis:5000},pool:{min:0,max:1},acquireConnectionTimeout:5000,migrations:{directory:'/inputs',loadExtensions:['.cjs'],tableName:'knex_migrations',schemaName:'public',disableMigrationsListValidation:false,disableTransactions:false}});
 try{await knex.migrate.latest();}finally{await knex.destroy();}
}catch{process.exitCode=1;}
`;
export const KNEX_WORKER_BOOTSTRAP_SOURCE = String.raw`
import {createServer} from 'node:net';
import {mkdir,chmod} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {decodeKnexFrames} from '/runner/protocol.mjs';
const MAX=65536,TOTAL=67108864;let sent=0,logs=0,initialized=false,child=null,active=null,connections=0,closed=false,completed=false;
const shutdown=()=>{if(closed)return;closed=true;active?.socket.destroy();server.close();child?.kill('SIGTERM');setTimeout(()=>process.exit(1),1000).unref();};
const paused=new Set();
const send=(kind,bytes=Buffer.alloc(0))=>{if(closed)return false;if(bytes.length>MAX||(sent+=bytes.length+5)>TOTAL){shutdown();return false;}const out=Buffer.alloc(bytes.length+5);out[0]=kind.charCodeAt(0);out.writeUInt32BE(bytes.length,1);bytes.copy(out,5);return process.stdout.write(out);};
const tagged=(id,bytes=Buffer.alloc(0))=>{const b=Buffer.alloc(bytes.length+4);b.writeUInt32BE(id,0);bytes.copy(b,4);return b;};
process.stdout.on('drain',()=>{for(const stream of paused)stream.resume();paused.clear();});
const emit=(kind,stream,chunk,id)=>{if(kind==='L'&&(logs+=chunk.length)>1048576){shutdown();return;}const limit=id?MAX-4:MAX;for(let at=0;at<chunk.length;at+=limit){const part=chunk.subarray(at,at+limit);if(!send(kind,id?tagged(id,part):part)){stream.pause();paused.add(stream);}}};
const server=createServer(socket=>{
 if(active||++connections>4){socket.destroy();shutdown();return;}const channel={socket,id:connections};active=channel;send('O',tagged(channel.id));
 socket.on('data',bytes=>emit('D',socket,bytes,channel.id));socket.on('error',shutdown);
 socket.on('close',()=>{if(active===channel){active=null;send('C',tagged(channel.id));}});
});
const accept=async(kind,bytes)=>{
 if(kind==='J'){
  if(initialized||bytes.length>8192)throw Error();const c=JSON.parse(bytes.toString('utf8'));
  if(Object.keys(c).sort().join(',')!=='database,knexDirectory,password,user'||!/^rehearsal_knex_[a-f0-9]{16}$/.test(c.user)||!/^[/]sdk[/][A-Za-z0-9_@./-]+$/.test(c.knexDirectory)||typeof c.password!=='string'||c.password.length>128||typeof c.database!=='string')throw Error();
  initialized=true;await mkdir('/tmp/rehearsal-pg',{mode:448});await new Promise((ok,no)=>{server.once('error',no);server.listen('/tmp/rehearsal-pg/.s.PGSQL.5432',ok);});await chmod('/tmp/rehearsal-pg/.s.PGSQL.5432',384);
  child=spawn(process.execPath,['/runner/child.mjs'],{cwd:'/inputs',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp',NODE_ENV:'production'},stdio:['pipe','pipe','pipe']});
  child.stdout.on('data',b=>emit('L',child.stdout,b));child.stderr.on('data',b=>emit('L',child.stderr,b));child.on('error',shutdown);
  child.on('exit',(code,signal)=>{completed=true;send('X',Buffer.from([code===0&&!signal?0:1]));active?.socket.destroy();server.close();process.exitCode=code===0&&!signal?0:1;process.stdin.destroy();});
  child.stdin.end(JSON.stringify(c));bytes.fill(0);return;
 }
 if(!initialized||bytes.length<4)throw Error();const id=bytes.readUInt32BE(0),body=bytes.subarray(4);
 if(id<1||id>connections)throw Error();if(!active||active.id!==id)return; // Known old channel, never a new client's socket.
 const channel=active;
 if(kind==='P'&&body.length){await new Promise((ok,no)=>channel.socket.write(body,error=>error?no(Error()):ok()));return;}
 if(kind==='E'&&!body.length){active=null;channel.socket.destroy();return;}throw Error();
};
void(async()=>{try{for await(const {kind,bytes}of decodeKnexFrames(process.stdin,'JPE'))await accept(kind,bytes);if(!completed)shutdown();}catch{if(!completed)shutdown();}})();
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);setTimeout(shutdown,120000).unref();
`;
