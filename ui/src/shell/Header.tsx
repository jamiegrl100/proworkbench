import React from 'react';

import type { Meta } from '../types';

export default function Header({ meta, onLogout }: { meta: Meta; onLogout: () => void }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: 16, borderBottom: '1px solid #ddd' }}>
      <div>
        <div style={{ fontWeight: 700 }}>Proworkbench</div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>v{meta.version}</div>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          {meta.gitCommit ? `git ${meta.gitCommit}` : ''} {meta.buildTime ? `· ${meta.buildTime}` : ''}
        </div>
        <button style={{ padding: '6px 10px' }} onClick={onLogout}>Logout</button>
      </div>
    </div>
  );
}
