const STORAGE_KEY = 'yibu-rules-window-v1';
const initializedPanels = new WeakSet();

export function initializeFloatingRules() {
  const panel = document.getElementById('rules-panel');
  const handle = document.getElementById('rules-drag');
  const toggle = document.getElementById('rules-toggle');
  const label = document.getElementById('rules-toggle-label');
  const content = document.getElementById('rules-list');
  if (!panel || !handle || !toggle || !label || !content || initializedPanels.has(panel)) return;
  initializedPanels.add(panel);

  let drag = null;
  const initial = panel.getBoundingClientRect();
  let position = { x: initial.left, y: initial.top };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) position = saved;
  } catch { /* Moving rules remains available when browser storage is unavailable. */ }

  function savePosition() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(position)); } catch { /* Optional preference. */ }
  }

  function place(x, y) {
    const width = document.documentElement.clientWidth || window.innerWidth;
    const height = window.innerHeight;
    const margin = Math.min(12, width / 4, height / 4);
    panel.style.maxWidth = `${width - margin * 2}px`;
    panel.style.maxHeight = `${Math.min(520, height - margin * 2)}px`;
    const bounds = panel.getBoundingClientRect();
    position = {
      x: Math.max(margin, Math.min(x, width - bounds.width - margin)),
      y: Math.max(margin, Math.min(y, height - bounds.height - margin)),
    };
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = `${position.x}px`;
    panel.style.top = `${position.y}px`;
  }

  function setExpanded(expanded) {
    content.hidden = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
    panel.dataset.expanded = String(expanded);
    label.textContent = expanded ? '收起' : '展开';
    place(position.x, position.y);
    savePosition();
  }

  function finishDrag(event) {
    if (!drag || event?.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
    const pointerId = drag.pointerId;
    drag = null;
    panel.classList.remove('is-dragging');
    if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    savePosition();
  }

  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false || drag) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: position.x, y: position.y };
    handle.setPointerCapture(event.pointerId);
    panel.classList.add('is-dragging');
  });
  window.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    place(drag.x + event.clientX - drag.startX, drag.y + event.clientY - drag.startY);
  });
  window.addEventListener('pointerup', finishDrag);
  window.addEventListener('pointercancel', finishDrag);
  handle.addEventListener('lostpointercapture', finishDrag);
  window.addEventListener('blur', () => finishDrag());
  window.addEventListener('resize', () => {
    finishDrag();
    place(position.x, position.y);
    savePosition();
  });

  handle.addEventListener('keydown', event => {
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 10;
    place(position.x + direction[0] * step, position.y + direction[1] * step);
    savePosition();
  });
  toggle.addEventListener('click', () => setExpanded(content.hidden));
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !content.hidden) {
      event.preventDefault();
      setExpanded(false);
      toggle.focus({ preventScroll: true });
    }
  });
  place(position.x, position.y);
}
