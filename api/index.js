const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');

const MAX_PDF_SIZE_BYTES = 15 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_SIZE_BYTES, files: 1 },
  fileFilter: (_request, file, callback) => {
    const isPdf = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname || '');
    return isPdf ? callback(null, true) : callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'arquivo'));
  }
});

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));

function normalizeText(value) {
  return String(value || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function fileNameWithoutExtension(fileName) {
  return String(fileName || 'Prova').replace(/^.*[\\/]/, '').replace(/\.pdf$/i, '').trim() || 'Prova';
}

function parseQuestions(pdfText) {
  const lines = normalizeText(pdfText).split('\n').map((line) => line.trim()).filter(Boolean);
  const questionStart = /^(\d{1,3})\s*[.)\-:]\s*(.+)$/;
  const alternativeStart = /^([A-Da-d])\s*[.)\-:]\s*(.+)$/;
  const questions = [];
  let currentQuestion = null;
  let previousLineWasAlternative = false;

  for (const line of lines) {
    const questionMatch = line.match(questionStart);
    const alternativeMatch = line.match(alternativeStart);
    if (questionMatch) {
      if (currentQuestion) questions.push(currentQuestion);
      currentQuestion = { ordem: Number(questionMatch[1]), tipo: 'MULTIPLA_ESCOLHA', enunciado: questionMatch[2], texto_apoio: null, alternativas: [] };
      previousLineWasAlternative = false;
      continue;
    }
    if (!currentQuestion) continue;
    if (alternativeMatch) {
      currentQuestion.alternativas.push({ id: alternativeMatch[1].toUpperCase(), texto: alternativeMatch[2] });
      previousLineWasAlternative = true;
      continue;
    }
    if (previousLineWasAlternative && currentQuestion.alternativas.length) {
      const lastAlternative = currentQuestion.alternativas[currentQuestion.alternativas.length - 1];
      lastAlternative.texto = `${lastAlternative.texto} ${line}`;
    } else {
      currentQuestion.enunciado = `${currentQuestion.enunciado} ${line}`;
    }
  }

  if (currentQuestion) questions.push(currentQuestion);
  if (!questions.length && normalizeText(pdfText)) {
    questions.push({
      ordem: 1,
      tipo: 'DISSERTATIVA',
      enunciado: normalizeText(pdfText),
      texto_apoio: 'O PDF não apresentou um padrão de questões reconhecível. Revise o conteúdo antes de publicar.',
      alternativas: []
    });
  }

  return questions.map((question, index) => ({
    ...question,
    ordem: index + 1,
    tipo: question.alternativas.length ? 'MULTIPLA_ESCOLHA' : 'DISSERTATIVA',
    recursos_acessibilidade: { texto_para_narracao: question.enunciado, descricao_imagem: null }
  }));
}

async function uploadPdf(request, response, next) {
  try {
    if (!request.file) return response.status(400).json({ erro: 'Envie um arquivo PDF no campo "arquivo".' });
    if (!Buffer.isBuffer(request.file.buffer) || !request.file.buffer.length) {
      return response.status(400).json({ erro: 'O arquivo enviado está vazio ou não pôde ser lido em memória.' });
    }

    let parsedPdf;
    try {
      parsedPdf = await pdfParse(request.file.buffer);
    } catch (pdfError) {
      console.error('Falha ao extrair texto do PDF:', pdfError);
      return response.status(500).json({
        erro: 'Falha ao ler o conteúdo do PDF.',
        detalhes: pdfError.message
      });
    }

    const textoProva = String(parsedPdf.text || '').trim();
    if (!textoProva) {
      return response.status(422).json({ erro: 'Não foi possível extrair texto do PDF. Verifique se o documento não é uma imagem digitalizada.' });
    }

    const questions = parseQuestions(textoProva);
    return response.status(200).json({
      status: 'sucesso',
      message: 'PDF recebido e processado com sucesso.',
      textoProva,
      titulo: normalizeText(request.body.titulo) || fileNameWithoutExtension(request.file.originalname),
      descricao: normalizeText(request.body.descricao) || null,
      versao: '1.0',
      metadados: {
        idioma: 'pt-BR',
        total_questoes: questions.length,
        origem: { arquivo: request.file.originalname, tamanho_bytes: request.file.size, processado_em: new Date().toISOString() }
      },
      questoes: questions
    });
  } catch (error) {
    return next(error);
  }
}

app.get('/', (_request, response) => response.status(200).json({ status: 'online', message: 'API da PAI rodando perfeitamente.' }));
app.get('/api/health', (_request, response) => response.status(200).json({ status: 'ok' }));
app.post('/api/upload-pdf', upload.single('arquivo'), uploadPdf);

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? `O PDF excede o limite de ${MAX_PDF_SIZE_BYTES / (1024 * 1024)} MB.`
      : 'Envie somente um arquivo PDF no campo "arquivo".';
    return response.status(400).json({ erro: message });
  }
  console.error('Erro ao processar PDF:', error);
  return response.status(500).json({ erro: 'Não foi possível processar o PDF. Tente novamente com outro arquivo.' });
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`API PAI disponível em http://localhost:${port}`));
}

module.exports = app;
