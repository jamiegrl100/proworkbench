import React from 'react';

export type TableColumn<T> = { key: string; label: string; render?: (r: T) => React.ReactNode };

export default function Table<T>({
  rows,
  columns,
  actions,
}: {
  rows: T[];
  columns: TableColumn<T>[];
  actions?: (row: T) => React.ReactNode;
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="pb-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{ textAlign: 'left', fontSize: 12, padding: '8px 6px' }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={`${(r as any)?.chat_id}:${idx}`}>
              {columns.map((c) => (
                <td key={c.key} style={{ padding: '10px 6px', fontSize: 13 }}>
                  {c.render ? c.render(r) : ((r as any)?.[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
