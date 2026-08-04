const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');

const MAX_PDF_SIZE_BYTES = 15 * 1024 * 1024;
const OCR_MAX_WAIT_MS = Math.min(Number(process.env.OCR_MAX_WAIT_MS || 8000), 8000);
const OCR_POLL_INTERVAL_MS = 800;
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

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isAzureOcrConfigured() {
  return Boolean(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT && process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY);
}

function hasBrokenPdfText(text) {
  return /\(cid:\d+\)|\uFFFD/.test(String(text || ''));
}

function countQuestionNumberGaps(questions) {
  return questions.slice(1).reduce((gaps, question, index) => {
    const previous = questions[index];
    return gaps + (question.id - previous.id > 1 ? 1 : 0);
  }, 0);
}

function shouldTryOcr(text, questions) {
  return hasBrokenPdfText(text) || questions.length < 2 || countQuestionNumberGaps(questions) > 0;
}

function ocrResultToText(payload) {
  const pages = payload && payload.analyzeResult && Array.isArray(payload.analyzeResult.pages)
    ? payload.analyzeResult.pages
    : [];
  return pages.flatMap((page) => Array.isArray(page.lines) ? page.lines.map((line) => line.content) : [])
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * OCR opcional com Azure AI Document Intelligence. O PDF permanece somente em
 * memória: nenhum arquivo é salvo no disco da função Vercel. O serviço devolve
 * texto com posição de leitura, útil para provas escaneadas e páginas em colunas.
 */
async function extractTextWithAzureOcr(pdfBuffer) {
  if (!isAzureOcrConfigured()) return { text: null, status: 'not_configured' };

  const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT.replace(/\/$/, '');
  const apiVersion = process.env.AZURE_DOCUMENT_INTELLIGENCE_API_VERSION || '2024-11-30';
  const analyzeUrl = `${endpoint}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=${apiVersion}`;
  const headers = {
    'Ocp-Apim-Subscription-Key': process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY,
    'Content-Type': 'application/pdf'
  };

  const submitted = await fetch(analyzeUrl, { method: 'POST', headers, body: pdfBuffer });
  if (!submitted.ok) {
    throw new Error(`OCR remoto recusou o PDF (HTTP ${submitted.status}).`);
  }

  const operationUrl = submitted.headers.get('operation-location');
  if (!operationUrl) throw new Error('O serviço OCR não retornou a URL de acompanhamento.');

  const startedAt = Date.now();
  while (Date.now() - startedAt < OCR_MAX_WAIT_MS) {
    await wait(OCR_POLL_INTERVAL_MS);
    const operation = await fetch(operationUrl, { headers: { 'Ocp-Apim-Subscription-Key': process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY } });
    if (!operation.ok) throw new Error(`Não foi possível consultar o OCR (HTTP ${operation.status}).`);
    const result = await operation.json();
    if (result.status === 'succeeded') return { text: ocrResultToText(result), status: 'succeeded' };
    if (result.status === 'failed') throw new Error('O serviço OCR não conseguiu reconhecer este PDF.');
  }

  return { text: null, status: 'pending' };
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

function textItemsToLines(items) {
  const orderedItems = [...items].sort((left, right) => right.y - left.y || left.x - right.x);
  const lines = [];

  for (const item of orderedItems) {
    const currentLine = lines[lines.length - 1];
    if (currentLine && Math.abs(currentLine.y - item.y) <= 3) {
      currentLine.items.push(item);
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }

  return lines.map((line) => line.items
    .sort((left, right) => left.x - right.x)
    .map((item) => item.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  ).filter(Boolean).join('\n');
}

async function renderPageInReadingOrder(pageData) {
  const content = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
  const items = content.items
    .filter((item) => String(item.str || '').trim())
    .map((item) => ({ text: item.str, x: item.transform[4], y: item.transform[5] }));
  const pageWidth = pageData.view[2] - pageData.view[0];
  const middle = pageWidth / 2;
  const leftColumn = items.filter((item) => item.x < middle);
  const rightColumn = items.filter((item) => item.x >= middle);

  // Provas como a de 3º ano usam duas colunas: lê toda a esquerda antes da direita.
  if (leftColumn.length >= 8 && rightColumn.length >= 8) {
    return [textItemsToLines(leftColumn), textItemsToLines(rightColumn)].filter(Boolean).join('\n');
  }
  return textItemsToLines(items);
}

function getExamQuestionMarkers(text) {
  const explicitPattern = /(?:^|\n)\s*quest(?:ão|ao)\s*0*(\d{1,3})\b\s*/gi;
  const explicitMarkers = [...text.matchAll(explicitPattern)];
  if (explicitMarkers.length) return explicitMarkers;
  const genericPattern = /(?:^|\n|\s)(?:quest(?:ão|ao)\s*)?0*(\d{1,3})\s*(?:\.|\)|-|:)/gi;
  return [...text.matchAll(genericPattern)];
}

function getSupportTextsByQuestion(text, questionMarkers) {
  const supportPattern = /(?:^|\n)\s*TEXTO\s+PARA\s+AS?\s+QUEST(?:ÕES|OES)\s+0*(\d{1,3})(?:\s*(?:E|A|À|ATÉ|ATE|-)\s*0*(\d{1,3}))?\b/gi;
  const supportMarkers = [...text.matchAll(supportPattern)];
  const supportByQuestion = new Map();

  supportMarkers.forEach((marker, index) => {
    const nextSupport = supportMarkers[index + 1];
    const nextQuestion = questionMarkers.find((question) => question.index > marker.index);
    const end = Math.min(
      nextSupport ? nextSupport.index : text.length,
      nextQuestion ? nextQuestion.index : text.length
    );
    const supportText = text.slice(marker.index + marker[0].length, end).replace(/\s+/g, ' ').trim();
    if (!supportText) return;

    const firstQuestion = Number(marker[1]);
    const lastQuestion = Number(marker[2] || marker[1]);
    for (let questionNumber = firstQuestion; questionNumber <= lastQuestion; questionNumber += 1) {
      supportByQuestion.set(questionNumber, supportText);
    }
  });

  return { supportMarkers, supportByQuestion };
}

/**
 * Extrai exclusivamente questões objetivas do texto do PDF.
 * O delimitador exige que "1.", "01 -" ou "QUESTÃO 01" esteja no começo
 * de uma linha. Tudo antes do primeiro marcador é descartado: cabeçalho,
 * instruções, textos de leitura e dados da escola não viram questão.
 */
function extrairQuestoesProva(textoBruto) {
  // Normaliza o artefato comum de PDFs em colunas: "QUEST Ã O", "Q U E S T A O"
  // ou "QUESTAO" passam a usar um único marcador previsível.
  const textoNormalizado = normalizeText(textoBruto)
    .replace(/Q\s*U\s*E\s*S\s*T\s*[ÃA]\s*O/gi, 'QUESTÃO')
    .replace(/\n{2,}/g, '\n');

  /*
   * Fatiamento agressivo: o lookahead mantém o marcador no início de cada
   * fatia. Assim, todo cabeçalho, instrução ou texto anterior à primeira
   * questão fica isolado no primeiro item e pode ser descartado sem risco de
   * contaminar o enunciado.
   */
  const blocos = textoNormalizado.split(/(?=\bQUESTÃO\s+\d+\b|^\s*\d+\s*[.\-])/gmi);
  if (blocos.length && !/^\s*(?:QUESTÃO\s+\d+\b|\d+\s*[.\-])/i.test(blocos[0])) {
    blocos.shift();
  }

  return blocos.map((blocoBruto) => {
    const bloco = blocoBruto.trim();
    if (!bloco) return null;

    // O número vem do começo da fatia e nunca do meio do enunciado.
    const idTexto = bloco.replace(/^\s*(?:QUESTÃO\s*)?0*(\d{1,3})\s*[.\-:)]?.*$/is, '$1');
    const id = Number(idTexto);
    if (!Number.isFinite(id)) return null;

    /*
     * Segundo fatiamento: reconhece (A), A), A., A- e versões minúsculas.
     * Como as opções se limitam a A-E, itens romanos I, II e III dentro da
     * pergunta não são falsamente tratados como alternativas.
     */
    // Não usamos "\s*" antes do lookahead: ele também encontraria o "A)"
    // dentro de "(A)", gerando uma fatia isolada com apenas "(".
    const partes = bloco.split(/(?=(?:\([a-eA-E]\)|(?<!\()[a-eA-E][.\-)])\s+)/g);
    if (partes.length < 3) return null; // instruções e rodapés não viram questão

    const pergunta = partes[0]
      .replace(/^\s*(?:QUESTÃO\s*)?0*\d{1,3}\s*[.\-:)]?\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!pergunta) return null;

    const alternativas = partes.slice(1).map((parte) => parte
      .replace(/^\s*(?:\(\s*[a-eA-E]\s*\)|[a-eA-E][.\-)])\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim()
    ).filter(Boolean);

    return alternativas.length < 2 ? null : { id, pergunta, alternativas, correta: null };
  }).filter(Boolean).sort((esquerda, direita) => esquerda.id - direita.id);
}

function parseExamQuestions(pdfText) {
  const text = normalizeText(pdfText);
  const supportMarkers = getExamQuestionMarkers(text);
  const { supportByQuestion } = getSupportTextsByQuestion(text, supportMarkers);

  return extrairQuestoesProva(text).map((question, index) => ({
    ordem: index + 1,
    tipo: 'MULTIPLA_ESCOLHA',
    enunciado: question.pergunta,
    texto_apoio: supportByQuestion.get(question.id) || null,
    alternativas: question.alternativas.map((texto, alternativaIndex) => ({
      id: String.fromCharCode(65 + alternativaIndex),
      texto
    })),
    imagem_url: null,
    descricao_imagem: null,
    recursos_acessibilidade: { texto_para_narracao: question.pergunta, descricao_imagem: null }
  }));
}

function extractExamInstructions(pdfText) {
  const text = normalizeText(pdfText);
  const instructionStart = text.search(/LEIA\s+COM\s+ATENÇÃO\s+AS\s+INSTRUÇÕES\s+ABAIXO/i);
  if (instructionStart >= 0) {
    const textAfterStart = text.slice(instructionStart);
    const instructionEnd = /BOA\s+PROVA!?/i.exec(textAfterStart);
    if (instructionEnd) {
      return textAfterStart.slice(0, instructionEnd.index + instructionEnd[0].length).replace(/\s+/g, ' ').trim();
    }
  }

  const markers = getExamQuestionMarkers(text);
  if (!markers.length) return null;
  const { supportMarkers } = getSupportTextsByQuestion(text, markers);
  const firstContentIndex = Math.min(
    markers[0].index,
    supportMarkers.length ? supportMarkers[0].index : text.length
  );
  return text.slice(0, firstContentIndex).replace(/\s+/g, ' ').trim() || null;
}

async function uploadPdf(request, response, next) {
  try {
    if (!request.file) return response.status(400).json({ erro: 'Envie um arquivo PDF no campo "arquivo".' });
    if (!Buffer.isBuffer(request.file.buffer) || !request.file.buffer.length) {
      return response.status(400).json({ erro: 'O arquivo enviado está vazio ou não pôde ser lido em memória.' });
    }

    let parsedPdf;
    try {
      parsedPdf = await pdfParse(request.file.buffer, { pagerender: renderPageInReadingOrder });
    } catch (pdfError) {
      console.error('Falha ao extrair texto do PDF:', pdfError);
      return response.status(500).json({
        erro: 'Falha ao ler o conteúdo do PDF.',
        detalhes: pdfError.message
      });
    }

    const textoNativo = String(parsedPdf.text || '').trim();
    let textoProva = textoNativo;
    let questoesDetectadas = extrairQuestoesProva(textoNativo);
    let ocr = { tentado: false, usado: false, status: 'not_needed' };

    // O OCR só é acionado quando há indícios objetivos de extração ruim. Assim,
    // PDFs digitais normais continuam rápidos e não enviam dados a outro serviço.
    if (shouldTryOcr(textoNativo, questoesDetectadas)) {
      ocr.tentado = true;
      try {
        const resultadoOcr = await extractTextWithAzureOcr(request.file.buffer);
        ocr.status = resultadoOcr.status;
        if (resultadoOcr.text) {
          const questoesOcr = extrairQuestoesProva(resultadoOcr.text);
          const ocrMelhorouLeitura = questoesOcr.length > questoesDetectadas.length
            || countQuestionNumberGaps(questoesOcr) < countQuestionNumberGaps(questoesDetectadas)
            || hasBrokenPdfText(textoNativo);
          if (ocrMelhorouLeitura) {
            textoProva = resultadoOcr.text;
            questoesDetectadas = questoesOcr;
            ocr.usado = true;
          }
        }
      } catch (ocrError) {
        // A prova ainda pode ser exibida pelo texto nativo. O motivo fica nos
        // metadados para o professor revisar a importação, sem derrubar o upload.
        console.error('OCR complementar indisponível:', ocrError);
        ocr.status = 'failed';
        ocr.detalhe = ocrError.message;
      }
    }

    if (!textoProva) {
      return response.status(422).json({
        erro: 'Não foi possível extrair texto do PDF. Este arquivo parece ser uma imagem; configure o OCR para processá-lo.'
      });
    }

    const questions = parseExamQuestions(textoProva);
    const instructions = extractExamInstructions(textoProva);
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
        ocr,
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
