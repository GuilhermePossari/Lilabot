// index.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

const GRAPH = 'https://graph.facebook.com/v20.0';
const { VERIFY_TOKEN, PHONE_NUMBER_ID, PORT = 3000 } = process.env;

// ===== Gemini (REST) =====
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-1.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;

// headers Meta
const auth = () => ({ Authorization: `Bearer ${process.env.WHATS_TOKEN}` });

// ===== Persistência simples (contador) =====
const DB_FILE = './contagem.json';
const db = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE))
  : { total: 0, porUsuario: {}, porTipo: { geral: 0, med: 0 } };

const saveDB = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const incCont = (jid, tipo='geral') => {
  db.total++;
  db.porTipo[tipo] = (db.porTipo[tipo] || 0) + 1;
  db.porUsuario[jid] = (db.porUsuario[jid] || 0) + 1;
  saveDB();
};
const resumo = (jid) =>
  `📊 Contador de Piadas
Total do bot: ${db.total}
Seu total: ${db.porUsuario[jid]||0}
Por tipo: geral=${db.porTipo.geral||0}, med=${db.porTipo.med||0}`;
const top = (n=5) => {
  const a = Object.entries(db.porUsuario).sort((x,y)=>y[1]-x[1]).slice(0,n);
  return a.length
    ? '🏆 Top contadores\n' + a.map(([j,c],i)=>`${i+1}. ${j.split('@')[0]} — ${c}`).join('\n')
    : '🏆 Top contadores\nSem dados ainda.';
};

// ===== Sessões (modo pergunta + persona Lila) =====
const SESS_FILE = './sessions.json';
// Estrutura: { jid: { mode: 'default'|'chat', personaOn: boolean, history: [{role:'user'|'model', text}] } }
const sessions = fs.existsSync(SESS_FILE) ? JSON.parse(fs.readFileSync(SESS_FILE)) : {};
const saveSess = () => fs.writeFileSync(SESS_FILE, JSON.stringify(sessions, null, 2));

const ensureSess = (jid) => {
  if (!sessions[jid]) {
    sessions[jid] = { mode: 'default', personaOn: false, history: [] };
  }
};
const setMode = (jid, mode) => { ensureSess(jid); sessions[jid].mode = mode; saveSess(); };
const getMode = (jid) => (sessions[jid]?.mode || 'default');
const setPersona = (jid, on) => { ensureSess(jid); sessions[jid].personaOn = !!on; saveSess(); };
const isPersona = (jid) => !!(sessions[jid]?.personaOn);
const pushHistory = (jid, role, text) => {
  ensureSess(jid);
  sessions[jid].history.push({ role, text });
  if (sessions[jid].history.length > 16) sessions[jid].history = sessions[jid].history.slice(-16);
  saveSess();
};
const clearHistory = (jid) => { ensureSess(jid); sessions[jid].history = []; saveSess(); };

// ===== Fallback piadas =====
const FB_GERAL = [
  `Por que o livro de matemática estava triste?\n\nPorque tinha muitos problemas.`,
  `O que o zero disse pro oito?\n\nBela cinta!`,
];
const FB_MED = [
  `Paciente: "Doutor, estou vendo tudo dobrado!"\n\nMédico: "Sente ali."\nPaciente: "Em qual das quatro cadeiras?"`,
  `Estudante: "Decorei todos os ossos!"\n\nAmigo: "De cor?"\n"Não, de dor."`,
];

// ===== Intenções/Regex =====
const REG_PEDIR_PIADA = /\b(piada|piadinha|me conta|me conte|conta uma|conte uma|manda uma)\b/i;
const REG_MED = /\b(med|medicina|médic|anatomia|hospital|plantão|residênc|clínic|cirurg)\b/i;
const querPiada = (t) => REG_PEDIR_PIADA.test(t||'');
const isMedText = (t) => REG_MED.test(t||'');

const CMD_PERGUNTA_ON = /^!pergunta\s+on\b/i;
const CMD_PERGUNTA_OFF = /^!pergunta\s+off\b/i;
const ONE_SHOT_Q_CMD = /^!pergunta\s+(.+)/i;
const ONE_SHOT_Q_TXT = /^(?:\?+|pergunta:\s*)(.+)/i;
const extraiPergunta = (raw) => {
  const a = ONE_SHOT_Q_CMD.exec(raw); if (a?.[1]) return a[1].trim();
  const b = ONE_SHOT_Q_TXT.exec(raw); if (b?.[1]) return b[1].trim();
  return null;
};

// ===== Persona Lila =====
const personaHeader = `
Você é **Lila**, uma spitz alemã branquinha (cachorrinha dócil e brincalhona).
Sua humana é a **Helo**, uma garota ruiva linda que estuda **Medicina**.
Sua irmã é a **Dory Maria**, uma **lhasa** branca e gordinha.
Fale em **português do Brasil**, com tom carinhoso, divertido e leve.
Mantenha segurança: sem informações médicas/legais específicas; seja respeitosa.
Quando fizer piadas, mantenha o formato:
Setup

Punchline
`.trim();

// envelopa qualquer prompt com a persona quando ligada
const withPersona = (basePrompt) =>
  `${personaHeader}\n\n---\n\nTarefa:\n${basePrompt}`;

// ===== Prompts =====
const pPiadaGeral = () => `
Gere UMA piada curta, em português do Brasil.
Formato:
Setup da piada

Punchline da piada
Regras:
- 2 a 6 frases.
- Tom leve, sem ofensas/estigmas.
- Sem nomes reais, diagnósticos específicos ou dados pessoais.
`.trim();

const pPiadaMed = () => `
Gere UMA piada curta sobre MEDICINA (vida de estudantes/profissionais), em português do Brasil.
Formato:
Setup da piada

Punchline da piada
Regras:
- 2 a 6 frases.
- Tom leve, não ofensivo; sem estigmatizar doenças/pacientes; sem conteúdo antiético.
- Evite diagnósticos específicos e dados pessoais.
`.trim();

const pPerguntaOneShot = (q) => `
Responda, de forma concisa (até ~8 linhas), à pergunta abaixo:
"${q}"
Seja direto, útil e seguro. Se o tema for delicado (saúde, legal, financeiro), ofereça informações gerais e ressalvas apropriadas.
`.trim();

// ===== Gemini helpers =====
async function geminiGenerate(prompt, historyParts = null) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY ausente');

  const contents = [];
  if (historyParts && historyParts.length) {
    for (const p of historyParts) {
      contents.push({
        role: p.role === 'model' ? 'model' : 'user',
        parts: [{ text: p.text }],
      });
    }
  }
  contents.push({ role: 'user', parts: [{ text: prompt }] });

  const body = {
    contents,
    generationConfig: { temperature: 0.9, maxOutputTokens: 220 },
  };

  const { data } = await axios.post(GEMINI_URL, body, { timeout: 20000 });
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim();
  if (!text) throw new Error('Gemini sem texto');
  return text.replace(/\n{3,}/g, '\n\n');
}

// ===== WhatsApp helpers =====
async function sendText(to, body) {
  return axios.post(
    `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body } },
    { headers: auth() }
  );
}
async function sendStickerById(to, stickerId) {
  return axios.post(
    `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'sticker', sticker: { id: stickerId } },
    { headers: auth() }
  );
}

// ===== Verificação de webhook =====
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===== Webhook de mensagens =====
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const type = msg.type;

    // ===== TEXTO =====
    if (type === 'text') {
      const raw = (msg.text?.body || '').trim();
      const text = raw.toLowerCase();

      // Obrigado → sticker automático
      if (text.includes('obrigada') || text.includes('obrigado')) {
        const s1 = process.env.LILA_ID_1;
        const s2 = process.env.DORY_ID_1;
        const stickers = [s1, s2].filter(Boolean);
        if (stickers.length) {
          const pick = stickers[Math.floor(Math.random() * stickers.length)];
          try { await sendStickerById(from, pick); }
          catch (e) { await sendText(from, '💛 de nada! (mande uma imagem que viro figurinha 😉)'); }
        } else {
          await sendText(from, 'Recebi seu “obrigada”! Configure LILA_ID_1/DORY_ID_1 para eu mandar figurinhas 😊');
        }
        return res.sendStatus(200);
      }

      // Contador/Ranking
      if (/^!conta\b/i.test(text)) { await sendText(from, resumo(from)); return res.sendStatus(200); }
      if (/^!top\b/i.test(text)) { await sendText(from, top(5)); return res.sendStatus(200); }

      // Ajuda
      if (/^!help\b/i.test(text)) {
        const persona = isPersona(from) ? 'ON' : 'OFF';
        const mode = getMode(from) === 'chat' ? 'ON' : 'OFF';
        await sendText(from,
`Comandos:
!piada           → piada geral
!piada med       → piada sobre medicina
!conta           → sua contagem + total
!top             → ranking de piadas
!pergunta on/off → liga/desliga modo chat (Gemini). Status: ${mode}
!pergunta TEXTO  → pergunta pontual (one-shot)
? TEXTO          → idem
!lila on/off     → liga/desliga persona Lila. Status: ${persona}
!lila status     → mostra status da persona

Dica: mande "me conte uma piada" (se falar de medicina, faço piada de med).
Envie imagem com legenda "!sticker" para criar figurinha.`);
        return res.sendStatus(200);
      }

      // Persona Lila ON/OFF/STATUS
      if (/^!lila\s+on\b/i.test(text)) { setPersona(from, true); await sendText(from, '🐶 Modo Lila: ON'); return res.sendStatus(200); }
      if (/^!lila\s+off\b/i.test(text)) { setPersona(from, false); await sendText(from, '🐶 Modo Lila: OFF (Gemini comum)'); return res.sendStatus(200); }
      if (/^!lila\s+status\b/i.test(text)) {
        await sendText(from, `🐶 Modo Lila está: ${isPersona(from) ? 'ON' : 'OFF'}`);
        return res.sendStatus(200);
      }

      // Modo pergunta (chat) ON/OFF
      if (CMD_PERGUNTA_ON.test(text)) { setMode(from, 'chat'); await sendText(from, '💬 Modo Pergunta: ON. Pode mandar suas perguntas!'); return res.sendStatus(200); }
      if (CMD_PERGUNTA_OFF.test(text)) { setMode(from, 'default'); clearHistory(from); await sendText(from, '💬 Modo Pergunta: OFF.'); return res.sendStatus(200); }

      // Pergunta one-shot
      const perguntaPontual = extraiPergunta(raw);
      if (perguntaPontual) {
        try {
          const base = pPerguntaOneShot(perguntaPontual);
          const prompt = isPersona(from) ? withPersona(base) : base;
          const resp = await geminiGenerate(prompt);
          await sendText(from, resp);
        } catch (e) {
          await sendText(from, 'Não consegui responder agora 😞. Tente novamente em instantes.');
        }
        return res.sendStatus(200);
      }

      // Piadas via comando
      if (/^!piada(\s+med)?\b/i.test(text)) {
        const isMed = /\bmed\b/i.test(text);
        try {
          const base = isMed ? pPiadaMed() : pPiadaGeral();
          const prompt = isPersona(from) ? withPersona(base) : base;
          const joke = await geminiGenerate(prompt);
          incCont(from, isMed ? 'med' : 'geral');
          await sendText(from, joke);
        } catch (e) {
          const fb = (isMed ? FB_MED : FB_GERAL);
          const pick = fb[Math.floor(Math.random() * fb.length)];
          incCont(from, isMed ? 'med' : 'geral');
          await sendText(from, pick);
        }
        return res.sendStatus(200);
      }

      // Piadas via linguagem natural
      if (querPiada(text)) {
        const med = isMedText(text);
        try {
          const base = med ? pPiadaMed() : pPiadaGeral();
          const prompt = isPersona(from) ? withPersona(base) : base;
          const joke = await geminiGenerate(prompt);
          incCont(from, med ? 'med' : 'geral');
          await sendText(from, joke);
        } catch (e) {
          const fb = (med ? FB_MED : FB_GERAL);
          const pick = fb[Math.floor(Math.random() * fb.length)];
          incCont(from, med ? 'med' : 'geral');
          await sendText(from, pick);
        }
        return res.sendStatus(200);
      }

      // Modo chat (Gemini) ligado → toda mensagem vira pergunta
      if (getMode(from) === 'chat') {
        try {
          // histórico como está, adicionamos a persona no "system-like" do prompt atual
          const base = raw;
          const prompt = isPersona(from) ? withPersona(base) : base;
          const hist = sessions[from]?.history || [];
          const resp = await geminiGenerate(prompt, hist);
          pushHistory(from, 'user', raw);
          pushHistory(from, 'model', resp);
          await sendText(from, resp);
        } catch (e) {
          await sendText(from, 'Não consegui responder agora 😞. Tente novamente em instantes.');
        }
        return res.sendStatus(200);
      }

      // Padrão (modo normal): mantém seu comportamento original
      await sendText(from,
        'Oi! 👋 Manda uma foto com a legenda "!sticker" que eu viro figurinha 😎\n\nNovidades:\n- !piada / !piada med\n- !pergunta on/off, !pergunta TEXTO, ? TEXTO\n- !lila on/off/status (persona da Lila)');
      return res.sendStatus(200);
    }

    // ===== IMAGEM → figurinha =====
    if (type === 'image') {
      try {
        const mediaId = msg.image.id;
        const meta = await axios.get(`${GRAPH}/${mediaId}`, { headers: auth() });
        const url = meta.data.url;

        const imgResp = await axios.get(url, { headers: auth(), responseType: 'arraybuffer' });
        const imgBuf = Buffer.from(imgResp.data);

        let q = 80;
        async function makeWebp(quality) {
          return sharp(imgBuf)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp({ quality })
            .toBuffer();
        }
        let webp = await makeWebp(q);
        while (webp.length > 100 * 1024 && q >= 40) {
          q -= 5;
          webp = await makeWebp(q);
        }

        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', 'sticker');
        form.append('file', webp, { filename: 'sticker.webp', contentType: 'image/webp' });

        const up = await axios.post(`${GRAPH}/${PHONE_NUMBER_ID}/media`, form, {
          headers: { ...auth(), ...form.getHeaders() }
        });
        const stickerId = up.data.id;

        await new Promise(r => setTimeout(r, 600));
        await axios.post(
          `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: 'whatsapp', to: from, type: 'sticker', sticker: { id: stickerId } },
          { headers: auth() }
        );

        await sendText(from, '✅ Pra você! 🌹');
      } catch (e) {
        await sendText(from, '❌ Não consegui gerar a figurinha. Manda mensagem pro Possari 😞😢');
      }
      return res.sendStatus(200);
    }

    // ===== Outros tipos → padrão =====
    await sendText(from, 'Oi! Manda uma foto que eu faço virar figurinha 😎 (ou use !piada / !pergunta / !lila)');
  } catch (e) {
    console.error('Erro no webhook:', e?.response?.data || e.message);
  }
  return res.sendStatus(200);
});

// Healthcheck
app.get('/', (_, res) => res.send('ok'));
app.listen(PORT, () => console.log(`Webhook ON :${PORT}`));
