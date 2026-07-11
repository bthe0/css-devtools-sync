/**
 * @css-sync/contract — single source of truth for the wire protocol between
 * the DevTools extension (capture side) and the local sync server (apply side).
 *
 * All shapes are Zod v4 schemas; TS types are derived via z.infer.
 * Extension and server MUST parse payloads with these schemas at the boundary.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Instrumentation attribute names
// (babel plugin writes these onto JSX elements; extension reads them back)
// ---------------------------------------------------------------------------

export const DATA_SOURCE_FILE = "data-source-file" as const;
export const DATA_SOURCE_LINE = "data-source-line" as const;
export const DATA_SOURCE_COMPONENT = "data-source-component" as const;

// ---------------------------------------------------------------------------
// Workspace package names (so downstream agents reference them consistently)
// ---------------------------------------------------------------------------

export const PKG_CONTRACT = "@css-sync/contract" as const;
export const PKG_BABEL_PLUGIN = "@css-sync/babel-plugin-source-locator" as const;
export const PKG_SERVER = "@css-sync/server" as const;
export const PKG_TEST_APP = "@css-sync/test-app" as const;
// The Chrome extension lives at apps/extension and is not a published package.

// ---------------------------------------------------------------------------
// Core building blocks
// ---------------------------------------------------------------------------

/** Origin of a stylesheet as reported by CDP CSS.StyleSheetOrigin (plus DevTools-created). */
export const StyleSheetOriginSchema = z.enum([
  "regular",
  "inspector",
  "injected",
  "user-agent",
]);
export type StyleSheetOrigin = z.infer<typeof StyleSheetOriginSchema>;

/** Reference to a stylesheet in the inspected page. */
export const StyleSheetRefSchema = z.object({
  /** CDP styleSheetId (opaque, session-scoped). */
  id: z.string().min(1),
  /** URL the sheet was loaded from ("" for inline/constructed sheets). */
  sourceURL: z.string(),
  /** sourceMappingURL if present (absolute or relative to sourceURL). */
  sourceMapURL: z.string().optional(),
  origin: StyleSheetOriginSchema,
});
export type StyleSheetRef = z.infer<typeof StyleSheetRefSchema>;

/**
 * Range in the COMPILED stylesheet text, in CDP coordinates
 * (0-based lines and columns, end-exclusive).
 */
export const SourceRangeSchema = z.object({
  startLine: z.number().int().nonnegative(),
  startColumn: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  endColumn: z.number().int().nonnegative(),
});
export type SourceRange = z.infer<typeof SourceRangeSchema>;

/**
 * Context about the element that was selected in Elements when the edit was
 * made. The data-source-* fields come from the babel instrumentation plugin
 * (see DATA_SOURCE_* constants) and let the server map the change straight to
 * a source file even without a sourcemap.
 */
export const ElementContextSchema = z.object({
  tagName: z.string().min(1),
  classList: z.array(z.string()),
  /** Value of data-source-file, if instrumented. */
  dataSourceFile: z.string().optional(),
  /** Value of data-source-line, if instrumented. */
  dataSourceLine: z.number().int().positive().optional(),
  /** Value of data-source-component, if instrumented. */
  dataSourceComponent: z.string().optional(),
});
export type ElementContext = z.infer<typeof ElementContextSchema>;

/**
 * ElementContext refined so dataSourceFile/dataSourceLine are guaranteed
 * present (non-empty file, positive line). Required for DOM/markup edits:
 * unlike CSS ops there is no stylesheet/sourcemap fallback, so without a
 * JSX source location the server has no way to locate the element at all.
 */
export const RequiredElementContextSchema = ElementContextSchema.refine(
  (el): el is ElementContext & { dataSourceFile: string; dataSourceLine: number } =>
    typeof el.dataSourceFile === "string" &&
    el.dataSourceFile.length > 0 &&
    typeof el.dataSourceLine === "number",
  {
    message:
      "DOM edits require element.dataSourceFile and element.dataSourceLine " +
      "(babel source-locator instrumentation missing on this element)",
  },
);
export type RequiredElementContext = z.infer<typeof RequiredElementContextSchema>;

// ---------------------------------------------------------------------------
// Captured changes (extension -> server)
// ---------------------------------------------------------------------------

/** An existing declaration's value was changed in the Styles panel. */
export const ModifyChangeSchema = z.object({
  op: z.literal("modify"),
  styleSheet: StyleSheetRefSchema,
  /** Full selector text of the rule containing the declaration. */
  selector: z.string().min(1).max(2000),
  /** Range of the rule/declaration in the compiled sheet, when known. */
  range: SourceRangeSchema.optional(),
  /** Enclosing @media condition text, if any (e.g. "(max-width: 768px)"). */
  mediaText: z.string().optional(),
  property: z.string().min(1).max(2000),
  oldValue: z.string().max(100000),
  newValue: z.string().max(100000),
  element: ElementContextSchema.optional(),
});
export type ModifyChange = z.infer<typeof ModifyChangeSchema>;

/** A new declaration was added to an EXISTING rule. */
export const AddDeclChangeSchema = z.object({
  op: z.literal("add-decl"),
  styleSheet: StyleSheetRefSchema,
  selector: z.string().min(1).max(2000),
  range: SourceRangeSchema.optional(),
  mediaText: z.string().optional(),
  property: z.string().min(1).max(2000),
  newValue: z.string().max(100000),
  element: ElementContextSchema.optional(),
});
export type AddDeclChange = z.infer<typeof AddDeclChangeSchema>;

/** A declaration was deleted (or unchecked) in an existing rule. */
export const DeleteDeclChangeSchema = z.object({
  op: z.literal("delete-decl"),
  styleSheet: StyleSheetRefSchema,
  selector: z.string().min(1).max(2000),
  range: SourceRangeSchema.optional(),
  /** Enclosing @media condition text, if any — disambiguates a selector that
   * also exists at top level (e.g. `.card` in and out of an @media block). */
  mediaText: z.string().optional(),
  property: z.string().min(1).max(2000),
  element: ElementContextSchema.optional(),
});
export type DeleteDeclChange = z.infer<typeof DeleteDeclChangeSchema>;

/**
 * A brand-new rule (or new @media block) the user typed in DevTools.
 * These land in the inspector stylesheet, so styleSheet.origin is usually
 * "inspector" and there is no meaningful source range — the server must
 * PLACE the rule (hence they often end up in ApplyResult.needsPlacement).
 */
export const AddRuleChangeSchema = z.object({
  op: z.literal("add-rule"),
  styleSheet: StyleSheetRefSchema,
  selector: z.string().min(1).max(2000),
  mediaText: z.string().optional(),
  /** Complete rule text as typed, e.g. ".card:hover { transform: scale(1.02); }". */
  ruleText: z.string().min(1).max(100000),
  element: ElementContextSchema.optional(),
});
export type AddRuleChange = z.infer<typeof AddRuleChangeSchema>;

/**
 * An attribute was added or changed on an element in the Elements panel.
 * Maps to a JSX attribute on the source element (NOT a stylesheet edit).
 */
export const SetAttrChangeSchema = z.object({
  op: z.literal("set-attr"),
  element: RequiredElementContextSchema,
  attribute: z.string().min(1).max(2000),
  value: z.string().max(100000),
});
export type SetAttrChange = z.infer<typeof SetAttrChangeSchema>;

/** An attribute was removed from an element in the Elements panel. */
export const RemoveAttrChangeSchema = z.object({
  op: z.literal("remove-attr"),
  element: RequiredElementContextSchema,
  attribute: z.string().min(1).max(2000),
});
export type RemoveAttrChange = z.infer<typeof RemoveAttrChangeSchema>;

/**
 * An element's text content was edited in place in the Elements panel.
 * Only applies when the element's SOLE child is static text (or it is empty) —
 * the server refuses elements whose children mix in {expressions}/nested tags,
 * because flattening them would destroy the dynamic content. To edit one static
 * run of text inside such a mixed element, use `set-text-segment` instead
 * (enumerate the segments with the /describe endpoint first).
 */
export const SetTextChangeSchema = z.object({
  op: z.literal("set-text"),
  element: RequiredElementContextSchema,
  newText: z.string().max(100000),
  oldText: z.string().max(100000).optional(),
});
export type SetTextChange = z.infer<typeof SetTextChangeSchema>;

/**
 * ONE static text run inside an element with mixed/dynamic children was edited.
 * Unlike set-text (whole-body replace, refuses any {expression}), this targets
 * a single JSXText child by its index in the parsed source children array and
 * leaves every {expr} hole and nested element untouched. `oldText` is a drift
 * guard: the server refuses the write unless the child at `segmentIndex` is a
 * JSXText whose raw source value equals it exactly. Obtain both fields from a
 * TemplateResponse (the /describe endpoint).
 */
export const SetTextSegmentChangeSchema = z.object({
  op: z.literal("set-text-segment"),
  element: RequiredElementContextSchema,
  /** Index of the target child in the located element's source children array. */
  segmentIndex: z.number().int().nonnegative(),
  /** Current raw source text of that static segment (drift guard). */
  oldText: z.string().max(100000),
  newText: z.string().max(100000),
});
export type SetTextSegmentChange = z.infer<typeof SetTextSegmentChangeSchema>;

/** One CSS declaration lifted out of an element's inline `style`. */
export const InlineDeclarationSchema = z.object({
  property: z.string().min(1).max(2000),
  value: z.string().min(1).max(100000),
});
export type InlineDeclaration = z.infer<typeof InlineDeclarationSchema>;

/**
 * Generated class name that targets a promoted element. Deterministic per
 * source location (`csync-<base36 hash of file:line>`) so re-promoting the same
 * element updates ONE rule in place instead of piling up copies. The strict
 * charset also means it is always safe to embed both in a JSX `className` string
 * and as a CSS selector — no escaping needed, nothing hostile can be injected.
 */
export const PromotedClassNameSchema = z
  .string()
  .regex(/^csync-[0-9a-z]+$/, "className must match /^csync-[0-9a-z]+$/");

/**
 * An `element.style` (inline style) edit made in the Elements panel. Inline
 * styles have no stylesheet/selector to map back to, so instead of writing an
 * inline `style={{}}` into JSX (which the user explicitly does not want) the
 * server appends a generated class to the element and upserts a matching rule
 * into the overrides stylesheet — turning a transient inline tweak into a
 * persistent, source-controlled CSS rule keyed by a stable class.
 */
export const PromoteInlineStyleChangeSchema = z.object({
  op: z.literal("promote-inline-style"),
  element: RequiredElementContextSchema,
  className: PromotedClassNameSchema,
  /** Non-empty set of declarations the element carried in its inline style. */
  declarations: z.array(InlineDeclarationSchema).min(1).max(1000),
});
export type PromoteInlineStyleChange = z.infer<typeof PromoteInlineStyleChangeSchema>;

/** Discriminated union of everything the extension can capture. */
export const CaptureChangeSchema = z.discriminatedUnion("op", [
  ModifyChangeSchema,
  AddDeclChangeSchema,
  DeleteDeclChangeSchema,
  AddRuleChangeSchema,
  SetAttrChangeSchema,
  RemoveAttrChangeSchema,
  SetTextChangeSchema,
  SetTextSegmentChangeSchema,
  PromoteInlineStyleChangeSchema,
]);
export type CaptureChange = z.infer<typeof CaptureChangeSchema>;

/** POST body: extension -> server, one sync batch. */
export const CapturePayloadSchema = z.object({
  /** URL of the inspected page. */
  url: z.string().min(1),
  /**
   * Optional hint mapping the page to a local workspace root, for setups
   * where the server watches multiple project roots and can't disambiguate
   * which one served the inspected page from the URL alone (e.g. several
   * dev servers on different ports/paths behind one proxy). Currently
   * accepted and forwarded by the extension but not yet consumed by the
   * server's resolution logic — kept rather than dropped because multi-root
   * disambiguation is on the near-term roadmap and this would otherwise be
   * a breaking field to add later once clients are already sending payloads.
   */
  workspaceHint: z.string().optional(),
  changes: z.array(CaptureChangeSchema).max(500),
});
export type CapturePayload = z.infer<typeof CapturePayloadSchema>;

// ---------------------------------------------------------------------------
// Apply results (server -> extension)
// ---------------------------------------------------------------------------

/** How the server resolved a change to a source location. */
export const ApplyModeSchema = z.enum([
  /** Matched via postcss AST walk of the source file. */
  "postcss",
  /** Located through the stylesheet's sourcemap. */
  "sourcemap",
  /** Resolved via the element's classList / data-source-* attributes. */
  "classlist",
  /** Edited a css-in-js template/object in a JS/TS source file. */
  "cssinjs",
  /** New rule was placed into a file chosen by the placement engine. */
  "placed",
  /** Edited JSX markup directly (attribute or text) via a source location. */
  "jsx",
  /** Promoted an inline-style edit to a generated class + overrides CSS rule. */
  "promote",
]);
export type ApplyMode = z.infer<typeof ApplyModeSchema>;

/** One successfully applied change. */
export const ApplyOutcomeSchema = z.object({
  change: CaptureChangeSchema,
  /** Workspace-relative path of the edited file. */
  file: z.string().min(1),
  /** 1-based line in the edited file, when known. */
  line: z.number().int().positive().optional(),
  mode: ApplyModeSchema,
  /** Human-readable note (e.g. "matched 2nd of 3 duplicate selectors"). */
  note: z.string().optional(),
});
export type ApplyOutcome = z.infer<typeof ApplyOutcomeSchema>;

export const SkippedChangeSchema = z.object({
  change: CaptureChangeSchema,
  reason: z.string().min(1),
});
export type SkippedChange = z.infer<typeof SkippedChangeSchema>;

/** Response body for a CapturePayload. */
export const ApplyResultSchema = z.object({
  applied: z.array(ApplyOutcomeSchema),
  skipped: z.array(SkippedChangeSchema),
  /**
   * Changes (typically op:add-rule) the server could not confidently place;
   * the client should prompt the user or invoke LLM-assisted placement.
   */
  needsPlacement: z.array(CaptureChangeSchema),
});
export type ApplyResult = z.infer<typeof ApplyResultSchema>;

// ---------------------------------------------------------------------------
// Template describe (extension -> server -> extension)
// Enumerate an element's source children so the panel can offer per-segment
// static-text editing on elements it would otherwise have to skip wholesale.
// ---------------------------------------------------------------------------

/** POST body: "describe the source template of this instrumented element". */
export const DescribeTemplateRequestSchema = z.object({
  element: RequiredElementContextSchema,
});
export type DescribeTemplateRequest = z.infer<typeof DescribeTemplateRequestSchema>;

/**
 * One ordered child of the located element's source template. `index` is the
 * position in the source children array — pass it back verbatim as
 * set-text-segment.segmentIndex to edit a static part.
 */
export const TemplatePartSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("static"),
    index: z.number().int().nonnegative(),
    /** Raw source text of this JSXText child (this is what you edit). */
    text: z.string(),
    /** True when `text` is only whitespace/newlines (JSX-insignificant); a panel may hide it. */
    whitespaceOnly: z.boolean(),
  }),
  z.object({
    kind: z.literal("dynamic"),
    index: z.number().int().nonnegative(),
    /** Source text of the hole, e.g. "name" for {name} — read-only; cannot be edited here. */
    expr: z.string(),
  }),
  z.object({
    kind: z.literal("element"),
    index: z.number().int().nonnegative(),
    /** Tag of a nested child element, e.g. "strong" — read-only here. */
    tag: z.string(),
  }),
]);
export type TemplatePart = z.infer<typeof TemplatePartSchema>;

/** Response body for a DescribeTemplateRequest. */
export const TemplateResponseSchema = z.object({
  /** Workspace-relative path of the located source file. */
  file: z.string().min(1),
  /** 1-based data-source-line the element was located at. */
  line: z.number().int().positive(),
  /** Tag name of the located element. */
  tag: z.string().min(1),
  parts: z.array(TemplatePartSchema),
  /** True when at least one static, non-whitespace-only segment can be edited. */
  editable: z.boolean(),
});
export type TemplateResponse = z.infer<typeof TemplateResponseSchema>;

// ---------------------------------------------------------------------------
// Verification round-trip (server -> extension -> server)
// ---------------------------------------------------------------------------

export const VerifyCheckSchema = z.object({
  selector: z.string().min(1),
  property: z.string().min(1),
  expected: z.string(),
  actual: z.string(),
});
export type VerifyCheck = z.infer<typeof VerifyCheckSchema>;

/** Server asks the extension to re-read computed styles after HMR/reload. */
export const VerifyRequestSchema = z.object({
  url: z.string().min(1),
  checks: z.array(VerifyCheckSchema).max(500),
});
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;

export const VerifyResultSchema = z.object({
  ok: z.boolean(),
  mismatches: z.array(VerifyCheckSchema),
});
export type VerifyResult = z.infer<typeof VerifyResultSchema>;
