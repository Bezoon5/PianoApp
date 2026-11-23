window.Tesseract = { createWorker: async () => ({
  recognize: c => new Promise(r => setTimeout(() => {
    const isLabel = c.width < 900;
    r({ data: isLabel ? { text: window.__labels ? window.__labels.shift() || '' : 'Piano', lines: [] }
                      : { text: 'Test Title\n= 80', lines: [{ text: 'Test Title', confidence: 90, bbox: { x0: 0, y0: 0, x1: 100, y1: 30 } }] } });
  }, 1200)),
  terminate: async () => {}
}) };
