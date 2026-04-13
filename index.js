const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

// ─── CONFIGURAÇÕES ────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const SHEET_ID        = process.env.GOOGLE_SHEET_ID;
const SEU_CHAT_ID     = process.env.SEU_CHAT_ID;

const TELEGRAM_API    = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ─── GOOGLE SHEETS ────────────────────────────────────────────────────────────
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function salvarPaciente(nome) {
  const sheets = await getSheetsClient();
  const hoje = new Date().toLocaleDateString("pt-BR");
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Atendimentos!A:B",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[hoje, nome]] },
  });
}

async function listarAtendimentos() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Atendimentos!A:B",
  });
  const rows = res.data.values || [];
  return rows.filter(r => r[0] !== "Data");
}

// ─── TELEGRAM: ENVIAR MENSAGEM ────────────────────────────────────────────────
async function enviar(chatId, texto) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: texto,
    parse_mode: "Markdown",
  });
}

// ─── TELEGRAM: BAIXAR ARQUIVO ─────────────────────────────────────────────────
async function baixarArquivo(fileId) {
  const { data } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = data.result.file_path;
  const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const resp = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(resp.data).toString("base64");
}

// ─── CLAUDE: EXTRAIR NOME DA ETIQUETA ────────────────────────────────────────
async function extrairNome(imageBase64) {
  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 100,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: imageBase64 },
            },
            {
              type: "text",
              text: `Esta é uma etiqueta de plano de saúde.\nExtraia SOMENTE o nome completo do paciente.\nResponda apenas com o nome, sem mais nada.\nSe não encontrar, responda: NÃO IDENTIFICADO`,
            },
          ],
        }],
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
      }
    );

    console.log("Resposta Claude:", JSON.stringify(resp.data));

    if (!resp.data || !resp.data.content || !resp.data.content[0]) {
      console.error("Resposta inesperada:", resp.data);
      return "NÃO IDENTIFICADO";
    }

    return resp.data.content[0].text.trim();

  } catch (err) {
    console.error("Erro Claude:", err?.response?.data || err.message);
    return "NÃO IDENTIFICADO";
  }
}

// ─── CLAUDE: EXTRAIR NOMES DO PDF ────────────────────────────────────────────
async function extrairNomesPDF(pdfBase64) {
  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
            },
            {
              type: "text",
              text: `Este é um relatório de repasse do plano de saúde.\nListe TODOS os nomes de pacientes encontrados.\nResponda APENAS com os nomes, um por linha, sem numeração.`,
            },
          ],
        }],
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
      }
    );

    if (!resp.data || !resp.data.content || !resp.data.content[0]) {
      return [];
    }

    return resp.data.content[0].text.trim().split("\n").map(n => n.trim()).filter(Boolean);

  } catch (err) {
    console.error("Erro Claude PDF:", err?.response?.data || err.message);
    return [];
  }
}

// ─── CRUZAMENTO ───────────────────────────────────────────────────────────────
function normalizar(nome) {
  return nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function cruzar(atendimentos, nomesPDF) {
  const normPDF = nomesPDF.map(normalizar);
  const repassados = [], ausentes = [];

  for (const [data, nome] of atendimentos) {
    const norm = normalizar(nome);
    const achou = normPDF.some(n => n.includes(norm) || norm.includes(n));
    if (achou) repassados.push(`✅ ${nome} (${data})`);
    else        ausentes.push(`❌ ${nome} (${data})`);
  }
  return { repassados, ausentes };
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body?.message;
  if (!msg) return;

  const chatId  = String(msg.chat.id);
  const texto   = msg.text?.toLowerCase().trim();

  if (chatId !== SEU_CHAT_ID) {
    await enviar(chatId, "⛔ Acesso não autorizado.");
    return;
  }

  try {

    // ── FOTO: etiqueta ──────────────────────────────────────────────────────
    if (msg.photo) {
      await enviar(chatId, "🔍 Analisando etiqueta...");
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const base64 = await baixarArquivo(fileId);
      const nome = await extrairNome(base64);

      if (nome === "NÃO IDENTIFICADO") {
        await enviar(chatId, "⚠️ Não consegui identificar o nome. Tente uma foto mais nítida.");
        return;
      }

      await salvarPaciente(nome);
      await enviar(chatId, `✅ Registrado!\n👤 *${nome}*\n📅 ${new Date().toLocaleDateString("pt-BR")}`);
    }

    // ── DOCUMENTO: PDF do plano ─────────────────────────────────────────────
    else if (msg.document) {
      const doc = msg.document;

      if (!doc.file_name?.toLowerCase().endsWith(".pdf")) {
        await enviar(chatId, "⚠️ Envie o relatório em formato PDF.");
        return;
      }

      await enviar(chatId, "📄 Lendo PDF do plano... aguarde.");
      const base64 = await baixarArquivo(doc.file_id);
      const nomesPDF = await extrairNomesPDF(base64);
      const atendimentos = await listarAtendimentos();

      if (atendimentos.length === 0) {
        await enviar(chatId, "⚠️ Nenhum atendimento registrado ainda.");
        return;
      }

      const { repassados, ausentes } = cruzar(atendimentos, nomesPDF);
      const total = repassados.length + ausentes.length;

      let relatorio = `📊 *Relatório do Mês*\n\n`;
      relatorio += `Total atendido: ${total}\n`;
      relatorio += `✅ Repassados: ${repassados.length}\n`;
      relatorio += `❌ Não encontrados: ${ausentes.length}\n`;

      if (ausentes.length > 0) {
        relatorio += `\n*Ausentes no plano:*\n${ausentes.join("\n")}`;
      } else {
        relatorio += `\n🎉 Todos repassados!`;
      }

      await enviar(chatId, relatorio);
    }

    // ── TEXTO: comandos ─────────────────────────────────────────────────────
    else if (texto === "resumo") {
      const atendimentos = await listarAtendimentos();
      await enviar(chatId, `📋 *Resumo*\nTotal no mês: *${atendimentos.length} pacientes*`);

    } else if (texto === "ajuda") {
      await enviar(chatId,
        `🤖 *Bot de Atendimentos*\n\n` +
        `📸 Envie uma *foto da etiqueta* → registra o paciente\n` +
        `📄 Envie o *PDF do plano* → gera relatório\n\n` +
        `💬 Comandos:\n` +
        `• *resumo* → total do mês\n` +
        `• *ajuda* → este menu`
      );
    }

  } catch (err) {
    console.error(err?.response?.data || err.message);
    await enviar(chatId, "⚠️ Ocorreu um erro. Tente novamente.");
  }
});

app.get("/", (_, res) => res.send("Bot ativo ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
