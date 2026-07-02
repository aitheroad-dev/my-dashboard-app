import { z } from "zod";

export const CURRENT_SPEC_VERSION = 1;
export const MAX_SPEC_BYTES = 64 * 1024;
export const MAX_FIELDS_PER_ENTITY = 50;
export const MAX_VIEWS_PER_PAGE = 10;
export const MAX_VISIBLE_FIELDS_PER_VIEW = 30;
export const MAX_SINGLE_SELECT_OPTIONS = 50;
export const MAX_PLAN_ACTIONS = 40;

export const ACTIVE_FIELD_TYPES = ["text", "long_text", "number", "date", "checkbox", "single_select"] as const;
export const INERT_FIELD_TYPES = ["relation", "lookup", "rollup"] as const;
export const FIELD_TYPES = [...ACTIVE_FIELD_TYPES, ...INERT_FIELD_TYPES] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type ActiveFieldType = (typeof ACTIVE_FIELD_TYPES)[number];

export const ACTIVE_VIEW_KINDS = ["list", "detail"] as const;
export const INERT_VIEW_KINDS = ["board", "calendar", "gallery"] as const;
export const VIEW_KINDS = [...ACTIVE_VIEW_KINDS, ...INERT_VIEW_KINDS] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

const KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;
const keySchema = z.string().trim().regex(KEY_RE, "must start with a lowercase letter and contain only lowercase letters, numbers, or underscores");
const labelSchema = z.string().trim().min(1, "is required").max(120, "too long (max 120 characters)");
const iconSchema = z.string().trim().max(48, "too long (max 48 characters)").optional();

const SingleSelectConfigSchema = z.strictObject({
  options: z.array(z.string().trim().min(1, "option cannot be empty").max(120, "option too long (max 120 characters)"))
    .max(MAX_SINGLE_SELECT_OPTIONS, `over cap: single_select options max ${MAX_SINGLE_SELECT_OPTIONS}`),
});

const FieldConfigSchema = z.union([
  SingleSelectConfigSchema,
  z.record(z.string(), z.never()),
]).optional();

export const FieldSpecSchema = z.strictObject({
  specVersion: z.number().int().catch(CURRENT_SPEC_VERSION).default(CURRENT_SPEC_VERSION),
  key: keySchema,
  label: labelSchema,
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(false),
  unique: z.boolean().default(false),
  config: FieldConfigSchema,
});
export type FieldSpec = z.infer<typeof FieldSpecSchema>;

export const EntitySpecSchema = z.strictObject({
  specVersion: z.number().int().catch(CURRENT_SPEC_VERSION).default(CURRENT_SPEC_VERSION),
  key: keySchema,
  singular: labelSchema,
  plural: labelSchema,
  icon: iconSchema,
  fields: z.array(FieldSpecSchema)
    .max(MAX_FIELDS_PER_ENTITY, `over cap: fields per entity max ${MAX_FIELDS_PER_ENTITY}`),
});
export type EntitySpec = z.infer<typeof EntitySpecSchema>;

const FilterValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const FilterOpSchema = z.enum(["eq", "neq", "contains", "gt", "gte", "lt", "lte", "is_empty", "is_not_empty"]);
export type FilterOp = z.infer<typeof FilterOpSchema>;

export const FilterSpecSchema = z.strictObject({
  field: keySchema,
  op: FilterOpSchema,
  value: FilterValueSchema.optional(),
});
export type FilterSpec = z.infer<typeof FilterSpecSchema>;

export const SortSpecSchema = z.strictObject({
  field: keySchema,
  direction: z.enum(["asc", "desc"]).default("asc"),
});
export type SortSpec = z.infer<typeof SortSpecSchema>;

export const ViewSpecSchema = z.strictObject({
  specVersion: z.number().int().catch(CURRENT_SPEC_VERSION).default(CURRENT_SPEC_VERSION),
  key: keySchema,
  kind: z.enum(VIEW_KINDS),
  name: labelSchema,
  config: z.strictObject({
    visible_fields: z.array(keySchema)
      .max(MAX_VISIBLE_FIELDS_PER_VIEW, `over cap: visible fields per view max ${MAX_VISIBLE_FIELDS_PER_VIEW}`),
    sort: SortSpecSchema.optional(),
    filter: FilterSpecSchema.optional(),
  }),
});
export type ViewSpec = z.infer<typeof ViewSpecSchema>;

export const ViewRefSchema = z.strictObject({
  entity_key: keySchema,
  view_key: keySchema,
});
export type ViewRef = z.infer<typeof ViewRefSchema>;

export const PageSpecSchema = z.strictObject({
  specVersion: z.number().int().catch(CURRENT_SPEC_VERSION).default(CURRENT_SPEC_VERSION),
  key: keySchema,
  title: labelSchema,
  icon: iconSchema,
  views: z.array(ViewRefSchema)
    .max(MAX_VIEWS_PER_PAGE, `over cap: views per page max ${MAX_VIEWS_PER_PAGE}`),
});
export type PageSpec = z.infer<typeof PageSpecSchema>;

export const AddEntityActionSchema = z.strictObject({
  type: z.literal("add_entity"),
  additive: z.literal(true),
  entity: EntitySpecSchema,
});
export const AddFieldActionSchema = z.strictObject({
  type: z.literal("add_field"),
  additive: z.literal(true),
  entity_key: keySchema,
  field: FieldSpecSchema,
});
export const AddViewActionSchema = z.strictObject({
  type: z.literal("add_view"),
  additive: z.literal(true),
  entity_key: keySchema,
  view: ViewSpecSchema,
});
export const AddPageActionSchema = z.strictObject({
  type: z.literal("add_page"),
  additive: z.literal(true),
  page: PageSpecSchema,
});

export const ChangeActionSchema = z.discriminatedUnion("type", [
  AddEntityActionSchema,
  AddFieldActionSchema,
  AddViewActionSchema,
  AddPageActionSchema,
]);
export type ChangeAction = z.infer<typeof ChangeActionSchema>;

export const PlanSchema = z.strictObject({
  specVersion: z.number().int().catch(CURRENT_SPEC_VERSION).default(CURRENT_SPEC_VERSION),
  actions: z.array(ChangeActionSchema)
    .max(MAX_PLAN_ACTIONS, `over cap: actions per plan max ${MAX_PLAN_ACTIONS}`),
});
export type Plan = z.infer<typeof PlanSchema>;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export function migrateSpec(raw: unknown): unknown {
  const obj = cloneRecord(raw);
  obj.specVersion = CURRENT_SPEC_VERSION;
  if (Array.isArray(obj.actions)) {
    obj.actions = obj.actions.map((action) => {
      const next = cloneRecord(action);
      if (isRecord(next.entity)) next.entity = stampSpec(next.entity);
      if (isRecord(next.field)) next.field = stampSpec(next.field);
      if (isRecord(next.view)) next.view = stampSpec(next.view);
      if (isRecord(next.page)) next.page = stampSpec(next.page);
      return next;
    });
  }
  return obj;
}

export function validateSpec(instance: unknown): ValidationResult<Plan> {
  const capError = jsonSizeError(instance);
  if (capError) return { ok: false, errors: [capError] };

  const first = PlanSchema.safeParse(migrateSpec(instance));
  if (!first.success) {
    const repaired = repairSpecShape(migrateSpec(instance));
    const retried = PlanSchema.safeParse(repaired);
    if (!retried.success) {
      return { ok: false, errors: zodErrors(first.error) };
    }
    return validatePlanSemantics(retried.data);
  }
  return validatePlanSemantics(first.data);
}

export function isActiveFieldType(type: string): type is ActiveFieldType {
  return (ACTIVE_FIELD_TYPES as readonly string[]).includes(type);
}

function validatePlanSemantics(plan: Plan): ValidationResult<Plan> {
  const errors: string[] = [];
  if (plan.actions.length > MAX_PLAN_ACTIONS) {
    errors.push(`over cap: actions per plan max ${MAX_PLAN_ACTIONS}`);
  }

  const addedEntities = new Map<string, EntitySpec>();
  const addedFields = new Map<string, Set<string>>();
  const addedViews = new Map<string, Set<string>>();
  const addedPages = new Set<string>();

  for (const [actionIndex, action] of plan.actions.entries()) {
    if (action.type === "add_entity") {
      validateEntity(action.entity, `actions.${actionIndex}.entity`, errors);
      if (addedEntities.has(action.entity.key)) errors.push(`actions.${actionIndex}.entity.key duplicate entity key "${action.entity.key}"`);
      addedEntities.set(action.entity.key, action.entity);
      addedFields.set(action.entity.key, new Set(action.entity.fields.map((field) => field.key)));
    }
    if (action.type === "add_field") {
      validateField(action.field, `actions.${actionIndex}.field`, errors);
      const keys = addedFields.get(action.entity_key) ?? new Set<string>();
      if (keys.has(action.field.key)) errors.push(`actions.${actionIndex}.field.key duplicate field key "${action.field.key}" for entity "${action.entity_key}"`);
      keys.add(action.field.key);
      addedFields.set(action.entity_key, keys);
    }
    if (action.type === "add_view") {
      validateView(action.view, action.entity_key, addedFields.get(action.entity_key) ?? new Set<string>(), `actions.${actionIndex}.view`, errors);
      const keys = addedViews.get(action.entity_key) ?? new Set<string>();
      if (keys.has(action.view.key)) errors.push(`actions.${actionIndex}.view.key duplicate view key "${action.view.key}" for entity "${action.entity_key}"`);
      keys.add(action.view.key);
      addedViews.set(action.entity_key, keys);
    }
    if (action.type === "add_page") {
      validatePage(action.page, addedViews, `actions.${actionIndex}.page`, errors);
      if (addedPages.has(action.page.key)) errors.push(`actions.${actionIndex}.page.key duplicate page key "${action.page.key}"`);
      addedPages.add(action.page.key);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: plan };
}

function validateEntity(entity: EntitySpec, path: string, errors: string[]): void {
  if (entity.fields.length > MAX_FIELDS_PER_ENTITY) errors.push(`${path}.fields over cap: max ${MAX_FIELDS_PER_ENTITY}`);
  const fieldKeys = new Set<string>();
  for (const [index, field] of entity.fields.entries()) {
    validateField(field, `${path}.fields.${index}`, errors);
    if (fieldKeys.has(field.key)) errors.push(`${path}.fields.${index}.key duplicate field key "${field.key}"`);
    fieldKeys.add(field.key);
  }
}

function validateField(field: FieldSpec, path: string, errors: string[]): void {
  if (!isActiveFieldType(field.type)) errors.push(`${path}.type "${field.type}" is declared but inert in S1`);
  if (field.type === "single_select") {
    const options = readOptions(field);
    if (options.length === 0) errors.push(`${path}.config.options is required for single_select`);
    if (options.length > MAX_SINGLE_SELECT_OPTIONS) errors.push(`${path}.config.options over cap: max ${MAX_SINGLE_SELECT_OPTIONS}`);
    if (new Set(options).size !== options.length) errors.push(`${path}.config.options contains duplicate options`);
  } else if (field.config !== undefined && Object.keys(field.config).length > 0) {
    errors.push(`${path}.config is only supported for single_select in S1`);
  }
}

function validateView(view: ViewSpec, entityKey: string, fieldKeys: Set<string>, path: string, errors: string[]): void {
  if (!(ACTIVE_VIEW_KINDS as readonly string[]).includes(view.kind)) errors.push(`${path}.kind "${view.kind}" is declared but inert in S1`);
  if (view.config.visible_fields.length > MAX_VISIBLE_FIELDS_PER_VIEW) {
    errors.push(`${path}.config.visible_fields over cap: max ${MAX_VISIBLE_FIELDS_PER_VIEW}`);
  }
  const visible = new Set<string>();
  for (const [index, key] of view.config.visible_fields.entries()) {
    if (!fieldKeys.has(key)) errors.push(`${path}.config.visible_fields.${index} references unknown field "${key}" on entity "${entityKey}"`);
    if (visible.has(key)) errors.push(`${path}.config.visible_fields.${index} duplicate field "${key}"`);
    visible.add(key);
  }
  if (view.config.sort && !fieldKeys.has(view.config.sort.field)) {
    errors.push(`${path}.config.sort.field references unknown field "${view.config.sort.field}" on entity "${entityKey}"`);
  }
  if (view.config.filter) {
    if (!fieldKeys.has(view.config.filter.field)) {
      errors.push(`${path}.config.filter.field references unknown field "${view.config.filter.field}" on entity "${entityKey}"`);
    }
    if (view.config.filter.value !== undefined && looksLikeFieldReference(view.config.filter.value, fieldKeys)) {
      errors.push(`${path}.config.filter.value must be a static constant, not a field reference`);
    }
  }
}

function validatePage(page: PageSpec, viewsByEntity: Map<string, Set<string>>, path: string, errors: string[]): void {
  if (page.views.length > MAX_VIEWS_PER_PAGE) errors.push(`${path}.views over cap: max ${MAX_VIEWS_PER_PAGE}`);
  const refs = new Set<string>();
  for (const [index, ref] of page.views.entries()) {
    const refKey = `${ref.entity_key}.${ref.view_key}`;
    if (refs.has(refKey)) errors.push(`${path}.views.${index} duplicate view ref "${refKey}"`);
    refs.add(refKey);
    if (!(viewsByEntity.get(ref.entity_key)?.has(ref.view_key) ?? false)) {
      errors.push(`${path}.views.${index} references unknown view "${ref.view_key}" on entity "${ref.entity_key}"`);
    }
  }
}

function readOptions(field: FieldSpec): string[] {
  if (!field.config || !("options" in field.config) || !Array.isArray(field.config.options)) return [];
  return field.config.options;
}

function looksLikeFieldReference(value: string | number | boolean | null, fieldKeys: Set<string>): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.startsWith("$field.") || trimmed.startsWith("${") || trimmed.startsWith("field:")) return true;
  if (trimmed.startsWith("$") && fieldKeys.has(trimmed.slice(1))) return true;
  return false;
}

function zodErrors(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${path}: ${issue.message}`;
  });
}

function jsonSizeError(value: unknown): string | null {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return "spec JSON could not be serialized";
  }
  const bytes = new TextEncoder().encode(json).byteLength;
  return bytes > MAX_SPEC_BYTES ? `spec JSON too large: ${bytes} bytes exceeds ${MAX_SPEC_BYTES}` : null;
}

function repairSpecShape(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const plan = cloneRecord(value);
  plan.specVersion = CURRENT_SPEC_VERSION;
  if ("actions" in plan) plan.actions = toArray(plan.actions);
  if (Array.isArray(plan.actions)) plan.actions = plan.actions.map(repairAction);
  return plan;
}

function repairAction(value: unknown): unknown {
  const action = cloneRecord(value);
  if (typeof action.type === "string") action.type = action.type.trim();
  if (action.additive === "true") action.additive = true;
  if (isRecord(action.entity)) action.entity = repairEntity(action.entity);
  if (isRecord(action.field)) action.field = repairField(action.field);
  if (isRecord(action.view)) action.view = repairView(action.view);
  if (isRecord(action.page)) action.page = repairPage(action.page);
  if (typeof action.entity_key === "string") action.entity_key = action.entity_key.trim();
  return action;
}

function repairEntity(value: Record<string, unknown>): Record<string, unknown> {
  const entity = stampSpec(value);
  trimStringProps(entity, ["key", "singular", "plural", "icon"]);
  entity.fields = toArray(entity.fields).map((field) => isRecord(field) ? repairField(field) : field);
  return entity;
}

function repairField(value: Record<string, unknown>): Record<string, unknown> {
  const field = stampSpec(value);
  trimStringProps(field, ["key", "label", "type"]);
  if (field.required === "true") field.required = true;
  if (field.required === "false") field.required = false;
  if (field.unique === "true") field.unique = true;
  if (field.unique === "false") field.unique = false;
  if (isRecord(field.config) && "options" in field.config) {
    field.config = { ...field.config, options: toArray(field.config.options).map((option) => typeof option === "string" ? option.trim() : String(option).trim()) };
  }
  return field;
}

function repairView(value: Record<string, unknown>): Record<string, unknown> {
  const view = stampSpec(value);
  trimStringProps(view, ["key", "kind", "name"]);
  if (isRecord(view.config)) {
    const config = { ...view.config };
    config.visible_fields = toArray(config.visible_fields).map((field) => typeof field === "string" ? field.trim() : String(field).trim());
    if (isRecord(config.sort)) trimStringProps(config.sort, ["field", "direction"]);
    if (isRecord(config.filter)) trimStringProps(config.filter, ["field", "op"]);
    view.config = config;
  }
  return view;
}

function repairPage(value: Record<string, unknown>): Record<string, unknown> {
  const page = stampSpec(value);
  trimStringProps(page, ["key", "title", "icon"]);
  page.views = toArray(page.views).map((ref) => {
    if (!isRecord(ref)) return ref;
    const next = { ...ref };
    trimStringProps(next, ["entity_key", "view_key"]);
    return next;
  });
  return page;
}

function stampSpec(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value, specVersion: CURRENT_SPEC_VERSION };
}

function trimStringProps(value: Record<string, unknown>, props: string[]): void {
  for (const prop of props) {
    if (typeof value[prop] === "string") value[prop] = value[prop].trim();
  }
}

function toArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value) ? { ...value } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
