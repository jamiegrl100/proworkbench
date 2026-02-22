import React from 'react';

export default function SectionHeader({
  title,
  subtitle,
  actions,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <div>
        <h2 style={{ margin: 0 }}>{title}</h2>
        {subtitle ? <div className="pb-muted" style={{ fontSize: 13 }}>{subtitle}</div> : null}
      </div>
      {actions}
    </div>
  );
}
