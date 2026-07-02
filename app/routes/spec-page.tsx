import { useRef, useState } from "react";
import { Plus, Table } from "lucide-react";
import { useParams } from "react-router";
import type { Route } from "./+types/spec-page";
import { ApiError } from "../lib/api";
import {
  useAddSpecRecord,
  useDeleteSpecRecord,
  useEditSpecRecord,
  useSpecPage,
  type SpecRecord,
} from "../lib/spec-api";
import { DetailView, renderView } from "../components/views";
import { Button, Card, EmptyState, ErrorState, Loading, PageHeader } from "../components/ui";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Page — My Dashboard" }];
}

export default function SpecPage() {
  const { pageKey } = useParams();
  const { data, isLoading, error } = useSpecPage(pageKey);
  const addRecord = useAddSpecRecord(data?.entity.key);
  const editRecord = useEditSpecRecord(data?.entity.key);
  const deleteRecord = useDeleteSpecRecord(data?.entity.key);
  const [openRecord, setOpenRecord] = useState<SpecRecord | null | undefined>(undefined);
  const openerRef = useRef<HTMLElement | null>(null);

  function openDetail(record: SpecRecord | null) {
    openerRef.current = (document.activeElement as HTMLElement) ?? null;
    setOpenRecord(record);
  }

  function closeDetail() {
    setOpenRecord(undefined);
    openerRef.current?.focus?.();
  }

  async function saveRecord(values: Record<string, unknown>) {
    if (!data) return;
    if (openRecord) {
      await editRecord.mutateAsync({ id: openRecord.id, data: values });
    } else {
      await addRecord.mutateAsync(values);
    }
    closeDetail();
  }

  async function removeRecord() {
    if (!openRecord) return;
    await deleteRecord.mutateAsync(openRecord.id);
    closeDetail();
  }

  if (isLoading) return <Loading />;

  if (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      return (
        <EmptyState
          icon={Table}
          title="This page isn't available"
          message="It may not exist, or you may not have access to it."
        />
      );
    }
    return <ErrorState message={(error as Error).message} />;
  }

  if (!data) {
    return <Card className="text-sm text-slate-500">This page isn't available.</Card>;
  }

  const title = data.page.icon ? `${data.page.icon} ${data.page.title}` : data.page.title;

  return (
    <div>
      <div inert={openRecord !== undefined ? true : undefined}>
        <PageHeader
          title={title}
          subtitle={data.entity.plural}
          action={
            <Button type="button" onClick={() => openDetail(null)}>
              <Plus className="h-4 w-4" />
              Add record
            </Button>
          }
        />

        {renderView({
          entity: data.entity,
          view: data.view,
          records: data.records,
          onOpen: openDetail,
        })}
      </div>

      {openRecord !== undefined && (
        <DetailView
          entity={data.entity}
          record={openRecord}
          onSave={saveRecord}
          onDelete={openRecord ? removeRecord : undefined}
          onClose={closeDetail}
        />
      )}
    </div>
  );
}
