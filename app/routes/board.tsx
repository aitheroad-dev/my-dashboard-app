import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, GripVertical, X, CalendarDays, CheckSquare } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCorners,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Route } from "./+types/board";
import {
  useCards,
  useAddCard,
  useMoveCard,
  useEditCard,
  useDeleteCard,
  useRequireEnabled,
  type Card as CardT,
  type CardStatus,
  type CardPriority,
  type CardLabel,
  type ChecklistItem,
} from "../lib/api";
import { PageHeader, Loading, ErrorState } from "../components/ui";
import { cn } from "../lib/utils";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Board — My Dashboard" }];
}

const COLUMNS: { id: CardStatus; label: string }[] = [
  { id: "todo", label: "To Do" },
  { id: "in_progress", label: "In Progress" },
  { id: "done", label: "Done" },
];
const COLUMN_IDS = COLUMNS.map((c) => c.id);

// ---- Richer-card presentation helpers ----

const PRIORITY_META: Record<CardPriority, { label: string; dot: string } | null> = {
  none: null,
  low: { label: "Low", dot: "#3b82f6" },
  medium: { label: "Medium", dot: "#f59e0b" },
  high: { label: "High", dot: "#ef4444" },
};
const PRIORITY_ORDER: CardPriority[] = ["none", "low", "medium", "high"];

// Fixed label palette; server defaults any invalid color to #64748b (slate-500).
const LABEL_COLORS = [
  "#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#64748b",
];
// Caps mirror the server bounds (store.ts parseLabels/parseChecklist).
const MAX_LABELS = 12;
const MAX_CHECKLIST = 50;

/** Local YYYY-MM-DD (not UTC) so "today" matches the user's calendar. */
function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Format YYYY-MM-DD as "Jul 5" without a timezone shift (parse the parts). */
function formatDue(due: string): string {
  const [y, m, d] = due.split("-").map(Number);
  if (!y || !m || !d) return due;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Due-date chip styling: overdue → red, today → amber, else neutral. */
function dueMeta(due: string | null): { label: string; cls: string } | null {
  if (!due) return null;
  const today = todayStr();
  if (due < today) return { label: formatDue(due), cls: "bg-red-100 text-red-700" };
  if (due === today) return { label: "Today", cls: "bg-amber-100 text-amber-700" };
  return { label: formatDue(due), cls: "bg-slate-100 text-slate-600" };
}

type ItemsByColumn = Record<CardStatus, string[]>;

function groupIds(cards: CardT[]): ItemsByColumn {
  const by: ItemsByColumn = { todo: [], in_progress: [], done: [] };
  for (const c of cards) by[c.status].push(c.id);
  return by;
}

/** Position strictly between two neighbours (or one step past an edge). */
function between(prev: number | null, next: number | null): number {
  if (prev == null && next == null) return 1000;
  if (prev == null) return (next as number) - 1000;
  if (next == null) return prev + 1000;
  return (prev + next) / 2;
}

/**
 * Nearest KNOWN neighbour position scanning outward from `index` in `dir`, skipping
 * the active card. A neighbour momentarily absent from the cache can't collapse the
 * gap to null (which would push the dropped card outside its visual slot) — keep
 * scanning until a card with a real position is found. (Forge audit #1.)
 */
function neighbourPos(
  order: string[],
  index: number,
  dir: 1 | -1,
  cardsById: Map<string, CardT>,
  activeId: string,
): number | null {
  for (let i = index + dir; i >= 0 && i < order.length; i += dir) {
    const id = order[i];
    if (id === activeId) continue;
    const pos = cardsById.get(id)?.position;
    if (typeof pos === "number") return pos;
  }
  return null;
}

export default function Board() {
  useRequireEnabled("board");
  const cards = useCards();
  const addCard = useAddCard();
  const moveCard = useMoveCard();

  const cardsById = useMemo(() => {
    const m = new Map<string, CardT>();
    for (const c of cards.data ?? []) m.set(c.id, c);
    return m;
  }, [cards.data]);

  // Local ordered ids per column. Synced from the server whenever data changes and
  // no drag is in flight; mutated locally during a drag for live cross-column preview.
  const [items, setItems] = useState<ItemsByColumn>({ todo: [], in_progress: [], done: [] });
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const origin = useRef<{ status: CardStatus; index: number } | null>(null);
  // The element that opened the modal — focus returns here on close (a11y). (Forge MED-3.)
  const openerRef = useRef<HTMLElement | null>(null);

  function openCardModal(id: string) {
    openerRef.current = (document.activeElement as HTMLElement) ?? null;
    setOpenId(id);
  }
  function closeCardModal() {
    setOpenId(null);
    openerRef.current?.focus?.();
  }

  useEffect(() => {
    if (activeId != null) return; // don't clobber an in-progress drag
    setItems(groupIds(cards.data ?? []));
  }, [cards.data, activeId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function findContainer(id: UniqueIdentifier): CardStatus | null {
    // Card membership first (Forge audit #5) — a card whose id equals a column key
    // can't be misrouted to the column.
    const inColumn = COLUMN_IDS.find((col) => items[col].includes(id as string));
    if (inColumn) return inColumn;
    if (COLUMN_IDS.includes(id as CardStatus)) return id as CardStatus;
    return null;
  }

  function onDragStart(e: DragStartEvent) {
    const status = findContainer(e.active.id);
    if (!status) return;
    origin.current = { status, index: items[status].indexOf(e.active.id as string) };
    setActiveId(e.active.id);
  }

  function onDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over) return;
    const from = findContainer(active.id);
    const to = findContainer(over.id);
    if (!from || !to || from === to) return;
    setItems((prev) => {
      const activeIds = prev[from];
      const overIds = prev[to];
      const activeIndex = activeIds.indexOf(active.id as string);
      if (activeIndex < 0) return prev;
      // Insert before the card we're over, or at the end when over the column itself.
      const overIndex = overIds.indexOf(over.id as string);
      const insertAt = overIndex >= 0 ? overIndex : overIds.length;
      return {
        ...prev,
        [from]: activeIds.filter((id) => id !== active.id),
        [to]: [...overIds.slice(0, insertAt), active.id as string, ...overIds.slice(insertAt)],
      };
    });
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    const start = origin.current;
    origin.current = null;
    setActiveId(null);
    if (!over || !start) return;

    const to = findContainer(over.id);
    if (!to) return;

    // Reorder within the destination column so the dropped card lands at the over target.
    let column = items[to];
    const activeIndex = column.indexOf(active.id as string);
    const overIndex = column.indexOf(over.id as string);
    if (activeIndex >= 0 && overIndex >= 0 && activeIndex !== overIndex) {
      column = arrayMove(column, activeIndex, overIndex);
      setItems((prev) => ({ ...prev, [to]: column }));
    }

    const finalIndex = column.indexOf(active.id as string);
    if (to === start.status && finalIndex === start.index) return; // no-op drop

    const position = between(
      neighbourPos(column, finalIndex, -1, cardsById, active.id as string),
      neighbourPos(column, finalIndex, 1, cardsById, active.id as string),
    );
    moveCard.mutate({ id: active.id as string, status: to, position });
  }

  const activeCard = activeId ? cardsById.get(activeId as string) ?? null : null;
  const openCard = openId ? cardsById.get(openId) ?? null : null;

  return (
    <div>
      {/* Background is inert while the modal is open — Tab can't reach board controls
          behind the overlay and Enter/Space can't activate them. (Forge MED-3.) */}
      <div inert={openCard ? true : undefined}>
      <PageHeader
        title="Board"
        subtitle="Your tasks. Drag a card across the columns as it moves — or ask the Assistant to. Click a card to add a due date, priority, labels, and a checklist."
      />

      {cards.isLoading ? (
        <Loading />
      ) : cards.error ? (
        <ErrorState message={(cards.error as Error).message} />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={() => {
            origin.current = null;
            setActiveId(null);
            setItems(groupIds(cards.data ?? []));
          }}
        >
          <div className="grid gap-4 md:grid-cols-3">
            {COLUMNS.map((col) => (
              <Column
                key={col.id}
                status={col.id}
                label={col.label}
                cardIds={items[col.id]}
                cardsById={cardsById}
                onOpenCard={openCardModal}
                onAdd={(title) => addCard.mutate({ title, status: col.id })}
                adding={addCard.isPending}
              />
            ))}
          </div>

          <DragOverlay>
            {activeCard ? <CardView card={activeCard} overlay /> : null}
          </DragOverlay>
        </DndContext>
      )}
      </div>

      {openCard && <CardDetailModal card={openCard} onClose={closeCardModal} />}
    </div>
  );
}

function Column({
  status,
  label,
  cardIds,
  cardsById,
  onOpenCard,
  onAdd,
  adding,
}: {
  status: CardStatus;
  label: string;
  cardIds: string[];
  cardsById: Map<string, CardT>;
  onOpenCard: (id: string) => void;
  onAdd: (title: string) => void;
  adding: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const cards = cardIds.map((id) => cardsById.get(id)).filter(Boolean) as CardT[];

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex flex-col rounded-2xl border bg-slate-50/70 p-3 transition-colors",
        isOver ? "border-slate-400 bg-slate-100" : "border-slate-200",
      )}
    >
      <div className="mb-3 flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold text-slate-700">{label}</h2>
        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600">
          {cards.length}
        </span>
      </div>

      <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
        <div className="flex min-h-[8px] flex-col gap-2">
          {cards.map((card) => (
            <SortableCard key={card.id} card={card} onOpen={() => onOpenCard(card.id)} />
          ))}
          {cards.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-400">
              Drop a card here
            </div>
          )}
        </div>
      </SortableContext>

      <AddCard onAdd={onAdd} adding={adding} />
    </div>
  );
}

function SortableCard({ card, onOpen }: { card: CardT; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div ref={setNodeRef} style={style} className={cn(isDragging && "opacity-40")}>
      <CardView card={card} dragProps={{ ...attributes, ...listeners }} onOpen={onOpen} />
    </div>
  );
}

/** Chip row on the card face — renders only the chips that actually exist (ISC-83.8). */
function CardChips({ card }: { card: CardT }) {
  const due = dueMeta(card.due_date);
  const prio = PRIORITY_META[card.priority];
  const labels = card.labels ?? [];
  const shownLabels = labels.slice(0, 3);
  const overflow = labels.length - shownLabels.length;
  const total = card.checklist?.length ?? 0;
  const done = card.checklist?.filter((i) => i.done).length ?? 0;

  if (!due && !prio && labels.length === 0 && total === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {due && (
        <span
          aria-label={`Due ${due.label}`}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
            due.cls,
          )}
        >
          <CalendarDays className="h-3 w-3" />
          {due.label}
        </span>
      )}
      {prio && (
        <span
          aria-label={`Priority ${prio.label}`}
          className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600"
        >
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: prio.dot }} />
          {prio.label}
        </span>
      )}
      {shownLabels.map((l, i) => (
        <span
          key={i}
          className="inline-flex max-w-[10rem] items-center truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium text-white"
          style={{ backgroundColor: l.color }}
        >
          {l.name}
        </span>
      ))}
      {overflow > 0 && (
        <span className="inline-flex items-center rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
          +{overflow}
        </span>
      )}
      {total > 0 && (
        <span
          aria-label={`Checklist ${done} of ${total} done`}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
            done === total ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600",
          )}
        >
          <CheckSquare className="h-3 w-3" />
          {done}/{total}
        </span>
      )}
    </div>
  );
}

function CardView({
  card,
  dragProps,
  onOpen,
  overlay,
}: {
  card: CardT;
  dragProps?: Record<string, unknown>;
  onOpen?: () => void;
  overlay?: boolean;
}) {
  const del = useDeleteCard();
  return (
    <div
      className={cn(
        "group flex items-start gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm",
        overlay ? "shadow-lg ring-1 ring-slate-900/5" : "hover:border-slate-300",
      )}
    >
      <button
        type="button"
        aria-label="Drag card"
        {...(dragProps ?? {})}
        className="mt-0.5 cursor-grab touch-none text-slate-300 hover:text-slate-500 active:cursor-grabbing"
        onClick={(e) => e.preventDefault()}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <div
        role={onOpen ? "button" : undefined}
        tabIndex={onOpen ? 0 : undefined}
        onClick={onOpen}
        onKeyDown={
          onOpen
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen();
                }
              }
            : undefined
        }
        className={cn("min-w-0 flex-1 text-left", onOpen && "cursor-pointer")}
      >
        <div className="text-sm font-medium text-slate-900">{card.title}</div>
        {card.notes && (
          <div className="mt-0.5 line-clamp-2 text-xs text-slate-500">{card.notes}</div>
        )}
        {!overlay && <CardChips card={card} />}
      </div>

      {!overlay && (
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            aria-label="Delete card"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => del.mutate(card.id)}
            className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

/** Full-field editor. Every field is local state until Save, which persists them all
 * in one `editCard` PUT (one audit row). Cancel/ESC/backdrop discard. */
function CardDetailModal({ card, onClose }: { card: CardT; onClose: () => void }) {
  const edit = useEditCard();
  const del = useDeleteCard();

  const [title, setTitle] = useState(card.title);
  const [notes, setNotes] = useState(card.notes ?? "");
  const [due, setDue] = useState(card.due_date ?? "");
  const [priority, setPriority] = useState<CardPriority>(card.priority);
  const [labels, setLabels] = useState<CardLabel[]>(card.labels ?? []);
  const [checklist, setChecklist] = useState<ChecklistItem[]>(card.checklist ?? []);

  const [labelName, setLabelName] = useState("");
  const [labelColor, setLabelColor] = useState(LABEL_COLORS[0]);
  const [itemText, setItemText] = useState("");
  // Backdrop closes only when BOTH pointerdown and click land on the backdrop —
  // a text-selection drag that releases over the backdrop won't discard edits. (Forge LOW-1.)
  const backdropDown = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const doneCount = checklist.filter((i) => i.done).length;

  function addLabel() {
    if (labels.length >= MAX_LABELS) return; // at cap — don't slice off the new one (Forge MED-2)
    const name = labelName.trim().slice(0, 40);
    if (!name) return;
    setLabels((ls) => [...ls, { name, color: labelColor }]);
    setLabelName("");
  }
  function addItem() {
    if (checklist.length >= MAX_CHECKLIST) return; // at cap — don't drop the new one (Forge MED-2)
    const text = itemText.trim().slice(0, 200);
    if (!text) return;
    setChecklist((c) => [...c, { text, done: false }]);
    setItemText("");
  }
  function save() {
    const t = title.trim();
    if (!t) return;
    const nextNotes = notes.trim() || null;
    const nextDue = due || null;
    // Send ONLY the fields that changed vs the card as opened. editCard treats an
    // omitted field as "keep current", so a title-only edit can't revert a label/due
    // change made concurrently (e.g. by the Assistant, which drives this same board) —
    // fixes last-write-wins clobber. An empty patch = nothing changed → no PUT, no
    // audit row. (Forge MED-1 + advisor no-op guard.)
    const patch: {
      title?: string;
      notes?: string | null;
      due_date?: string | null;
      priority?: CardPriority;
      labels?: CardLabel[];
      checklist?: ChecklistItem[];
    } = {};
    if (t !== card.title) patch.title = t;
    if (nextNotes !== (card.notes ?? null)) patch.notes = nextNotes;
    if (nextDue !== (card.due_date ?? null)) patch.due_date = nextDue;
    if (priority !== card.priority) patch.priority = priority;
    if (JSON.stringify(labels) !== JSON.stringify(card.labels ?? [])) patch.labels = labels;
    if (JSON.stringify(checklist) !== JSON.stringify(card.checklist ?? []))
      patch.checklist = checklist;
    if (Object.keys(patch).length === 0) return onClose();
    edit.mutate({ id: card.id, ...patch }, { onSuccess: onClose });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:items-center"
      onMouseDown={(e) => {
        backdropDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropDown.current) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Card details"
        className="my-8 w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-500">Card details</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Title */}
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Card title"
          aria-label="Card title"
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-medium focus:border-slate-500 focus:outline-none"
        />

        {/* Description */}
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Description (optional)"
          aria-label="Card description"
          rows={3}
          className="mt-3 w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />

        {/* Due date + Priority */}
        <div className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">Due date</label>
            <input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              aria-label="Due date"
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">Priority</label>
            <div className="flex gap-1">
              {PRIORITY_ORDER.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  aria-pressed={priority === p}
                  className={cn(
                    "flex-1 rounded-md border px-1.5 py-1 text-xs font-medium capitalize",
                    priority === p
                      ? "border-slate-800 bg-slate-800 text-white"
                      : "border-slate-200 text-slate-600 hover:bg-slate-50",
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Labels */}
        <div className="mt-4">
          <label className="mb-1 block text-xs font-semibold text-slate-700">Labels</label>
          {labels.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {labels.map((l, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-white"
                  style={{ backgroundColor: l.color }}
                >
                  {l.name}
                  <button
                    type="button"
                    aria-label={`Remove label ${l.name}`}
                    onClick={() => setLabels(labels.filter((_, j) => j !== i))}
                    className="opacity-80 hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              value={labelName}
              onChange={(e) => setLabelName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addLabel();
                }
              }}
              placeholder="Add a label"
              aria-label="New label name"
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-slate-500 focus:outline-none"
            />
            <div className="flex items-center gap-1">
              {LABEL_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Label color ${c}`}
                  onClick={() => setLabelColor(c)}
                  className={cn(
                    "h-5 w-5 rounded-full ring-2 ring-offset-1",
                    labelColor === c ? "ring-slate-800" : "ring-transparent",
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={addLabel}
              disabled={!labelName.trim() || labels.length >= MAX_LABELS}
              className="rounded-md bg-slate-900 px-2.5 py-1 text-sm font-medium text-white hover:bg-slate-700 disabled:bg-slate-300"
            >
              Add
            </button>
          </div>
        </div>

        {/* Checklist */}
        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs font-semibold text-slate-700">Checklist</label>
            {checklist.length > 0 && (
              <span className="text-xs text-slate-500">
                {doneCount}/{checklist.length}
              </span>
            )}
          </div>
          {checklist.length > 0 && (
            <div className="mb-2 flex flex-col gap-1.5">
              {checklist.map((it, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={it.done}
                    aria-label={`Mark "${it.text}" done`}
                    onChange={(e) =>
                      setChecklist(
                        checklist.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)),
                      )
                    }
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  <input
                    value={it.text}
                    aria-label={`Checklist item ${i + 1}`}
                    onChange={(e) =>
                      setChecklist(
                        checklist.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                      )
                    }
                    className={cn(
                      "min-w-0 flex-1 rounded border border-transparent px-1 py-0.5 text-sm hover:border-slate-200 focus:border-slate-400 focus:outline-none",
                      it.done && "text-slate-400 line-through",
                    )}
                  />
                  <button
                    type="button"
                    aria-label="Remove item"
                    onClick={() => setChecklist(checklist.filter((_, j) => j !== i))}
                    className="text-slate-400 hover:text-red-600"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              value={itemText}
              onChange={(e) => setItemText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addItem();
                }
              }}
              placeholder="Add a checklist item"
              aria-label="New checklist item"
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-slate-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={addItem}
              disabled={!itemText.trim() || checklist.length >= MAX_CHECKLIST}
              className="rounded-md bg-slate-900 px-2.5 py-1 text-sm font-medium text-white hover:bg-slate-700 disabled:bg-slate-300"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Save failed → keep the modal open, keep the user's edits, tell them. (Advisor gap.) */}
        {edit.isError && (
          <p className="mt-3 text-xs text-red-600" role="alert">
            Couldn&apos;t save: {(edit.error as Error)?.message ?? "unknown error"}. Your
            changes are still here — try again.
          </p>
        )}

        {/* Footer */}
        <div className="mt-5 flex items-center gap-2 border-t border-slate-100 pt-4">
          <button
            type="button"
            onClick={() => del.mutate(card.id, { onSuccess: onClose })}
            className="mr-auto rounded-lg px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={edit.isPending || !title.trim()}
            className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:bg-slate-300"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function AddCard({ onAdd, adding }: { onAdd: (title: string) => void; adding: boolean }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");

  function submit() {
    const t = title.trim();
    if (!t) return;
    onAdd(t);
    setTitle("");
    // keep the composer open for rapid entry
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-800"
      >
        <Plus className="h-4 w-4" />
        Add a card
      </button>
    );
  }

  return (
    <div className="mt-2">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") {
            setTitle("");
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (!title.trim()) setOpen(false);
        }}
        placeholder="What needs doing?"
        aria-label="New card title"
        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={adding || !title.trim()}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:bg-slate-300"
        >
          Add
        </button>
        <button
          type="button"
          onClick={() => {
            setTitle("");
            setOpen(false);
          }}
          className="text-sm text-slate-500 hover:text-slate-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
