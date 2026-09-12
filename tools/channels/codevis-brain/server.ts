#!/usr/bin/env -S npx tsx
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { createServer } from 'http'
import paths from '../../../server/codevis-paths.cjs'

const BRIDGE_URL = `http://127.0.0.1:${paths.BRIDGE_PORT}`

// Diese Instanz identifiziert sich über die von Claude Code gesetzte Env-Variable.
const SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID || `anon-${process.pid}`
const PROJECT_DIR = paths.PROJECT_ROOT

// Titel der Session = erste User-Nachricht aus dem Transkript (best effort, lazy).
function sessionTitle(): string {
  try {
    const encoded = PROJECT_DIR.replace(/[/_.]/g, '-')
    const path = `${homedir()}/.claude/projects/${encoded}/${SESSION_ID}.jsonl`
    const lines = readFileSync(path, 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      const rec = JSON.parse(line)
      if (rec.type === 'user') {
        const c = rec.message?.content
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((p: any) => p.type === 'text')?.text : ''
        if (text && !text.startsWith('<')) return text.replace(/\s+/g, ' ').trim().slice(0, 60)
      }
    }
  } catch { /* Transkript evtl. noch leer */ }
  return `Session ${SESSION_ID.slice(0, 8)}`
}

const mcp = new Server(
  { name: 'codevis-brain', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: `Messages arrive as <channel source="codevis-brain" chat_id="..." session_id="...">. The body is a braindump in any language. Turn it into a LINKED subgraph (db='meta', createdBy='brain-worker'), writing node contents in the braindump's language:
1. create_knowledge for descriptive content. Valid categories ONLY: framework|architecture|domain|design|testing|security|performance|general. Architecture/modules/subsystems -> category='architecture'. Decisions ("X weil Y") -> category='architecture' or 'general', put "Entscheidung: ... Begruendung: ..." in content. Conventions -> 'general'. There is NO 'decision' or 'question' category.
2. create_task for actionable items (verb-oriented: title, description, workInstructions, priority). SPECIFICATION GATE: title >= 8 chars, description >= 80 chars, workInstructions >= 50 chars (exact steps + acceptance criteria) — shorter tasks are REJECTED. Open questions -> a create_task with priority='low', title='Clarify: ...' and a description with the question's context.
3. LINK them: create the knowledge FIRST, then create_task with knowledgeLinks=['<knowledge name>', ...] to draw Knowledge-[:APPLIES_TO]->Task in one call. Link knowledge to existing code nodes via link_knowledge(knowledgeName, targetNodes=[...]). Nodes must not be isolated.
Collect ALL taskIds and knowledge names. Reply ONCE with reply_brain(chat_id verbatim from the tag, summary='... incl. which edges were drawn', nodeIds=[...all...]).`,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply_brain',
    description: 'Send the result subgraph back to the CodeVis frontend',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'chat_id from the inbound channel tag' },
        summary: { type: 'string', description: 'Human-readable summary of what was created' },
        nodeIds: { type: 'array', items: { type: 'string' }, description: 'IDs of all created nodes (taskIds or knowledge node names)' },
      },
      required: ['chat_id', 'summary', 'nodeIds'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'reply_brain') {
    const { chat_id, summary, nodeIds } = req.params.arguments as { chat_id: string; summary: string; nodeIds: string[] }
    try {
      const res = await fetch(`${BRIDGE_URL}/api/brain/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, summary, nodeIds }),
      })
      const text = await res.text()
      return { content: [{ type: 'text', text: `posted to bridge (${res.status}): ${text}` }], isError: !res.ok }
    } catch (e: any) {
      return { content: [{ type: 'text', text: `bridge POST failed: ${e.message}` }], isError: true }
    }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

await mcp.connect(new StdioServerTransport())

let nextId = 1
// Port 0 → das OS vergibt einen freien Port. Kein fixer 8788 mehr → kein Konflikt,
// wenn mehrere Claude-Instanzen den Channel gleichzeitig laden.
// Plain node:http statt Bun.serve — der Channel läuft unter `npx tsx`,
// Bun ist keine Prerequisite mehr.
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200).end('codevis-brain channel — POST text to push event')
    return
  }
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  let body: { text?: string; sessionId?: string } | null = null
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* unten 400 */ }
  if (!body?.text) {
    res.writeHead(400).end('expected JSON {text, sessionId?}')
    return
  }
  // chat_id MUST be the BraindumpSession id when the bridge provides one:
  // publishBrainResult MERGEs the DERIVES provenance edges via
  // (s:BraindumpSession {sessionId: chat_id}) — a bare counter matches no
  // session and the braindump "book" silently gets zero edges.
  const chat_id = body.sessionId ?? String(nextId++)
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: body.text, meta: { chat_id, session_id: body.sessionId ?? chat_id } },
  })
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, chat_id }))
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const channelPort = (server.address() as { port: number }).port

// Bei der Bridge registrieren, damit diese Instanz im "Send to ▾"-Dropdown erscheint.
// Heartbeat alle 10s → Bridge erkennt tote Instanzen per TTL. Titel wird lazy
// nachgezogen (Transkript ist bei Session-Start evtl. noch leer).
async function register() {
  try {
    await fetch(`${BRIDGE_URL}/api/brain/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID, title: sessionTitle(), port: channelPort }),
    })
  } catch { /* Bridge evtl. noch nicht oben */ }
}
await register()
setInterval(register, 10_000)

async function deregister() {
  try {
    await fetch(`${BRIDGE_URL}/api/brain/deregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    })
  } catch { /* egal */ }
}
process.on('SIGINT', () => { deregister().finally(() => process.exit(0)) })
process.on('SIGTERM', () => { deregister().finally(() => process.exit(0)) })
