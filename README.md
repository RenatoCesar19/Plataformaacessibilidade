# Plataforma de Avaliação Inclusiva (PAI)

Sistema PWA offline-first para avaliações escolares acessíveis a estudantes com deficiências motoras, visuais e neurodivergências.

## Tecnologias

- Frontend: HTML5, CSS3, JavaScript, Service Worker e IndexedDB
- Backend: Node.js, Express, Multer, pdf-parse e SQLite

## Execução

```bash
npm install
npm start
```

A API será iniciada em `http://localhost:3000`.

## OCR para PDFs digitalizados

O envio de PDF usa primeiro a extração local de texto. Quando detectar texto corrompido, páginas em colunas ou lacunas na numeração, a API pode usar o Azure AI Document Intelligence para OCR, sem gravar o arquivo no disco da Vercel.

No painel da Vercel, em **Settings > Environment Variables**, configure:

```text
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=https://SEU-RECURSO.cognitiveservices.azure.com
AZURE_DOCUMENT_INTELLIGENCE_KEY=SUA_CHAVE_SECRETA
```

As duas variáveis são necessárias. Sem elas, a plataforma continua processando PDFs que já possuem texto selecionável e informa nos metadados quando o OCR seria necessário.
