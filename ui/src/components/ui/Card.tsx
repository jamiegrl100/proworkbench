import React from 'react';

export default function Card({
  title,
  children,
  style,
}: {
  title?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <section className="pb-card" style={{ padding: 14, ...style }}>
      {title ? <div style={{ fontWeight: 800, marginBottom: 10 }}>{title}</div> : null}
      {children}
    </section>
  );
}
