import test from "node:test"
import assert from "node:assert/strict"
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,realpathSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import { execFileSync, spawn } from "node:child_process"
import {isolatedToolPermission,isolatedClaudeOptions,loadClaudeIsolation,type ClaudeIsolation} from "../src/worker/claude-isolation.js"
function fixture(t:test.TestContext){
 const root=realpathSync(mkdtempSync(join(tmpdir(),"claude-isolation-test-")))
 t.after(()=>rmSync(root,{recursive:true,force:true}))
 for(const name of ["workspace","inputs","scratch","deps"])mkdirSync(join(root,name))
 const config:ClaudeIsolation={schemaVersion:"claude-isolation.v1",workspace:join(root,"workspace"),inputs:join(root,"inputs"),scratch:join(root,"scratch"),readRoots:[join(root,"deps")],blockedRoots:[root],writable:true}
 return {root,config,gate:(tool:string,input:Record<string,unknown>)=>isolatedToolPermission(config,tool,input)}
}
test("file tools deny private roots, traversal, and symlink escapes",t=>{
 const {root,config,gate}=fixture(t)
 writeFileSync(join(root,"private"),"private")
 writeFileSync(join(config.workspace,"source"),"source")
 for(const tool of ["Read","Grep","Glob"]){
  assert.equal(gate(tool,tool==="Read"?{file_path:join(root,"private")}:{path:root,pattern:"*"}).behavior,"deny")
  assert.equal(gate(tool,tool==="Read"?{file_path:"source"}:{path:config.workspace,pattern:"*"}).behavior,"allow")
 }
 symlinkSync(join(root,"private"),join(config.workspace,"escape"))
 assert.equal(gate("Read",{file_path:"escape"}).behavior,"deny")
 assert.equal(gate("Grep",{path:config.workspace,pattern:"private"}).behavior,"deny")
 for(const pattern of ["../../*","{..,x}/**","[.][.]/**"])assert.equal(gate("Glob",{path:config.workspace,pattern}).behavior,"deny")
 for(const tool of ["Write","Edit"]){
  assert.equal(gate(tool,{file_path:"escape"}).behavior,"deny")
  assert.equal(gate(tool,{file_path:"../private"}).behavior,"deny")
  assert.equal(gate(tool,{file_path:join(config.readRoots[0]!,"new")}).behavior,"deny")
  assert.equal(gate(tool,{file_path:join(config.scratch,"new")}).behavior,"allow")
  assert.equal(gate(tool,{file_path:"new"}).behavior,"allow")
 }
})
test("dangling symlinks resolve to their target for writes and do not block safe searches", t => {
  const { root, config, gate } = fixture(t)
  symlinkSync(join(root, "missing-outside"), join(config.workspace, "outside-link"))
  for (const tool of ["Write", "Edit"]) assert.equal(gate(tool, { file_path: "outside-link" }).behavior, "deny")
  const target = join(config.workspace, "missing-inside")
  symlinkSync(target, join(config.workspace, "inside-link"))
  const write = gate("Write", { file_path: "inside-link" })
  assert.equal(write.behavior, "allow")
  if (write.behavior !== "allow") throw new Error("unreachable")
  assert.equal(write.updatedInput?.file_path, target)
  // Remove the escaping link; the remaining dangling link is inside the approved tree.
  rmSync(join(config.workspace, "outside-link"))
  for (const tool of ["Grep", "Glob"]) assert.equal(gate(tool, { path: config.workspace, pattern: "*" }).behavior, "allow")
})
test("all tool calls must pass callback; host surfaces and delegation unavailable",t=>{
 const {config,gate}=fixture(t)
 const options=isolatedClaudeOptions(config)
 assert.deepEqual((options.settings as {permissions:{ask:string[]}}).permissions.ask,options.tools)
 assert.deepEqual(options.settingSources,[])
 assert.deepEqual(options.mcpServers,{})
 assert.equal(options.strictMcpConfig,true)
 assert.equal(options.sandbox?.enabled,false)
 assert.equal((options.settings as {disableAllHooks:boolean}).disableAllHooks,true)
 for(const tool of ["Agent","Task","WebFetch","WebSearch","Skill","mcp__x__y","NotebookEdit"])assert.equal(gate(tool,{}).behavior,"deny")
 assert.equal(gate("Bash",{command:"true",run_in_background:true}).behavior,"deny")
 assert.equal(gate("Bash",{command:"true",dangerouslyDisableSandbox:true}).behavior,"deny")
})
test("sandboxed Bash cannot read private data or write outside workspace, including injection and symlinks",{skip:process.platform!=="darwin"},t=>{
 const {root,config,gate}=fixture(t)
 const privateFile=join(root,"private")
 writeFileSync(privateFile,"private")
 const shell=(command:string)=>{
  const decision=gate("Bash",{command})
  assert.equal(decision.behavior,"allow")
  if(decision.behavior!=="allow")throw new Error("unreachable")
  return execFileSync("/bin/bash",["-c",String(decision.updatedInput!.command)],{cwd:config.workspace,env:{PATH:"/usr/bin:/bin",POISON:"secret"},encoding:"utf8",timeout:5000,stdio:["ignore","pipe","pipe"]})
 }
 assert.equal(shell('printf "%s" "${POISON:-clean}"'),"clean")
 assert.equal(shell('printf "%s" "quotes \' ; $(echo confined)"'),"quotes ' ; confined")
 assert.throws(()=>shell(`/bin/cat '${privateFile}'`),/Operation not permitted|Permission denied/)
 assert.throws(()=>shell(`printf x > '${privateFile}'`),/Operation not permitted|Permission denied/)
 symlinkSync(privateFile,join(config.workspace,"escape"))
 assert.throws(()=>shell("cat escape"),/Operation not permitted|Permission denied/)
 shell("printf ok > result")
  const outside = spawn("/bin/sleep", ["5"])
  t.after(() => outside.kill())
  assert.throws(() => shell(`kill -0 ${outside.pid}`), /Operation not permitted|Permission denied/)
  shell("sleep 5 & kill $!")
})
test("configuration rejects noncanonical roots and cwd mismatch", { skip: process.platform !== "darwin" }, t => {
 const {root,config}=fixture(t)
 const file=join(root,"config.json")
 writeFileSync(file,JSON.stringify(config))
 assert.deepEqual(loadClaudeIsolation(file,config.workspace),config)
 assert.throws(()=>loadClaudeIsolation(file,config.inputs),/differs/)
 writeFileSync(file,JSON.stringify({...config,scratch:"/"}))
 assert.throws(()=>loadClaudeIsolation(file),/canonical/)
})
test("configuration rejects read roots nested with workspace or scratch in either direction", { skip: process.platform !== "darwin" }, t => {
  const { root, config } = fixture(t)
  const file = join(root, "config.json")
  for (const readRoot of [join(config.workspace, "deps"), join(config.scratch, "deps"), root]) {
    writeFileSync(file, JSON.stringify({ ...config, readRoots: [readRoot] }))
    assert.throws(() => loadClaudeIsolation(file), /Isolation readRoots must be separate from writable roots/)
  }
})

test("Bash cannot reach a listener that the unsandboxed parent can reach",{skip:process.platform!=="darwin"},async t=>{
 const {config,gate}=fixture(t)
 const {createServer,createConnection}=await import("node:net")
 const {spawn}=await import("node:child_process")
 let connections=0
 const server=createServer(socket=>{connections++;socket.end()})
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve))
 t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
 const port=(server.address() as {port:number}).port
 await new Promise<void>((resolve,reject)=>{const socket=createConnection({host:"127.0.0.1",port});socket.once("error",reject);socket.once("end",resolve);socket.resume()})
 assert.equal(connections,1)
 const permission=gate("Bash",{command:`/usr/bin/nc -z -v -w 1 127.0.0.1 ${port}`})
 assert.equal(permission.behavior,"allow")
 if(permission.behavior!=="allow")throw new Error("unreachable")
 const result=await new Promise<{code:number|null;stderr:string}>((resolve,reject)=>{
  const child=spawn("/bin/bash",["-c",String(permission.updatedInput!.command)],{cwd:config.workspace,stdio:["ignore","ignore","pipe"]})
  let stderr="";const timer=setTimeout(()=>child.kill("SIGKILL"),5000)
  child.stderr.on("data",chunk=>{stderr+=chunk})
  child.once("error",reject);child.once("close",code=>{clearTimeout(timer);resolve({code,stderr})})
 })
 assert.notEqual(result.code,0)
 assert.match(result.stderr,/Operation not permitted|Permission denied/)
 assert.equal(connections,1)
})
