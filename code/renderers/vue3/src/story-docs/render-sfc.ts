import { types as t } from 'storybook/internal/babel';

import { indent, isVueExpressionAttribute, slotSortKey, wrapSlotContent } from './ast-utils.ts';
import type {
  ClassifiedArg,
  ClassifiedPropLikeArg,
  ClassifiedSlotArg,
  RenderableValuePlan,
} from './classify-args.ts';
import { printValue, unwrapValue } from './classify-value.ts';

export interface RenderSfcInput {
  /** Component identifier from CSF meta.component. */
  componentName: string;
  /** Classified args to render into the SFC snippet. */
  args: ClassifiedArg[];
  /** Optional renderer for function-valued slot args. */
  renderFunctionSlot?: FunctionSlotRenderer;
}

export interface RenderSfcMarkupInput {
  /** Rendered Vue template markup without the wrapping `<template>` block. */
  templateCode: string;
  /** Imports and variables referenced by the prepared template markup. */
  ctx: RenderContext;
}

export interface RenderContext {
  /** Imports hoisted into `<script setup>`. */
  imports: Record<string, Set<string>>;
  /** Identifiers already taken in `<script setup>` scope. */
  bindings: Set<string>;
  /** Const declarations hoisted into `<script setup>`. */
  variables: Map<string, string>;
}

export interface RenderPropValueInput {
  /** Vue template attribute name. */
  attributeName: string;
  /** JavaScript identifier referenced by hoisted values. */
  variableName: string;
  /** CSF arg value expression. */
  value: t.Node;
  /** Render plan the value was classified with. */
  plan: RenderableValuePlan;
}

export interface RenderedProp {
  /** Vue template attribute. */
  attrName: string;
  /** Vue template attribute value, or undefined for a bare attribute. */
  value?: string;
}

export type FunctionSlotRenderer = (
  value: t.ArrowFunctionExpression | t.FunctionExpression,
  ctx: RenderContext
) => string | undefined;

const VUE_PACKAGE = 'vue';

/** Render classified CSF args into the same SFC block shape as Vue's runtime source decorator. */
export function renderSfcSnippet(input: RenderSfcInput): string | undefined {
  const ctx = createRenderContext(input.args);
  const partitioned = partitionArgsByRole(input.args);
  const props = partitioned.props.map((arg) => formatRenderedProp(renderPropLikeArg(arg, ctx)));
  const events = partitioned.events.map((arg) => formatRenderedProp(renderEventArg(arg, ctx)));
  const slotSource: string[] = [];
  for (const arg of partitioned.slots) {
    const rendered = renderSlotArg(arg, ctx, input.renderFunctionSlot);
    // Only function-slot plans fail to render; without their content the snippet would misrepresent
    // the story, so bail and leave it to runtime source.
    if (rendered === undefined) {
      return undefined;
    }
    slotSource.push(rendered);
  }
  const slotSourceCode = slotSource.join('\n');
  const openTag = [input.componentName, ...props, ...events].join(' ');
  const templateCode = slotSourceCode
    ? `<${openTag}>\n${indent(slotSourceCode)}\n</${input.componentName}>`
    : `<${openTag} />`;

  return renderPreparedSfcSnippet({ templateCode, ctx });
}

/**
 * Split classified args by role, each group sorted in stable attribute order.
 *
 * Sorted before rendering, so hoisted consts are declared in the order their attributes appear.
 */
export function partitionArgsByRole(args: ClassifiedArg[]): {
  props: ClassifiedPropLikeArg[];
  events: ClassifiedPropLikeArg[];
  slots: ClassifiedSlotArg[];
} {
  return {
    props: args
      .filter((arg): arg is ClassifiedPropLikeArg => arg.role === 'model' || arg.role === 'prop')
      .sort((a, b) => a.name.localeCompare(b.name)),
    events: args
      .filter((arg): arg is ClassifiedPropLikeArg => arg.role === 'event')
      .sort((a, b) => a.name.localeCompare(b.name)),
    slots: args
      .filter((arg): arg is ClassifiedSlotArg => arg.role === 'slot')
      .sort((a, b) => slotSortKey(a.name).localeCompare(slotSortKey(b.name))),
  };
}

/** Create an isolated hoist context for one generated snippet. */
export function createRenderContext(args: ClassifiedArg[]): RenderContext {
  const imports: RenderContext['imports'] = {};
  const bindings = new Set<string>();

  if (args.some((arg) => arg.role === 'model')) {
    imports[VUE_PACKAGE] = new Set(['ref']);
    bindings.add('ref');
  }

  return { imports, bindings, variables: new Map() };
}

/** Wrap prepared template markup with the shared SFC block assembly. */
export function renderPreparedSfcSnippet(input: RenderSfcMarkupInput): string {
  const template = `<template>\n${indent(input.templateCode)}\n</template>`;
  const script = renderScript(input.ctx);

  return script ? `${script}\n\n${template}` : template;
}

/** Render a classified prop or model arg into a Vue template attribute. */
export function renderPropLikeArg(arg: ClassifiedPropLikeArg, ctx: RenderContext): RenderedProp {
  return arg.role === 'model' ? renderModelArg(arg, ctx) : renderPropArg(arg, ctx);
}

function renderPropArg(arg: ClassifiedPropLikeArg, ctx: RenderContext): RenderedProp {
  return renderPropValue(
    { attributeName: arg.name, variableName: arg.name, value: arg.value, plan: arg.plan },
    ctx
  );
}

/** Render a classified arg value into a Vue template attribute under a chosen attribute name. */
export function renderPropValue(input: RenderPropValueInput, ctx: RenderContext): RenderedProp {
  const value = unwrapValue(input.value);

  if (input.plan.kind === 'hoist') {
    return hoistedProp(input, ctx, printValue(value));
  }

  if (value.type === 'BooleanLiteral') {
    return value.value
      ? { attrName: input.attributeName }
      : { attrName: `:${input.attributeName}`, value: 'false' };
  }

  if (value.type === 'StringLiteral') {
    const quoted = quoteAttributeValue(value.value);
    return quoted === undefined
      ? hoistedProp(input, ctx, printValue(value))
      : { attrName: input.attributeName, value: value.value };
  }

  return { attrName: `:${input.attributeName}`, value: printValue(value) };
}

function hoistedProp(
  input: Pick<RenderPropValueInput, 'attributeName' | 'variableName'>,
  ctx: RenderContext,
  source: string
): RenderedProp {
  const bindingName = allocateBindingName(input.variableName, ctx);
  ctx.variables.set(bindingName, source);
  return { attrName: `:${input.attributeName}`, value: bindingName };
}

function renderModelArg(arg: ClassifiedPropLikeArg, ctx: RenderContext): RenderedProp {
  const bindingName = allocateBindingName(arg.name, ctx);
  ctx.variables.set(bindingName, `ref(${printValue(unwrapValue(arg.value))})`);

  const directive = arg.name === 'modelValue' ? 'v-model' : `v-model:${arg.name}`;
  return { attrName: directive, value: bindingName };
}

/** Listeners hoist their handler, because inline handlers would bloat the tag. */
export function renderEventArg(arg: ClassifiedPropLikeArg, ctx: RenderContext): RenderedProp {
  const bindingName = allocateBindingName(arg.name, ctx);
  ctx.variables.set(bindingName, printValue(unwrapValue(arg.value)));
  return { attrName: `@${arg.eventName ?? arg.name}`, value: bindingName };
}

function renderSlotArg(
  arg: ClassifiedSlotArg,
  ctx: RenderContext,
  renderFunctionSlot?: FunctionSlotRenderer
): string | undefined {
  const content = renderSlotArgContent(arg, ctx, renderFunctionSlot);
  return content === undefined ? undefined : wrapSlotContent(arg.name, content);
}

/** Slot children for one classified slot arg, or undefined when a function slot cannot render. */
export function renderSlotArgContent(
  arg: ClassifiedSlotArg,
  ctx: RenderContext,
  renderFunctionSlot?: FunctionSlotRenderer
): string | undefined {
  if (arg.plan.kind === 'function-slot') {
    const value = unwrapValue(arg.value);
    return renderFunctionSlot && isFunctionValue(value)
      ? renderFunctionSlot(value, ctx)
      : undefined;
  }

  return renderSlotContent(arg, arg.plan, ctx);
}

/** Inline primitive arg values that do not require script setup hoists. */
export function renderInlinePrimitiveValue(node: t.Node): string | undefined {
  const value = unwrapValue(node);

  switch (value.type) {
    case 'StringLiteral':
      return value.value;
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return String(value.value);
    default:
      return undefined;
  }
}

/**
 * Slot children for one classified slot arg.
 *
 * Text-shaped literals become text directly; everything else is interpolated, since a hoisted
 * `<script setup>` binding cannot reach slot content any other way.
 */
function renderSlotContent(
  arg: ClassifiedSlotArg,
  plan: RenderableValuePlan,
  ctx: RenderContext
): string {
  const value = unwrapValue(arg.value);

  if (plan.kind === 'inline') {
    return renderInlinePrimitiveValue(value) ?? `{{ ${printValue(value)} }}`;
  }

  const bindingName = allocateBindingName(arg.name, ctx);
  ctx.variables.set(bindingName, printValue(value));
  return `{{ ${bindingName} }}`;
}

function isFunctionValue(node: t.Node): node is t.ArrowFunctionExpression | t.FunctionExpression {
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';
}

function renderScript(ctx: RenderContext): string | undefined {
  const importsCode = Object.entries(ctx.imports)
    .map(([packageName, imports]) => {
      return `import { ${Array.from(imports.values()).sort().join(', ')} } from "${packageName}";`;
    })
    .join('\n');
  const variablesCode = Array.from(ctx.variables.entries())
    .map(([name, value]) => `const ${name} = ${value};`)
    .join('\n\n');

  if (!importsCode && !variablesCode) {
    return undefined;
  }

  return `<script lang="ts" setup>
${importsCode ? `${importsCode}\n\n${variablesCode}` : variablesCode}
</script>`;
}

function allocateBindingName(name: string, ctx: RenderContext): string {
  const baseName = t.toIdentifier(name);
  let bindingName = baseName;
  let suffix = 2;

  while (ctx.bindings.has(bindingName)) {
    bindingName = `${baseName}${suffix}`;
    suffix += 1;
  }

  ctx.bindings.add(bindingName);
  return bindingName;
}

/** Quoted attribute value, or `undefined` when both quote styles occur and it must be hoisted. */
function quoteAttributeValue(value: string): string | undefined {
  if (!value.includes('"')) {
    return `"${value}"`;
  }
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  return undefined;
}

/** Format one structured attribute at the SFC print boundary. */
export function formatRenderedProp(prop: RenderedProp): string {
  if (prop.value === undefined) {
    return prop.attrName;
  }

  if (!isVueExpressionAttribute(prop.attrName)) {
    // renderPropValue hoists strings mixing both quote styles, so this value is always quotable.
    return `${prop.attrName}=${quoteAttributeValue(prop.value)!}`;
  }

  return `${prop.attrName}="${prop.value}"`;
}
