// Agent7 — Role Agent Worker
// Deploy this as a NEW Cloudflare Worker (e.g. agent7-roles.shvirooren.workers.dev)
//
// Environment variables required:
//   ANTHROPIC_API_KEY — Claude API key

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
      if (url.pathname === '/role-chat')  return await handleRoleChat(request, env, cors);
      if (url.pathname === '/role-learn') return await handleRoleLearn(request, env, cors);
      if (url.pathname === '/embed')      return await handleEmbed(request, env, cors);
      return new Response('Not Found', { status: 404, headers: cors });
    } catch (err) {
      return jsonRes({ error: err.message }, cors, 500);
    }
  }
};

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

// ─── Skills available to role agents ─────────────────────────

const AGENT_TOOLS = [
  {
    name: 'create_pdf',
    description: 'יצור מסמך PDF עבור המשתמש. השתמש בכלי זה כאשר המשתמש מבקש PDF, הצעת מחיר, דוח, סיכום, חוזה, או כל מסמך מובנה להורדה.',
    input_schema: {
      type: 'object',
      properties: {
        title:    { type: 'string', description: 'כותרת המסמך' },
        subtitle: { type: 'string', description: 'כותרת משנה, תאריך, או פרטי לקוח' },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string' },
              type:    { type: 'string', enum: ['text', 'table', 'list'] },
              content: { type: 'string', description: 'טקסט חופשי (כשtype=text)' },
              headers: { type: 'array', items: { type: 'string' }, description: 'כותרות עמודות (כשtype=table)' },
              rows:    { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'שורות הטבלה' },
              items:   { type: 'array', items: { type: 'string' }, description: 'פריטי הרשימה (כשtype=list)' }
            },
            required: ['type']
          }
        },
        message: { type: 'string', description: 'הודעה קצרה לעובד בצ\'אט לאחר יצירת המסמך' }
      },
      required: ['title', 'sections', 'message']
    }
  }
];

// ─── POST /role-chat ──────────────────────────────────────────

async function handleRoleChat(request, env, cors) {
  const { role_profile, memory, conversation_history, new_message, today } = await request.json();

  if (!new_message) return jsonRes({ error: 'new_message is required' }, cors, 400);

  let memoryBlock = '';
  if (memory && memory.length > 0) {
    const top = [...memory].sort((a, b) => b.importance - a.importance).slice(0, 30);
    memoryBlock = '\n\nידע שנצבר מניסיון קודם:\n' + top.map(m => `• [${m.category}] ${m.content}`).join('\n');
  }

  const knowledgeBlock = role_profile.knowledge ? `\n\nבסיס ידע:\n${role_profile.knowledge}` : '';
  const customBlock = role_profile.system_prompt ? `\n\nהוראות מיוחדות:\n${role_profile.system_prompt}` : '';

  const system = `אתה סוכן AI מקצועי של תפקיד "${role_profile.title}" בחברת "${role_profile.company_name}".

תיאור התפקיד: ${role_profile.description || 'לא צוין'}
אחריות ומשימות: ${role_profile.responsibilities || 'לא צוין'}${memoryBlock}${knowledgeBlock}${customBlock}

כללים:
- אתה עוזר לכל מי שממלא תפקיד זה. הידע שלך שייך לתפקיד, לא לאדם ספציפי.
- ענה תמיד בעברית אלא אם מבקשים אחרת.
- היה ממוקד, מקצועי ומועיל.
- אם אין לך מידע, אמור זאת בכנות.
- כשמישהו מבקש PDF, הצעת מחיר, דוח, סיכום, חוזה או כל מסמך — השתמש תמיד בכלי create_pdf.
- התאריך של היום הוא: ${today || new Date().toLocaleDateString('he-IL')}.`;

  const messages = [
    ...(conversation_history || []).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: new_message }
  ];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2048, system, tools: AGENT_TOOLS, messages })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Claude API error');

  // Tool use — PDF
  if (data.stop_reason === 'tool_use') {
    const toolUse = data.content.find(c => c.type === 'tool_use');
    if (toolUse && toolUse.name === 'create_pdf') {
      return jsonRes({
        reply: toolUse.input.message || 'המסמך מוכן.',
        action: { type: 'create_pdf', data: toolUse.input }
      }, cors);
    }
  }

  // Normal reply
  const reply = data.content.find(c => c.type === 'text')?.text || '';
  return jsonRes({ reply }, cors);
}

// ─── POST /embed ──────────────────────────────────────────────

async function handleEmbed(request, env, cors) {
  const { texts } = await request.json();
  if (!texts || !texts.length) return jsonRes({ error: 'texts required' }, cors, 400);
  const result = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: texts });
  return jsonRes({ embeddings: result.data }, cors);
}

// ─── POST /role-learn ─────────────────────────────────────────

async function handleRoleLearn(request, env, cors) {
  const { conversation_history, role_profile } = await request.json();

  if (!conversation_history || conversation_history.length < 2) {
    return jsonRes({ insights: [] }, cors);
  }

  const convText = conversation_history
    .map(m => `${m.role === 'user' ? 'עובד' : 'סוכן'}: ${m.content}`)
    .join('\n');

  const system = `אתה מנתח שיחות עבודה. תפקידך לחלץ תובנות שיעזרו לעובד הבא בתפקיד "${role_profile.title}". החזר JSON בלבד.`;

  const prompt = `נתח שיחה זו וחלץ עד 5 תובנות שימושיות:

${convText}

פורמט JSON:
{"insights":[{"category":"workflow|faq|process|contact|insight","content":"תיאור בעברית","importance":3}]}

importance: 1=נמוך, 5=גבוה מאוד. כלול רק מידע שיועיל לעובד הבא.`;

  const text = await claude(env, system, [{ role: 'user', content: prompt }], 512);

  let insights = [];
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) insights = JSON.parse(match[0]).insights || [];
  } catch (e) { insights = []; }

  return jsonRes({ insights }, cors);
}
