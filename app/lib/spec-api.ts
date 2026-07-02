import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";

export type SpecFieldType =
  | "text"
  | "long_text"
  | "number"
  | "date"
  | "checkbox"
  | "single_select"
  | (string & {});

export interface SpecField {
  key: string;
  label: string;
  type: SpecFieldType;
  required: boolean;
  unique: boolean;
  options?: string[];
}

export interface SpecPageSummary {
  key: string;
  title: string;
  icon: string | null;
  entity_key: string;
}

export interface SpecView {
  kind: string;
  name: string;
  visible_fields: string[];
  sort?: { field: string; direction: "asc" | "desc" };
}

export interface SpecRecord {
  id: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SpecEntity {
  key: string;
  singular: string;
  plural: string;
  fields: SpecField[];
}

export interface SpecPageDetail {
  page: { key: string; title: string; icon: string | null };
  entity: SpecEntity;
  view: SpecView;
  records: SpecRecord[];
}

export interface PendingPlan {
  plan_id: string;
  kind: "spec_plan";
  title: string;
  impact: { entities: number; fields: number; views: number; pages: number };
  actions: string[];
  preview: {
    pageTitle: string;
    entity: {
      singular: string;
      plural: string;
      fields: { key: string; label: string; type: string }[];
    };
    view: { kind: string; name: string; visible_fields: string[] };
  };
}

export interface SpecRecordRow extends SpecRecord {
  entity_id: string;
  position: number;
}

export interface AppliedPlan {
  plan_id: string;
  status: string;
  impact: PendingPlan["impact"];
  applied_at: string;
}

export interface RejectedPlan {
  plan_id: string;
  status: string;
}

export const useSpecPages = () =>
  useQuery({
    queryKey: ["sd", "pages"],
    queryFn: () => apiGet<SpecPageSummary[]>("/api/sd/pages"),
    retry: false,
  });

export const useSpecPage = (key: string | undefined) =>
  useQuery({
    queryKey: ["sd", "page", key],
    queryFn: () => apiGet<SpecPageDetail>(`/api/sd/pages/${key}`),
    enabled: Boolean(key),
    retry: false,
  });

function requireEntityKey(entityKey: string | undefined): string {
  if (!entityKey) throw new Error("Missing data type.");
  return entityKey;
}

export const useAddSpecRecord = (entityKey: string | undefined) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiPost<SpecRecordRow>(`/api/sd/entities/${requireEntityKey(entityKey)}/records`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sd", "page"] }),
  });
};

export const useEditSpecRecord = (entityKey: string | undefined) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      apiPut<SpecRecordRow>(
        `/api/sd/entities/${requireEntityKey(entityKey)}/records/${id}`,
        data,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sd", "page"] }),
  });
};

export const useDeleteSpecRecord = (entityKey: string | undefined) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiDelete<{ id: string }>(`/api/sd/entities/${requireEntityKey(entityKey)}/records/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sd", "page"] }),
  });
};

export const applyPlan = (planId: string) =>
  apiPost<AppliedPlan>(`/api/sd/plans/${planId}/apply`, {});

export const rejectPlan = (planId: string) =>
  apiPost<RejectedPlan>(`/api/sd/plans/${planId}/reject`, {});
