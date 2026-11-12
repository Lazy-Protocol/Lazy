import { Component, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-[400px] flex items-center justify-center">
          <div className="text-center p-8 max-w-md">
            <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertTriangle className="w-8 h-8 text-red-500" />
            </div>
            <h2 className="text-xl font-bold text-drift-white mb-2">
              Display interrupted.
            </h2>
            <p className="text-drift-white/70 mb-6">
              This section could not load. A refresh typically resolves this.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="bg-yield-gold hover:bg-yield-gold-light text-lazy-navy font-semibold px-6 py-2 rounded-xl transition-colors"
            >
              Refresh
            </button>
            {this.state.error && (
              <details className="mt-4 text-left">
                <summary className="text-drift-white/50 text-sm cursor-pointer">
                  Error details
                </summary>
                <pre className="mt-2 p-3 bg-lazy-navy rounded-lg text-xs text-red-400 overflow-auto">
                  {this.state.error.message}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
