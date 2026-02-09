import React from 'react';

export function NavItem({ label, active, badge, onClick }: { label: string; active: boolean; badge?: number | null; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        textAlign: 'left',
        padding: '10px 10px',
        borderRadius: 10,
        border: '1px solid ' + (active ? '#ddd' : 'transparent'),
        background: active ? '#fafafa' : 'transparent',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        cursor: 'pointer',
        marginBottom: 6,
      }}
    >
      <span>{label}</span>
      {badge != null ? (
        <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, border: '1px solid #ddd', background: '#fff' }}>
          {badge}
        </span>
      ) : null}
    </button>
  );
}
