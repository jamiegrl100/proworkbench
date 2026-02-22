import React from 'react';

export default function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} style={{ ...(props.style || {}) }} />;
}
