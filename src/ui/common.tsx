import { useState, type ReactNode } from 'react';
import { cls } from './format';
import { Icon } from './icons';

/** Hover tooltip wrapper (pure CSS positioning, no portals). */
export function Tip({ tip, children, wide }: { tip: ReactNode; children: ReactNode; wide?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <span className="tipwrap" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && tip ? <span className={cls('tip', wide && 'wide')}>{tip}</span> : null}
    </span>
  );
}

export function Bar({ value, color, h = 6, title }: { value: number; color?: string; h?: number; title?: string }) {
  const v = Math.max(0, Math.min(1, value));
  const c = color ?? (v > 0.66 ? 'var(--good)' : v > 0.33 ? 'var(--warn)' : 'var(--bad)');
  return (
    <div className="bar" style={{ height: h }} title={title}>
      <div style={{ width: `${v * 100}%`, background: c }} />
    </div>
  );
}

export function Section({ title, children, right, icon }: { title: ReactNode; children: ReactNode; right?: ReactNode; icon?: string }) {
  return (
    <div className="section">
      <div className="section-h">{icon && <Icon name={icon} size={14} />}<span>{title}</span><div style={{ flex: 1 }} />{right}</div>
      {children}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs">
      {tabs.map(([k, l]) => <button key={k} className={cls('tab', value === k && 'on')} onClick={() => onChange(k)}>{l}</button>)}
    </div>
  );
}

export function Btn({ children, onClick, disabled, kind, title, small }: { children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: 'primary' | 'danger' | 'ghost'; title?: string; small?: boolean }) {
  return <button className={cls('btn', kind, small && 'small')} onClick={onClick} disabled={disabled} title={title}>{children}</button>;
}

export function Stat({ label, value, tip, tone }: { label: string; value: ReactNode; tip?: ReactNode; tone?: 'good' | 'bad' | 'warn' }) {
  const inner = <div className="stat"><span>{label}</span><b className={tone}>{value}</b></div>;
  return tip ? <Tip tip={tip}>{inner}</Tip> : inner;
}

export function Modal({ title, onClose, children, wide, className }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={cls('modal', wide && 'wide', className)}>
        <div className="modal-h"><span>{title}</span><button className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="close" /></button></div>
        <div className="modal-b">{children}</div>
      </div>
    </div>
  );
}
