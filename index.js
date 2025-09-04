// index.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

const GRAPH = 'https://graph.facebook.com/v23.0';
const { VERIFY_TOKEN, PHONE_NUMBER_ID, PORT = 3000 } = process.env;

// ===== Gemini (REST) =====
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-1.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;

// headers Meta
const auth = () => ({ Authorization: `Bearer ${process.env.WHATS_TOKEN}` });

// ===== Persistências =====
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

const SESS_FILE = './sessions.json';
// { jid: { mode: 'normal'|'pergunta', personaOn: boolean, history:[{role,text}] } }
const sessions = fs.existsSync(SESS_FILE) ? JSON.parse(fs.readFileSync(SESS_FILE)) : {};
const saveSess = () => fs.writeFileSync(SESS_FILE, JSON.stringify(sessions, null, 2));
const ensureSess = (jid) => { if (!sessions[jid]) sessions[jid] = { mode:'normal', personaOn:false, history:[] }; };
const setMode = (jid, mode) => { ensureSess(jid); sessions[jid].mode = mode; saveSess(); };
const togglePersona = (jid) => { ensureSess(jid); sessions[jid].personaOn = !sessions[jid].personaOn; saveSess(); return sessions[jid].personaOn; };
const getMode = (jid) => (sessions[jid]?.mode || 'normal');
const isPersona = (jid) => !!(sessions[jid]?.personaOn);
const pushHistory = (jid, role, text) => {
  ensureSess(jid);
  sessions[jid].history.push({ role, text });
  if (sessions[jid].history.length > 16) sessions[jid].history = sessions[jid].history.slice(-16);
  saveSess();
};
const clearHistory = (jid) => { ensureSess(jid); sessions[jid].history = []; saveSess(); };

// ===== Piadas fallback =====
const FB_GERAL = [
  'Meu relógio quebrou… agora vivo no horário do “tanto faz”.',
  'Tentei fazer dieta. A geladeira tentou me sabotar. Ganhou.',
  'Fui correr na esteira… a esteira fugiu. Sinal de que não era pra hoje.',
  'Comprei um despertador silencioso. Ele não toca. Perfeito!',
  'Meu plano fitness: pular conclusões e correr dos boletos.',
];
const FB_MED = [
  'Na prova prática me pediram “calma”: achei que era um medicamento novo.',
  'Plantão de 12 horas: também conhecido como “um minuto de paz parcelado em 720 vezes”.',
  'Anatomia é linda… até você decorar que temos mais nervos do que paciência.',
  'Estetoscópio é tipo Wi-Fi do médico: sem ele a gente nem conecta no paciente.',
  'Passei tanto tempo no hospital que tô pensando em pagar condomínio.',
];

// ===== Intenções =====
const REG_PIADA = /(me conte uma piada|conte uma piada|conta uma piada|manda uma piada)/i;
const REG_PIADA_MED = /(piada sobre medicina|piada de medicina|piada de med|piada médica|piada de anatomia|piada de plantão)/i;
const REG_MODO_NORMAL = /^modo\s+normal$/i;
const REG_MODO_PERGUNTA = /^modo\s+pergunta$/i;
const REG_MODO_LILA = /^modo\s+lila$/i;

// ===== Persona (não repetir em toda resposta; só influencia o tom) =====
const personaHint = `Responda no tom de “Lila”, uma spitz branca carinhosa e brincalhona. Ela é da Helo (ruiva, estudante de Medicina) e irmã da Dory Maria (lhasa branca fofinha). Seja calorosa, espirituosa e leve, sem repetir essa descrição.`;

// ===== Prompts =====
const promptPiada = (isMed=false) => `
Escreva UMA piada curta, em português do Brasil, com humor leve e timing natural. Nada de títulos como “Setup” ou “Punchline”.
Tema: ${isMed ? 'vida de estudantes/profissionais de Medicina (sem estigmatizar doenças/pacientes)' : 'cotidiano geral'}.
Evite nomes reais e conteúdo sensível. Soe natural como conversa de WhatsApp.
`.trim();

const promptPergunta = (q) => `
Responda de forma útil e concisa (até ~8 linhas) à pergunta:
"${q}"
Se o tema for sensível (saúde/finanças/lei), traga informações gerais e ressalvas. Seja direto, claro e gentil.
`.trim();

// ===== Gemini =====
async function geminiGenerate({ prompt, historyParts = null, persona = false }) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY ausente');
  const contents = [];

  if (historyParts?.length) {
    for (const p of historyParts) contents.push({ role: p.role === 'model' ? 'model' : 'user', parts: [{ text: p.text }] });
  }

  // Sem repetir persona toda hora: é só uma dica de estilo dentro do prompt atual
  const finalPrompt = persona ? `${personaHint}\n\n${prompt}` : prompt;
  contents.push({ role: 'user', parts: [{ text: finalPrompt }] });

  const body = { contents, generationConfig: { temperature: 0.95, maxOutputTokens: 220 } };
  const { data } = await axios.post(GEMINI_URL, body, { timeout: 20000 });
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim();
  if (!text) throw new Error('Gemini sem texto');
  return text.replace(/\n{3,}/g, '\n\n');
}

// ===== WhatsApp helpers =====
async function sendText(to, body) {
  return axios.post(`${GRAPH}/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body } },
    { headers: auth() });
}
async function sendStickerById(to, stickerId) {
  return axios.post(`${GRAPH}/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'sticker', sticker: { id: stickerId } },
    { headers: auth() });
}

// ===== Webhook verify =====
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===== Webhook =====
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

      // “obrigado/obrigada” → sticker pronto (opcional)
      if (text.includes('obrigada') || text.includes('obrigado')) {
        const s1 = process.env.LILA_ID_1;
        const s2 = process.env.DORY_ID_1;
        const stickers = [s1, s2].filter(Boolean);
        if (stickers.length) {
          try { await sendStickerById(from, stickers[Math.floor(Math.random()*stickers.length)]); }
          catch { /* silencia */ }
        }
        // não precisa responder texto sempre
        return res.sendStatus(200);
      }

      // ===== Modo normal / pergunta / Lila (sem exclamações) =====
      if (REG_MODO_NORMAL.test(raw)) {
        setMode(from, 'normal'); // não mexe na persona
        clearHistory(from);
        await sendText(from, 'Oi, Helo! Mande uma foto pra virar figurinha, digite "Modo pergunta" pra falar com o Gemini, "Modo Lila" pra falar com a Lila (mais ou menos kkk), "conte uma piada/piada sobre medicina" ou "Modo Normal" pra ver essa mensagem de novo! Beijão.');
        return res.sendStatus(200);
      }

      if (REG_MODO_PERGUNTA.test(raw)) {
        setMode(from, 'pergunta');
        await sendText(from, isPersona(from)
          ? '💬 Modo Pergunta ON (com jeitinho da Lila). Manda sua pergunta!'
          : '💬 Modo Pergunta ON. Manda sua pergunta!');
        return res.sendStatus(200);
      }

      if (REG_MODO_LILA.test(raw)) {
        const on = togglePersona(from); // liga/desliga com o mesmo comando
        await sendText(from, on ? '🐶 Modo Lila ON.' : '🐶 Modo Lila OFF (Gemini comum).');
        return res.sendStatus(200);
      }

      // ===== Piadas por linguagem natural =====
      if (REG_PIADA_MED.test(text) || /piada.*(med|médic|medicina|plantão|anatomia)/i.test(text)) {
        try {
          const joke = await geminiGenerate({ prompt: promptPiada(true), persona: isPersona(from) });
          incCont(from, 'med');
          await sendText(from, joke);
        } catch {
          const pick = FB_MED[Math.floor(Math.random()*FB_MED.length)];
          incCont(from, 'med');
          await sendText(from, pick);
        }
        return res.sendStatus(200);
      }

      if (REG_PIADA.test(text) || /\bpiada\b/i.test(text)) {
        try {
          const joke = await geminiGenerate({ prompt: promptPiada(false), persona: isPersona(from) });
          incCont(from, 'geral');
          await sendText(from, joke);
        } catch {
          const pick = FB_GERAL[Math.floor(Math.random()*FB_GERAL.length)];
          incCont(from, 'geral');
          await sendText(from, pick);
        }
        return res.sendStatus(200);
      }

      // ===== Modo pergunta ligado → tudo vira pergunta pro Gemini =====
      if (getMode(from) === 'pergunta') {
        try {
          const hist = sessions[from]?.history || [];
          const resp = await geminiGenerate({ prompt: raw, historyParts: hist, persona: isPersona(from) });
          pushHistory(from, 'user', raw);
          pushHistory(from, 'model', resp);
          await sendText(from, resp);
        } catch {
          await sendText(from, 'Não consegui responder agora 😞. Tente novamente em instantes.');
        }
        return res.sendStatus(200);
      }

      // ===== Mensagem padrão quando em modo normal =====
      await sendText(from, 'Oi, Helo! Mande uma foto pra virar figurinha, digite "Modo pergunta" pra falar com o Gemini, "Modo Lila" pra falar com a Lila (mais ou menos kkk), "conte uma piada/piada sobre medicina" ou "Modo Normal" pra ver essa mensagem de novo! Beijão.');
      return res.sendStatus(200);
    }

    // ===== IMAGEM → figurinha automática =====
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
            .resize(512, 512, { fit: 'contain', background: { r:0,g:0,b:0,alpha:0 } })
            .webp({ quality })
            .toBuffer();
        }
        let webp = await makeWebp(q);
        while (webp.length > 100 * 1024 && q >= 40) { q -= 5; webp = await makeWebp(q); }

        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', 'sticker');
        form.append('file', webp, { filename: 'sticker.webp', contentType: 'image/webp' });

        const up = await axios.post(`${GRAPH}/${PHONE_NUMBER_ID}/media`, form, { headers: { ...auth(), ...form.getHeaders() } });
        const stickerId = up.data.id;

        await new Promise(r => setTimeout(r, 600));
        await axios.post(`${GRAPH}/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: 'whatsapp', to: from, type: 'sticker', sticker: { id: stickerId } },
          { headers: auth() });

        // opcional: mandar um coraçãozinho depois
        // await sendText(from, isPersona(from) ? '💖 Amei a foto!' : '✅ Figurinha enviada!');
      } catch (e) {
        await sendText(from, '❌ Não consegui gerar a figurinha. Me manda de novo?');
      }
      return res.sendStatus(200);
    }

    // ===== Outros tipos → ignora ou responde curto =====
    return res.sendStatus(200);
  } catch (e) {
    console.error('Erro no webhook:', e?.response?.data || e.message);
    return res.sendStatus(200);
  }
});

// Healthcheck
app.get('/', (_, res) => res.send('ok'));
app.listen(process.env.PORT || PORT, () => console.log(`Webhook ON :${process.env.PORT || PORT}`));
