(() => {
  'use strict';

  const form = document.querySelector('#uploadForm');
  const pdfInput = document.querySelector('#pdfInput');
  const submitButton = document.querySelector('#submitButton');
  const statusMessage = document.querySelector('#statusMessage');
  const configuredBaseUrl = document.querySelector('meta[name="api-base-url"]')?.content.trim();
  const apiBaseUrl = configuredBaseUrl || window.PAI_API_BASE_URL || '';
  const uploadUrl = `${apiBaseUrl.replace(/\/$/, '')}/api/upload-pdf`;

  function showStatus(message, isError = false) {
    statusMessage.textContent = message;
    statusMessage.style.color = isError ? '#b42318' : '#067647';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = pdfInput.files[0];

    if (!file) {
      const message = 'Selecione um arquivo PDF antes de enviar.';
      showStatus(message, true);
      alert(message);
      pdfInput.focus();
      return;
    }

    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      const message = 'O arquivo selecionado não é um PDF válido.';
      showStatus(message, true);
      alert(message);
      return;
    }

    const formData = new FormData();
    formData.append('arquivo', file);
    submitButton.disabled = true;
    showStatus('Enviando e processando a prova...');

    try {
      const response = await fetch(uploadUrl, {
        method: 'POST',
        body: formData
      });
      const data = await response.json().catch(() => ({}));
      const message = data.message || data.erro || `O servidor respondeu com status ${response.status}.`;

      if (!response.ok) {
        showStatus(message, true);
        console.error('Falha no envio do PDF:', data);
        alert(message);
        return;
      }

      showStatus(message);
      console.log('PDF enviado com sucesso:', data);
      alert(message);
      form.reset();
    } catch (error) {
      const message = 'Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.';
      showStatus(message, true);
      console.error('Erro de rede ao enviar o PDF:', error);
      alert(message);
    } finally {
      submitButton.disabled = false;
    }
  });
})();
