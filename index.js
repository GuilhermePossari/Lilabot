require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');

const app = express();
app.use(express.json({ limit: '10mb' }));

const GRAPH = 'https://graph.facebook.com/v20.0';
const { VERIFY_TOKEN, PHONE_NUMBER_ID, PORT = 3000 } = process.env;

// headers sempre frescos (lê o token atual do env)
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

    if (msg.type === 'image') {
      console.time("sticker-process");
      try {
        // (1) metadados da mídia → URL temporária
        console.timeLog("sticker-process", "inicio - requisitando metadados");
        const mediaId = msg.image.id;
        const meta = await axios.get(`${GRAPH}/${mediaId}`, { headers: auth() });
        const url = meta.data.url;

        // (2) baixa bytes
        console.timeLog("sticker-process", "baixando imagem");
        const imgResp = await axios.get(url, { headers: auth(), responseType: 'arraybuffer' });
        const imgBuf = Buffer.from(imgResp.data);
        console.timeLog("sticker-process", "imagem baixada");

        // (3) converte para WEBP 512x512 com padding transparente
        console.timeLog("sticker-process", "iniciando conversão WEBP");
        let q = 80;
        async function makeWebp(quality) {
          return sharp(imgBuf)
            .resize(512, 512, {
              fit: 'contain',
              background: { r: 0, g: 0, b: 0, alpha: 0 } // padding transparente
            })
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

        // (4.1) pequeno atraso para propagação do media
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
          { messaging_product: 'whatsapp', to: from, type: 'text', text: { body: '✅ Figurinha enviada (se não aparecer, me avise).' } },
          { headers: auth() }
        );
      } catch (e) {
        const data = e?.response?.data || e.message;
        console.error('Erro sticker:', JSON.stringify(data, null, 2));
        await axios.post(
          `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: 'whatsapp', to: from, type: 'text', text: { body: '❌ Não consegui gerar a figurinha. Tente outra imagem.' } },
          { headers: auth() }
        );
      }
    } else {
      await axios.post(
        `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
        { messaging_product: 'whatsapp', to: from, type: 'text', text: { body: 'Manda uma imagem que eu devolvo como figurinha 😉' } },
        { headers: auth() }
      );
    }
  } catch (e) {
    console.error('Erro no webhook:', e?.response?.data || e.message);
  }
  return res.sendStatus(200);
});

app.get('/', (_, res) => res.send('ok'));
app.listen(PORT, () => console.log(`Webhook ON :${PORT}`));
