// Agent7 — Role Agent Worker
// Environment variables required:
//   ANTHROPIC_API_KEY    — Claude API key
//   SUPABASE_URL         — Supabase project URL
//   SUPABASE_SERVICE_KEY — Supabase service role key (for DB actions)

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: cors });

    const url = new URL(request.url);
    try {
      if (url.pathname === '/role-chat')   return await handleRoleChat(request, env, cors);
      if (url.pathname === '/role-learn')  return await handleRoleLearn(request, env, cors);
      if (url.pathname === '/role-save')   return await handleRoleSave(request, env, cors);
      if (url.pathname === '/role-index')  return await handleRoleIndex(request, env, cors);
      if (url.pathname === '/role-extract-pdf') return await handleExtractPdf(request, env, cors);
      if (url.pathname === '/role-action') return await handleRoleAction(request, env, cors);
      if (url.pathname === '/embed')       return await handleEmbed(request, env, cors);
      return new Response('Not Found', { status: 404, headers: cors });
    } catch (err) {
      return jsonRes({ error: err.message }, cors, 500);
    }
  }
};

// ─── Helpers ──────────────────────────────────────────────────

function jsonRes(data, cors, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}

async function claude(env, system, messages, max_tokens = 1024) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens, system, messages })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Claude API error');
  return data.content[0].text;
}

// ─── Supabase REST helpers (use service key) ──────────────────

async function sbGet(env, table, params = {}) {
  const url = new URL(`${env.SUPABASE_URL.trim()}/rest/v1/${table}`);
  const noPrefix = new Set(['select', 'order', 'limit', 'offset']);
  Object.entries(params).forEach(([k, v]) => {
    url.searchParams.set(k, noPrefix.has(k) ? v : `eq.${v}`);
  });
  const res = await fetch(url.toString(), {
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (!res.ok) throw new Error(`Supabase GET error: ${await res.text()}`);
  return res.json();
}

async function sbPatch(env, table, match, data) {
  const url = new URL(`${env.SUPABASE_URL.trim()}/rest/v1/${table}`);
  Object.entries(match).forEach(([k, v]) => url.searchParams.set(k, `eq.${v}`));
  const res = await fetch(url.toString(), {
    method: 'PATCH',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`Supabase PATCH error: ${await res.text()}`);
}

async function sbDeleteIds(env, table, ids) {
  if (!ids.length) return;
  const url = new URL(`${env.SUPABASE_URL.trim()}/rest/v1/${table}`);
  url.searchParams.set('id', `in.(${ids.join(',')})`);
  const res = await fetch(url.toString(), {
    method: 'DELETE',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (!res.ok) throw new Error(`Supabase DELETE error: ${await res.text()}`);
}

async function sbDelete(env, table, match) {
  const url = new URL(`${env.SUPABASE_URL.trim()}/rest/v1/${table}`);
  Object.entries(match).forEach(([k, v]) => url.searchParams.set(k, `eq.${v}`));
  const res = await fetch(url.toString(), {
    method: 'DELETE',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (!res.ok) throw new Error(`Supabase DELETE error: ${await res.text()}`);
}

async function sbRpc(env, fn, params) {
  const res = await fetch(`${env.SUPABASE_URL.trim()}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(params)
  });
  if (!res.ok) throw new Error(`Supabase RPC error: ${await res.text()}`);
  return res.json();
}

// Split text into ~500-word chunks, works for both paragraph and line-per-message formats (e.g. WhatsApp)
function chunkText(text, wordsPerChunk = 150) {
  // Try paragraph splits first; fall back to single-line splits for chat exports
  let segments = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  if (segments.length <= 3 && text.length > 2000) {
    // Likely single-newline format (WhatsApp, logs) — split on every line
    segments = text.split(/\n/).map(p => p.trim()).filter(Boolean);
  }
  const MAX_CHUNK_CHARS = 4000; // safety cap for embedding model
  const chunks = [];
  let current = [];
  let wordCount = 0;
  for (const seg of segments) {
    const words = seg.split(/\s+/).length;
    if ((wordCount + words > wordsPerChunk || current.join('\n').length + seg.length > MAX_CHUNK_CHARS) && current.length) {
      chunks.push(current.join('\n'));
      current = [];
      wordCount = 0;
    }
    current.push(seg);
    wordCount += words;
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks;
}

async function sbInsert(env, table, data) {
  const res = await fetch(`${env.SUPABASE_URL.trim()}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`Supabase INSERT error: ${await res.text()}`);
}

async function sbUpsert(env, table, data, onConflict) {
  const url = new URL(`${env.SUPABASE_URL.trim()}/rest/v1/${table}`);
  url.searchParams.set('on_conflict', onConflict);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`Supabase UPSERT error: ${await res.text()}`);
}

async function verifyJwt(env, jwt) {
  const url = `${env.SUPABASE_URL.trim()}/auth/v1/user`;
  const res = await fetch(url, {
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${jwt}`
    }
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user.id ? user : null;
}

// ─── Tool definitions ─────────────────────────────────────────

const BASE_TOOLS = [
  {
    name: 'create_pdf',
    description: 'יצור מסמך PDF עבור המשתמש. השתמש כאשר המשתמש מבקש PDF, הצעת מחיר, דוח, סיכום, חוזה, או כל מסמך מובנה.',
    input_schema: {
      type: 'object',
      properties: {
        title:    { type: 'string', description: 'כותרת המסמך' },
        subtitle: { type: 'string', description: 'כותרת משנה' },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string' },
              type:    { type: 'string', enum: ['text', 'table', 'list'] },
              content: { type: 'string' },
              headers: { type: 'array', items: { type: 'string' } },
              rows:    { type: 'array', items: { type: 'array', items: { type: 'string' } } },
              items:   { type: 'array', items: { type: 'string' } }
            },
            required: ['type']
          }
        },
        message: { type: 'string', description: 'הודעה קצרה לאחר יצירת המסמך' }
      },
      required: ['title', 'sections', 'message']
    }
  }
];

// Write tools, keyed by entity — only added when permission.write = true
const WRITE_TOOLS = {
  shipments: [
    {
      name: 'update_shipment_status',
      description: 'עדכן סטטוס של משלוח.',
      input_schema: {
        type: 'object',
        properties: {
          shipment_id:  { type: 'string', description: 'מזהה המשלוח (id) מהרשימה' },
          status:       { type: 'string', enum: ['בדרך', 'עוכב', 'הגיע', 'נסגר'], description: 'הסטטוס החדש' },
          description:  { type: 'string', description: 'תיאור קריא לאדם' }
        },
        required: ['shipment_id', 'status', 'description']
      }
    },
    {
      name: 'create_shipment',
      description: 'צור משלוח חדש.',
      input_schema: {
        type: 'object',
        properties: {
          supplier:        { type: 'string', description: 'שם הספק' },
          carrier:         { type: 'string', description: 'חברת השילוח' },
          tracking_number: { type: 'string', description: 'מספר מעקב' },
          origin_country:  { type: 'string', description: 'ארץ מוצא' },
          destination:     { type: 'string', description: 'יעד' },
          departure_date:  { type: 'string', description: 'תאריך יציאה (YYYY-MM-DD)' },
          arrival_date:    { type: 'string', description: 'תאריך הגעה משוער (YYYY-MM-DD)' },
          description:     { type: 'string', description: 'תיאור קריא לאדם' }
        },
        required: ['supplier', 'description']
      }
    }
  ],
  tasks: [
    {
      name: 'update_task_status',
      description: 'עדכן סטטוס של משימה.',
      input_schema: {
        type: 'object',
        properties: {
          task_id:     { type: 'string', description: 'מזהה המשימה (id) מהרשימה' },
          status:      { type: 'string', enum: ['פתוח', 'בביצוע', 'הושלם'], description: 'הסטטוס החדש' },
          description: { type: 'string', description: 'תיאור קריא לאדם' }
        },
        required: ['task_id', 'status', 'description']
      }
    },
    {
      name: 'create_task',
      description: 'צור משימה חדשה.',
      input_schema: {
        type: 'object',
        properties: {
          title:       { type: 'string', description: 'כותרת המשימה' },
          description: { type: 'string', description: 'תיאור המשימה (אופציונלי)' },
          priority:    { type: 'string', enum: ['רגיל', 'בינוני', 'דחוף'], description: 'עדיפות' },
          employee_id: { type: 'string', description: 'מזהה עובד לשיוך (אופציונלי)' },
          readable_description: { type: 'string', description: 'תיאור קריא לאדם' }
        },
        required: ['title', 'readable_description']
      }
    },
    {
      name: 'delete_task',
      description: 'מחק משימה.',
      input_schema: {
        type: 'object',
        properties: {
          task_id:     { type: 'string', description: 'מזהה המשימה' },
          description: { type: 'string', description: 'תיאור קריא לאדם' }
        },
        required: ['task_id', 'description']
      }
    }
  ],
  employees: [
    {
      name: 'create_employee',
      description: 'צור עובד חדש במערכת.',
      input_schema: {
        type: 'object',
        properties: {
          name:        { type: 'string', description: 'שם העובד' },
          email:       { type: 'string', description: 'אימייל העובד' },
          department:  { type: 'string', description: 'מחלקה (אופציונלי)' },
          role:        { type: 'string', description: 'תפקיד (אופציונלי)' },
          description: { type: 'string', description: 'תיאור קריא לאדם' }
        },
        required: ['name', 'email', 'description']
      }
    }
  ]
};

// Maps action_type → required permission
const ACTION_PERMISSIONS = {
  update_shipment_status: { entity: 'shipments', op: 'write' },
  create_shipment:        { entity: 'shipments', op: 'write' },
  update_task_status:     { entity: 'tasks',     op: 'write' },
  create_task:            { entity: 'tasks',     op: 'write' },
  delete_task:            { entity: 'tasks',     op: 'write' },
  create_employee:        { entity: 'employees', op: 'write' }
};

// ─── POST /role-chat ──────────────────────────────────────────

async function handleRoleChat(request, env, cors) {
  const { role_profile, memory, conversation_history, new_message, today, permissions, manager_id, stream } = await request.json();

  if (!new_message) return jsonRes({ error: 'new_message is required' }, cors, 400);

  // RAG — vector search for relevant knowledge chunks
  let knowledgeBlock = '';
  if (role_profile.id && manager_id && env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    try {
      const embedRes = await env.AI.run('@cf/baai/bge-m3', { text: [new_message] });
      const queryEmbedding = embedRes.data?.[0];
      if (queryEmbedding) {
        const dynamicCount = new_message.length < 30 ? 4 : 8;
        const chunks = await sbRpc(env, 'match_knowledge_chunks_hybrid', {
          query_embedding:      queryEmbedding,
          query_text:           new_message,
          match_role_id:        role_profile.id,
          match_manager_id:     manager_id,
          match_count:          dynamicCount,
          similarity_threshold: 0.15
        });
        if (chunks && chunks.length) {
          const formatted = chunks.map(c =>
            (c.source_filename ? `[${c.source_filename}]\n` : '') + c.content
          ).join('\n---\n');
          // cap knowledge block at 3000 chars to limit token usage
          knowledgeBlock = '\n\nבסיס ידע:\n' + formatted.slice(0, 3000);
        }
      }
    } catch (e) { /* RAG failed silently */ }
  }

  // Fetch live data for read-permitted entities
  let liveDataBlock = '';
  if (manager_id && permissions && env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    const parts = [];

    if (permissions.shipments?.read) {
      try {
        const ships = await sbGet(env, 'shipments', {
          select: 'id,supplier,carrier,status,tracking_number,origin_country,destination,departure_date,arrival_date',
          manager_id: manager_id,
          order: 'created_at.desc',
          limit: '40'
        });
        if (ships.length) {
          parts.push('משלוחים:\n' + ships.map(s =>
            `[id:${s.id}] ${s.supplier||'-'} | ${s.carrier||'-'} | סטטוס:${s.status} | מעקב:${s.tracking_number||'-'} | מ:${s.origin_country||'-'} ל:${s.destination||'-'} | יציאה:${s.departure_date||'-'} הגעה:${s.arrival_date||'-'}`
          ).join('\n'));
        }
      } catch(e) { console.log('ships error:', e.message); }
    }

    if (permissions.tasks?.read) {
      try {
        const tasks = await sbGet(env, 'tasks', {
          select: 'id,title,status,priority',
          user_id: manager_id,
          order: 'created_at.desc',
          limit: '40'
        });
        if (tasks.length) {
          parts.push('משימות:\n' + tasks.map(t =>
            `[id:${t.id}] ${t.title} | סטטוס:${t.status} | עדיפות:${t.priority}`
          ).join('\n'));
        }
      } catch(e) {}
    }

    if (permissions.quotes?.read) {
      try {
        const quotes = await sbGet(env, 'quotes', {
          select: 'id,client_name,status,total',
          user_id: manager_id,
          order: 'created_at.desc',
          limit: '20'
        });
        if (quotes.length) {
          parts.push('הצעות מחיר:\n' + quotes.map(q =>
            `[id:${q.id}] ${q.client_name} | סטטוס:${q.status} | סכום:₪${q.total||0}`
          ).join('\n'));
        }
      } catch(e) {}
    }

    if (permissions.orders?.read) {
      try {
        const orders = await sbGet(env, 'orders', {
          select: 'id,client_name,type,status,total',
          user_id: manager_id,
          order: 'created_at.desc',
          limit: '20'
        });
        if (orders.length) {
          parts.push('הזמנות:\n' + orders.map(o =>
            `[id:${o.id}] ${o.client_name} | סוג:${o.type} | סטטוס:${o.status} | סכום:₪${o.total||0}`
          ).join('\n'));
        }
      } catch(e) {}
    }

    if (parts.length) liveDataBlock = '\n\n--- נתונים עדכניים מהמערכת ---\n' + parts.join('\n\n');
  }

  // Build tools list based on permissions
  const tools = [...BASE_TOOLS];
  if (permissions) {
    Object.entries(WRITE_TOOLS).forEach(([entity, entityTools]) => {
      if (permissions[entity]?.write) tools.push(...entityTools);
    });
  }

  const hasWritePerms = permissions && Object.values(permissions).some(p => p?.write);

  let memoryBlock = '';
  if (memory && memory.length > 0) {
    const top = [...memory].sort((a, b) => b.importance - a.importance).slice(0, 15);
    memoryBlock = '\n\nידע שנצבר מניסיון קודם:\n' + top.map(m => `• [${m.category}] ${m.content}`).join('\n');
  }

  const customBlock     = role_profile.system_prompt ? `\n\nהוראות מיוחדות:\n${role_profile.system_prompt}` : '';
  const writeInstruction = hasWritePerms
    ? '\n- כשהמשתמש מבקש לעדכן נתונים (סטטוס משלוח, משימה וכו\') — השתמש בכלי המתאים. אל תאמר שאתה מבצע פעולה בטקסט בלבד.'
    : '';

  const system = `אתה סוכן AI מקצועי של תפקיד "${role_profile.title}" בחברת "${role_profile.company_name}".

תיאור התפקיד: ${role_profile.description || 'לא צוין'}
אחריות ומשימות: ${role_profile.responsibilities || 'לא צוין'}${memoryBlock}${knowledgeBlock}${customBlock}${liveDataBlock}

כללים:
- ענה תמיד בעברית אלא אם מבקשים אחרת.
- היה ממוקד, מקצועי ומועיל.
- אם אין לך מידע, אמור זאת בכנות.
- כשמישהו מבקש PDF, הצעת מחיר, דוח, סיכום, חוזה או מסמך — השתמש בכלי create_pdf.${writeInstruction}
- התאריך של היום הוא: ${today || new Date().toLocaleDateString('he-IL')}.`;

  const messages = [
    ...(conversation_history || []).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: new_message }
  ];

  if (stream) return streamRoleChat(env, cors, system, tools, messages);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2048, system, tools, messages })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Claude API error');

  if (data.stop_reason === 'tool_use') {
    const toolUse = data.content.find(c => c.type === 'tool_use');
    if (toolUse) {
      if (toolUse.name === 'create_pdf') {
        return jsonRes({
          reply: toolUse.input.message || 'המסמך מוכן.',
          action: { type: 'create_pdf', data: toolUse.input }
        }, cors);
      }
      const textContent = data.content.find(c => c.type === 'text');
      return jsonRes({
        reply: textContent?.text || 'מצאתי את הפעולה הנדרשת. אנא אשר.',
        db_action: {
          type: toolUse.name,
          params: toolUse.input,
          description: toolUse.input.readable_description || toolUse.input.description || toolUse.name
        }
      }, cors);
    }
  }

  const reply = data.content.find(c => c.type === 'text')?.text || '';
  return jsonRes({ reply }, cors);
}

// ─── Streaming handler ────────────────────────────────────────

async function streamRoleChat(env, cors, system, tools, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2048, system, tools, messages, stream: true })
  });

  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error?.message || 'Claude API error');
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let toolBlock = null;

    const send = async (obj) => writer.write(enc.encode('data: ' + JSON.stringify(obj) + '\n\n'));

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6);
          if (raw === '[DONE]') continue;
          let evt;
          try { evt = JSON.parse(raw); } catch { continue; }

          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            await send({ t: evt.delta.text });
          } else if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
            toolBlock = { name: evt.content_block.name, json: '' };
          } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta' && toolBlock) {
            toolBlock.json += evt.delta.partial_json;
          } else if (evt.type === 'message_stop') {
            if (toolBlock) {
              try {
                const input = JSON.parse(toolBlock.json);
                if (toolBlock.name === 'create_pdf') {
                  await send({ action: { type: 'create_pdf', data: input }, reply: input.message || 'המסמך מוכן.' });
                } else {
                  await send({ db_action: { type: toolBlock.name, params: input, description: input.description || toolBlock.name } });
                }
              } catch {}
            }
            await writer.write(enc.encode('data: [DONE]\n\n'));
          }
        }
      }
    } catch (e) {
      try { await send({ error: e.message }); } catch {}
    } finally {
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }
  });
}

// ─── POST /role-action ────────────────────────────────────────

async function handleRoleAction(request, env, cors) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return jsonRes({ error: 'Worker not configured for DB actions' }, cors, 500);
  }

  const { action_type, params, role_id, manager_id, employee_jwt } = await request.json();

  if (!action_type || !role_id || !manager_id || !employee_jwt) {
    return jsonRes({ error: 'חסרים פרמטרים' }, cors, 400);
  }

  // 1. Verify employee JWT
  const user = await verifyJwt(env, employee_jwt);
  if (!user) return jsonRes({ error: 'הפגישה פגה — אנא התחבר מחדש' }, cors, 401);

  // Resolve employee_id for this auth user
  const empUsers = await sbGet(env, 'employee_users', { select: 'employee_id', auth_user_id: user.id });
  const employee_id = empUsers[0]?.employee_id || null;

  // 2. Fetch permissions from DB (server-side — never trust client)
  const roles = await sbGet(env, 'job_roles', {
    select: 'permissions',
    id: role_id,
    user_id: manager_id
  });
  if (!roles.length) return jsonRes({ error: 'תפקיד לא נמצא' }, cors, 403);
  const permissions = roles[0].permissions || {};

  // 3. Validate permission
  const required = ACTION_PERMISSIONS[action_type];
  if (!required) return jsonRes({ error: 'פעולה לא מוכרת' }, cors, 400);
  if (!permissions[required.entity]?.[required.op]) {
    return jsonRes({ error: 'אין הרשאה לפעולה זו' }, cors, 403);
  }

  // 4. Execute — always filter by manager_id for tenant isolation
  switch (action_type) {
    case 'update_shipment_status': {
      await sbPatch(env, 'shipments',
        { id: params.shipment_id, manager_id: manager_id },
        { status: params.status, updated_at: new Date().toISOString() }
      );
      return jsonRes({ success: true, message: `סטטוס המשלוח עודכן ל-${params.status}` }, cors);
    }
    case 'update_task_status': {
      await sbPatch(env, 'tasks',
        { id: params.task_id, user_id: manager_id },
        { status: params.status, updated_at: new Date().toISOString() }
      );
      return jsonRes({ success: true, message: `סטטוס המשימה עודכן ל-${params.status}` }, cors);
    }
    case 'create_task': {
      await sbInsert(env, 'tasks', {
        user_id: manager_id,
        employee_id: params.employee_id || employee_id || null,
        title: params.title,
        description: params.description || '',
        priority: params.priority || 'רגיל',
        status: 'פתוח',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      return jsonRes({ success: true, message: `משימה נוצרה: ${params.title}` }, cors);
    }
    case 'delete_task': {
      await sbDelete(env, 'tasks', { id: params.task_id, user_id: manager_id });
      return jsonRes({ success: true, message: 'המשימה נמחקה' }, cors);
    }
    case 'create_shipment': {
      await sbInsert(env, 'shipments', {
        manager_id: manager_id,
        supplier: params.supplier || '',
        carrier: params.carrier || '',
        tracking_number: params.tracking_number || '',
        origin_country: params.origin_country || '',
        destination: params.destination || '',
        departure_date: params.departure_date || null,
        arrival_date: params.arrival_date || null,
        status: 'בדרך',
        created_at: new Date().toISOString()
      });
      return jsonRes({ success: true, message: `משלוח נוצר: ${params.supplier}` }, cors);
    }
    case 'create_employee': {
      await sbInsert(env, 'employees', {
        user_id: manager_id,
        name: params.name,
        email: params.email,
        department: params.department || '',
        role: params.role || '',
        active: true,
        created_at: new Date().toISOString()
      });
      return jsonRes({ success: true, message: `עובד נוצר: ${params.name}` }, cors);
    }
    default:
      return jsonRes({ error: 'פעולה לא ממומשת' }, cors, 400);
  }
}

// ─── POST /embed ──────────────────────────────────────────────

async function handleEmbed(request, env, cors) {
  const { texts } = await request.json();
  if (!texts || !texts.length) return jsonRes({ error: 'texts required' }, cors, 400);
  const result = await env.AI.run('@cf/baai/bge-m3', { text: texts });
  return jsonRes({ embeddings: result.data }, cors);
}

// ─── POST /role-extract-pdf — extract text from PDF via Claude ─
async function handleExtractPdf(request, env, cors) {
  const { pdf_base64 } = await request.json();
  if (!pdf_base64) return jsonRes({ error: 'pdf_base64 required' }, cors, 400);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'pdfs-2024-09-25'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 }
          },
          {
            type: 'text',
            text: 'Extract all text from this document. Return only the raw text content, preserving structure (headings, paragraphs, tables as text). No explanations.'
          }
        ]
      }]
    })
  });

  const data = await res.json();
  if (!res.ok) return jsonRes({ error: data.error?.message || 'Claude PDF error' }, cors, 500);
  const text = data.content?.[0]?.text || '';
  return jsonRes({ text }, cors);
}

// ─── POST /role-index — chunk + embed knowledge base ─────────

async function handleRoleIndex(request, env, cors) {
  const { role_id, manager_id, content, storage_path, filename, file_id, append = false } = await request.json();
  if (!role_id || !manager_id || (!content && !storage_path)) {
    return jsonRes({ error: 'role_id, manager_id, and content or storage_path required' }, cors, 400);
  }

  // 1. Resolve text content
  let text = content;
  if (!text && storage_path) {
    const storageUrl = `${env.SUPABASE_URL.trim()}/storage/v1/object/${storage_path}`;
    const fileRes = await fetch(storageUrl, {
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
    if (!fileRes.ok) throw new Error('Storage fetch failed: ' + await fileRes.text());
    text = await fileRes.text();
  }

  // 2. Delete existing chunks
  if (!append) {
    try {
      await sbDelete(env, 'role_knowledge_chunks', { role_id, manager_id });
    } catch(e) {
      return jsonRes({ error: 'step2-delete: ' + e.message }, cors, 500);
    }
  }

  // 3. Split into chunks
  const chunks = chunkText(text);
  if (!chunks.length) return jsonRes({ indexed: 0 }, cors);

  // 4. Get start index for append mode
  let startIndex = 0;
  if (append) {
    try {
      const existing = await sbGet(env, 'role_knowledge_chunks', {
        select: 'chunk_index',
        role_id,
        manager_id,
        order: 'chunk_index.desc',
        limit: '1'
      });
      startIndex = existing.length ? (existing[0].chunk_index + 1) : 0;
    } catch(e) {}
  }

  // 5. Embed in batches of 20 to avoid Worker timeouts
  const EMBED_BATCH = 20;
  const allEmbeddings = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    let result;
    try {
      result = await env.AI.run('@cf/baai/bge-m3', { text: batch });
    } catch(e) {
      return jsonRes({ error: `step5-embed batch${i}-${i+batch.length}: ${e.message}` }, cors, 500);
    }
    allEmbeddings.push(...(result.data || []));
  }

  // 6. Insert chunks with embeddings
  const rows = chunks.map((chunk, i) => ({
    role_id,
    manager_id,
    chunk_index: startIndex + i,
    content: chunk,
    embedding: allEmbeddings[i] ? JSON.stringify(allEmbeddings[i]) : null,
    ...(filename ? { source_filename: filename } : {})
  }));
  try {
    await sbInsert(env, 'role_knowledge_chunks', rows);
  } catch(e) {
    return jsonRes({ error: 'step6-insert (' + rows.length + ' rows): ' + e.message }, cors, 500);
  }

  // 7. Update file registry if file_id provided
  if (file_id) {
    try {
      await sbPatch(env, 'role_knowledge_files', { id: file_id }, {
        chunk_count: rows.length,
        indexed_at: new Date().toISOString()
      });
    } catch(e) { /* non-fatal */ }
  }

  return jsonRes({ indexed: rows.length, filename: filename || null }, cors);
}

// ─── POST /role-learn — extract insights, return to client ───

async function handleRoleLearn(request, env, cors) {
  const { conversation_history, role_profile, agent_id } = await request.json();

  if (!conversation_history || conversation_history.length < 2) {
    return jsonRes({ insights: [] }, cors);
  }

  // Fetch existing memories for dedup
  let existingBlock = '';
  if (agent_id) {
    try {
      const existing = await sbGet(env, 'role_agent_memory', {
        select: 'content',
        agent_id,
        order: 'importance.desc',
        limit: '40'
      });
      if (existing.length) {
        existingBlock = '\n\nזיכרונות קיימים — אל תשכפל:\n' + existing.map(m => `• ${m.content}`).join('\n');
      }
    } catch(e) {}
  }

  const convText = conversation_history
    .map(m => `${m.role === 'user' ? 'עובד' : 'סוכן'}: ${m.content}`)
    .join('\n');

  const system = `אתה מנתח שיחות עבודה. תפקידך לחלץ תובנות שיעזרו לעובד הבא בתפקיד "${role_profile?.title || ''}". החזר JSON בלבד.`;
  const prompt = `נתח שיחה זו וחלץ עד 5 תובנות שימושיות:

${convText}${existingBlock}

פורמט JSON:
{"insights":[{"category":"workflow|faq|process|contact|insight","content":"תיאור בעברית","importance":3}]}

חוקים:
- importance: 1=נמוך, 5=גבוה מאוד — שמור רק importance >= 2
- אל תכלול תובנות הדומות לזיכרונות הקיימים`;

  let insights = [];
  try {
    const text = await claude(env, system, [{ role: 'user', content: prompt }], 512);
    const match = text.match(/\{[\s\S]*\}/);
    if (match) insights = JSON.parse(match[0]).insights || [];
  } catch(e) {}

  insights = insights.filter(ins => (ins.importance || 1) >= 2);
  return jsonRes({ insights }, cors);
}

// ─── POST /role-save — learn + save insights server-side ─────

async function handleRoleSave(request, env, cors) {
  const { conversation_history, role_profile, agent_id, conv_id, employee_id } = await request.json();

  if (!conversation_history || conversation_history.length < 2 || !agent_id) {
    return jsonRes({ saved: 0 }, cors);
  }

  // 1. Close the conversation record immediately
  if (conv_id) {
    await sbPatch(env, 'role_conversations', { id: conv_id }, { ended_at: new Date().toISOString() }).catch(() => {});
  }

  // 2. Fetch existing memories to avoid duplicates
  let existingMemories = [];
  try {
    existingMemories = await sbGet(env, 'role_agent_memory', {
      select: 'content',
      agent_id,
      order: 'importance.desc',
      limit: '40'
    });
  } catch(e) {}

  const existingBlock = existingMemories.length
    ? '\n\nזיכרונות קיימים — אל תשכפל:\n' + existingMemories.map(m => `• ${m.content}`).join('\n')
    : '';

  // 3. Extract insights via Claude
  const convText = conversation_history
    .map(m => `${m.role === 'user' ? 'עובד' : 'סוכן'}: ${m.content}`)
    .join('\n');

  const system = `אתה מנתח שיחות עבודה. תפקידך לחלץ תובנות שיעזרו לעובד הבא בתפקיד "${role_profile?.title || ''}". החזר JSON בלבד.`;
  const prompt = `נתח שיחה זו וחלץ עד 5 תובנות שימושיות:

${convText}${existingBlock}

פורמט JSON:
{"insights":[{"category":"workflow|faq|process|contact|insight|זהות|העדפה","content":"תיאור בעברית","importance":3,"personal":false}]}

חוקים:
- importance: 1=נמוך, 5=גבוה מאוד — שמור רק importance >= 2
- אל תכלול תובנות הדומות לזיכרונות הקיימים
- personal: true רק אם התובנה אישית לעובד הזה ולא לתפקיד בכלל`;

  let insights = [];
  try {
    const text = await claude(env, system, [{ role: 'user', content: prompt }], 512);
    const match = text.match(/\{[\s\S]*\}/);
    if (match) insights = JSON.parse(match[0]).insights || [];
  } catch (e) {}

  // 4. Filter low-importance + build insert rows
  const PERSONAL_CATEGORIES = new Set(['זהות', 'העדפה']);
  const inserts = insights
    .filter(ins => (ins.importance || 1) >= 2)
    .map(ins => {
      const row = {
        agent_id,
        category: ins.category || 'insight',
        content: ins.content,
        importance: Math.min(5, Math.max(2, ins.importance || 2))
      };
      if (ins.personal || PERSONAL_CATEGORIES.has(ins.category)) {
        row.employee_id = employee_id || null;
      }
      return row;
    });

  if (!inserts.length) return jsonRes({ saved: 0 }, cors);

  await sbInsert(env, 'role_agent_memory', inserts).catch(() => {});

  // 5. Prune — keep top 60 by importance desc, created_at desc
  try {
    const all = await sbGet(env, 'role_agent_memory', {
      select: 'id',
      agent_id,
      order: 'importance.desc,created_at.desc',
      limit: '200'
    });
    if (all.length > 60) {
      await sbDeleteIds(env, 'role_agent_memory', all.slice(60).map(m => m.id));
    }
  } catch(e) {}

  // 6. Bump total_conversations counter
  try {
    const agents = await sbGet(env, 'role_agents', { select: 'total_conversations', id: agent_id });
    if (agents.length) {
      await sbPatch(env, 'role_agents', { id: agent_id }, {
        total_conversations: (agents[0].total_conversations || 0) + 1,
        last_updated: new Date().toISOString()
      });
    }
  } catch (e) {}

  return jsonRes({ saved: inserts.length }, cors);
}


// redeploy with secrets
