'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { ErrorBoundary } from '../error-boundary';
import { AlertCircle, RefreshCw } from 'lucide-react';

interface SelectErrorBoundaryProps {
  children: ReactNode;
  label: string;
  type: 'category' | 'author';
}

interface SelectErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class SelectErrorBoundary extends Component<SelectErrorBoundaryProps, SelectErrorBoundaryState> {
  constructor(props: SelectErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null
    };
  }

  static getDerivedStateFromError(error: Error): SelectErrorBoundaryState {
    return {
      hasError: true,
      error
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[SelectErrorBoundary:${this.props.type}] Error caught:`, {
      error,
      errorInfo,
      label: this.props.label,
      timestamp: new Date().toISOString()
    });
  }

  handleRetry = () => {
    this.setState({
      hasError: false,
      error: null
    });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 bg-red-50 border border-red-200 rounded-md">
          <div className="flex items-center gap-2 mb-2">
            <AlertCircle className="h-4 w-4 text-red-600" />
            <span className="text-sm font-medium text-red-800">
              {this.props.label} filter unavailable
            </span>
          </div>
          <p className="text-sm text-red-700 mb-3">
            The {this.props.type} filter encountered an error and cannot be displayed.
          </p>
          <button
            onClick={this.handleRetry}
            className="inline-flex items-center gap-1 px-3 py-1 text-sm bg-red-100 hover:bg-red-200 text-red-800 rounded transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            Try Again
          </button>
          {process.env.NODE_ENV === 'development' && this.state.error && (
            <details className="mt-2">
              <summary className="text-xs text-red-600 cursor-pointer">
                Technical Details (Dev Only)
              </summary>
              <pre className="mt-1 text-xs text-red-600 bg-red-100 p-2 rounded overflow-auto">
                {this.state.error.message}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

export default SelectErrorBoundary;