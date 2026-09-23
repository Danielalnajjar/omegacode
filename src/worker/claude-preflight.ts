import {spawn} from "node:child_process"
import {readdir,rmdir,readFile,writeFile,rm,symlink,realpath} from "node:fs/promises"
import {createServer,createConnection} from "node:net"
import {randomUUID} from "node:crypto"
import {join} from "node:path"
import {query,type SDKMessage} from "@anthropic-ai/claude-agent-sdk"
import {loadClaudeIsolation,isolatedClaudeOptions,isolatedToolPermission,ISOLATED_TOOLS, type ClaudeIsolation} from "./claude-isolation.js"
import {toClaudeOutputFormat} from "./schema.js"
import {resolveClaudeProfile} from "./claude-profile.js"

function execute(command:string,cwd:string,timeoutMs=30000):Promise<{code:number|null;stdout:string;stderr:string}> {
  return new Promise((resolveResult,reject)=>{
    const child=spawn("/bin/bash",["--noprofile","--norc","-c",command],{cwd,env:{PATH:"/usr/bin:/bin",BENCHMARK_POISON:"must-not-inherit"},detached:true,stdio:["ignore","pipe","pipe"]})
    let stdout="",stderr=""
    const kill=()=>{try{process.kill(-child.pid!,"SIGKILL")}catch{}}
    const timer=setTimeout(kill,timeoutMs)
    child.stdout.on("data",chunk=>{stdout+=chunk;if(stdout.length>1024*1024)kill()})
    child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-4096)})
    child.once("error",error=>{clearTimeout(timer);reject(error)})
    child.once("close",code=>{clearTimeout(timer);kill();resolveResult({code,stdout,stderr})})
  })
}
const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'"
export async function proveClaudeIsolation(configFile:string,profileId:string) {
  const config=loadClaudeIsolation(configFile)
  const checks:Array<{label:string;passed:boolean;exitCode?:number|null;stderr?:string;stdout?:string}>=[]
  const receipt:{passed:boolean;modelCalls:number;authCopied:boolean;profileId:string;checks:typeof checks;startup?:unknown;error?:string}={passed:false,modelCalls:0,authCopied:false,profileId,checks}
  const files:string[]=[]
  const assert=(label:string,passed:boolean,exitCode?:number|null)=>{checks.push({label,passed,...(exitCode===undefined?{}:{exitCode})});if(!passed)throw new Error(`Claude preflight failed: ${label}`)}
  const gate=(tool:string,input:Record<string,unknown>)=>isolatedToolPermission(config,tool,input)
  async function bash(label:string,command:string,allowed:boolean,expected?:string){
    const decision=gate("Bash",{command})
    assert(label+"-mandatory-gate",decision.behavior==="allow")
    if(decision.behavior!=="allow")throw new Error("unreachable")
    const result=await execute(String(decision.updatedInput!.command),config.workspace)
    checks.push({label:label+"-command-result",passed:allowed ? result.code===0 : result.code!==0,exitCode:result.code,stderr:result.stderr,stdout:result.stdout.slice(-4000)})
    assert(label,allowed?result.code===0&&(expected===undefined||result.stdout.trim()===expected):result.code!==0&&/Operation not permitted|Permission denied/.test(result.stderr),result.code)
    return result
  }
  async function marker(root:string,contents:string,suffix=""){
    const path=join(root,`.claude-preflight-${randomUUID()}${suffix}`)
    await writeFile(path,contents,{flag:"wx",mode:0o600});files.push(path);return path
  }
  let connections=0
  const listener=createServer(socket=>{connections++;socket.end()})
  try {
    const source=await marker(config.workspace,"workspace-readable")
    const input=await marker(config.inputs,"inputs-readable")
    await bash("workspace-read",`/bin/cat ${quote(source)}`,true,"workspace-readable")
    await bash("input-read",`/bin/cat ${quote(input)}`,true,"inputs-readable")
    await bash("environment-clean",'test -z "${BENCHMARK_POISON:-}"',true)
    for(const tool of ["Read","Grep","Glob"]){
      const data=tool==="Read"?{file_path:source}:{path:source,pattern:"workspace"}
      assert(`${tool}-workspace-read`,gate(tool,data).behavior==="allow")
      for(const root of config.blockedRoots){
        // Existing root paths suffice for gate proof; Bash reads synthetic bytes
        // created only in the task-owned probe directory, never host config.
        assert(`${tool}-blocked-${config.blockedRoots.indexOf(root)}`,gate(tool,tool==="Read"?{file_path:root}:{path:root,pattern:"*"}).behavior==="deny")
      }
    }
    const privateFile=await marker(join(configFile,".."),"private-denied")
    await bash("private-read-denied",`/bin/cat ${quote(privateFile)}`,false)
    for(const [i,root] of config.blockedRoots.entries())await bash(`blocked-root-list-${i}`,`/bin/ls -A ${quote(root)}`,false)
    const outside=join(configFile,"..",`.outside-${randomUUID()}`);files.push(outside)
    const inside=join(config.workspace,`.inside-${randomUUID()}`);files.push(inside)
    const scratch=join(config.scratch,`.scratch-${randomUUID()}`);files.push(scratch)
    for(const tool of ["Edit","Write"]){
      assert(`${tool}-outside-denied`,gate(tool,{file_path:outside}).behavior==="deny")
      assert(`${tool}-workspace-policy`,(gate(tool,{file_path:inside}).behavior==="allow")===config.writable)
      assert(`${tool}-scratch-write`,gate(tool,{file_path:scratch}).behavior==="allow")
    }
    await bash("outside-write-denied",`/usr/bin/touch ${quote(outside)}`,false)
    await bash("workspace-write-policy",`/usr/bin/touch ${quote(inside)}`,config.writable)
    await bash("scratch-write",`/usr/bin/touch ${quote(scratch)}`,true)
    const link=join(config.workspace,`.escape-${randomUUID()}`);files.push(link);await symlink(privateFile,link)
    assert("Read-symlink-escape-denied",gate("Read",{file_path:link}).behavior==="deny")
    assert("Write-symlink-escape-denied",gate("Write",{file_path:link}).behavior==="deny")
    await bash("Bash-symlink-escape-denied",`/bin/cat ${quote(link)}`,false)
    await rm(link)
    // The runner's optional launch metadata identifies the same pinned Node and
    // dependency roots as the sealed case. No package install happens here.
    const details=JSON.parse(await readFile(configFile,"utf8")) as {nodeArgv?:string[];dependencyLinks?:Array<{realPath:string;lockRealPath:string;path:string}>;targetedTest?:{cwd:string;args:string[];env:Record<string,string>}}
    if(details.dependencyLinks){
      for(const [i,dep] of details.dependencyLinks.entries()){
        await bash(`dependency-read-${i}`,`/bin/cat ${quote(dep.lockRealPath)} >/dev/null`,true)
        const target=join(dep.realPath,`.probe-${randomUUID()}`)
        assert(`Write-dependency-denied-${i}`,gate("Write",{file_path:target}).behavior==="deny")
        await bash(`dependency-write-denied-${i}`,`/usr/bin/touch ${quote(target)}`,false)
        await bash(`dependency-alias-write-denied-${i}`,`/usr/bin/touch ${quote(join(config.workspace,dep.path,target.slice(dep.realPath.length+1)))}`,false)
      }
      let runner:string|undefined
      for(const dep of details.dependencyLinks){try{runner=await realpath(join(config.workspace,dep.path,"vitest/vitest.mjs"));break}catch{}}
      assert("linked-vitest-present",Boolean(runner&&details.nodeArgv))
      const testFile=await marker(config.workspace,`import {test,expect} from ${JSON.stringify(join(runner!,"..","dist/index.js"))};test('confined dependency execution',()=>expect(2+2).toBe(4));`,".test.mjs")
      const testConfig=await marker(config.inputs,`export default {test:{include:[${JSON.stringify(testFile)}],watch:false,cache:false}};`,".config.mjs")
      await bash("dependency-vitest-targeted",[...details.nodeArgv!,runner!,"run",testFile,"--config",testConfig,"--configLoader","runner","--no-cache"].map(quote).join(" "),true)
    }
    if(details.targetedTest){
      const target=details.targetedTest
      const command=`cd ${quote(join(config.workspace,target.cwd))} && `+[...Object.entries(target.env).map(([key,value])=>`${key}=${quote(value)}`),...details.nodeArgv!.map(quote),...target.args.map(quote)].join(" ")
      const decision=gate("Bash",{command})
      assert("case-targeted-vitest-gate",decision.behavior==="allow")
      if(decision.behavior!=="allow")throw new Error("unreachable")
      const directories=async()=>new Set((await readdir(config.workspace,{recursive:true,withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>join(entry.parentPath,entry.name)))
      const beforeDirectories=await directories()
      const result=await execute(String(decision.updatedInput!.command),config.workspace,180000)
      // Some targeted tests leave only an empty output directory. Remove only
      // newly created empty directories; changed files remain visible to the
      // runner's unchanged-source check and still fail preflight.
      const afterDirectories=await directories()
      for(const directory of [...afterDirectories].filter(path=>!beforeDirectories.has(path)).sort((a,b)=>b.length-a.length)){
        try{await rmdir(directory)}catch(error){if(!["ENOTEMPTY","ENOENT"].includes((error as NodeJS.ErrnoException).code??""))throw error}
      }
      const executed=(result.code===0||result.code===1)&&/Test Files/.test(result.stdout)&&/Tests/.test(result.stdout)
      checks.push({label:"case-targeted-vitest",passed:executed,exitCode:result.code,stdout:result.stdout.slice(-4000),stderr:result.stderr})
      assert("case-targeted-vitest-executed",executed)
    }
    await new Promise<void>((resolve,reject)=>{listener.once("error",reject);listener.listen(0,"127.0.0.1",resolve)})
    const port=(listener.address() as {port:number}).port
    await new Promise<void>((resolve,reject)=>{const socket=createConnection({host:"127.0.0.1",port});socket.once("error",reject);socket.once("end",resolve);socket.resume()})
    assert("network-positive-control",connections===1)
    await bash("network-denied",`/usr/bin/nc -z -v -w 1 127.0.0.1 ${port}`,false)
    assert("network-listener-unreached",connections===1)
    for(const tool of ["Agent","Task","WebFetch","WebSearch","Skill","mcp__unknown__call"]){assert(`${tool}-refused`,gate(tool,{}).behavior==="deny")}
    await proveStartup(config,profileId,assert,value=>{receipt.startup=value})
    receipt.passed=true
  } catch(error){receipt.error=error instanceof Error?error.message:"Claude preflight failed"}
  finally {
    if(listener.listening)await new Promise<void>(resolve=>listener.close(()=>resolve()))
    await Promise.all(files.map(path=>rm(path,{force:true})))
  }
  return receipt
}
async function proveStartup(config:ClaudeIsolation,profileId:string,assert:(label:string,passed:boolean)=>void,record:(value:unknown)=>void){
  const controller=new AbortController()
  const profile=await resolveClaudeProfile(profileId,controller.signal)
  const env=Object.fromEntries(["HOME","PATH","USER","LOGNAME","LANG","SHELL"].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]!]))
  env.CLAUDE_CONFIG_DIR=profile.configDir
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"
  let release!:()=>void, startLocal!:()=>void
  const pending=new Promise<void>(resolve=>{release=resolve})
  const start=new Promise<void>(resolve=>{startLocal=resolve})
  async function* localCommand(){
    await start
    yield {type:"user" as const,message:{role:"user" as const,content:"/context"},parent_tool_use_id:null,session_id:""}
    await pending
  }
  const q=query({prompt:localCommand(),options:{...isolatedClaudeOptions(config),cwd:config.workspace,env,pathToClaudeCodeExecutable:profile.claudeCodeExecutable,model:config.model ?? "claude-opus-5-5",effort:config.effort,
    ...(config.schema?{outputFormat:toClaudeOutputFormat(config.schema)}:{}),
    ...(config.instructions?{systemPrompt:{type:"preset",preset:"claude_code",append:config.instructions} as const}:{}),abortController:controller,stderr:()=>{},
    // Only the no-inference startup probe gets this outer network denial. Live
    // provider traffic stays in the unsandboxed parent; tools use their own gate.
    spawnClaudeCodeProcess:options=>spawn("/usr/bin/sandbox-exec",["-p","(version 1)(allow default)(deny network*)",options.command,...options.args],{cwd:options.cwd,env:options.env,signal:options.signal,stdio:["pipe","pipe","pipe"]})}})
  let init:Extract<SDKMessage,{type:"system",subtype:"init"}>|undefined
  let observed!:()=>void
  const initializedTools=new Promise<void>(resolve=>{observed=resolve})
  const drain=(async()=>{try{for await(const message of q){if(message.type==="system"&&message.subtype==="init"){init=message;observed()}}}catch{}finally{observed()}})()
  const timer=setTimeout(()=>controller.abort(),20000)
  try {
    const initialized=await q.initializationResult()
    const servers=await q.mcpServerStatus()
    const commands=await q.supportedCommands()
    const agents=await q.supportedAgents()
    const context=await q.getContextUsage() as unknown as {memoryFiles?:unknown[];mcpTools?:unknown[]}
    startLocal()
    await initializedTools
    record({profileId, accountMetadataPresent:Boolean(initialized.account), agents:agents.map(agent=>agent.name),
      requestedTools:[...ISOLATED_TOOLS], nativeInitTools:init?.tools ?? null,
      mcp:servers.map(server=>({name:server.name,status:server.status})),commands:commands.map(command=>command.name),
      nativeInitPlugins:init?.plugins ?? null,nativeInitSkills:init?.skills ?? null,nativeInitCommands:init?.slash_commands ?? null, settingSources:[],hooksDisabled:true,memoryFiles:context.memoryFiles,
      modelCalls:0,localControlMessages:1,localCommand:"/context",inferencePreventedBy:"probe-only OS network denial",delegationProbeSurface:"production mandatory permission callback"})
    assert("profile-initialized",Boolean(initialized.account))
    assert("built-in-agents-only",agents.every(agent=>["claude","Explore","general-purpose","Plan","statusline-setup"].includes(agent.name)))
    assert("no-mcp",servers.length===0&&context.mcpTools?.length===0)
    assert("no-skills-or-commands",commands.length===0)
    assert("no-CLAUDE-md",context.memoryFiles?.length===0)
    assert("native-init-tool-list-available",Array.isArray(init?.tools))
    assert("no-delegation-or-web-tools",init!.tools.every(tool=>ISOLATED_TOOLS.includes(tool)||(tool==="StructuredOutput"&&Boolean(config.schema))))
    assert("no-plugins",init!.plugins.length===0)
    assert("no-native-skills-or-commands",init!.skills.length===0&&init!.slash_commands.length===0)
    return {profileId,agents:agents.map(agent=>agent.name),tools:init!.tools,mcp:[],commands:[],plugins:[],settingSources:[],hooksDisabled:true,memoryFiles:[]}
  } finally {clearTimeout(timer);startLocal();release();q.close();await drain}
}
