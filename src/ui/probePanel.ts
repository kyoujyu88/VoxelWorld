import type { CapabilityStatus } from '../xr/capabilities';
import { el } from './dom';

export interface KV {
  label: string;
  value: string;
}

/** Render a capability status card (badge + title + reasons). */
export function renderCapabilityStatus(status: CapabilityStatus): HTMLElement {
  const badge = el('span', {
    className: `badge badge-${status.level}`,
    textContent: status.level === 'ok' ? 'OK' : 'ERROR',
  });
  const title = el('h2', { className: 'status-title' }, [badge, ` ${status.title}`]);

  const list = el('ul', { className: 'reasons' });
  for (const reason of status.reasons) {
    list.append(el('li', { textContent: reason }));
  }
  return el('section', { className: 'card' }, [title, list]);
}

/** Render a simple label/value table. */
export function renderKVTable(rows: ReadonlyArray<KV>): HTMLElement {
  const table = el('table', { className: 'kv' });
  const body = el('tbody');
  for (const row of rows) {
    body.append(
      el('tr', {}, [el('th', { textContent: row.label }), el('td', { textContent: row.value })]),
    );
  }
  table.append(body);
  return table;
}
