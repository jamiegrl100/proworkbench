export function requireAuth(db) {
  return (req, res, next) => {
    const sid = req.cookies?.pb_sid;
    if (!sid) return res.status(401).json({ error: 'Not authenticated' });
    const row = db.prepare('SELECT sid, expires_at FROM sessions WHERE sid = ?').get(sid);
    if (!row) return res.status(401).json({ error: 'Not authenticated' });
    if (new Date(row.expires_at).getTime() < Date.now()) {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      return res.status(401).json({ error: 'Session expired' });
    }
    next();
  };
}
