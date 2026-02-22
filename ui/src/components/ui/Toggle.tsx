import React from 'react';

export default function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, opacity: disabled ? 0.6 : 1 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      {label}
    </label>
  );
}
