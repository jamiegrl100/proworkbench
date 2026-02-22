import React from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: 'linear-gradient(135deg, var(--accent-1), var(--accent-2))',
    border: '1px solid color-mix(in srgb, var(--accent-2) 50%, var(--border))',
    color: 'var(--text-inverse)',
    fontWeight: 700,
  },
  secondary: {
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
  },
  ghost: {
    background: 'transparent',
    border: '1px solid var(--border-soft)',
    color: 'var(--text)',
  },
  danger: {
    background: 'color-mix(in srgb, var(--bad) 18%, var(--panel))',
    border: '1px solid color-mix(in srgb, var(--bad) 45%, var(--border))',
    color: 'var(--text)',
  },
};

export default function Button({
  variant = 'secondary',
  style,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      style={{
        padding: '8px 12px',
        borderRadius: 'var(--r-md)',
        ...variantStyles[variant],
        ...style,
      }}
    />
  );
}
