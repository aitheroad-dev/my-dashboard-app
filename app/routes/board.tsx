import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, Pencil, GripVertical, X, Check } from "lucide-react";
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
  const origin = useRef<{ status: CardStatus; index: number } | null>(null);

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

  return (
    <div>
      <PageHeader
        title="Board"
        subtitle="Your tasks. Drag a card across the columns as it moves — or ask the Assistant to."
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
  );
}

function Column({
  status,
  label,
  cardIds,
  cardsById,
  onAdd,
  adding,
}: {
  status: CardStatus;
  label: string;
  cardIds: string[];
  cardsById: Map<string, CardT>;
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
            <SortableCard key={card.id} card={card} />
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

function SortableCard({ card }: { card: CardT }) {
  const [editing, setEditing] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    disabled: editing,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const dragProps = editing ? {} : { ...attributes, ...listeners };

  return (
    <div ref={setNodeRef} style={style} className={cn(isDragging && "opacity-40")}>
      {editing ? (
        <CardEditor card={card} onDone={() => setEditing(false)} />
      ) : (
        <CardView card={card} dragProps={dragProps} onEdit={() => setEditing(true)} />
      )}
    </div>
  );
}

function CardView({
  card,
  dragProps,
  onEdit,
  overlay,
}: {
  card: CardT;
  dragProps?: Record<string, unknown>;
  onEdit?: () => void;
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

      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-900">{card.title}</div>
        {card.notes && <div className="mt-0.5 text-xs text-slate-500">{card.notes}</div>}
      </div>

      {!overlay && (
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            aria-label="Edit card"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onEdit}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
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

function CardEditor({ card, onDone }: { card: CardT; onDone: () => void }) {
  const edit = useEditCard();
  const [title, setTitle] = useState(card.title);
  const [notes, setNotes] = useState(card.notes ?? "");

  function save() {
    const t = title.trim();
    if (!t) return onDone();
    edit.mutate(
      { id: card.id, title: t, notes: notes.trim() || null },
      { onSuccess: onDone },
    );
  }

  return (
    <div className="rounded-xl border border-slate-300 bg-white p-3 shadow-sm">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") onDone();
        }}
        placeholder="Card title"
        aria-label="Card title"
        className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-slate-500 focus:outline-none"
      />
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone();
        }}
        placeholder="Notes (optional)"
        aria-label="Card notes"
        rows={2}
        className="mt-2 w-full resize-none rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-slate-500 focus:outline-none"
      />
      <div className="mt-2 flex justify-end gap-1">
        <button
          type="button"
          onClick={onDone}
          aria-label="Cancel"
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={save}
          disabled={edit.isPending}
          aria-label="Save"
          className="rounded p-1 text-emerald-600 hover:bg-emerald-50 disabled:opacity-40"
        >
          <Check className="h-4 w-4" />
        </button>
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
