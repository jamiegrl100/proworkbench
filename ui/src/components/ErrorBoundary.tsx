import React from 'react';

export default class ErrorBoundary extends React.Component<{ title: string; children: any }, { error: any }> {
  constructor(props: any) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: any) {
    return { error };
  }
  componentDidCatch(error: any) {
    // eslint-disable-next-line no-console
    console.error('UI crashed:', error);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 16, maxWidth: 980 }}>
          <h2 style={{ marginTop: 0 }}>{this.props.title}</h2>
          <div style={{ padding: 12, border: '1px solid #ffcdd2', background: '#ffebee', borderRadius: 10 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>This page crashed</div>
            <div style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {String(this.state.error?.message || this.state.error)}
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
