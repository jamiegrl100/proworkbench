import React from 'react';

export default function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} style={{ width: '100%', ...(props.style || {}) }} />;
}
