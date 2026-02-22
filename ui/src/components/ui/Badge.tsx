import React from 'react';

type BadgeVariant = 'neutral' | 'ok' | 'warn' | 'bad';

const styles: Record<BadgeVariant, React.CSSProperties> = {
  neutral: {
    background: 'color-mix(in srgb, var(--panel-2) 90%, transparent)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
  },
  ok: {
    background: 'color-mix(in srgb, var(--ok) 16%, var(--panel))',
    border: '1px solid color-mix(in srgb, var(--ok) 50%, var(--border))',
    color: 'var(--ok)',
  },
  warn: {
    background: 'color-mix(in srgb, var(--warn) 18%, var(--panel))',
    border: '1px solid color-mix(in srgb, var(--warn) 50%, var(--border))',
    color: 'var(--warn)',
  },
  bad: {
    background: 'color-mix(in srgb, var(--bad) 18%, var(--panel))',
    border: '1px solid color-mix(in srgb, var(--bad) 50%, var(--border))',
    color: 'var(--bad)',
  },
};

export default function Badge({
  variant = 'neutral',
  children,
  style,
}: {
  variant?: BadgeVariant;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: 999,
        padding: '2px 8px',
        fontSize: 12,
        fontWeight: 700,
        ...styles[variant],
        ...style,
      }}
    >
      {children}
    </span>
  );
}
