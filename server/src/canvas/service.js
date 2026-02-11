import { insertCanvasItem } from './canvas.js';

// Canvas writes are internal PB actions, not tools.
// They are always allowed for admin Web UI and never require approvals.

export function createItem(db, input) {
  return insertCanvasItem(db, input);
}

export function appendItem(db, { id, appendText }) {
  const row = db.prepare('SELECT * FROM canvas_items WHERE id = ?').get(String(id));
  if (!row) {
    const err = new Error('Canvas item not found');
    err.code = 'CANVAS_NOT_FOUND';
    throw err;
  }
  const contentType = String(row.content_type || 'text');
  if (contentType !== 'text' && contentType !== 'markdown') {
    const err = new Error('Can only append to text/markdown items');
    err.code = 'CANVAS_APPEND_UNSUPPORTED';
    throw err;
  }
  const next = String(row.content_text || '') + String(appendText || '');
  db.prepare('UPDATE canvas_items SET content_text = ?, updated_at = ? WHERE id = ?')
    .run(next, new Date().toISOString(), String(id));
  return db.prepare('SELECT * FROM canvas_items WHERE id = ?').get(String(id));
}

