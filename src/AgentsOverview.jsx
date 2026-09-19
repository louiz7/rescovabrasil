import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Mail,
  MessageSquare,
  Network,
  Users,
} from 'lucide-react';
import SupervisorEscalations from './SupervisorEscalations';
import './AgentsOverview.css';

const label = (s = '') => s.replaceAll('_', ' ');
const time = (value) =>
  value && !Number.isNaN(new Date(value).getTime())
    ? new Date(value).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
function status(agent, enabled) {
  if (!agent.configured) return ['Configuration needed', 'attention'];
  if (agent.stats?.running) return ['Working', 'working'];
  if (!enabled && !['openai_voice', 'voice_backend'].includes(agent.id))
    return ['Disabled', 'neutral'];
  return [agent.execution === 'Manual test' ? 'Test only' : 'Available', 'ready'];
}
function Status({ agent, enabled }) {
  const [text, tone] = status(agent, enabled);
  return (
    <span className={`team-status ${tone}`}>
      <i />
      {text}
    </span>
  );
}
function useAgentData() {
  const [data, setData] = useState(null),
    [error, setError] = useState('');
  useEffect(() => {
    let stopped = false,
      timer;
    async function load() {
      try {
        const response = await fetch('/api/agents');
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not load agents.');
        if (!stopped) {
          setData(result);
          setError('');
        }
      } catch (e) {
        if (!stopped) setError(e.message);
      }
      if (!stopped) timer = setTimeout(load, 5000);
    }
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  return { data, error };
}
function AgentDetail({ agent, data, onBack, onSelect, onCase, onConversations }) {
  const [workFilter, setWorkFilter] = useState('ready');
  const [work, setWork] = useState(null),
    [error, setError] = useState('');
  useEffect(() => {
    let stopped = false,
      timer;
    setWork(null);
    setError('');
    async function load() {
      try {
        const response = await fetch(
          `/api/agent-tasks?state=${workFilter}&limit=5&owner=${encodeURIComponent(agent.name)}`,
        );
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not load current work.');
        if (!stopped) {
          setWork(result);
          setError('');
        }
      } catch (e) {
        if (!stopped) setError(e.message);
      }
      if (!stopped) timer = setTimeout(load, 5000);
    }
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [agent.id, agent.name, workFilter]);
  const connections = (data.relationships || []).filter(
    (r) => r.from === agent.id || r.to === agent.id,
  );
  const nodes = [...data.agents, ...(data.infrastructure || []), data.coordinator];
  return (
    <div className="agent-profile">
      <button className="team-back" onClick={onBack}>
        <ArrowLeft size={16} />
        All agents
      </button>
      <header className="team-profile-header">
        <div className="team-avatar large">{agent.name[0]}</div>
        <div>
          <p className="team-eyebrow">{agent.role}</p>
          <h2>{agent.name}</h2>
          <p>{agent.description}</p>
        </div>
        <Status agent={agent} enabled={data.enabled} />
      </header>
      <div className="team-profile-columns">
        <div className="team-main-column">
          <section className="team-panel">
            <div className="team-panel-heading">
              <h3>Current work</h3>
              <span>
                {work ? work.total : '–'} {workFilter === 'ready' ? 'ready now' : workFilter}
              </span>
            </div>
            <div className="team-work-filters" aria-label="Work timing">
              {[
                ['ready', 'Ready now'],
                ['scheduled', 'Scheduled'],
                ['waiting', 'Waiting'],
              ].map(([key, title]) => (
                <button
                  key={key}
                  aria-pressed={workFilter === key}
                  onClick={() => setWorkFilter(key)}
                >
                  {title}
                  <span>{work?.counts?.[key] ?? '–'}</span>
                </button>
              ))}
            </div>
            {error ? (
              <p role="alert" className="error">
                {error}
              </p>
            ) : !work ? (
              <p className="team-empty">Loading work…</p>
            ) : work.rows.length ? (
              <div className="team-work-list">
                {work.rows.map((task) => (
                  <button key={task.id} onClick={() => onCase(task.case_id)}>
                    <div>
                      <strong>{label(task.title)}</strong>
                      <span>
                        {task.name || task.reference} ·{' '}
                        {task.bucket === 'scheduled'
                          ? `Scheduled · ${task.due_at?.length === 10 ? new Date(task.due_at + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }) : time(task.due_at)}`
                          : label(task.status)}
                      </span>
                      <p>{task.next_action}</p>
                    </div>
                    <ChevronRight size={16} />
                  </button>
                ))}
                {work.total > work.rows.length && (
                  <p className="team-note">
                    Showing {work.rows.length} of {work.total}. All work is available in Agent
                    tasks.
                  </p>
                )}
              </div>
            ) : (
              <p className="team-empty">
                {workFilter === 'ready'
                  ? 'Nothing needs to run now. Scheduled reminders and waiting tasks are shown separately.'
                  : workFilter === 'scheduled'
                    ? 'No future tasks are scheduled.'
                    : 'No tasks are waiting on a dependency.'}
              </p>
            )}
          </section>
          <section className="team-panel">
            <div className="team-panel-heading">
              <h3>Recent activity</h3>
              <span>Recorded runs</span>
            </div>
            {agent.stats?.lastRuns?.length ? (
              <div className="team-run-list">
                {agent.stats.lastRuns.slice(0, 5).map((run, index) => (
                  <div key={run.id || index}>
                    <span className={`team-run-mark ${run.status}`} />
                    <div>
                      <strong>{label(run.status || 'completed')}</strong>
                      <span>{run.model || agent.model}</span>
                    </div>
                    <time>{time(run.created_at || run.createdAt)}</time>
                    {run.conversation_id && (
                      <button
                        className="team-text-button"
                        aria-label="Open run conversation"
                        onClick={() => onConversations(run.conversation_id)}
                      >
                        <ArrowRight size={16} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="team-empty">No recorded runs in this view yet.</p>
            )}
          </section>
          <section className="team-panel team-profile-connections">
            <h3>Connections</h3>
            {connections.length ? (
              connections.map((edge, index) => {
                const other = nodes.find(
                  (n) => n.id === (edge.from === agent.id ? edge.to : edge.from),
                );
                if (!other) return null;
                const clickable = data.agents.some((a) => a.id === other.id);
                return (
                  <div className="team-connection" key={index}>
                    {clickable ? (
                      <button className="team-text-button" onClick={() => onSelect(other.id)}>
                        {other.name}
                        <ChevronRight size={14} />
                      </button>
                    ) : (
                      <strong>{other.name}</strong>
                    )}
                    <span>
                      {edge.from === agent.id ? 'Outgoing' : 'Incoming'} · {edge.label}
                    </span>
                  </div>
                );
              })
            ) : (
              <p className="team-empty">No registered connections.</p>
            )}
          </section>
        </div>
        <aside className="team-side-column">
          <section className="team-panel">
            <h3>Responsibilities</h3>
            <ul className="team-capabilities">
              {(agent.responsibilities || agent.capabilities).map((text) => (
                <li key={text}>
                  <Check size={15} />
                  {text}
                </li>
              ))}
            </ul>
            {agent.limitations?.length > 0 && (
              <>
                <h4>Boundaries</h4>
                <ul className="team-boundaries">
                  {agent.limitations.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
          <section className="team-panel">
            <h3>Setup</h3>
            <dl className="team-setup">
              <div>
                <dt>Execution</dt>
                <dd>{agent.execution}</dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd>{agent.scope}</dd>
              </div>
              <div>
                <dt>{agent.kind === 'retrieval' ? 'Engine' : 'Model'}</dt>
                <dd>{agent.model || 'Not configured'}</dd>
              </div>
              <div>
                <dt>Provider</dt>
                <dd>{agent.provider}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
      {agent.id === 'supervisor' && (
        <section className="team-supervisor">
          <h3>Escalation history</h3>
          <SupervisorEscalations onConversation={onConversations} onCase={onCase} />
        </section>
      )}
    </div>
  );
}
const positions = {
  openai_voice: [115, 105],
  voice_backend: [115, 280],
  inbound_triage: [350, 105],
  context_router: [350, 280],
  case_planner: [350, 430],
  payment_conversation_agent: [585, 105],
  resolution_router: [585, 280],
  supervisor: [820, 105],
  document_librarian: [820, 280],
};
function TeamMap({ data, onSelect }) {
  const [selected, setSelected] = useState('payment_conversation_agent');
  const nodes = [...data.agents, ...(data.infrastructure || []), data.coordinator];
  const edges = (data.relationships || []).filter(
    (edge) => edge.from === selected || edge.to === selected,
  );
  const current = nodes.find((a) => a.id === selected);
  return (
    <div className="team-map-view">
      <div className="team-map-intro">
        <h2>How the team works together</h2>
        <p>
          Select an agent to explore handoffs and information access. Connections show
          collaboration, not reporting lines.
        </p>
      </div>
      <div className="team-map-scroll">
        <div className="team-map-canvas">
          <div className="team-map-labels">
            <span>Voice</span>
            <span>Decision layer</span>
            <span>Conversation</span>
            <span>Specialists</span>
          </div>
          <svg viewBox="0 0 940 520" aria-hidden="true">
            <defs>
              <marker
                id="team-arrow"
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
              >
                <path d="M0,0 L7,3.5 L0,7" fill="#829a6b" />
              </marker>
            </defs>
            {edges
              .filter((e) => positions[e.from] && positions[e.to])
              .map((edge, i) => {
                const a = positions[edge.from],
                  b = positions[edge.to];
                const vertical = a[0] === b[0];
                const direction = vertical ? Math.sign(b[1] - a[1]) : Math.sign(b[0] - a[0]);
                const start = vertical
                  ? [a[0], a[1] + direction * 46]
                  : [a[0] + direction * 90, a[1]];
                const end = vertical
                  ? [b[0], b[1] - direction * 49]
                  : [b[0] - direction * 93, b[1]];
                return (
                  <path
                    key={i}
                    className={edge.kind === 'information' ? 'information' : ''}
                    d={`M ${start} C ${vertical ? `${start[0]},${(start[1] + end[1]) / 2}` : `${(start[0] + end[0]) / 2},${start[1]}`} ${vertical ? `${end[0]},${(start[1] + end[1]) / 2}` : `${(start[0] + end[0]) / 2},${end[1]}`} ${end}`}
                    markerEnd="url(#team-arrow)"
                  />
                );
              })}
          </svg>
          {data.agents.map((agent) => {
            const pos = positions[agent.id];
            if (!pos) return null;
            return (
              <button
                key={agent.id}
                className={`team-map-node ${selected === agent.id ? 'selected' : ''}`}
                style={{ left: pos[0], top: pos[1] }}
                aria-pressed={selected === agent.id}
                onClick={() => setSelected(agent.id)}
              >
                <span className="team-avatar">{agent.name[0]}</span>
                <span>
                  <strong>{agent.name}</strong>
                  <small>{agent.role}</small>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="team-map-foundations">
        <span>Shared foundations</span>
        {[data.coordinator, ...(data.infrastructure || [])].filter(Boolean).map((node) => (
          <button
            key={node.id || node.name}
            aria-pressed={selected === node.id}
            onClick={() => setSelected(node.id)}
          >
            <strong>{node.name}</strong>
            <small>{node.kind || 'Application service'}</small>
          </button>
        ))}
      </div>
      <section className="team-panel team-map-inspector">
        <div className="team-panel-heading">
          <h3>{current?.name}’s connections</h3>
          {data.agents.some((a) => a.id === selected) && (
            <button className="team-text-button" onClick={() => onSelect(selected)}>
              View agent
              <ArrowRight size={15} />
            </button>
          )}
        </div>
        <div className="team-edge-list">
          {edges.map((edge, index) => (
            <div key={index}>
              <strong>
                {nodes.find((n) => n.id === edge.from)?.name}
                <ArrowRight size={13} />
                {nodes.find((n) => n.id === edge.to)?.name}
              </strong>
              <span>{edge.label}</span>
            </div>
          ))}
        </div>
        <p className="team-note">
          Solid connections: handoffs · Dashed connections: information access. Shared service
          access is listed here to keep the map clear.
        </p>
      </section>
    </div>
  );
}
export default function AgentsOverview({ onConversations, onCase, onEmailTest }) {
  const { data, error } = useAgentData();
  const [tab, setTab] = useState('team'),
    [selected, setSelected] = useState(null);
  const agent = data?.agents.find((a) => a.id === selected);
  if (agent)
    return (
      <div className="team-page">
        <AgentDetail
          key={agent.id}
          agent={agent}
          data={data}
          onBack={() => setSelected(null)}
          onSelect={setSelected}
          onCase={onCase}
          onConversations={onConversations}
        />
      </div>
    );
  return (
    <div className="team-page">
      <div className="team-toolbar">
        <div className="team-tabs" role="tablist" aria-label="Agent views">
          <button role="tab" aria-selected={tab === 'team'} onClick={() => setTab('team')}>
            <Users size={16} />
            Team
          </button>
          <button role="tab" aria-selected={tab === 'map'} onClick={() => setTab('map')}>
            <Network size={16} />
            Team map
          </button>
        </div>
        <button className="secondary" onClick={() => onConversations()}>
          <MessageSquare size={16} />
          Conversations
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!data ? (
        <p className="team-empty">Loading agents…</p>
      ) : tab === 'map' ? (
        <TeamMap data={data} onSelect={setSelected} />
      ) : (
        <>
          <div className="team-summary">
            <div>
              <strong>{data.agents.length}</strong>
              <span>Agents</span>
            </div>
            <div>
              <strong>{data.agents.filter((a) => a.stats?.running).length}</strong>
              <span>Working now</span>
            </div>
            <div>
              <strong>{data.agents.filter((a) => !a.configured).length}</strong>
              <span>Need setup</span>
            </div>
          </div>
          <div className="team-grid">
            {data.agents.map((a) => (
              <button
                className="team-card"
                key={a.id}
                onClick={() => setSelected(a.id)}
                aria-label={`View ${a.name}`}
              >
                <div className="team-card-top">
                  <span className="team-avatar">{a.name[0]}</span>
                  <Status agent={a} enabled={data.enabled} />
                </div>
                <h2>{a.name}</h2>
                <span className="team-role">{a.role}</span>
                <p>{a.description}</p>
                <div className="team-card-bottom">
                  <span>{a.kind === 'retrieval' ? 'Deterministic' : a.execution}</span>
                  <ArrowRight size={17} />
                </div>
              </button>
            ))}
          </div>
          <div className="team-footer">
            <p>
              Availability reflects configuration, not a provider health check. Work is tracked
              where supported.
            </p>
            <button className="team-text-button" onClick={onEmailTest}>
              <Mail size={15} />
              Email test
            </button>
          </div>
        </>
      )}
    </div>
  );
}
