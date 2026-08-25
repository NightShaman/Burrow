import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Burrow UI render error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="app-error" role="alert"><h1>Burrow hit a snag</h1><p>{this.state.error.message || 'The interface could not render.'}</p><button onClick={() => window.location.reload()}>Reload cockpit</button></main>;
  }
}
