export function initializeFeedback() {
  const byId = id => document.getElementById(id);
  const dialog = byId('feedback-dialog');
  const form = byId('feedback-form');
  const openButton = byId('feedback-button');
  if (!dialog || !form || !openButton || dialog.dataset.initialized) return;
  dialog.dataset.initialized = 'true';

  const message = byId('feedback-message');
  const contact = byId('feedback-contact');
  const status = byId('feedback-status');
  const submit = byId('feedback-submit');
  let pending = false;

  const setStatus = (text, kind = '') => {
    status.textContent = text;
    status.dataset.kind = kind;
  };
  const updateCount = () => {
    byId('feedback-count').textContent = `${message.value.length} / 2000`;
  };

  openButton.addEventListener('click', () => {
    if (!pending) setStatus('');
    if (!dialog.open) dialog.showModal();
    message.focus();
  });
  byId('feedback-close').addEventListener('click', () => dialog.close());
  message.addEventListener('input', () => {
    updateCount();
    if (!pending) setStatus('');
  });
  contact.addEventListener('input', () => {
    if (!pending) setStatus('');
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending) return;
    const content = message.value.trim();
    const replyTo = contact.value.trim();
    if (content.length < 5 || content.length > 2000) {
      setStatus('请填写 5–2000 字的建议，方便我们了解你的想法。', 'error');
      message.focus();
      return;
    }
    if (replyTo.length > 200) {
      setStatus('联系方式请控制在 200 字以内。', 'error');
      contact.focus();
      return;
    }

    pending = true;
    submit.disabled = true;
    message.disabled = true;
    contact.disabled = true;
    submit.textContent = '正在提交…';
    setStatus('正在送达，请稍候。');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ message: content, contact: replyTo }),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 429) throw new Error('提交得有点频繁，请稍后再试。');
        throw new Error('暂时未能提交，请稍后重试。你的建议仍保留在这里。');
      }
      form.reset();
      updateCount();
      setStatus('建议已收到，谢谢你帮助弈步变得更好。', 'success');
    } catch (error) {
      setStatus(error.name === 'AbortError'
        ? '连接超时，请稍后重试。你的建议仍保留在这里。'
        : error instanceof TypeError
          ? '网络连接失败，请检查网络后重试。你的建议仍保留在这里。'
          : error.message, 'error');
    } finally {
      clearTimeout(timeout);
      pending = false;
      submit.disabled = false;
      message.disabled = false;
      contact.disabled = false;
      submit.textContent = '提交建议';
    }
  });
  updateCount();
}
