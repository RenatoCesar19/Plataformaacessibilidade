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

function repairTextEncoding(value) {
  const original = String(value || '');
  // O Multer trata o nome do arquivo como latin1 em alguns navegadores.
  // Corrige sequências como "3Âº" e "MÃ‰DIO" de volta para UTF-8.
  if (!/[ÃÂâ]/.test(original)) return original;
  try {
    const repaired = Buffer.from(original, 'latin1').toString('utf8');
    return repaired.includes('\uFFFD') ? original : repaired;
  } catch (_error) {
    return original;
  }
}

function normalizeText(value) {
  return repairTextEncoding(value).replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function fileNameWithoutExtension(fileName) {
  return repairTextEncoding(fileName).replace(/^.*[\\/]/, '').replace(/\.pdf$/i, '').trim() || 'Prova';
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
    // A imagem é opcional: o frontend não cria um espaço vazio quando não há mídia no PDF.
    imagem_url: null,
    descricao_imagem: null,
    recursos_acessibilidade: { texto_para_narracao: question.enunciado, descricao_imagem: null }
  }));
}

function parseStructuredQuestions(pdfText) {
  const text = normalizeText(pdfText);
  const questionPattern = /(?:^|\n|\s)(?:quest[ãa]o\s*)?0*(\d{1,3})\s*(?:\.|\)|-|:)/gi;
  const allQuestionMarkers = [...text.matchAll(questionPattern)];
  const firstQuestionIndex = allQuestionMarkers.findIndex((marker) => Number(marker[1]) === 1);
  if (firstQuestionIndex < 0) return [];

  const questionMarkers = allQuestionMarkers.slice(firstQuestionIndex);
  return questionMarkers.map((marker, index) => {
    const nextMarker = questionMarkers[index + 1];
    const blockStart = marker.index + marker[0].length;
    const blockEnd = nextMarker ? nextMarker.index : text.length;
    const block = text.slice(blockStart, blockEnd).trim();
    const alternativePattern = /(?:^|\n|\s)([A-D])\s*(?:\.|\)|-|:)/gi;
    const alternativeMarkers = [...block.matchAll(alternativePattern)];

    // A numbered instruction is not a question unless it has at least two alternatives.
    if (alternativeMarkers.length < 2) return null;
    const statement = block.slice(0, alternativeMarkers[0].index).replace(/\s+/g, ' ').trim();
    if (!statement) return null;

    const alternatives = alternativeMarkers.slice(0, 4).map((alternative, alternativeIndex) => {
      const nextAlternative = alternativeMarkers[alternativeIndex + 1];
      const textStart = alternative.index + alternative[0].length;
      const textEnd = nextAlternative ? nextAlternative.index : block.length;
      return {
        id: alternative[1].toUpperCase(),
        texto: block.slice(textStart, textEnd).replace(/\s+/g, ' ').trim()
      };
    }).filter((alternative) => alternative.texto);

    if (alternatives.length < 2) return null;
    return {
      ordem: Number(marker[1]),
      tipo: 'MULTIPLA_ESCOLHA',
      enunciado: statement,
      texto_apoio: null,
      alternativas: alternatives,
      imagem_url: null,
      descricao_imagem: null,
      recursos_acessibilidade: { texto_para_narracao: statement, descricao_imagem: null }
    };
  }).filter(Boolean).map((question, index) => ({ ...question, ordem: index + 1 }));
}

function extractInstructions(pdfText) {
  const text = normalizeText(pdfText);
  const questionPattern = /(?:^|\n|\s)(?:quest[ãa]o\s*)?0*(\d{1,3})\s*(?:\.|\)|-|:)/gi;
  const markers = [...text.matchAll(questionPattern)];
  const alternativePattern = /(?:^|\n|\s)([A-D])\s*(?:\.|\)|-|:)/gi;

  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const nextMarker = markers[index + 1];
    const blockStart = marker.index + marker[0].length;
    const blockEnd = nextMarker ? nextMarker.index : text.length;
    const alternatives = [...text.slice(blockStart, blockEnd).matchAll(alternativePattern)];
    if (alternatives.length >= 2) {
      const instructions = text.slice(0, marker.index).replace(/\s+/g, ' ').trim();
      return instructions || null;
    }
  }
  return null;
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

    const questions = parseStructuredQuestions(textoProva);
    const instructions = extractInstructions(textoProva);
    if (!questions.length) {
      return response.status(422).json({
        erro: 'Não foram encontradas questões de múltipla escolha no padrão 1. / Questão 1 com alternativas A, B, C ou D.'
      });
    }
    return response.status(200).json({
      status: 'sucesso',
      message: 'PDF recebido e processado com sucesso.',
      textoProva,
      titulo: normalizeText(request.body.titulo) || fileNameWithoutExtension(request.file.originalname),
      descricao: normalizeText(request.body.descricao) || null,
      instrucoes: instructions,
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
