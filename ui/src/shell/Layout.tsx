import React from 'react';

export default function Layout({ nav, children }: { nav: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', minHeight: 'calc(100vh - 64px)' }}>
      <div style={{ borderRight: '1px solid #eee', padding: 12 }}>{nav}</div>
      <div>{children}</div>
    </div>
  );
}
