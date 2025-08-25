// index.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');

const app = express();
app.use(express.json({ limit: '10mb' }));

const GRAPH = 'https://graph.facebook.com/v20.0';
const { VERIFY_TOKEN, PHONE_NUMBER_ID, PORT = 3000 } = process.env;

// headers sempre frescos
const auth = () => ({ Authorization: `Bearer ${process.env.WHATS_TOKEN}` });

// 1) Verificação do webhook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// 2) Recebimento de mensagens
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    console.log("Mensagem recebida de:", from, "tipo:", msg.type);

    // === Caso TEXTO (ver "obrigada/obrigado") ===
    if (msg.type === 'text') {
      const text = (msg.text?.body || '').trim().toLowerCase();

      if (text.includes('obrigada') || text.includes('obrigado')) {
        // pegue as duas figurinhas do ambiente
        const s1 = process.env.LILA_ID_1;
        const s2 = process.env.DORY_ID_1;
        const stickers = [s1, s2].filter(Boolean);

        if (stickers.length) {
          // escolhe 1 aleatória
          const pick = stickers[Math.floor(Math.random() * stickers.length)];
          try {
            const resp = await axios.post(
              `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
              { messaging_product: 'whatsapp', to: from, type: 'sticker', sticker: { id: pick } },
              { headers: auth() }
            );
            console.log("Sticker de agradecimento enviado:", JSON.stringify(resp.data, null, 2));
          } catch (e) {
            console.error('Falha ao enviar sticker de agradecimento:', e?.response?.data || e.message);
            await axios.post(
              `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
              { messaging_product: 'whatsapp', to: from, type: 'text', text: { body: '💛 de nada! (mande uma imagem que viro figurinha 😉)' } },
              { headers: auth() }
            );
          }
        } else {
          // Sem IDs configurados
          await axios.post(
            `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
            { messaging_product: 'whatsapp', to: from, type: 'text', text: { body: 'Recebi seu “obrigada”! Configure THANKS_STICKER_ID1/2 para eu mandar figurinhas 😊' } },
            { headers: auth() }
          );
        }
        return res.sendStatus(200);
      }

      // outros textos → resposta padrão
      await axios.post(
        `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
        { messaging_product: 'whatsapp', to: from, type: 'text', text: { body: 'Oi! Manda uma foto que eu viro figurinha 😎' } },
        { headers: auth() }
      );
      return res.sendStatus(200);
    }

    // === Caso IMAGEM → gerar figurinha dinâmica ===
    if (msg.type === 'image') {
      console.time("sticker-process");
      try {
        // (1) metadados → URL
        console.timeLog("sticker-process", "inicio - requisitando metadados");
        const mediaId = msg.image.id;
        const meta = await axios.get(`${GRAPH}/${mediaId}`, { headers: auth() });
        const url = meta.data.url;

        // (2) baixa bytes
        console.timeLog("sticker-process", "baixando imagem");
        const imgResp = await axios.get(url, { headers: auth(), responseType: 'arraybuffer' });
        const imgBuf = Buffer.from(imgResp.data);
        console.timeLog("sticker-process", "imagem baixada");

        // (3) converte p/ WEBP 512x512 (canvas quadrado com padding transparente) <= 100KB
        console.timeLog("sticker-process", "iniciando conversão WEBP");
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
        console.log("WEBP size:", webp.length, "bytes");
        console.timeLog("sticker-process", "conversão concluída");

        // (4) upload do sticker
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', 'sticker');
        form.append('file', webp, { filename: 'sticker.webp', contentType: 'image/webp' });

        console.timeLog("sticker-process", "iniciando upload");
        const up = await axios.post(`${GRAPH}/${PHONE_NUMBER_ID}/media`, form, {
          headers: { ...auth(), ...form.getHeaders() }
        });
        const stickerId = up.data.id;
        console.timeLog("sticker-process", "upload concluído");
        console.log("Sticker media_id:", stickerId);

        // (4.1) pequeno atraso de propagação
        await new Promise(r => setTimeout(r, 600));

        // (5) envia o sticker de volta
        console.timeLog("sticker-process", "enviando mensagem");
        const resp = await axios.post(
          `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: 'whatsapp', to: from, type: 'sticker', sticker: { id: stickerId } },
          { headers: auth() }
        );
        console.timeLog("sticker-process", "mensagem enviada");
        console.log("WA send response:", JSON.stringify(resp.data, null, 2));
        console.timeEnd("sticker-process");

        // confirmação por texto
        await axios.post(
          `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: 'whatsapp', to: from, type: 'text', text: { body: '✅ Pra você! 🌹' } },
          { headers: auth() }
        );
      } catch (e) {
        const data = e?.response?.data || e.message;
        console.error('Erro sticker:', JSON.stringify(data, null, 2));
        await axios.post(
          `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: 'whatsapp', to: from, type: 'text', text: { body: '❌ Não consegui gerar a figurinha. Tenta outra imagem?' } },
          { headers: auth() }
        );
      }
      return res.sendStatus(200);
    }

    // === Outros tipos → padrão
    await axios.post(
      `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: from, type: 'text', text: { body: 'Oi! Manda uma foto que eu viro figurinha 😎' } },
      { headers: auth() }
    );

  } catch (e) {
    console.error('Erro no webhook:', e?.response?.data || e.message);
  }
  return res.sendStatus(200);
});

app.get('/', (_, res) => res.send('ok'));
app.listen(PORT, () => console.log(`Webhook ON :${PORT}`));
