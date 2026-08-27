import { el } from './dom.ts';

/**
 * The channel picker.
 *
 * One decision shapes this whole file: while the dialog is open, the list of
 * rows *is* the model. Nothing is re-rendered from an array, so nothing the
 * visitor is touching can be destroyed underneath them.
 *
 * That matters more than it sounds. The obvious implementation — keep an array
 * of slugs, rebuild the rows on every change — replaces the very button the
 * visitor just pressed. Focus falls back to `<body>`, a keyboard user loses
 * their place, and a screen reader jumps to the top of the dialog. Nothing
 * throws, so it survives review and fails only for the people least able to
 * work around it. Reordering by moving the existing row avoids the entire
 * class of problem; the one thing that must be restored by hand afterwards is
 * focus itself, because taking a node out of the document blurs it.
 *
 * The design re-sorts the list live as boxes are ticked. That is left out on
 * purpose: a list that rearranges itself while you are working down it is hard
 * to use, and the ordering controls already express the same intent.
 */

export interface Channel {
  readonly slug: string;
  readonly name: string;
  /** OKLCH hue, for the identity dot. */
  readonly hue: string;
}

interface Row {
  readonly root: HTMLLIElement;
  readonly box: HTMLInputElement;
  readonly up: HTMLButtonElement;
  readonly down: HTMLButtonElement;
  readonly slug: string;
}

/** Opens the dialog. `onDone` receives the chosen slugs, in the chosen order. */
export function openPicker(
  channels: readonly Channel[],
  chosen: readonly string[],
  onDone: (slugs: readonly string[]) => void,
): void {
  const order = [...chosen, ...channels.map((each) => each.slug).filter((slug) => !chosen.includes(slug))];
  const byslug = new Map(channels.map((each) => [each.slug, each]));

  const dialog = el('dialog');
  dialog.setAttribute('aria-label', 'Выбор каналов');

  const top = el('div', 'pick-top');
  top.append(el('h2', undefined, 'Каналы'));
  const close = el('button', 'pick-x', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Закрыть');
  top.append(close);

  const hint = el('p', 'pick-hint', 'Отмеченные каналы показываются первыми, в этом порядке');
  const list = el('ul', 'pick-list');
  const rows: Row[] = [];

  for (const slug of order) {
    const channel = byslug.get(slug);
    if (channel !== undefined) {
      rows.push(buildRow(channel, chosen.includes(slug), list));
    }
  }

  const foot = el('div', 'pick-foot');
  const count = el('span', 'pick-n');
  const done = el('button', 'pick-ok', 'Готово');
  done.type = 'button';
  foot.append(count, done);

  dialog.append(top, hint, list, foot);
  document.body.append(dialog);

  /** Neighbour in `delta` direction that is also ticked, if there is one. */
  const neighbour = (row: Row, delta: -1 | 1): Row | undefined => {
    const index = rows.indexOf(row);
    for (let step = index + delta; step >= 0 && step < rows.length; step += delta) {
      if (rows[step]!.box.checked) {
        return rows[step];
      }
    }
    return undefined;
  };

  const refresh = (): void => {
    const ticked = rows.filter((row) => row.box.checked);
    for (const row of rows) {
      row.up.hidden = !row.box.checked;
      row.down.hidden = !row.box.checked;
      row.up.disabled = neighbour(row, -1) === undefined;
      row.down.disabled = neighbour(row, 1) === undefined;
    }
    count.textContent = ticked.length === 1 ? '1 канал' : `Выбрано: ${ticked.length}`;
    // Zero channels would mean an empty page, and an empty saved list is
    // indistinguishable from never having chosen. Refuse it at the door.
    done.disabled = ticked.length === 0;
  };

  const move = (row: Row, delta: -1 | 1): void => {
    const other = neighbour(row, delta);
    if (other === undefined) {
      return;
    }
    if (delta === -1) {
      other.root.before(row.root);
    } else {
      other.root.after(row.root);
    }
    const from = rows.indexOf(row);
    rows.splice(from, 1);
    rows.splice(rows.indexOf(other) + (delta === -1 ? 0 : 1), 0, row);
    refresh();
    // Moving a node removes it from the document, which blurs it. The button
    // still exists, so putting focus back is exact rather than approximate —
    // except at the ends, where the button the visitor just pressed is now
    // disabled and `focus()` on a disabled control does nothing at all. Focus
    // then goes to the opposite arrow, which is the only move still available
    // and is where they would have to go next anyway.
    const pressed = delta === -1 ? row.up : row.down;
    (pressed.disabled ? (delta === -1 ? row.down : row.up) : pressed).focus();
  };

  for (const row of rows) {
    row.box.addEventListener('change', refresh);
    row.up.addEventListener('click', () => move(row, -1));
    row.down.addEventListener('click', () => move(row, 1));
  }

  let committed = false;
  done.addEventListener('click', () => {
    committed = true;
    dialog.close();
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (committed) {
      onDone(rows.filter((row) => row.box.checked).map((row) => row.slug));
    }
    dialog.remove();
  });

  refresh();
  dialog.showModal();
}

function buildRow(channel: Channel, ticked: boolean, list: HTMLElement): Row {
  const root = el('li', 'pick-row');
  root.style.setProperty('--h', channel.hue);

  const box = el('input');
  box.type = 'checkbox';
  box.checked = ticked;
  box.id = `pick-${channel.slug}`;

  const label = el('label', undefined, channel.name);
  label.htmlFor = box.id;

  const move = el('div', 'pick-move');
  const up = el('button', undefined, '↑');
  up.type = 'button';
  up.setAttribute('aria-label', `${channel.name} — выше`);
  const down = el('button', undefined, '↓');
  down.type = 'button';
  down.setAttribute('aria-label', `${channel.name} — ниже`);
  move.append(up, down);

  root.append(box, el('span', 'dot'), label, move);
  list.append(root);
  return { root, box, up, down, slug: channel.slug };
}
