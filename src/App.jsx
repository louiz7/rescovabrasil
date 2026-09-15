import AgentsOverview from './AgentsOverview';
import AgentConversations from './AgentConversations';
import CaseDocuments from './CaseDocuments';
import PortfolioDetail from './PortfolioDetail';
import VoiceDebug from './VoiceDebug';
import PaymentFollowups from './PaymentFollowups';
import GrokVoiceTest from './GrokVoiceTest';
import TwilioPhoneTest from './TwilioPhoneTest';
import BrowserVoiceTest from './BrowserVoiceTest';
import legacyLabels from './legacy-display.json';
const displayLabel = (value) => (Object.hasOwn(legacyLabels, value) ? legacyLabels[value] : value);
import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  LayoutDashboard,
  FolderOpen,
  Users,
  Radio,
  ListTodo,
  Settings,
  Plus,
  Upload,
  Download,
  Search,
  ChevronRight,
  X,
  Check,
  CheckCircle2,
  AlertCircle,
  Clock3,
  Phone,
  Mail,
  MessageSquare,
  ShieldCheck,
  Play,
  Activity,
  RefreshCw,
  LogOut,
  Menu,
  Headphones,
  FileSpreadsheet,
  Sparkles,
  SlidersHorizontal,
  CircleHelp,
} from 'lucide-react';

const OUTCOMES = {
  not_reached: 'Not reached',
  invalid_contact: 'Invalid contact',
  callback: 'Callback requested',
  paid_reported: 'Payment reported',
  willing_to_pay: 'Willingness to pay',
  unable_to_pay: 'Financial difficulty',
  disputed: 'Debt disputed',
  human_review: 'Human review',
  opt_out: 'Do not contact',
};
const STATUS = {
  ready: 'Ready for outreach',
  review: 'Human review',
  suppressed: 'Contact blocked',
  unreached: 'Not reached',
  contacted: 'Contacted',
  draft: 'Draft',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  queued: 'Queued',
  waiting: 'Waiting',
  dispatching: 'Sending',
  stopped: 'Stopped',
  open: 'Open',
  done: 'Completed',
  delivered: 'Delivered',
  read: 'Read',
  answered: 'Answered',
  failed: 'Failed',
  unknown: 'Delivery uncertain',
  accepted: 'Accepted',
  sending: 'Sending',
  undelivered: 'Undelivered',
  initiated: 'Initiated',
  ringing: 'Ringing',
  busy: 'Busy',
  'no-answer': 'No response',
  canceled: 'Canceled',
};
const CHANNELS = {
  voice: { label: 'AI phone call', short: 'AI voice', icon: Phone },
  sms: { label: 'SMS', short: 'SMS', icon: MessageSquare },
  email: { label: 'Email', short: 'Email', icon: Mail },
  whatsapp: { label: 'WhatsApp', short: 'WhatsApp', icon: MessageSquare },
};
const NAV = [
  ['overview', 'Overview', LayoutDashboard],
  ['portfolios', 'Portfolios', FolderOpen],
  ['cases', 'Cases', Users],
  ['tasks', 'Follow-ups', ListTodo],
  ['agents', 'Agents', Sparkles],
  ['settings', 'Settings', Settings],
];
const money = (n) =>
  n == null
    ? 'Not provided'
    : new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'BRL' }).format(n / 100);
const number = (n) => new Intl.NumberFormat('en-GB').format(n || 0);
const date = (v, time = false, tz = 'America/Sao_Paulo') =>
  v
    ? new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        day: '2-digit',
        month: 'short',
        ...(time ? { hour: '2-digit', minute: '2-digit' } : { year: 'numeric' }),
      }).format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + 'T12:00:00Z' : v))
    : 'Not provided';
const initials = (name) =>
  (name || 'Unnamed')
    .split(' ')
    .slice(0, 2)
    .map((s) => s[0])
    .join('');
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  if (!r.ok) {
    const e = new Error(data.error || 'Could not load the data.');
    e.status = r.status;
    throw e;
  }
  return data;
}
function Badge({ value, children }) {
  return (
    <span className={'badge ' + (value || '')}>
      <i />
      {children || OUTCOMES[value] || STATUS[value] || value}
    </span>
  );
}
function Empty({ icon: Icon = FolderOpen, title = 'No records yet', text, action }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={25} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
function ErrorBox({ error }) {
  return error ? (
    <div className="error" role="alert">
      <AlertCircle size={17} />
      {error}
    </div>
  ) : null;
}
function Field({ label, children, hint }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function ChannelIcons({ channels }) {
  return (
    <span className="channel-icons">
      {channels.map((c) => {
        const Icon = CHANNELS[c].icon;
        return (
          <span title={CHANNELS[c].label} key={c}>
            <Icon size={14} />
            <span className="sr-only">{CHANNELS[c].label}</span>
          </span>
        );
      })}
    </span>
  );
}
function Modal({ title, subtitle, children, onClose, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector('input,select,button,textarea')?.focus();
    const handle = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const items = [
          ...ref.current.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]'),
        ].filter((x) => !x.disabled);
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handle);
    return () => {
      document.body.style.overflow = old;
      document.removeEventListener('keydown', handle);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        className={'modal ' + (wide ? 'wide' : '')}
      >
        <header className="modal-header">
          <div>
            <h2 id="dialog-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(null),
    [page, setPage] = useState('overview'),
    [data, setData] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [modal, setModal] = useState(() =>
      new URLSearchParams(window.location.search).get('voiceTest') === '1'
        ? { type: 'browserVoiceTest' }
        : new URLSearchParams(window.location.search).get('twilioTest') === '1'
          ? { type: 'twilioPhoneTest' }
          : new URLSearchParams(window.location.search).get('grokTest') === '1'
            ? { type: 'grokVoiceTest' }
            : null,
    ),
    [toast, setToast] = useState(''),
    [menu, setMenu] = useState(false);
  const [search, setSearch] = useState(''),
    [portfolio, setPortfolio] = useState(''),
    [status, setStatus] = useState(''),
    [offset, setOffset] = useState(0),
    [caseList, setCaseList] = useState({ rows: [], total: 0 }),
    [caseLoading, setCaseLoading] = useState(false);
  const flash = (message) => setToast(message);
  async function refresh() {
    setBusy(true);
    try {
      const [dashboard, portfolios, tasks, settings] = await Promise.all(
        ['/dashboard', '/portfolios', '/tasks', '/settings'].map((x) => api(x)),
      );
      setData({ dashboard, portfolios, tasks, settings });
      setError('');
    } catch (e) {
      setError(e.message);
      if (e.status === 401) setSession((s) => ({ ...s, authenticated: false }));
    } finally {
      setBusy(false);
    }
  }
  async function loadCases() {
    setCaseLoading(true);
    try {
      const q = new URLSearchParams({ search, portfolio, status, offset, limit: 25 });
      setCaseList(await api('/cases?' + q));
    } catch (e) {
      setError(e.message);
    } finally {
      setCaseLoading(false);
    }
  }
  useEffect(() => {
    api('/session')
      .then(setSession)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (session?.authenticated) refresh();
  }, [session?.authenticated]);
  useEffect(() => {
    if (!session?.authenticated) return;
    const timer = setTimeout(loadCases, 200);
    return () => clearTimeout(timer);
  }, [search, portfolio, status, offset, session?.authenticated]);
  useEffect(() => {
    if (!session?.authenticated) return;
    const t = setInterval(() => {
      if (!document.hidden) {
        refresh();
        if (page === 'cases') loadCases();
      }
    }, 15000);
    return () => clearInterval(t);
  }, [session?.authenticated, page, search, portfolio, status, offset]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(''), 6000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  function navigate(next) {
    setPage(next);
    setMenu(false);
  }
  async function changed(message) {
    setModal(null);
    flash(message);
    await Promise.all([refresh(), loadCases()]);
  }
  if (!session)
    return (
      <div className="boot">
        <div className="brand-logo">r</div>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button onClick={() => window.location.reload()}>Try again</button>
          </>
        ) : (
          <p>Preparing your workspace…</p>
        )}
      </div>
    );
  if (!session.authenticated)
    return (
      <Login mode={session.mode} onLogin={() => setSession({ ...session, authenticated: true })} />
    );
  const d = data?.dashboard;
  return (
    <div className="app-shell">
      {menu && <div className="nav-scrim" onClick={() => setMenu(false)} />}
      <aside className={'sidebar ' + (menu ? 'mobile-open' : '')}>
        <a
          href="#overview"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigate('overview');
          }}
        >
          <span className="brand-logo">
            r<span />
          </span>
          <span>
            rescova<span className="brand-country">BRAZIL</span>
          </span>
        </a>
        <div className="workspace">
          <div className="workspace-icon">
            <FolderOpen size={18} />
          </div>
          <div>
            <strong>Brazil workspace</strong>
            <small>Credit operations</small>
          </div>
          <span className="country-dot">BR</span>
        </div>
        <span className="nav-label">MAIN</span>
        <nav>
          {NAV.map(([id, label, Icon]) => (
            <button
              key={id}
              className={'nav-item ' + (page === id ? 'active' : '')}
              onClick={() => navigate(id)}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === 'tasks' && d?.openTasks > 0 && <b>{d.openTasks}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="trust-note">
            <ShieldCheck size={21} />
            <strong>Respectful conversations.</strong>
            <p>Human connections, supported by AI at scale.</p>
          </div>
          <button className="profile" onClick={() => setModal({ type: 'account' })}>
            <span className="avatar">OP</span>
            <span>
              <strong>Operator</strong>
              <small>Brazil workspace</small>
            </span>
            <Settings size={16} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-only"
              aria-label="Open navigation"
              onClick={() => setMenu(true)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>{NAV.find((n) => n[0] === page)?.[1]}</strong>
          </div>
          <div className="topbar-actions">
            <span className={'environment ' + session.mode}>
              <i />
              {session.mode === 'demo' ? 'Demo environment' : 'Live environment'}
            </span>
            <button
              className="icon-button"
              title="Refresh data"
              aria-label="Refresh data"
              disabled={busy}
              onClick={() => {
                refresh();
                loadCases();
              }}
            >
              <RefreshCw size={17} className={busy ? 'spin' : ''} />
            </button>
            <span className="avatar small">OP</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div className="eyebrow">
              BRAZIL OPERATIONS <span> / </span> OUTREACH: PT-BR · BRL
            </div>
            <div className="heading-row">
              <div>
                <h1>
                  {
                    {
                      overview: 'Every conversation, a new way forward.',
                      portfolios: 'Your portfolios, all in one place.',
                      cases: 'The people behind every case.',
                      tasks: 'The next step starts here.',
                      agents: 'Your agents, working together.',
                      settings: 'Your operation, your settings.',
                    }[page]
                  }
                </h1>
                <p>
                  {
                    {
                      overview: 'A clear view of your outreach and what needs attention.',
                      portfolios:
                        'Activate ongoing outreach, track progress, and manage exceptions.',
                      cases: 'Explore contacts, track responses, and follow up with people.',
                      tasks: 'Turn responses into actions for your team.',
                      agents: 'See responsibilities, models, and ongoing work.',
                      settings: 'Channels, schedules, and rules for responsible outreach.',
                    }[page]
                  }
                </p>
              </div>
              <div className="heading-actions">
                {page === 'portfolios' ? (
                  <button className="primary" onClick={() => setModal({ type: 'portfolio' })}>
                    <Plus size={17} />
                    New portfolio
                  </button>
                ) : page !== 'settings' && page !== 'tasks' && page !== 'agents' ? (
                  <>
                    <button className="secondary" onClick={() => setModal({ type: 'import' })}>
                      <Upload size={16} />
                      Import cases
                    </button>
                    <button className="primary" onClick={() => navigate('portfolios')}>
                      <Plus size={17} />
                      Manage portfolios
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </div>
          <ErrorBox error={error} />
          {!data ? (
            <div className="loading-panel">
              <RefreshCw className="spin" />
              Loading your workspace…
            </div>
          ) : (
            <>
              {page === 'overview' && (
                <Overview
                  data={data}
                  navigate={navigate}
                  onCase={(id) => setModal({ type: 'case', id })}
                  onPortfolio={(id) => setModal({ type: 'portfolioDetail', id })}
                  onSimulate={() => setModal({ type: 'simulator' })}
                  onConversations={() => setModal({ type: 'agentConversations' })}
                  onVoiceTest={() => setModal({ type: 'browserVoiceTest' })}
                  onPhoneTest={() => setModal({ type: 'twilioPhoneTest' })}
                  onGrokTest={() => setModal({ type: 'grokVoiceTest' })}
                  onDebug={(id) =>
                    setModal({
                      type: 'voiceDebug',
                      debugId: typeof id === 'string' ? id : undefined,
                    })
                  }
                />
              )}
              {page === 'portfolios' && (
                <>
                  <div className="section-toolbar">
                    <span>
                      <strong>{data.portfolios.length}</strong> portfolios in this workspace
                    </span>
                    <button className="secondary" onClick={() => setModal({ type: 'import' })}>
                      <Upload size={16} />
                      Import file
                    </button>
                  </div>
                  <div className="portfolio-grid">
                    {data.portfolios.map((p) => (
                      <article className="card portfolio-card" key={p.id}>
                        <div className="card-top">
                          <span className="portfolio-icon">
                            <FolderOpen size={23} />
                          </span>
                          <Badge value={p.status === 'active' ? 'running' : p.status || 'draft'}>
                            {p.status === 'active'
                              ? 'Active'
                              : p.status === 'paused'
                                ? 'Paused'
                                : 'Draft'}
                          </Badge>
                        </div>
                        <h2>{displayLabel(p.name)}</h2>
                        <p>{displayLabel(p.creditor)}</p>
                        <div className="portfolio-balance">
                          <small>Known balance</small>
                          <strong>{money(p.balance)}</strong>
                        </div>
                        <div className="portfolio-meta">
                          <span>
                            <Users size={15} />
                            {number(p.case_count)} cases
                          </span>
                          <span>{p.timezone.replace('America/', '').replaceAll('_', ' ')}</span>
                        </div>
                        <div className="portfolio-progress">
                          <div>
                            <span>Contact coverage</span>
                            <strong>{p.metrics?.coveragePercent || 0}%</strong>
                          </div>
                          <progress
                            aria-label="Contact coverage"
                            max="100"
                            value={p.metrics?.coveragePercent || 0}
                          />
                          <small>
                            {number(p.metrics?.attemptedCases)} of {number(p.case_count)} cases
                            attempted
                          </small>
                        </div>
                        <div className="portfolio-meta">
                          <span>{number(p.metrics?.reachedCases)} reached</span>
                          <span>{number(p.metrics?.openFollowups)} open follow-ups</span>
                        </div>
                        <button
                          className="card-link"
                          onClick={() => setModal({ type: 'portfolioDetail', id: p.id })}
                        >
                          View progress <ArrowUpRight size={18} />
                        </button>
                      </article>
                    ))}
                  </div>
                  {!data.portfolios.length && (
                    <Empty
                      title="Create your first portfolio"
                      text="Group a creditor's cases to get started."
                      action={
                        <button className="primary" onClick={() => setModal({ type: 'portfolio' })}>
                          <Plus size={16} />
                          Create portfolio
                        </button>
                      }
                    />
                  )}
                </>
              )}
              {page === 'cases' && (
                <section className="card">
                  <div className="table-toolbar">
                    <div className="search-input">
                      <Search size={17} />
                      <input
                        placeholder="Search name, reference, or phone…"
                        aria-label="Search cases"
                        value={search}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setOffset(0);
                        }}
                      />
                    </div>
                    <select
                      aria-label="Filter portfolio"
                      value={portfolio}
                      onChange={(e) => {
                        setPortfolio(e.target.value);
                        setOffset(0);
                      }}
                    >
                      <option value="">All portfolios</option>
                      {data.portfolios.map((p) => (
                        <option key={p.id} value={p.id}>
                          {displayLabel(p.name)}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Filter status"
                      value={status}
                      onChange={(e) => {
                        setStatus(e.target.value);
                        setOffset(0);
                      }}
                    >
                      <option value="">All statuses</option>
                      {['ready', 'review', 'suppressed', 'unreached', 'contacted'].map((s) => (
                        <option key={s} value={s}>
                          {STATUS[s]}
                        </option>
                      ))}
                    </select>
                    <a
                      className="secondary square"
                      href="/api/cases/export"
                      title="Export all cases as CSV"
                      aria-label="Export all cases as CSV"
                    >
                      <Download size={17} />
                    </a>
                  </div>
                  {caseLoading ? <div className="loading-line">Updating cases…</div> : null}
                  <CaseTable rows={caseList.rows} onCase={(id) => setModal({ type: 'case', id })} />
                  <div className="table-footer">
                    <span>
                      {caseList.total
                        ? `${offset + 1}–${Math.min(offset + 25, caseList.total)} of ${number(caseList.total)} cases`
                        : '0 cases found'}
                    </span>
                    <div>
                      <button
                        className="icon-button"
                        disabled={offset === 0}
                        onClick={() => setOffset(Math.max(0, offset - 25))}
                        aria-label="Previous page"
                      >
                        <ArrowLeft size={17} />
                      </button>
                      <button
                        className="icon-button"
                        disabled={offset + 25 >= caseList.total}
                        onClick={() => setOffset(offset + 25)}
                        aria-label="Next page"
                      >
                        <ArrowRight size={17} />
                      </button>
                    </div>
                  </div>
                </section>
              )}
              {page === 'tasks' && (
                <Tasks
                  tasks={data.tasks}
                  onTask={(task) => setModal({ type: 'task', task })}
                  onCase={(id) => setModal({ type: 'case', id })}
                />
              )}
              {page === 'agents' && (
                <AgentsOverview
                  onConversations={(conversationId) =>
                    setModal({ type: 'agentConversations', conversationId })
                  }
                  onCase={(id) => setModal({ type: 'case', id })}
                />
              )}
              {page === 'settings' && (
                <SettingsPage
                  settings={data.settings}
                  onSaved={() => {
                    refresh();
                    flash('Contact policy updated.');
                  }}
                />
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              Rescova Brazil <span>·</span> General times shown in Brasília time
            </span>
            <span>
              <span className="online-dot" />{' '}
              {session.mode === 'demo'
                ? 'Simulated data and outreach'
                : 'Refreshes automatically every 15 seconds'}
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={19} />
          <span>{toast}</span>
          <button className="icon-button" aria-label="Dismiss message" onClick={() => setToast('')}>
            <X size={15} />
          </button>
        </div>
      )}
      {modal && data && (
        <>
          {modal.type === 'portfolio' && (
            <PortfolioModal onClose={() => setModal(null)} onDone={changed} />
          )}{' '}
          {modal.type === 'import' && (
            <ImportModal
              portfolios={data.portfolios}
              initialPortfolioId={modal.portfolioId}
              onClose={() => setModal(null)}
              onDone={changed}
              onPortfolio={() => setModal({ type: 'portfolio' })}
            />
          )}{' '}
          {modal.type === 'portfolioDetail' && (
            <Modal
              title="Portfolio overview"
              subtitle="Ongoing outreach and portfolio progress"
              wide
              onClose={() => setModal(null)}
            >
              <PortfolioDetail
                id={modal.id}
                settings={data.settings}
                onChanged={refresh}
                onCases={(id) => {
                  setPortfolio(id);
                  setOffset(0);
                  setModal(null);
                  navigate('cases');
                }}
                onImport={(id) => setModal({ type: 'import', portfolioId: id })}
                onSimulate={() => setModal({ type: 'simulator', portfolioId: modal.id })}
              />
            </Modal>
          )}{' '}
          {modal.type === 'case' && (
            <CaseModal
              id={modal.id}
              initialTab={modal.tab || 'history'}
              onClose={() => setModal(null)}
              onChanged={() => {
                refresh();
                loadCases();
              }}
            />
          )}{' '}
          {modal.type === 'task' && (
            <TaskModal task={modal.task} onClose={() => setModal(null)} onDone={changed} />
          )}{' '}
          {modal.type === 'simulator' && (
            <Simulator
              portfolioId={modal.portfolioId}
              onClose={() => setModal(null)}
              onChanged={() => {
                refresh();
                loadCases();
              }}
            />
          )}{' '}
          {modal.type === 'agentConversations' && (
            <Modal
              title="Demo SMS conversations"
              subtitle="Payment follow-up and ongoing dialogue"
              wide
              onClose={() => setModal(null)}
            >
              <AgentConversations
                initialConversationId={modal.conversationId || ''}
                onCase={(id) => setModal({ type: 'case', id, tab: 'conversations' })}
              />
            </Modal>
          )}
          {modal.type === 'voiceDebug' && (
            <Modal
              title="Voice debug"
              subtitle="Recorded audio and local Whisper transcripts"
              wide
              onClose={() => setModal(null)}
            >
              <VoiceDebug initialId={modal.debugId || ''} />
            </Modal>
          )}
          {modal.type === 'grokVoiceTest' && (
            <Modal
              title="Grok browser test"
              subtitle="Talk to Grok using your microphone and a fictional case"
              onClose={() => setModal(null)}
            >
              <GrokVoiceTest
                onDebug={(id) =>
                  setModal({ type: 'voiceDebug', debugId: typeof id === 'string' ? id : undefined })
                }
                onCase={(id) => {
                  refresh();
                  loadCases();
                  setModal({ type: 'case', id, tab: 'payments' });
                }}
              />
            </Modal>
          )}
          {modal.type === 'twilioPhoneTest' && (
            <Modal
              title="Twilio phone test"
              subtitle="Call your approved test number with a fictional case"
              onClose={() => setModal(null)}
            >
              <TwilioPhoneTest
                onDebug={(id) => setModal({ type: 'voiceDebug', debugId: id })}
                onCase={(id) => {
                  refresh();
                  loadCases();
                  setModal({ type: 'case', id, tab: 'payments' });
                }}
              />
            </Modal>
          )}
          {modal.type === 'browserVoiceTest' && (
            <Modal
              title="Browser voice test"
              subtitle="Talk to the AI with a fictional Brazil case"
              onClose={() => setModal(null)}
            >
              <BrowserVoiceTest
                onDebug={(id) =>
                  setModal({ type: 'voiceDebug', debugId: typeof id === 'string' ? id : undefined })
                }
                onCase={(id) => {
                  refresh();
                  loadCases();
                  setModal({ type: 'case', id, tab: 'payments' });
                }}
              />
            </Modal>
          )}
          {modal.type === 'account' && (
            <Modal
              title="Your workspace"
              subtitle="Operator session"
              onClose={() => setModal(null)}
            >
              <div className="modal-body">
                <p>Administrative access to the Brazil workspace. Sessions expire after 8 hours.</p>
                <div className="info-box">
                  <ShieldCheck size={20} />
                  <span>
                    {session.mode === 'demo'
                      ? 'You are in demo mode. All outreach is simulated.'
                      : 'You are in the live environment. Actions are recorded in the history.'}
                  </span>
                </div>
                <button
                  className="secondary"
                  onClick={async () => {
                    await api('/logout', 'POST');
                    setModal(null);
                    setData(null);
                    setSession({ ...session, authenticated: false });
                  }}
                >
                  <LogOut size={16} />
                  Sign out
                </button>
              </div>
            </Modal>
          )}
        </>
      )}
    </div>
  );
}

function Login({ mode, onLogin }) {
  const [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <div className="login-page">
      <section className="login-story">
        <div className="brand">
          <span className="brand-logo">
            r<span />
          </span>
          <span>
            rescova<span className="brand-country">BRAZIL</span>
          </span>
        </div>
        <div>
          <span className="eyebrow">CONNECTIONS THAT MAKE A DIFFERENCE</span>
          <h1>
            Every conversation.
            <br />
            A new
            <br />
            <em>possibility.</em>
          </h1>
          <p>Intelligent outreach that brings people together and opens paths to recovery.</p>
          <div className="login-orbit">
            <div>
              <Headphones size={48} />
            </div>
            <span className="orbit-tag">
              <ShieldCheck size={16} />
              Respectful outreach
            </span>
          </div>
        </div>
        <small>Built for Brazil · Outreach in Portuguese · BRL</small>
      </section>
      <section className="login-form">
        <div className="login-form-inner">
          <span className="eyebrow">YOUR WORKSPACE IS READY</span>
          <h2>Welcome to Rescova.</h2>
          <p>Sign in to your outreach workspace.</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                await api('/login', 'POST', { password });
                onLogin();
              } catch (e) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Workspace password">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                placeholder="Enter your password"
              />
            </Field>
            <ErrorBox error={error} />
            <button className="primary full" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in to workspace'}
              <ArrowRight size={17} />
            </button>
          </form>
          {mode === 'demo' && (
            <div className="demo-login">
              <Sparkles size={18} />
              <div>
                <strong>Explore the demo</strong>
                <p>
                  Use the password <code>rescova-demo</code>. Synthetic data and no external
                  outreach.
                </p>
              </div>
            </div>
          )}
          <p className="login-note">
            <ShieldCheck size={14} />
            Access restricted to authorized team members.
          </p>
        </div>
      </section>
    </div>
  );
}

function Overview({
  data,
  navigate,
  onCase,
  onPortfolio,
  onSimulate,
  onVoiceTest,
  onConversations,
  onPhoneTest,
  onGrokTest,
  onDebug,
}) {
  const d = data.dashboard,
    max = Math.max(1, ...d.daily.map((v) => v.count)),
    open = data.tasks.filter((t) => t.status === 'open'),
    ratio = d.cases ? Math.round((d.responses / d.cases) * 100) : 0;
  return (
    <>
      {d.mode === 'demo' && (
        <div className="demo-strip">
          <span>
            <Sparkles size={16} />
            <strong>Explore without sending.</strong> This workspace uses synthetic data and
            simulated outreach.
          </span>
          <button onClick={onSimulate}>
            Test a conversation
            <ArrowRight size={15} />
          </button>
        </div>
      )}
      <section className="card voice-test-entry">
        <div>
          <strong>Try a real AI conversation</strong>
          <p>
            Try a fictional case using browser audio or a real call to your approved test number.
          </p>
        </div>
        <div className="voice-test-entry-actions">
          <button className="secondary" onClick={onConversations}>
            <MessageSquare size={17} />
            Demo SMS conversations
          </button>
          <button className="secondary" onClick={onDebug}>
            Voice debug
          </button>
          <button className="secondary" onClick={onGrokTest}>
            <Headphones size={17} />
            Grok browser test
          </button>
          <button className="primary" onClick={onVoiceTest}>
            <Headphones size={17} />
            Browser voice test
          </button>
          <button className="secondary" onClick={onPhoneTest}>
            <Phone size={17} />
            Twilio phone test
          </button>
        </div>
      </section>
      <div className="stats-grid">
        <Stat
          label="Imported cases"
          value={number(d.cases)}
          icon={Users}
          detail={`${d.portfolios} portfolios in this workspace`}
        />
        <Stat
          label="Contact attempts"
          value={number(d.attempts)}
          icon={Radio}
          detail={`${d.delivered} deliveries or answered calls`}
        />
        <Stat
          label="Confirmed contacts"
          value={number(d.rightParty)}
          icon={ShieldCheck}
          detail="Name confirmed by self-report"
        />
        <Stat
          label="Needs human attention"
          value={number(d.openTasks)}
          icon={ListTodo}
          detail="Follow-ups that need your team"
          accent
          onClick={() => navigate('tasks')}
        />
      </div>
      <div className="dashboard-middle">
        <section className="card activity-card">
          <div className="section-title">
            <div>
              <h2>Outreach activity</h2>
              <p>Attempts per day · up to 14 active days</p>
            </div>
            <span className="chart-key">
              <i />
              Contacts
            </span>
          </div>
          <div className="chart-summary">
            <strong>{number(d.attempts)}</strong>
            <span>
              total attempts
              <br />
              <small>{d.mode === 'demo' ? 'Simulated activity' : 'Recorded activity'}</small>
            </span>
          </div>
          {d.daily.length ? (
            <div
              className="bar-chart"
              role="img"
              aria-label={d.daily.map((v) => `${v.day}: ${v.count} attempts`).join('; ')}
            >
              <div className="chart-grid">
                <span>{max}</span>
                <span>{Math.ceil(max / 2)}</span>
                <span>0</span>
              </div>
              <div className="chart-bars">
                {d.daily.map((v, i) => (
                  <div className="chart-column" key={v.day}>
                    <div
                      className={'bar ' + (i === d.daily.length - 1 ? 'last' : '')}
                      style={{ height: `${Math.max(4, (v.count / max) * 100)}%` }}
                    >
                      <span>{v.count}</span>
                    </div>
                    <small>
                      {new Intl.DateTimeFormat('en-GB', {
                        day: '2-digit',
                        month: '2-digit',
                      }).format(new Date(v.day + 'T12:00:00'))}
                    </small>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <Empty
              icon={Activity}
              title="No activity yet"
              text="Your first contact attempts will appear here."
            />
          )}
          <div className="activity-caption">
            <Clock3 size={14} />
            Track deliveries and responses separately to measure reach.
          </div>
        </section>
        <section className="response-card">
          <div className="section-title">
            <div>
              <span className="eyebrow">EVERY RESPONSE MATTERS</span>
              <h2>Listen to move forward.</h2>
            </div>
            <ArrowUpRight size={23} />
          </div>
          <div className="response-number">
            {ratio}
            <span>%</span>
          </div>
          <p>of cases have a recorded response</p>
          <div className="response-meter">
            <div style={{ width: ratio + '%' }} />
          </div>
          <div className="response-facts">
            <div>
              <span>Recorded responses</span>
              <strong>{d.responses}</strong>
            </div>
            <div>
              <span>Known portfolio balance</span>
              <strong>{money(d.balances.total)}</strong>
            </div>
            {d.balances.unknown > 0 && (
              <small>{d.balances.unknown} case(s) without a reported balance</small>
            )}
          </div>
          <button onClick={() => navigate('cases')}>
            View results
            <ArrowRight size={17} />
          </button>
          <span className="decor-circle" />
        </section>
      </div>
      <div className="dashboard-bottom">
        <section className="card">
          <div className="section-title">
            <div>
              <h2>
                Portfolio progress <span className="count-pill">{data.portfolios.length}</span>
              </h2>
              <p>Ongoing work, from first contact to resolution.</p>
            </div>
            <button className="text-button" onClick={() => navigate('portfolios')}>
              View all
              <ArrowUpRight size={15} />
            </button>
          </div>
          {data.portfolios.length ? (
            <div className="compact-campaigns">
              {data.portfolios.slice(0, 3).map((c) => (
                <button key={c.id} className="compact-campaign" onClick={() => onPortfolio(c.id)}>
                  <span className="campaign-symbol">
                    <Radio size={19} />
                  </span>
                  <span className="campaign-info">
                    <strong>{displayLabel(c.name)}</strong>
                    <small>
                      {c.case_count} cases <span>·</span> {c.metrics?.attemptedCases || 0} attempted
                    </small>
                  </span>
                  <Badge value={c.status === 'active' ? 'running' : c.status || 'draft'}>
                    {c.status === 'active' ? 'Active' : c.status === 'paused' ? 'Paused' : 'Draft'}
                  </Badge>
                  <ChevronRight size={17} />
                </button>
              ))}
            </div>
          ) : (
            <Empty
              icon={Radio}
              title="No portfolios yet"
              text="Import a portfolio, choose channels, and activate ongoing outreach."
            />
          )}
          <div className="channel-summary">
            {Object.entries(CHANNELS)
              .filter(([key]) => key !== 'whatsapp')
              .map(([key, c]) => {
                const metrics = d.channels.find((x) => x.channel === key);
                return (
                  <div key={key}>
                    <c.icon size={16} />
                    <span>{c.short}</span>
                    <strong>{metrics?.attempts || 0}</strong>
                    <small>attempts</small>
                  </div>
                );
              })}
          </div>
        </section>
        <section className="card attention-card">
          <div className="section-title">
            <div>
              <h2>
                Needs your attention <span className="count-pill amber">{open.length}</span>
              </h2>
              <p>A person makes the difference.</p>
            </div>
            <ListTodo size={20} />
          </div>
          {open.length ? (
            <div className="attention-list">
              {open.slice(0, 3).map((t) => (
                <button key={t.id} onClick={() => onCase(t.case_id)}>
                  <span className={'avatar ' + (t.priority === 'high' ? 'peach' : '')}>
                    {initials(t.name)}
                  </span>
                  <span>
                    <strong>{t.name || t.reference}</strong>
                    <small>{displayLabel(t.reason)}</small>
                  </span>
                  <ArrowUpRight size={16} />
                </button>
              ))}
            </div>
          ) : (
            <Empty icon={CheckCircle2} title="All caught up" text="No open follow-ups." />
          )}
          <button className="card-link" onClick={() => navigate('tasks')}>
            Open follow-up queue
            <ArrowRight size={16} />
          </button>
        </section>
      </div>
      <section className="card results-strip">
        <div>
          <h2>What people are telling us</h2>
          <p>Recorded case outcomes</p>
        </div>
        <div className="outcome-chips">
          {d.outcomes.length ? (
            d.outcomes.map((o) => (
              <span key={o.outcome}>
                <span className={'outcome-dot ' + o.outcome} />
                {OUTCOMES[o.outcome]}
                <b>{o.count}</b>
              </span>
            ))
          ) : (
            <p>Responses will appear after your first contacts.</p>
          )}
        </div>
      </section>
    </>
  );
}
function Stat({ label, value, icon: Icon, detail, accent, onClick }) {
  return (
    <div className={'stat-card ' + (accent ? 'accent' : '')}>
      <div className="stat-top">
        <span>{label}</span>
        <Icon size={18} />
      </div>
      <strong>{value}</strong>
      <div>
        {detail}
        {onClick && (
          <button onClick={onClick} aria-label="Open follow-ups">
            <ArrowUpRight size={17} />
          </button>
        )}
      </div>
    </div>
  );
}
function CaseTable({ rows, onCase, selected, onSelect }) {
  return rows.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {onSelect && (
              <th className="check-cell">
                <span className="sr-only">Select</span>
              </th>
            )}
            <th>Person / reference</th>
            <th>Portfolio</th>
            <th>Outstanding balance</th>
            <th>Channels</th>
            <th>Status / outcome</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              {onSelect && (
                <td>
                  <input
                    aria-label={`Select ${c.name || c.reference}`}
                    type="checkbox"
                    checked={selected.includes(c.id)}
                    disabled={!!c.suppressed || !!c.review_required}
                    onChange={() => onSelect(c.id)}
                  />
                </td>
              )}
              <td>
                <button className="person-cell" onClick={() => onCase?.(c.id)} disabled={!onCase}>
                  <span className="avatar">{initials(c.name)}</span>
                  <span>
                    <strong>{c.name || 'Name not provided'}</strong>
                    <small>{c.reference}</small>
                  </span>
                </button>
              </td>
              <td className="muted">{displayLabel(c.portfolio_name)}</td>
              <td className="numeric">{money(c.amount_minor)}</td>
              <td>
                <ChannelIcons
                  channels={[...(c.phone ? ['voice', 'sms'] : []), ...(c.email ? ['email'] : [])]}
                />
              </td>
              <td>
                <Badge value={c.outcome || c.status} />
              </td>
              <td>
                {onCase && (
                  <button
                    className="icon-button"
                    aria-label={`Open case ${c.reference}`}
                    onClick={() => onCase(c.id)}
                  >
                    <ChevronRight size={16} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty
      icon={Users}
      title="No cases found"
      text="Import a file or adjust the filters to see cases."
    />
  );
}
function PortfolioModal({ onClose, onDone }) {
  const [form, setForm] = useState({ name: '', creditor: '', timezone: 'America/Sao_Paulo' }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title="New portfolio"
      subtitle="Organize cases from the same creditor."
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api('/portfolios', 'POST', form);
            onDone('Portfolio created. You can now import cases.');
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          <Field label="Portfolio name">
            <input
              required
              autoFocus
              placeholder="E.g. Personal loans · September"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Creditor">
            <input
              required
              placeholder="Creditor institution name"
              value={form.creditor}
              onChange={(e) => setForm({ ...form, creditor: e.target.value })}
            />
          </Field>
          <Field
            label="Default time zone"
            hint="Each case can have its own time zone specified during import."
          >
            <select
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
            >
              {[
                'America/Sao_Paulo',
                'America/Manaus',
                'America/Rio_Branco',
                'America/Noronha',
                'America/Fortaleza',
                'America/Cuiaba',
              ].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
          <ErrorBox error={error} />
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create portfolio'}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

const IMPORT_FIELDS = {
  reference: 'Contract reference',
  name: "Person's name",
  phone: 'Brazilian phone number',
  email: 'Email',
  amount: 'Balance in BRL',
  currency: 'Currency',
  due_date: 'Due date',
  timezone: 'Time zone',
  language: 'Language',
};
function ImportModal({ portfolios, initialPortfolioId, onClose, onDone, onPortfolio }) {
  const [portfolioId, setPortfolioId] = useState(initialPortfolioId || portfolios[0]?.id || ''),
    [file, setFile] = useState(null),
    [stage, setStage] = useState(null),
    [mapping, setMapping] = useState({}),
    [report, setReport] = useState(null),
    [selected, setSelected] = useState([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState('all'),
    [previewOffset, setPreviewOffset] = useState(0);
  const filteredReport = (report || []).filter(
    (r) =>
      filter === 'all' ||
      (filter === 'errors' && !r.valid) ||
      (filter === 'warnings' && r.warnings.length),
  );
  const step = report ? 3 : stage ? 2 : 1;
  async function upload(e) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      if (file.size > 10000000) throw new Error('The file must be no larger than 10 MB.');
      const content = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(new Error('Could not read the file.'));
        reader.readAsDataURL(file);
      });
      const result = await api('/imports', 'POST', { portfolioId, filename: file.name, content });
      setStage(result);
      setMapping(result.mapping);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    setBusy(true);
    setError('');
    try {
      const result = await api(`/imports/${stage.id}/preview`, 'POST', { mapping });
      setReport(result.rows);
      setPreviewOffset(0);
      setSelected(result.rows.filter((r) => r.valid).map((r) => r.row));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    setBusy(true);
    setError('');
    try {
      const r = await api(`/imports/${stage.id}/commit`, 'POST', {
        mapping,
        selectedRows: selected,
      });
      onDone(
        `${r.imported} cases imported. ${r.rejected} invalid rows; ${r.skipped} rows not imported.`,
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function template() {
    const text =
      'reference;name;phone;email;amount;currency;due_date\nTEST-001;Test Person;+5511999991234;test@example.invalid;1250,50;BRL;01/08/2026\n';
    const u = URL.createObjectURL(new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = u;
    a.download = 'rescova-import-template.csv';
    a.click();
    URL.revokeObjectURL(u);
  }
  return (
    <Modal
      title="Import cases"
      subtitle="Organized data is the first step toward a good conversation."
      wide
      onClose={onClose}
    >
      <div className="import-steps">
        {['Upload file', 'Map columns', 'Review and import'].map((x, i) => (
          <div key={x} className={step === i + 1 ? 'current' : step > i + 1 ? 'complete' : ''}>
            <span>{step > i + 1 ? <Check size={14} /> : i + 1}</span>
            {x}
          </div>
        ))}
      </div>
      <div className="modal-body">
        <ErrorBox error={error} />
        {step === 1 &&
          (!portfolios.length ? (
            <Empty
              title="Create a portfolio first"
              text="Imported cases need a destination portfolio."
              action={
                <button className="primary" onClick={onPortfolio}>
                  Create portfolio
                </button>
              }
            />
          ) : (
            <form id="upload-form" onSubmit={upload}>
              <Field label="Destination portfolio">
                <select
                  value={portfolioId}
                  onChange={(e) => setPortfolioId(e.target.value)}
                  required
                >
                  {portfolios.map((p) => (
                    <option value={p.id} key={p.id}>
                      {displayLabel(p.name)}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="upload-zone">
                <span className="upload-icon">
                  <FileSpreadsheet size={29} />
                </span>
                <strong>{file ? file.name : 'Select your spreadsheet'}</strong>
                <p>
                  {file
                    ? `${(file.size / 1024).toFixed(1)} KB · click to change`
                    : 'UTF-8 CSV or XLSX · up to 10 MB and 10,000 rows'}
                </p>
                <span className="secondary">
                  Choose file
                  <Upload size={15} />
                </span>
                <input
                  type="file"
                  accept=".csv,.xlsx"
                  required
                  aria-label="Case file"
                  onChange={(e) => {
                    setFile(e.target.files[0]);
                    setError('');
                  }}
                />
              </label>
              <button type="button" className="text-button" onClick={template}>
                <Download size={15} />
                Download CSV template
              </button>
              <div className="info-box">
                <CircleHelp size={20} />
                <span>
                  Missing fields will be flagged. Each row needs at least one valid contact. BRL
                  balances and Brazilian phone numbers are checked before import.
                </span>
              </div>
            </form>
          ))}
        {step === 2 && (
          <>
            <div className="file-summary">
              <FileSpreadsheet size={20} />
              <strong>{file.name}</strong>
              <span>{number(stage.total)} rows</span>
            </div>
            <p className="muted">
              Match each field to its column. Optional fields can remain unmapped.
            </p>
            <div className="mapping-grid">
              {Object.entries(IMPORT_FIELDS).map(([key, label]) => (
                <Field key={key} label={label}>
                  <select
                    value={mapping[key] || ''}
                    onChange={(e) => setMapping({ ...mapping, [key]: e.target.value })}
                  >
                    <option value="">Do not import this field</option>
                    {stage.headers.map((h) => (
                      <option key={h}>{h}</option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
            <details>
              <summary>View file sample</summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {stage.headers.map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {stage.sample.map((r, i) => (
                      <tr key={i}>
                        {r.map((v, j) => (
                          <td key={j}>{v}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <div className="info-box">
              <ShieldCheck size={19} />
              <span>
                The AI receives debt details and asks the person to confirm their name before
                sharing them. This is a self-reported confirmation, not documentary identity
                verification.
              </span>
            </div>
          </>
        )}
        {step === 3 && (
          <>
            <div className="review-stats">
              <div>
                <strong>{report.length}</strong>
                <span>rows reviewed</span>
              </div>
              <div>
                <strong>{report.filter((r) => r.valid).length}</strong>
                <span>valid</span>
              </div>
              <div>
                <strong>{report.filter((r) => !r.valid).length}</strong>
                <span>with errors</span>
              </div>
              <div>
                <strong>{report.filter((r) => r.warnings.length).length}</strong>
                <span>with warnings</span>
              </div>
            </div>
            <div className="section-toolbar">
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={
                    selected.length > 0 && selected.length === report.filter((r) => r.valid).length
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? report.filter((r) => r.valid).map((r) => r.row) : [],
                    )
                  }
                />
                Select all valid rows ({selected.length})
              </label>
              <select
                aria-label="Filter review"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setPreviewOffset(0);
                }}
              >
                <option value="all">All rows</option>
                <option value="errors">With errors</option>
                <option value="warnings">With warnings</option>
              </select>
            </div>
            <div className="table-scroll import-preview">
              <table>
                <thead>
                  <tr>
                    <th />
                    <th>Row / reference</th>
                    <th>Person / contact</th>
                    <th>Balance</th>
                    <th>Validation</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredReport.slice(previewOffset, previewOffset + 100).map((r) => (
                    <tr key={r.row}>
                      <td>
                        <input
                          type="checkbox"
                          disabled={!r.valid}
                          checked={selected.includes(r.row)}
                          aria-label={`Select row ${r.row}`}
                          onChange={() =>
                            setSelected((v) =>
                              v.includes(r.row) ? v.filter((x) => x !== r.row) : [...v, r.row],
                            )
                          }
                        />
                      </td>
                      <td>
                        <small>Row {r.row}</small>
                        <br />
                        {r.reference}
                      </td>
                      <td>
                        {r.name || 'Name missing'}
                        <small className="block">{r.phone || r.email || 'No valid contact'}</small>
                      </td>
                      <td>{money(r.amount_minor)}</td>
                      <td>
                        {r.valid && !r.warnings.length && <Badge value="ready">Valid</Badge>}
                        {r.errors.map((x) => (
                          <span className="validation-error" key={x}>
                            {x}
                          </span>
                        ))}
                        {r.warnings.map((x) => (
                          <span className="validation-warning" key={x}>
                            {x}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <LocalPagination
              total={filteredReport.length}
              offset={previewOffset}
              onChange={setPreviewOffset}
            />
            <p className="muted small-text">
              Invalid rows will not be imported. Review shared contacts and missing balances before
              selecting rows.
            </p>
          </>
        )}
      </div>
      <div className="modal-footer">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            if (step === 3) setReport(null);
            else if (step === 2) setStage(null);
            else onClose();
          }}
        >
          {step === 1 ? 'Cancel' : 'Back'}
        </button>
        {step === 1 ? (
          <button
            form="upload-form"
            className="primary"
            disabled={busy || !file || !portfolios.length}
          >
            {busy ? 'Reading file…' : 'Continue'}
            <ArrowRight size={16} />
          </button>
        ) : (
          <button
            className="primary"
            onClick={step === 2 ? preview : commit}
            disabled={busy || (step === 3 && !selected.length)}
          >
            {busy
              ? 'Processing…'
              : step === 2
                ? 'Validate data'
                : `Import ${selected.length} cases`}
            <ArrowRight size={16} />
          </button>
        )}
      </div>
    </Modal>
  );
}

function eventDescription(e) {
  let v;
  try {
    v = JSON.parse(e.detail);
  } catch {
    v = e.detail;
  }
  if (typeof v === 'string') return e.actor === 'borrower' ? v : displayLabel(v);
  if (!v) return '';
  if (v.label)
    return `${displayLabel(v.label)}${v.note ? ' · ' + (e.actor === 'demo' ? displayLabel(v.note) : v.note) : ''}`;
  if (v.channel)
    return `${CHANNELS[v.channel]?.label || v.channel}${v.status ? ' · ' + (STATUS[v.status] || v.status) : ''}${v.reason ? ' · ' + displayLabel(v.reason) : ''}`;
  if (v.status)
    return `${STATUS[v.status] || v.status}${v.note ? ' · ' + v.note : ''}${v.assignee ? ' · ' + v.assignee : ''}`;
  return (
    v.note ||
    v.name ||
    displayLabel(v.reason) ||
    Object.entries(v)
      .map(([k, x]) => `${k}: ${x}`)
      .join(' · ')
  );
}
const EVENTS = {
  imported: 'Case imported',
  outcome: 'Outcome recorded',
  suppressed: 'Contact blocked',
  reopened: 'Case reopened',
  task_updated: 'Follow-up updated',
  attempt_started: 'Contact started',
  channel_skipped: 'Channel skipped',
  simulated: 'Simulation completed',
  no_response: 'No response',
  provider_status: 'Provider status',
  provider_error: 'Integration failure',
  identity_self_reported: 'Name confirmed by self-report',
  realtime_error: 'Conversation interrupted',
  ai_summary: 'Conversation summary',
  inbound_message: 'Response received',
  demo_payment_agreement: 'Demo payment agreement saved',
  payment_followup_updated: 'Payment follow-up updated',
};
function CaseModal({ id, onClose, onChanged, initialTab = 'history' }) {
  const [c, setCase] = useState(null),
    [error, setError] = useState(''),
    [tab, setTab] = useState(initialTab),
    [form, setForm] = useState({
      outcome: 'human_review',
      note: '',
      willingness: 'unknown',
      ability: 'unknown',
      callbackAt: '',
    }),
    [busy, setBusy] = useState(false),
    [reopen, setReopen] = useState(''),
    [notice, setNotice] = useState('');
  async function load() {
    try {
      setCase(await api('/cases/' + id));
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
  }, [id]);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/cases/${id}/outcome`, 'POST', {
        ...form,
        callbackAt:
          form.outcome === 'callback' && form.callbackAt
            ? new Date(form.callbackAt).toISOString()
            : undefined,
      });
      await load();
      onChanged();
      setNotice('Outcome recorded in the case history.');
      setTab('history');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={c?.name || 'Case details'}
      subtitle={c ? `${c.reference} · ${displayLabel(c.portfolio_name)}` : 'Loading history…'}
      wide
      onClose={onClose}
    >
      <div className="modal-body">
        <ErrorBox error={error} />
        {notice && (
          <div className="success-box" role="status">
            <CheckCircle2 size={17} />
            {notice}
          </div>
        )}
        {c && (
          <>
            <div className="case-summary">
              <div>
                <small>Outstanding balance</small>
                <strong>{money(c.amount_minor)}</strong>
              </div>
              <div>
                <small>Due date</small>
                <strong>{date(c.due_date)}</strong>
              </div>
              <div>
                <small>Current status</small>
                <Badge value={c.outcome || c.status} />
              </div>
            </div>
            <div className="case-contact-grid">
              <span>
                <Phone size={16} />
                {c.phone || 'Phone not provided'}
              </span>
              <span>
                <Mail size={16} />
                {c.email || 'Email not provided'}
              </span>
              <span>
                <Clock3 size={16} />
                {c.timezone}
              </span>
              <span>
                <ShieldCheck size={16} />
                {c.identity_confirmation === 'self_reported_name'
                  ? 'Name confirmed by self-report'
                  : 'Name not yet confirmed'}
              </span>
            </div>
            <div className="tabs">
              {[
                ['history', 'History'],
                ['attempts', `Contacts (${c.attempts.length})`],
                ['outcome', 'Record outcome'],
                ['review', 'Case review'],
                ['payments', `Payment follow-ups (${c.paymentFollowups?.length || 0})`],
                ['conversations', 'Conversations'],
                ['documents', 'Documents'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  className={tab === key ? 'active' : ''}
                  onClick={() => setTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            {tab === 'history' && (
              <div className="timeline">
                {c.events.length ? (
                  c.events.map((e) => (
                    <article key={e.id}>
                      <span className="timeline-dot" />
                      <div>
                        <div className="timeline-heading">
                          <strong>{EVENTS[e.kind] || e.kind}</strong>
                          <time>{date(e.created_at, true, c.timezone)}</time>
                        </div>
                        <p>{eventDescription(e)}</p>
                        <small>
                          {e.actor === 'demo'
                            ? 'Demo'
                            : e.actor === 'operator'
                              ? 'Operator'
                              : e.actor === 'realtime'
                                ? 'AI assistant'
                                : e.actor === 'borrower'
                                  ? 'Contacted person'
                                  : 'System'}
                        </small>
                      </div>
                    </article>
                  ))
                ) : (
                  <Empty title="No events recorded" />
                )}
              </div>
            )}
            {tab === 'attempts' && (
              <div>
                {c.attempts.length ? (
                  c.attempts.map((a) => (
                    <article className="attempt-card" key={a.id}>
                      <div className="section-toolbar">
                        <strong>{CHANNELS[a.channel]?.label}</strong>
                        <Badge value={a.status} />
                      </div>
                      <p>
                        {a.destination} · {date(a.created_at, true, c.timezone)}
                      </p>
                      {a.outcome && <Badge value={a.outcome} />}
                      <small className="block">
                        {a.mode === 'demo' ? 'Simulated contact' : 'Live contact'} ·{' '}
                        {a.identity_verified
                          ? 'Name confirmed by self-report'
                          : 'Name not confirmed'}
                      </small>
                      {a.message && <blockquote>{a.message}</blockquote>}
                      {a.error && <ErrorBox error={a.error} />}
                    </article>
                  ))
                ) : (
                  <Empty
                    icon={Phone}
                    title="No contacts yet"
                    text="This person's contact attempts will appear here."
                  />
                )}
              </div>
            )}
            {tab === 'outcome' && (
              <form onSubmit={save}>
                <div className="form-grid">
                  <Field label="Outcome">
                    <select
                      value={form.outcome}
                      onChange={(e) => setForm({ ...form, outcome: e.target.value })}
                    >
                      {Object.entries(OUTCOMES).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {form.outcome === 'callback' && (
                    <Field
                      label="Callback date and time"
                      hint={`Browser local time: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`}
                    >
                      <input
                        type="datetime-local"
                        required
                        value={form.callbackAt}
                        onChange={(e) => setForm({ ...form, callbackAt: e.target.value })}
                      />
                    </Field>
                  )}
                  <Field label="Willingness to pay">
                    <select
                      value={form.willingness}
                      onChange={(e) => setForm({ ...form, willingness: e.target.value })}
                    >
                      <option value="unknown">Unknown</option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  </Field>
                  <Field label="Ability to pay">
                    <select
                      value={form.ability}
                      onChange={(e) => setForm({ ...form, ability: e.target.value })}
                    >
                      <option value="unknown">Unknown</option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  </Field>
                </div>
                <Field label="Notes">
                  <textarea
                    rows={4}
                    maxLength={2000}
                    value={form.note}
                    onChange={(e) => setForm({ ...form, note: e.target.value })}
                    placeholder="What did the person report, and what is the next step?"
                  />
                </Field>
                <div className="info-box">
                  <CircleHelp size={19} />
                  <span>
                    Reported payments require human reconciliation. Opt-outs block shared contact
                    details. Relevant responses stop the sequence and create a follow-up.
                  </span>
                </div>
                <button className="primary" disabled={busy}>
                  {busy ? 'Saving…' : 'Save outcome'}
                  <Check size={16} />
                </button>
              </form>
            )}
            {tab === 'conversations' && <AgentConversations caseId={id} />}
            {tab === 'documents' && <CaseDocuments caseId={id} onChanged={load} />}
            {tab === 'payments' && (
              <PaymentFollowups
                agreements={c.paymentAgreements || []}
                jobs={c.paymentFollowups || []}
                onSaved={async () => {
                  await load();
                  onChanged();
                }}
              />
            )}
            {tab === 'review' && (
              <>
                <h3>Case follow-ups</h3>
                {c.tasks.length ? (
                  c.tasks.map((t) => (
                    <div className="review-task" key={t.id}>
                      <div>
                        <strong>{displayLabel(t.reason)}</strong>
                        <p>
                          {t.assignee || 'Unassigned'} · {date(t.due_at, true)}
                        </p>
                      </div>
                      <Badge value={t.status} />
                    </div>
                  ))
                ) : (
                  <p className="muted">No linked follow-ups.</p>
                )}
                <div className="info-box">
                  <ShieldCheck size={20} />
                  <span>
                    {c.suppressed
                      ? 'Contact is blocked. Renewed authorization requires validation outside this pilot.'
                      : 'Complete the open follow-ups before reopening this case for outreach.'}
                  </span>
                </div>
                {!c.suppressed && c.review_required ? (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setBusy(true);
                      setError('');
                      try {
                        await api(`/cases/${id}/reopen`, 'POST', { note: reopen });
                        await load();
                        onChanged();
                        setNotice('Case reopened for outreach.');
                      } catch (e) {
                        setError(e.message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <Field label="Reason for reopening">
                      <textarea
                        required
                        minLength={15}
                        value={reopen}
                        onChange={(e) => setReopen(e.target.value)}
                        placeholder="Describe your review (at least 15 characters)."
                      />
                    </Field>
                    <button
                      className="secondary"
                      disabled={busy || c.tasks.some((t) => t.status === 'open')}
                    >
                      Reopen case
                    </button>
                  </form>
                ) : null}
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function Tasks({ tasks, onTask, onCase }) {
  const [filter, setFilter] = useState('open');
  const rows = tasks.filter((t) => filter === 'all' || t.status === filter);
  return (
    <>
      <div className="section-toolbar">
        <div className="segmented">
          {[
            ['open', 'Open'],
            ['done', 'Completed'],
            ['all', 'All'],
          ].map(([k, v]) => (
            <button className={filter === k ? 'active' : ''} key={k} onClick={() => setFilter(k)}>
              {v}
              <span>{tasks.filter((t) => k === 'all' || t.status === k).length}</span>
            </button>
          ))}
        </div>
        <span className="muted small-text">High priority first</span>
      </div>
      <section className="card">
        {rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Person / portfolio</th>
                  <th>Reason</th>
                  <th>Priority</th>
                  <th>Due by</th>
                  <th>Assignee</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <button className="text-button" onClick={() => onCase(t.case_id)}>
                        {t.name || t.reference}
                        <ArrowUpRight size={13} />
                      </button>
                      <small className="block">{displayLabel(t.portfolio_name)}</small>
                    </td>
                    <td>{displayLabel(t.reason)}</td>
                    <td>
                      <Badge value={t.priority === 'high' ? 'high' : 'normal'}>
                        {t.priority === 'high' ? 'High' : 'Normal'}
                      </Badge>
                    </td>
                    <td
                      className={
                        t.status === 'open' && new Date(t.due_at) < new Date() ? 'overdue' : ''
                      }
                    >
                      {date(t.due_at, true)}
                    </td>
                    <td className="muted">{t.assignee || 'Unassigned'}</td>
                    <td>
                      <Badge value={t.status} />
                    </td>
                    <td>
                      <button className="secondary" onClick={() => onTask(t)}>
                        Manage
                        <ArrowUpRight size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon={CheckCircle2}
            title={filter === 'open' ? 'All caught up!' : 'No follow-ups in this view'}
            text="Responses that need your team appear in this queue."
          />
        )}
      </section>
    </>
  );
}
function TaskModal({ task: t, onClose, onDone }) {
  const [form, setForm] = useState({
      status: t.status,
      assignee: t.assignee || '',
      note: t.note || '',
      due_at: new Date(
        new Date(t.due_at).getTime() - new Date(t.due_at).getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16),
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title="Manage follow-up"
      subtitle={`${t.name || t.reference} · ${displayLabel(t.reason)}`}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api('/tasks/' + t.id, 'PATCH', {
              ...form,
              due_at: new Date(form.due_at).toISOString(),
            });
            onDone(form.status === 'done' ? 'Follow-up completed.' : 'Follow-up updated.');
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          <Field label="Assignee">
            <input
              value={form.assignee}
              onChange={(e) => setForm({ ...form, assignee: e.target.value })}
              placeholder="Assignee name"
            />
          </Field>
          <div className="form-grid">
            <Field
              label="Due by"
              hint={`Browser local time: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`}
            >
              <input
                type="datetime-local"
                required
                value={form.due_at}
                onChange={(e) => setForm({ ...form, due_at: e.target.value })}
              />
            </Field>
            <Field label="Status">
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
              >
                <option value="open">Open</option>
                <option value="done">Completed</option>
              </select>
            </Field>
          </div>
          <Field
            label="Notes / resolution"
            hint="To complete, describe the resolution in at least 5 characters."
          >
            <textarea
              rows={4}
              value={form.note}
              required={form.status === 'done'}
              minLength={form.status === 'done' ? 5 : undefined}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </Field>
          <ErrorBox error={error} />
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
            <Check size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SettingsPage({ settings: s, onSaved }) {
  const [form, setForm] = useState(s.policy),
    [dates, setDates] = useState(s.policy.excludedDates.join('\n')),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <div className="settings-grid">
      <section className="card">
        <div className="section-title">
          <div>
            <h2>Contact policy</h2>
            <p>Each person's local time, Monday to Friday.</p>
          </div>
          <Clock3 size={20} />
        </div>
        <form
          className="settings-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setError('');
            setBusy(true);
            try {
              await api('/settings/policy', 'PUT', {
                ...form,
                excludedDates: dates
                  .split(/[\n,]/)
                  .map((v) => v.trim())
                  .filter(Boolean),
              });
              onSaved();
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-grid">
            <Field label="Contact window starts">
              <select
                value={form.startHour}
                onChange={(e) => setForm({ ...form, startHour: Number(e.target.value) })}
              >
                {Array.from({ length: 12 }, (_, i) => i + 8).map((h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Contact window ends">
              <select
                value={form.endHour}
                onChange={(e) => setForm({ ...form, endHour: Number(e.target.value) })}
              >
                {Array.from({ length: 12 }, (_, i) => i + 9).map((h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Contact interval (hours)">
              <input
                type="number"
                min={24}
                max={168}
                required
                value={form.gapHours}
                onChange={(e) => setForm({ ...form, gapHours: Number(e.target.value) })}
              />
            </Field>
            <Field label="Total attempt limit">
              <input
                type="number"
                min={1}
                max={3}
                required
                value={form.maxAttempts}
                onChange={(e) => setForm({ ...form, maxAttempts: Number(e.target.value) })}
              />
            </Field>
          </div>
          <Field
            label="Excluded dates"
            hint="One date per line in YYYY-MM-DD format. Include applicable holidays and local dates."
          >
            <textarea
              rows={4}
              placeholder="2026-12-25"
              value={dates}
              onChange={(e) => setDates(e.target.value)}
            />
          </Field>
          <div className="info-box">
            <ShieldCheck size={19} />
            <span>
              Attempt limits apply across portfolios and shared contact details. Opt-outs stop the
              sequence immediately.
            </span>
          </div>
          <ErrorBox error={error} />
          <button className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save policy'}
            <Check size={16} />
          </button>
        </form>
      </section>
      <div className="settings-side">
        <section className="card">
          <div className="section-title">
            <div>
              <h2>Channels and integrations</h2>
              <p>
                {s.mode === 'demo' ? 'Simulator availability' : 'Live environment availability'}
              </p>
            </div>
            <Radio size={20} />
          </div>
          <div className="integration-list">
            {Object.entries(CHANNELS).map(([key, c]) => (
              <div key={key}>
                <span className="integration-icon">
                  <c.icon size={19} />
                </span>
                <div>
                  <strong>{c.label}</strong>
                  <small>
                    {key === 'voice'
                      ? `Twilio + OpenAI · ${s.model}`
                      : key === 'sms'
                        ? 'Twilio Messaging'
                        : key === 'email'
                          ? 'SendGrid'
                          : 'WhatsApp Business'}
                  </small>
                  {!s.capabilities[key]?.available && <p>{s.capabilities[key]?.reason}</p>}
                </div>
                <Badge value={s.capabilities[key]?.available ? 'ready' : 'paused'}>
                  {s.capabilities[key]?.available
                    ? s.mode === 'demo'
                      ? 'Simulated'
                      : 'Active'
                    : 'Blocked'}
                </Badge>
              </div>
            ))}
          </div>
        </section>
        <section className="card voice-policy">
          <span className="voice-icon">
            <Headphones size={25} />
          </span>
          <h2>AI with context and boundaries.</h2>
          <p>
            The assistant speaks Brazilian Portuguese and receives the creditor, reference, balance,
            and due date. It shares these details after the person confirms their name. This
            self-report is not documentary proof of identity.
          </p>
          <ul>
            <li>Introduces itself as a virtual assistant.</li>
            <li>Never threatens or promises unauthorized terms.</li>
            <li>Distinguishes willingness from ability to pay.</li>
            <li>Refers disputes and requests to your team.</li>
          </ul>
          <span className="locale-badge">
            BRAZIL <span>·</span> pt-BR <span>·</span> BRL
          </span>
        </section>
      </div>
    </div>
  );
}

function Simulator({ portfolioId, onClose, onChanged }) {
  const [outcome, setOutcome] = useState('willing_to_pay'),
    [advance, setAdvance] = useState(false),
    [result, setResult] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title="Simulate a conversation"
      subtitle="Explore the workflow without contacting anyone."
      onClose={onClose}
    >
      <div className="modal-body">
        <div className="info-box">
          <Sparkles size={21} />
          <span>
            {portfolioId
              ? 'One queued attempt from this portfolio will be processed.'
              : 'One queued attempt from active portfolio work will be processed.'}{' '}
            This mode does not connect to Twilio or OpenAI. Results are marked as simulated.
          </span>
        </div>
        <Field label="Person's response">
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">Delivery / call only, no response</option>
            {Object.entries(OUTCOMES).map(([k, v]) => (
              <option value={k} key={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <label className="check-label">
          <input type="checkbox" checked={advance} onChange={(e) => setAdvance(e.target.checked)} />
          Advance contacts waiting for the next interval
        </label>
        <p className="muted small-text">
          Activate or resume a portfolio before simulating. A callback request creates a follow-up
          for tomorrow.
        </p>
        <ErrorBox error={error} />
        {result && (
          <div className={result.processed ? 'success-box' : 'info-box'} role="status">
            {result.processed ? <CheckCircle2 size={20} /> : <Clock3 size={20} />}
            <span>
              {result.processed
                ? `Simulated contact: ${result.name || 'unnamed person'}, via ${CHANNELS[result.channel]?.label}. ${OUTCOMES[outcome] || 'Delivery recorded, no response.'}`
                : result.message}
            </span>
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="secondary" onClick={onClose}>
          Close
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              setResult(
                await api('/demo/step', 'POST', {
                  outcome: outcome || undefined,
                  advanceTime: advance,
                  ...(portfolioId ? { portfolioId } : {}),
                }),
              );
              onChanged();
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Play size={16} />
          {busy ? 'Simulating…' : 'Simulate next contact'}
        </button>
      </div>
    </Modal>
  );
}

function LocalPagination({ total, offset, onChange }) {
  return (
    <div className="table-footer">
      <span>
        {total
          ? `${offset + 1}–${Math.min(offset + 100, total)} of ${number(total)} rows`
          : 'No rows in this view'}
      </span>
      {total > 100 && (
        <div>
          <button
            type="button"
            className="icon-button"
            disabled={!offset}
            onClick={() => onChange(Math.max(0, offset - 100))}
            aria-label="Previous rows"
          >
            <ArrowLeft size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={offset + 100 >= total}
            onClick={() => onChange(offset + 100)}
            aria-label="Next rows"
          >
            <ArrowRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
