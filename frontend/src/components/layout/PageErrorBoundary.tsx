// Crash page (UI-A2, D-ui-12). A render error inside a page shows a short message and a reference id in place of
// that page; the shell and sidebar keep working, and moving to another page starts fresh (the boundary is keyed by
// the path). The person never sees the error text or stack: in development they go to the console, in production
// to the server log (POST /api/client-errors) under the same reference id, so a reported id can be found there.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertOctagon } from 'lucide-react';
import { post } from '../../lib/api';
import { translate } from '../../lib/i18n';

function newRef(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return `ERR-${Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 8).toUpperCase()}`;
}

function report(ref: string, error: unknown, info: ErrorInfo) {
  const e = error instanceof Error ? error : new Error(String(error));
  if (import.meta.env.DEV) {
    console.error(ref, e, info.componentStack);
    return;
  }
  const stack = `${e.stack ?? ''}\n${info.componentStack ?? ''}`.slice(0, 4000);
  post('/client-errors', { ref, path: location.pathname.slice(0, 200), message: `${e.name}: ${e.message}`.slice(0, 500), stack }).catch(() => undefined);
}

interface State {
  ref: string | null;
}

export class PageErrorBoundary extends Component<{ children: ReactNode; home: string; fullScreen?: boolean; onCrash?: () => void }, State> {
  state: State = { ref: null };

  static getDerivedStateFromError(): State {
    return { ref: newRef() };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    report(this.state.ref ?? newRef(), error, info);
    // After the crashed page has unmounted (its data may be what broke it).
    setTimeout(() => this.props.onCrash?.(), 0);
  }

  render() {
    if (!this.state.ref) return this.props.children;
    return (
      <div
        className={this.props.fullScreen ? 'grid min-h-screen place-items-center bg-surface p-6' : 'grid h-full place-items-center p-6'}
        role="alert"
        data-testid="crash-page"
      >
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-crit-bg text-crit">
            <AlertOctagon className="size-5" />
          </div>
          <div className="text-section font-semibold text-ink">{translate('This page stopped working')}</div>
          <p className="mt-1 text-meta text-ink-3">{translate('Reload the page. If it happens again, give this reference to your administrator.')}</p>
          <p className="mt-3 text-meta text-ink-2">
            {translate('Reference')}: <span className="select-all font-mono font-semibold" data-testid="crash-ref">{this.state.ref}</span>
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <button type="button" className="inline-flex h-9 items-center rounded-control bg-navy px-4 text-meta font-medium text-white hover:bg-navy-2" onClick={() => location.reload()}>
              {translate('Reload page')}
            </button>
            <a className="inline-flex h-9 items-center rounded-control border border-line px-4 text-meta font-medium text-ink hover:bg-panel" href={this.props.home}>
              {translate('Go to my home')}
            </a>
          </div>
        </div>
      </div>
    );
  }
}
