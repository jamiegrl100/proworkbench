import React from 'react';

export default function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pb-card" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}
